import * as THREE from 'three';
import { ensureFont } from '../../assets/registry';
import type { Comp, Erode2D, Fill, Layer, Material2D, PartKey, PlateShape, Project, ReflectionMap2D, Title2DLayer, Transform } from '../../model/types';
import { hasPartEffects, layerParts, rimKey } from '../../model/parts';
import { cmdsBounds, type Bounds, type PathCmd } from '../../text/layout';
import { plateBaseCmds } from '../../text/plate';
import type { LayerRenderContext, LayerRenderer } from '../contracts';
import type { PassKit } from '../passkit';
import { decodeImage, getBitmap, onImageReady } from './images';
import { disposeMaterialSlot, emptyMaterialSlot, fillBitmap, fillUniforms, MaterialPass, setFill, sized, type MaterialSlot } from './materialPass';
import { loadReflectionMap, onReflectionReady } from './reflectionMaps';
import { buildGeometry, fillGroup, geometryKey, type FillGroup, type Geometry } from './outline2d';
import {
  BACKGROUND_FRAG,
  ERODE_FRAG,
  GROW_FRAG,
  MASK_COPY_FRAG,
  MASK_KEEP_FRAG,
  MASK_UNION_FRAG,
  NEAREST_GLYPH_FRAG,
  PICTURE_COPY_FRAG,
  PLACE_FRAG,
} from './shaders';

// 2D title renderer (Eye Candy / Photoshop layer-style replacement).
//
// Pipeline per layer, everything in a layer-local "frame" (layer-space box enclosing every
// element) at mask resolution m = layer scale × max(pxScale, 1) render px per layer unit, so
// a 0.5× preview shades exactly like a 1× render and is only filtered down when placed:
//   1. geometry: glyph outlines / shape / SVG paths / image (outline2d.ts); text and shape
//      outlines come with the layer's warp → distort → weight applied (src/text/ink.ts)
//   2. per element (face + enabled rims): coverage mask (Canvas2D fill + stroke = geometric
//      offset with miter/round/bevel joins; fillCounters rims draw only outer contours and
//      then flood-fill any pocket the grown outline closes off, e.g. between letters, like
//      Illustrator's Offset Path + Divide). A rim grows from its plate base (plateBaseCmds:
//      the outline itself, its closing, its convex hull or a slanted chamfered box). Image
//      sources have no paths, so contour rims grow through the SDF of the alpha (round joins,
//      counters flood-filled first, closing = grow + shrink through a second SDF) and hull /
//      box plates use the hull of the opaque pixels. Then, from that coverage (eroded by step 3
//      when かすれ is on), signed distance field (jump flooding over sub-pixel edge points) and
//      bevel height field — each cached by a key so e.g. a colour change never redoes the SDF.
//      Per-character face overrides split only the face: one face element per distinct
//      material, each masking its own glyphs; rims still grow from the whole word.
//   3. かすれ (erode), between the masks and their SDFs: the union of every element mask → its
//      SDF → one dry-brush keep-mask; each element's mask × the keep-mask (cached by mask +
//      keep-mask) replaces its coverage BEFORE shading, so the SDF, height field, shape burst,
//      inner glow, satin blur and knockout all follow the cut edges: face and rims break up
//      coherently and every streak gets its own bevelled, lit edge, like a dry-brush stroke
//      through Bevel & Emboss.
//   4. shading (materialPass.ts, shared with the Material effect): fill (gradient with stop
//      opacity over the layer, or per line / glyph box via a nearest-glyph index map; shape burst
//      from the SDF; image fill; an image source's own picture, see ownPicture) → refraction /
//      glass → bevel (PS-style light, gloss contour or custom curve LUT, highlight screen /
//      shadow multiply; pattern relief and surface textures join the height field) →
//      gradient-map finish → pattern marks (patterns.ts, lit by `shade`) → satin (blurred
//      silhouette shifted ±distance) → colour texture → sheen → inner glow → gloss cap, computed
//      in sRGB like Photoshop and composited
//      back-to-front (outermost rim first) into the stack texture (premultiplied linear) at the
//      material's fill opacity. Knockout erases the stack under each face before drawing it.
//      A part render (ctx.parts) shades only the listed elements into a stack of its own, from
//      the same frame, masks, grows, かすれ keep-mask and knockout as the full render, so an
//      isolated rim has exactly its full-render shape and pixels.
//   5. placement: the stack is drawn into the comp-sized target with position, rotation
//      (positive rotZ = clockwise on screen, about the layer position) and scale.
// The bevel light stays fixed on screen (Photoshop global light) when the layer rotates.

const MITER_LIMIT = 4;
const MAX_SIDE = 4096;
const MAX_PIXELS = 6_000_000;
const DEG = Math.PI / 180;

// ---------- invalidation / preload ----------

/** Called when an asynchronously decoded asset or reflection map becomes drawable (re-render needed). */
export function onLayer2DInvalidate(cb: () => void): () => void {
  const offImages = onImageReady(cb);
  const offMaps = onReflectionReady(cb);
  return () => {
    offImages();
    offMaps();
  };
}

/** Image assets of image fills (`image.assetId`) and custom patterns, and enabled reflection maps, anywhere inside `v`. */
function collectImageAssets(v: unknown, out: Set<string>, maps: Set<ReflectionMap2D>, key = ''): void {
  if (Array.isArray(v)) for (const x of v) collectImageAssets(x, out, maps);
  else if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (key === 'image' && typeof o.assetId === 'string' && o.assetId) out.add(o.assetId);
    if (key === 'pattern' && o.kind === 'custom' && typeof o.assetId === 'string' && o.assetId) out.add(o.assetId);
    if (key === 'reflection' && o.enabled === true && typeof o.map === 'string') maps.add(o.map as ReflectionMap2D);
    for (const [k, x] of Object.entries(o)) collectImageAssets(x, out, maps, k);
  }
}

/**
 * Load fonts, decode image assets and load reflection maps used by the project's titles (await
 * before exports): image sources (2D, and 3D ones, whose trace and face image read this cache),
 * image fills and custom patterns — including the custom patterns of 3D materials, which share
 * this image cache.
 */
export async function preloadTitle2D(project: Project): Promise<void> {
  const jobs: Promise<unknown>[] = [];
  const images = new Set<string>();
  const maps = new Set<ReflectionMap2D>();
  for (const l of project.layers) {
    if (l.kind === 'title2d' && l.source.kind === 'text') jobs.push(ensureFont(l.source.fontId));
    if ((l.kind === 'title2d' || l.kind === 'title3d') && l.source.kind === 'image') images.add(l.source.assetId);
    collectImageAssets(l, images, maps);
  }
  for (const id of images) jobs.push(decodeImage(id));
  for (const map of maps) jobs.push(loadReflectionMap(map));
  await Promise.all(jobs);
}

// ---------- GPU programs (masks, かすれ, spans, placement; shading is the MaterialPass's) ----------

interface Programs {
  copyMask: THREE.ShaderMaterial;
  copyPicture: THREE.ShaderMaterial;
  union: THREE.ShaderMaterial;
  grow: THREE.ShaderMaterial;
  nearest: THREE.ShaderMaterial;
  erode: THREE.ShaderMaterial;
  keep: THREE.ShaderMaterial;
  place: THREE.ShaderMaterial;
}

function makePrograms(kit: PassKit): Programs {
  const union = kit.shader({ uniforms: { tSrc: { value: null } }, fragmentShader: MASK_UNION_FRAG, blending: THREE.CustomBlending });
  union.blendEquation = THREE.MaxEquation;
  union.blendEquationAlpha = THREE.MaxEquation;
  return {
    copyMask: kit.shader({ uniforms: { tSrc: { value: null } }, fragmentShader: MASK_COPY_FRAG }),
    copyPicture: kit.shader({ uniforms: { tSrc: { value: null } }, fragmentShader: PICTURE_COPY_FRAG }),
    union,
    keep: kit.shader({ uniforms: { tSrc: { value: null }, tKeep: { value: null } }, fragmentShader: MASK_KEEP_FRAG }),
    erode: kit.shader({
      uniforms: {
        tUnion: { value: null },
        tSdf: { value: null },
        uDir: { value: new THREE.Vector2(1, 0) },
        uAmount: { value: 0 },
        uEdgePx: { value: 1 },
        uLenPx: { value: 1 },
        uLanePx: { value: 1 },
        uSeed: { value: new THREE.Vector2() },
        uOrigin: { value: new THREE.Vector2() },
      },
      fragmentShader: ERODE_FRAG,
    }),
    grow: kit.shader({
      uniforms: { tSdf: { value: null }, uGrow: { value: 0 }, uOffset: { value: new THREE.Vector2() } },
      fragmentShader: GROW_FRAG,
    }),
    nearest: kit.shader({
      uniforms: { tGlyphs: { value: null }, uCount: { value: 0 }, uFrameMin: { value: new THREE.Vector2() }, uM: { value: 1 } },
      fragmentShader: NEAREST_GLYPH_FRAG,
    }),
    place: kit.shader({
      uniforms: {
        tStack: { value: null },
        uTarget: { value: new THREE.Vector2() },
        uComp: { value: new THREE.Vector2() },
        uPos: { value: new THREE.Vector2() },
        uRot: { value: new THREE.Vector2(1, 0) },
        uScale: { value: 1 },
        uFlip: { value: new THREE.Vector2(1, 1) },
        uFrameMin: { value: new THREE.Vector2() },
        uFrameSize: { value: new THREE.Vector2(1, 1) },
        uTaps: { value: 1 },
      },
      fragmentShader: PLACE_FRAG,
    }),
  };
}

// ---------- elements ----------

interface ElementSpec {
  id: string; // 'face', 'face:<first glyph>' (per-character face groups) or rim id
  grow: number; // layer units (cumulative)
  join: CanvasLineJoin;
  fillCounters: boolean;
  dx: number; // layer units, y-up
  dy: number;
  material: Material2D;
  /** Rim band width (layer units): shape-burst fills run across it; 0 for face elements. */
  band: number;
  /** Face split by per-character overrides: indices into the path geometry's groups; null = all. */
  groups: number[] | null;
  /** Plate base outline the element grows from (plateBaseCmds); null = the source outline itself. */
  base: PathCmd[] | null;
  /** Bounds of the base outline (layer units, before grow / offset). */
  baseBounds: Bounds;
  /** Image sources, contour plates: closing radius (layer units) applied through the SDF. */
  close: number;
  /** Face elements: knockout punches them through the rims. */
  face: boolean;
  /** Export part split (TitleStyle2D.hideFace): mask only, for the knockout; never shaded. */
  hidden: boolean;
}

// Plate bases are memoized by plateBaseCmds, so their identity names them in cache keys.
const baseIds = new WeakMap<PathCmd[], number>();
const baseGroups = new WeakMap<PathCmd[], FillGroup>();
const baseBoundsCache = new WeakMap<PathCmd[], Bounds>();
let nextBaseId = 1;

function baseId(base: PathCmd[]): number {
  let id = baseIds.get(base);
  if (id === undefined) baseIds.set(base, (id = nextBaseId++));
  return id;
}

function baseBounds(base: PathCmd[]): Bounds {
  let b = baseBoundsCache.get(base);
  if (!b) baseBoundsCache.set(base, (b = cmdsBounds(base)));
  return b;
}

function baseGroup(base: PathCmd[]): FillGroup {
  let g = baseGroups.get(base);
  if (!g) baseGroups.set(base, (g = fillGroup(base, 'nonzero')));
  return g;
}

/** The base outline a rim grows from, as ElementSpec fields. */
function plateFor(geom: Geometry, plate: PlateShape, size: number): Pick<ElementSpec, 'base' | 'baseBounds' | 'close'> {
  if (geom.kind === 'path') {
    const base = plateBaseCmds(geom.cmds, plate, size, geom.shear);
    return base === geom.cmds ? { base: null, baseBounds: geom.bounds, close: 0 } : { base, baseBounds: baseBounds(base), close: 0 };
  }
  // Image sources: the closing runs on the alpha's SDF (it never leaves the hull, so the bounds hold).
  if (plate.kind === 'contour') return { base: null, baseBounds: geom.bounds, close: (Math.max(0, plate.close) * size) / 100 };
  const base = plateBaseCmds(geom.hull, plate, size, 0);
  return { base, baseBounds: baseBounds(base), close: 0 };
}

/**
 * An element's caches: its mask, and under かすれ the eroded coverage, which becomes the
 * MaterialSlot `shape` (`mask`, or `eroded` under かすれ) everything shaded derives from.
 */
interface Slot extends MaterialSlot {
  maskKey: string;
  mask: THREE.WebGLRenderTarget | null;
  /** かすれ: the mask × the layer's keep-mask; keyed by maskKey + keep-mask generation. */
  erodedKey: string;
  eroded: THREE.WebGLRenderTarget | null;
  /** Image face showing its own picture (ownPicture): the face drawing in colour (RGBA8); keyed by maskKey. */
  pictureKey: string;
  picture: THREE.WebGLRenderTarget | null;
}

const emptySlot = (): Slot => ({
  ...emptyMaterialSlot(),
  maskKey: '',
  mask: null,
  erodedKey: '',
  eroded: null,
  pictureKey: '',
  picture: null,
});

function disposeSlot(s: Slot) {
  disposeMaterialSlot(s);
  s.mask?.dispose();
  s.eroded?.dispose();
  s.picture?.dispose();
}

/** Gradient span lookup for a fill: 0 = element bounds, 1 = glyph ink box, 2 = line box. */
function spanMode(fill: Fill, geom: Geometry): 0 | 1 | 2 {
  if (fill.kind === 'solid' || fill.kind === 'shapeBurst' || fill.span === 'layer') return 0;
  if (geom.kind !== 'path' || !geom.spans) return 0;
  return fill.span === 'char' ? 1 : 2;
}

/**
 * An image source's face shows the picture itself (the plain image look): its fill is an image
 * fill of the source's own asset placed exactly over it (scale 1, no offset or turn). The face
 * then takes its colour from the same drawing as its mask, texel for texel, so the layer renders
 * as the image (filtering a straight-alpha fill texture would square the edge alpha and pull in
 * the colour of transparent pixels).
 */
function ownPicture(fill: Fill, assetId: string | null): boolean {
  const im = fill.image;
  return fill.kind === 'image' && !!im && im.assetId === assetId && im.scale === 1 && im.offsetX === 0 && im.offsetY === 0 && im.rotate === 0;
}

/** A shaded stack (frame-sized, premultiplied linear) and the key of what it shows. */
interface StackCache {
  rt: THREE.WebGLRenderTarget | null;
  key: string;
}

interface Frame {
  x0: number; // layer units
  y0: number;
  x1: number;
  y1: number;
  m: number; // mask px per layer unit
  w: number; // px
  h: number;
  key: string;
}

class Title2DRenderer implements LayerRenderer {
  private progs: Programs | null = null;
  private pass: MaterialPass | null = null;
  private kit: PassKit | null = null;
  private geomKey = '';
  /** Asset of the image source being rendered (ownPicture), else null. */
  private imageAsset: string | null = null;
  private geom: Geometry | null = null;
  private readonly slots = new Map<string, Slot>();
  /** Slot ids used by the current render; the rest are freed after it. */
  private live = new Set<string>();
  /** The full render's stack. */
  private readonly fullStack: StackCache = { rt: null, key: '' };
  /**
   * Part renders' stacks (ctx.parts) by parts list, least recently used first. Kept apart from
   * the full render's, so the engine's part renders (one per contiguous run of parts each
   * frame) and full renders never evict each other's stack. Masks, SDFs and height fields are
   * per element and identical in both, so they share the slots.
   */
  private readonly partStacks = new Map<string, StackCache>();
  private canvas: OffscreenCanvas | null = null;
  private canvasTex: THREE.CanvasTexture | null = null;
  /** Fill.span: glyph boxes (N × 2 RGBA32F, keyed by geometry) and nearest-glyph index map. */
  private glyphTex: THREE.DataTexture | null = null;
  private glyphKey = '';
  private spanIdx: THREE.WebGLRenderTarget | null = null;
  private spanKey = '';
  /** かすれ keep-mask (R8) shared by every element; keyed by the union SDF + erode params. */
  private erodeRT: THREE.WebGLRenderTarget | null = null;
  private erodeKey = '';
  /** Bumped whenever erodeRT is redrawn: names its content in the eroded masks' keys. */
  private erodeGen = 0;

  render(layer: Layer, ctx: LayerRenderContext, target: THREE.WebGLRenderTarget): void {
    const { kit } = ctx;
    if (layer.kind !== 'title2d') {
      kit.clear(target);
      return;
    }
    if (this.kit !== kit) {
      this.disposePrograms();
      this.kit = kit;
      this.progs = makePrograms(kit);
      this.pass = new MaterialPass(kit);
    }
    const progs = this.progs!;
    const t = layer.transform;

    // Geometry
    const gk = geometryKey(layer);
    if (gk !== this.geomKey) {
      this.geomKey = gk;
      this.geom = buildGeometry(layer);
    }
    const geom = this.geom;
    this.imageAsset = layer.source.kind === 'image' ? layer.source.assetId : null;
    const size = layer.source.size;
    const elements = geom ? this.elementSpecs(layer, geom, size) : [];
    if (!geom || elements.length === 0 || !(t.scale > 0)) {
      kit.clear(target);
      return;
    }
    // Part render (ctx.parts): which elements are shaded; null = every visible one (full render).
    // Per-character face groups are all the face part.
    const parts = ctx.parts;
    const drawn = parts ? elements.map((el) => !el.hidden && parts.includes(el.face ? 'face' : rimKey(el.id))) : null;
    if (drawn && !drawn.includes(true)) {
      kit.clear(target);
      return;
    }
    if (!parts && this.partStacks.size && !hasPartEffects(layer)) this.disposePartStacks();
    // The frame always encloses every element, so a part render lines up with the full one.
    const comp = ctx.project.comp;
    // Image sources: the output pixel grid in layer space (unrotated layers; a flip mirrors the
    // grid onto itself), so a picture at its own resolution maps texel for pixel instead of being
    // resampled half a pixel off.
    const fx = t.flipX ? -1 : 1;
    const fy = t.flipY ? -1 : 1;
    const grid = geom.kind === 'image' && t.rotZ % 360 === 0 ? { x: (fx * (-comp.width / 2 - t.x)) / t.scale, y: (fy * (-comp.height / 2 - t.y)) / t.scale, m: (t.scale * ctx.width) / comp.width } : null;
    const frame = this.frameFor(geom, elements, t.scale * Math.max(ctx.pxScale, 1), ctx.renderer, grid);
    const { knockout, erode } = layer.style;
    const unit = (frame.m * size) / 100; // mask px per 1 % of size

    // Masks first, of every element even in a part render: rims grow cumulatively, かすれ builds
    // its keep-mask from their union and knockout punches the faces, so a part render cuts and
    // shapes its elements exactly like the full render. Everything shaded below (SDFs, height
    // fields, shape bursts, satin blurs) derives from the eroded coverage.
    this.live = new Set<string>();
    const slots = elements.map((el) => {
      const slot = this.slot(el.id);
      this.updateMask(slot, el, geom, frame);
      return slot;
    });
    const eroding = erode.enabled && erode.amount > 0 && erode.edge > 0;
    if (eroding) this.updateErode(elements, erode, unit, frame);

    const stackParts: string[] = [frame.key, `${t.rotZ},${t.flipX},${t.flipY}`, JSON.stringify(comp.globalLight), String(knockout)];
    if (parts) stackParts.push(parts.join(','));
    let needSpan = false;
    elements.forEach((el, i) => {
      const slot = slots[i];
      if (drawn && !drawn[i]) {
        // Not shaded in this part render; a face still punches the drawn rims under knockout.
        if (!(el.face && knockout)) return;
        this.updateShape(slot, eroding, frame);
        stackParts.push(slot.shapeKey, 'punch');
        return;
      }
      this.updateShape(slot, eroding, frame);
      stackParts.push(slot.shapeKey, String(el.hidden));
      if (el.hidden) return;
      const mat = el.material;
      if (el.face && geom.kind === 'image' && ownPicture(mat.fill, this.imageAsset)) this.updatePicture(slot, geom, frame);
      this.pass!.prepare(slot, mat, unit, frame, el.band * frame.m);
      needSpan ||= spanMode(mat.fill, geom) > 0;
      // Images that finish decoding change the look without changing the material.
      const fillImg = fillBitmap(mat.fill) ? 1 : 0;
      const patImg = mat.pattern.kind === 'custom' && mat.pattern.assetId && getBitmap(mat.pattern.assetId) ? 1 : 0;
      stackParts.push(JSON.stringify(mat), `${fillImg}${patImg}`);
    });
    if (needSpan && geom.kind === 'path') this.updateSpanMap(geom, frame);
    for (const [id, slot] of this.slots) {
      if (this.live.has(id)) continue;
      disposeSlot(slot);
      this.slots.delete(id);
    }

    // Shade the stack (back to front: outermost rim … face, the order of layerParts). Knockout
    // first erases what the rims drew under each face, which then draws at its own fill opacity.
    const stack = parts ? this.partStack(parts, layer) : this.fullStack;
    const stackKey = stackParts.join('#');
    if (stackKey !== stack.key || !stack.rt) {
      const rt = (stack.rt = sized(stack.rt, frame.w, frame.h, THREE.RGBAFormat, THREE.HalfFloatType, true));
      kit.clear(rt);
      for (let i = elements.length - 1; i >= 0; i--) {
        const el = elements[i];
        const slot = this.slots.get(el.id)!;
        if (el.face && knockout) this.pass!.punch(slot, rt);
        if (drawn ? drawn[i] : !el.hidden) this.shade(el, slot, frame, size, t, comp, rt);
      }
      stack.key = stackKey;
    }

    // Place into the comp.
    const pu = progs.place.uniforms;
    pu.tStack.value = stack.rt.texture;
    (pu.uTarget.value as THREE.Vector2).set(ctx.width, ctx.height);
    (pu.uComp.value as THREE.Vector2).set(comp.width, comp.height);
    (pu.uPos.value as THREE.Vector2).set(t.x, t.y);
    (pu.uRot.value as THREE.Vector2).set(Math.cos(t.rotZ * DEG), Math.sin(t.rotZ * DEG));
    pu.uScale.value = t.scale;
    (pu.uFlip.value as THREE.Vector2).set(fx, fy);
    (pu.uFrameMin.value as THREE.Vector2).set(frame.x0, frame.y0);
    (pu.uFrameSize.value as THREE.Vector2).set(frame.x1 - frame.x0, frame.y1 - frame.y0);
    const ratio = frame.m / (t.scale * (ctx.width / comp.width)); // mask px per target px
    pu.uTaps.value = Math.min(4, Math.max(1, Math.ceil(ratio - 0.01)));
    kit.run(progs.place, target);
  }

  /**
   * The stack cache of part render `parts`, made most recently used. The engine renders a
   * frame's runs of parts, which partition the layer's parts, so keeping one stack per part
   * holds a whole frame; older sets are freed.
   */
  private partStack(parts: readonly PartKey[], layer: Title2DLayer): StackCache {
    const id = parts.join(',');
    const stack = this.partStacks.get(id) ?? { rt: null, key: '' };
    this.partStacks.delete(id);
    this.partStacks.set(id, stack);
    const cap = Math.max(1, layerParts(layer).length);
    for (const [k, old] of this.partStacks) {
      if (this.partStacks.size <= cap) break;
      old.rt?.dispose();
      this.partStacks.delete(k);
    }
    return stack;
  }

  private disposePartStacks() {
    for (const s of this.partStacks.values()) s.rt?.dispose();
    this.partStacks.clear();
  }

  /** The slot for `id`, created on first use and kept alive through this render. */
  private slot(id: string): Slot {
    this.live.add(id);
    let slot = this.slots.get(id);
    if (!slot) this.slots.set(id, (slot = emptySlot()));
    return slot;
  }

  private elementSpecs(layer: Title2DLayer, geom: Geometry, size: number): ElementSpec[] {
    const k = size / 100;
    const style = layer.style;
    // A hidden face (export part split) still knocks its area out of the rims.
    const faces = this.faceSpecs(layer, geom);
    const out: ElementSpec[] = !style.hideFace ? faces : style.knockout ? faces.map((f) => ({ ...f, hidden: true })) : [];
    let grow = 0;
    for (const rim of style.rims) {
      if (!rim.enabled || !(rim.width > 0)) continue;
      grow += rim.width * k;
      out.push({
        id: rim.id,
        grow,
        join: rim.join,
        fillCounters: rim.fillCounters,
        dx: rim.offsetX * k,
        dy: -rim.offsetY * k,
        material: rim.material,
        band: rim.width * k,
        groups: null,
        ...plateFor(geom, rim.plate, size),
        face: false,
        hidden: false,
      });
    }
    return out;
  }

  /**
   * The face, split into one element per distinct material when text characters carry a
   * face override (激 red / アツ gold); glyphs without one use the layer face.
   */
  private faceSpecs(layer: Title2DLayer, geom: Geometry): ElementSpec[] {
    const face = layer.style.face;
    const whole: ElementSpec = {
      id: 'face',
      grow: 0,
      join: 'miter',
      fillCounters: false,
      dx: 0,
      dy: 0,
      material: face,
      band: 0,
      groups: null,
      base: null,
      baseBounds: geom.bounds,
      close: 0,
      face: true,
      hidden: false,
    };
    const src = layer.source;
    if (src.kind !== 'text' || geom.kind !== 'path' || !geom.chars) return [whole];
    const chars = geom.chars;
    if (!chars.some((ci) => src.chars[ci]?.face)) return [whole];
    const byMaterial = new Map<string, ElementSpec>();
    const faceKey = JSON.stringify(face);
    chars.forEach((ci, gi) => {
      const mat = src.chars[ci]?.face ?? face;
      const key = mat === face ? faceKey : JSON.stringify(mat);
      const el = byMaterial.get(key);
      if (el) el.groups!.push(gi);
      else byMaterial.set(key, { ...whole, id: `face:${ci}`, material: mat, groups: [gi] });
    });
    if (byMaterial.size === 1) return [{ ...whole, material: byMaterial.values().next().value!.material }];
    return [...byMaterial.values()];
  }

  /**
   * The mask frame around `els`, `mWanted` px per layer unit within the GPU limits. With `grid`
   * (a corner of the output pixel grid in layer units, and its px per unit) and a frame of the
   * same resolution, the frame's pixels sit exactly on the output's.
   */
  private frameFor(geom: Geometry, els: ElementSpec[], mWanted: number, renderer: THREE.WebGLRenderer, grid: { x: number; y: number; m: number } | null): Frame {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    const strokePad = geom.kind === 'path' ? Math.max(0, ...geom.strokes.map((s) => (s.width / 2) * (MITER_LIMIT - 1))) : 0;
    for (const el of els) {
      const b = el.baseBounds;
      const pathed = geom.kind === 'path' || el.base !== null;
      // Image closing first grows the alpha by `close`: that must fit in the frame to shrink back.
      const reach = Math.max(el.grow, el.close);
      const pad = (el.join === 'miter' && pathed ? el.grow * MITER_LIMIT : reach) + (el.base ? 0 : strokePad);
      x0 = Math.min(x0, b.x0 - pad + el.dx);
      y0 = Math.min(y0, b.y0 - pad + el.dy);
      x1 = Math.max(x1, b.x1 + pad + el.dx);
      y1 = Math.max(y1, b.y1 + pad + el.dy);
    }
    const fw = Math.max(x1 - x0, 1e-3);
    const fh = Math.max(y1 - y0, 1e-3);
    const maxSide = Math.min(MAX_SIDE, renderer.capabilities.maxTextureSize);
    let m = mWanted;
    const margin = 3; // px each side
    m = Math.min(m, (maxSide - 2 * margin) / fw, (maxSide - 2 * margin) / fh);
    if ((fw * m + 2 * margin) * (fh * m + 2 * margin) > MAX_PIXELS) m = Math.sqrt(MAX_PIXELS / ((fw + 1) * (fh + 1))) * 0.98;
    const w = Math.ceil(fw * m) + 2 * margin;
    const h = Math.ceil(fh * m) + 2 * margin;
    // Expand to whole pixels symmetrically, or onto the output grid (a shift of at most half a
    // pixel, well inside the margin).
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const onGrid = !!grid && Math.abs(m - grid.m) <= 1e-9 * m;
    const fx0 = onGrid ? grid.x + Math.round((cx - w / m / 2 - grid.x) * m) / m : cx - w / m / 2;
    const fy0 = onGrid ? grid.y + Math.round((cy - h / m / 2 - grid.y) * m) / m : cy - h / m / 2;
    const f = { x0: fx0, y0: fy0, x1: fx0 + w / m, y1: fy0 + h / m, m, w, h };
    return { ...f, key: `${f.x0},${f.y0},${w},${h},${m}` };
  }

  // ---------- masks ----------

  private scratch(w: number, h: number) {
    if (!this.canvas || this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas = new OffscreenCanvas(w, h);
      this.canvasTex?.dispose();
      this.canvasTex = new THREE.CanvasTexture(this.canvas as unknown as HTMLCanvasElement);
      this.canvasTex.flipY = true;
      this.canvasTex.premultiplyAlpha = false;
      this.canvasTex.generateMipmaps = false;
      this.canvasTex.minFilter = THREE.NearestFilter;
      this.canvasTex.magFilter = THREE.NearestFilter;
    }
    // CPU-backed: rim masks are read back for the pocket flood fill.
    const c2d = this.canvas.getContext('2d', { willReadFrequently: true })!;
    c2d.setTransform(1, 0, 0, 1, 0, 0);
    c2d.clearRect(0, 0, w, h);
    return c2d;
  }

  private uploadScratch(slot: Slot, frame: Frame) {
    const progs = this.progs!;
    this.canvasTex!.needsUpdate = true;
    slot.mask = sized(slot.mask, frame.w, frame.h, THREE.RedFormat, THREE.UnsignedByteType);
    progs.copyMask.uniforms.tSrc.value = this.canvasTex;
    this.kit!.run(progs.copyMask, slot.mask);
  }

  private updateMask(slot: Slot, el: ElementSpec, geom: Geometry, frame: Frame) {
    const base = el.base ? `b${baseId(el.base)}` : `c${el.close}`;
    const key = `${this.geomKey}|${frame.key}|${el.grow}|${el.join}|${el.fillCounters}|${el.dx}|${el.dy}|${el.groups?.join(',') ?? '*'}|${base}`;
    if (geom.kind === 'image' && !el.base && el.grow > 0) {
      // Keep the image base SDFs this rim grows from, so the next width change reuses them.
      const id = el.fillCounters ? '#img-filled' : '#img-face';
      this.live.add(id);
      if (el.close > 0) this.live.add(`${id}:close`);
    }
    if (slot.maskKey === key && slot.mask) return;
    if (geom.kind === 'path' || el.base) {
      const c = this.scratch(frame.w, frame.h);
      const m = frame.m;
      // Layer y-up → canvas y-down.
      c.setTransform(m, 0, 0, -m, (-frame.x0 + el.dx) * m, (frame.y1 - el.dy) * m);
      c.fillStyle = '#fff';
      c.strokeStyle = '#fff';
      c.lineJoin = el.join;
      c.miterLimit = MITER_LIMIT;
      const groups = el.base ? [baseGroup(el.base)] : geom.kind !== 'path' ? [] : el.groups ? el.groups.map((i) => geom.groups[i]) : geom.groups;
      for (const g of groups) {
        const p = el.fillCounters ? g.outer : g.all;
        c.fill(p, el.fillCounters ? 'nonzero' : g.rule);
        if (el.grow > 0) {
          c.lineWidth = el.grow * 2;
          c.stroke(p);
        }
      }
      // A plate base already encloses the SVG strokes.
      if (!el.base && geom.kind === 'path') {
        for (const s of geom.strokes) {
          c.lineWidth = s.width + el.grow * 2;
          c.lineJoin = el.grow > 0 ? el.join : s.join;
          c.lineCap = s.cap;
          c.stroke(s.path);
        }
      }
      if (el.fillCounters && el.grow > 0) {
        // Gaps between glyphs that the grown outline closes off become solid plate too.
        c.setTransform(1, 0, 0, 1, 0, 0);
        const img = c.getImageData(0, 0, frame.w, frame.h);
        floodFillCounters(img);
        c.putImageData(img, 0, 0);
      }
      this.uploadScratch(slot, frame);
    } else if (el.grow === 0) {
      this.drawImage(geom, frame);
      this.uploadScratch(slot, frame);
    } else {
      // Image rim: grow the (optionally counter-filled, optionally closed) face through its SDF.
      const src = this.imageBase(geom, frame, el.fillCounters, el.close);
      const progs = this.progs!;
      slot.mask = sized(slot.mask, frame.w, frame.h, THREE.RedFormat, THREE.UnsignedByteType);
      progs.grow.uniforms.tSdf.value = src.sdf.texture;
      progs.grow.uniforms.uGrow.value = el.grow * frame.m - src.shrink;
      (progs.grow.uniforms.uOffset.value as THREE.Vector2).set(el.dx * frame.m, el.dy * frame.m);
      this.kit!.run(progs.grow, slot.mask);
    }
    slot.maskKey = key;
    slot.sdfKey = '';
    slot.heightKey = '';
  }

  private drawImage(geom: Extract<Geometry, { kind: 'image' }>, frame: Frame) {
    const c = this.scratch(frame.w, frame.h);
    const m = frame.m;
    const b = geom.bounds;
    c.imageSmoothingQuality = 'high';
    c.drawImage(geom.bitmap, (b.x0 - frame.x0) * m, (frame.y1 - b.y1) * m, (b.x1 - b.x0) * m, (b.y1 - b.y0) * m);
    return c;
  }

  /** The face drawing in colour (ownPicture), from the same draw as its mask; after updateMask. */
  private updatePicture(slot: Slot, geom: Extract<Geometry, { kind: 'image' }>, frame: Frame) {
    if (slot.picture && slot.pictureKey === slot.maskKey) return;
    this.drawImage(geom, frame);
    this.canvasTex!.needsUpdate = true;
    slot.picture = sized(slot.picture, frame.w, frame.h, THREE.RGBAFormat, THREE.UnsignedByteType);
    const prog = this.progs!.copyPicture;
    prog.uniforms.tSrc.value = this.canvasTex;
    this.kit!.run(prog, slot.picture);
    slot.pictureKey = slot.maskKey;
  }

  /**
   * SDF an image rim grows from, cached in hidden slots: the face (counters flood-filled when
   * asked); with `close` > 0, that face grown by close, whose SDF the caller thresholds at
   * grow − close (`shrink` px), which is the closing grown by the rim (morphological closing).
   */
  private imageBase(geom: Extract<Geometry, { kind: 'image' }>, frame: Frame, filled: boolean, close: number) {
    const id = filled ? '#img-filled' : '#img-face';
    const slot = this.slot(id);
    const key = `${this.geomKey}|${frame.key}|${filled}`;
    if (slot.maskKey !== key || !slot.mask) {
      const c = this.drawImage(geom, frame);
      if (filled) {
        const img = c.getImageData(0, 0, frame.w, frame.h);
        floodFillCounters(img);
        c.putImageData(img, 0, 0);
      }
      this.uploadScratch(slot, frame);
      slot.maskKey = key;
      slot.sdfKey = '';
    }
    this.pass!.updateSdf(slot, slot.mask!, key, frame);
    const r = close * frame.m;
    if (!(r > 0)) return { sdf: slot.sdf!, shrink: 0 };
    const grown = this.slot(`${id}:close`);
    const gkey = `${key}|${r}`;
    if (grown.maskKey !== gkey || !grown.mask) {
      const progs = this.progs!;
      grown.mask = sized(grown.mask, frame.w, frame.h, THREE.RedFormat, THREE.UnsignedByteType);
      progs.grow.uniforms.tSdf.value = slot.sdf!.texture;
      progs.grow.uniforms.uGrow.value = r;
      (progs.grow.uniforms.uOffset.value as THREE.Vector2).set(0, 0);
      this.kit!.run(progs.grow, grown.mask);
      grown.maskKey = gkey;
      grown.sdfKey = '';
    }
    this.pass!.updateSdf(grown, grown.mask!, gkey, frame);
    return { sdf: grown.sdf!, shrink: r };
  }

  /**
   * かすれ: union of every element's mask (MAX blend) → its SDF → the dry-brush keep-mask
   * (ERODE_FRAG). Streak coordinates are anchored to the layer origin in layer units, so the
   * mask holds still when the frame grows and matches between preview and export scales.
   */
  private updateErode(elements: ElementSpec[], erode: Erode2D, unit: number, frame: Frame) {
    const kit = this.kit!;
    const progs = this.progs!;
    const union = this.slot('#union');
    const key = `${frame.key}|${elements.map((el) => this.slots.get(el.id)!.maskKey).join('&')}`;
    if (union.maskKey !== key || !union.mask) {
      union.mask = sized(union.mask, frame.w, frame.h, THREE.RedFormat, THREE.UnsignedByteType, true);
      kit.clear(union.mask);
      for (const el of elements) {
        progs.union.uniforms.tSrc.value = this.slots.get(el.id)!.mask!.texture;
        kit.run(progs.union, union.mask, false);
      }
      union.maskKey = key;
      union.sdfKey = '';
    }
    this.pass!.updateSdf(union, union.mask, key, frame);
    const ekey = `${union.sdfKey}|${erode.amount},${erode.edge},${erode.scale},${erode.angle},${erode.seed}|${unit}`;
    if (this.erodeKey === ekey && this.erodeRT) return;
    this.erodeRT = sized(this.erodeRT, frame.w, frame.h, THREE.RedFormat, THREE.UnsignedByteType);
    const u = progs.erode.uniforms;
    u.tUnion.value = union.mask.texture;
    u.tSdf.value = union.sdf!.texture;
    // angle: clockwise on screen, 0 = horizontal drag → y-up vector.
    (u.uDir.value as THREE.Vector2).set(Math.cos(erode.angle * DEG), -Math.sin(erode.angle * DEG));
    u.uAmount.value = Math.min(1, Math.max(0, erode.amount));
    u.uEdgePx.value = Math.max(0.5, erode.edge * unit);
    u.uLenPx.value = Math.max(1, erode.scale * unit);
    // Bristle lanes ≈ 0.6 % of the size wide.
    u.uLanePx.value = Math.max(0.5, unit * 0.6);
    (u.uSeed.value as THREE.Vector2).set((erode.seed * 37.31) % 997, (erode.seed * 17.73) % 991);
    (u.uOrigin.value as THREE.Vector2).set(frame.x0 * frame.m, frame.y0 * frame.m);
    kit.run(progs.erode, this.erodeRT);
    this.erodeKey = ekey;
    this.erodeGen++;
  }

  /**
   * The coverage an element is shaded from: its mask, or under かすれ the mask × the keep-mask
   * (redrawn only when either changes), so its SDF, bevel, inner glow, satin and shape burst
   * all follow the cut edges and every streak gets a lit edge of its own.
   */
  private updateShape(slot: Slot, eroding: boolean, frame: Frame) {
    if (!eroding) {
      slot.eroded?.dispose();
      slot.eroded = null;
      slot.erodedKey = '';
      slot.shape = slot.mask;
      slot.shapeKey = slot.maskKey;
      return;
    }
    // `~` keeps the key from extending the bare maskKey with `|` (satin keys are `<shape>|<σ>`).
    const key = `${slot.maskKey}~k${this.erodeGen}`;
    if (slot.erodedKey !== key || !slot.eroded) {
      const keep = this.progs!.keep;
      slot.eroded = sized(slot.eroded, frame.w, frame.h, THREE.RedFormat, THREE.UnsignedByteType);
      keep.uniforms.tSrc.value = slot.mask!.texture;
      keep.uniforms.tKeep.value = this.erodeRT!.texture;
      this.kit!.run(keep, slot.eroded);
      slot.erodedKey = key;
    }
    slot.shape = slot.eroded;
    slot.shapeKey = key;
  }

  /** Glyph box table (per geometry) and the nearest-glyph index map (per geometry + frame). */
  private updateSpanMap(geom: Extract<Geometry, { kind: 'path' }>, frame: Frame) {
    const spans = geom.spans!;
    const n = spans.char.length;
    if (this.glyphKey !== this.geomKey || !this.glyphTex) {
      const data = new Float32Array(n * 2 * 4);
      const put = (b: Bounds, i: number) => data.set([b.x0, b.y0, b.x1, b.y1], i * 4);
      spans.char.forEach((b, i) => put(b, i));
      spans.line.forEach((b, i) => put(b, n + i));
      this.glyphTex?.dispose();
      this.glyphTex = new THREE.DataTexture(data, n, 2, THREE.RGBAFormat, THREE.FloatType);
      this.glyphTex.colorSpace = THREE.NoColorSpace;
      this.glyphTex.minFilter = THREE.NearestFilter;
      this.glyphTex.magFilter = THREE.NearestFilter;
      this.glyphTex.needsUpdate = true;
      this.glyphKey = this.geomKey;
      this.spanKey = '';
    }
    const key = `${this.geomKey}|${frame.key}`;
    if (this.spanKey === key && this.spanIdx) return;
    const nu = this.progs!.nearest.uniforms;
    this.spanIdx = sized(this.spanIdx, frame.w, frame.h, THREE.RedFormat, THREE.FloatType);
    nu.tGlyphs.value = this.glyphTex;
    nu.uCount.value = n;
    (nu.uFrameMin.value as THREE.Vector2).set(frame.x0, frame.y0);
    nu.uM.value = frame.m;
    this.kit!.run(this.progs!.nearest, this.spanIdx);
    this.spanKey = key;
  }

  // ---------- shading ----------

  /** `place`: the layer's transform, whose rotZ / flip the screen-fixed lights undo. */
  private shade(el: ElementSpec, slot: Slot, frame: Frame, size: number, place: Transform, comp: Comp, stack: THREE.WebGLRenderTarget) {
    const mat = el.material;
    const m = frame.m;
    // Element bounds in frame px (y-up): its base outline grown by `grow`, shifted.
    const gb: Bounds = el.baseBounds;
    const mode = spanMode(mat.fill, this.geom!);
    const picture = el.face && !!slot.picture && slot.pictureKey === slot.maskKey && ownPicture(mat.fill, this.imageAsset);
    this.pass!.shade(
      {
        mat,
        slot,
        unit: (m * size) / 100,
        size,
        m,
        // Pattern anchored to the layer origin, moving with a rim's offset; textures to the layer.
        patternOrigin: { x: frame.x0 - el.dx, y: frame.y0 - el.dy },
        textureOrigin: { x: frame.x0, y: frame.y0 },
        box: {
          x0: (gb.x0 - el.grow + el.dx - frame.x0) * m,
          y0: (gb.y0 - el.grow + el.dy - frame.y0) * m,
          x1: (gb.x1 + el.grow + el.dx - frame.x0) * m,
          y1: (gb.y1 + el.grow + el.dy - frame.y0) * m,
        },
        bandPx: el.band * m,
        span: mode
          ? { mode, idx: this.spanIdx!.texture, glyphs: this.glyphTex!, frameMin: { x: frame.x0, y: frame.y0 }, m, offset: { x: el.dx * m, y: el.dy * m }, grow: el.grow * m }
          : null,
        picture: picture ? slot.picture!.texture : null,
        pictureLinear: false,
        place,
        comp,
      },
      stack,
    );
  }

  private disposePrograms() {
    if (!this.progs) return;
    for (const p of Object.values(this.progs)) p.dispose();
    this.progs = null;
    this.pass?.dispose();
    this.pass = null;
  }

  dispose(): void {
    this.disposePrograms();
    for (const s of this.slots.values()) disposeSlot(s);
    this.slots.clear();
    this.fullStack.rt?.dispose();
    this.fullStack.rt = null;
    this.fullStack.key = '';
    this.disposePartStacks();
    this.canvasTex?.dispose();
    this.canvasTex = null;
    this.canvas = null;
    this.glyphTex?.dispose();
    this.glyphTex = null;
    this.glyphKey = '';
    this.spanIdx?.dispose();
    this.spanIdx = null;
    this.spanKey = '';
    this.erodeRT?.dispose();
    this.erodeRT = null;
    this.erodeKey = '';
  }
}

/** Fill every transparent region not connected to the image border (counters). */
function floodFillCounters(img: ImageData) {
  const { width: w, height: h, data } = img;
  const outside = new Uint8Array(w * h);
  const stack: number[] = [];
  const push = (i: number) => {
    if (!outside[i] && data[i * 4 + 3] < 128) {
      outside[i] = 1;
      stack.push(i);
    }
  };
  for (let x = 0; x < w; x++) {
    push(x);
    push((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    push(y * w);
    push(y * w + w - 1);
  }
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % w;
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (i >= w) push(i - w);
    if (i < w * (h - 1)) push(i + w);
  }
  for (let i = 0; i < w * h; i++) if (!outside[i]) data[i * 4 + 3] = 255;
}

export function createTitle2DRenderer(): LayerRenderer {
  return new Title2DRenderer();
}

// ---------- background ----------

class BackgroundRenderer implements LayerRenderer {
  private mat: THREE.ShaderMaterial | null = null;
  private kit: PassKit | null = null;

  render(layer: Layer, ctx: LayerRenderContext, target: THREE.WebGLRenderTarget): void {
    const { kit } = ctx;
    if (layer.kind !== 'background') {
      kit.clear(target);
      return;
    }
    if (this.kit !== kit || !this.mat) {
      this.mat?.dispose();
      this.kit = kit;
      this.mat = kit.shader({ uniforms: { ...fillUniforms(), uSize: { value: new THREE.Vector2() } }, fragmentShader: BACKGROUND_FRAG });
    }
    const u = this.mat.uniforms;
    // p runs in comp px: one target pixel = comp width / target width of them.
    setFill(u, layer.fill, ctx.project.comp.width / Math.max(1, ctx.width));
    (u.uSize.value as THREE.Vector2).set(ctx.project.comp.width, ctx.project.comp.height);
    kit.run(this.mat, target);
  }

  dispose(): void {
    this.mat?.dispose();
    this.mat = null;
  }
}

export function createBackgroundRenderer(): LayerRenderer {
  return new BackgroundRenderer();
}

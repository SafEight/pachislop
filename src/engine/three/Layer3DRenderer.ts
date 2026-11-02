import * as THREE from 'three';
import { getAsset, getFont, type AssetEntry, type FontEntry } from '../../assets/registry';
import { bandKey, plateKey } from '../../model/parts';
import { effectiveLighting, resolveEnvironment } from '../../model/lighting';
import { charSide, plateSide, sideMaterial } from '../../model/sides';
import type { Comp, Environment3D, Layer, Light3D, Material3D, PartKey, Title3DLayer } from '../../model/types';
import type { LayerRenderContext, LayerRenderer } from '../contracts';
import type { PassKit } from '../passkit';
import { AOPass } from './ao';
import { effectiveSegments } from './bevel';
import { orbGridFor } from './extrude';
import { envMapEuler } from './environment';
import { GlintPass, type GlintLight } from './glint';
import { inflateScale } from './inflate';
import { decodeImage, getBitmap } from '../layer2d/images';
import { imageFit } from '../../text/trace';
import { applyImageProjection, applyMaterial3D, createPartMaterial, edgeImageTexture, faceImageTexture, setEnvLookup, type EnvState, type ImageProjection, type PartMaterial, type PartSpace } from './materials';
import { Downsampler } from './resample';
import { buildTitle, flatShapes, hasMaterialOverride, hasRig, imageTitleShapes, shapeShapes, svgTitleShapes, textShapes, type GlyphRig, type TitleShapes } from './title';
import { compressHdrOutput, compressInto, HdrExpand, setCompressionExposure } from './hdrResolve';
import { createTonemapMaterial, TONEMAP_IDS } from './tonemap';

// Element 3D replacement (stills): extruded text / parametric shapes / SVG logos / traced
// transparent images with multi-band bevels and grown backplates, 保留 orbs, or static GLB
// models; PBR materials with env reflections, lights, a tinted shadow catcher, SSAO and
// an HDR glint pass.
//
// Lighting: environment, lights, tone mapping and exposure are the layer's effective lighting
// (model/lighting.ts: each value the layer's own, else the comp's); each part reflects the
// layer's environment with the values its material sets itself (Material3D.environment) over it.
//
// Scene graph: scene ─ lights
//                    ─ shadowCatcher (comp space, behind the layer)
//                    ─ root (layer transform: position, rotation X→Y→Z, uniform scale × flip mirror)
//                        ─ content ─ sheared (oblique-extrusion shear, Title3DProps.skew)
//                                  │    ─ main Mesh (unrigged glyphs / shape + their shared backplates)
//                                  │    ─ one Mesh per rigged glyph (CharAdjust dz / tilt) + its own backplates
//                                  ─ orb Mesh | GLB wrapper
// Every title Mesh holds all parts with one group per material slot, sharing one material array.
//
// Layer space: comp px, y-up, the text block centred on the origin, FRONT AT z = 0.
// Bevel bands sit by style3d.bevelPosition (title.ts): 'inside' is the Element 3D convention,
// where the silhouette (side walls) is EXACTLY the glyph outline, so it lines up with a 2D
// layer of the same text and counters stay open: the face is inset by the total band width and
// the bands step down (or up, for 'inset') from the face edge to the outline. 'outside' keeps
// the full glyph as the face and grows the bands outward like a stroke (the silhouette grows,
// counters narrow); 'center' is half each way. The wall runs back by `depth` from the outermost
// band edge; backplates (a base outline from src/text/plate.ts, pushed out to that edge, then
// grown) sit behind the main solid, each behind the previous one. Inflate mode replaces the
// face and bands with a puffy height field whose top is at
// z = 0 (inflate.ts). Text and shape outlines go through the layer's warp → distort → weight
// (src/text/ink.ts) before any of this, so bevel widths stay even along the bend. The orb is
// an ellipsoid filling the shape's bounds, front pole at z = 0; its backplates start at its
// equator.
//
// Oblique extrusion (skew): x += skew.x·(−z), y += skew.y·(−z) as the `sheared` group's
// matrix; three's normal matrix (inverse transpose) keeps the lighting exact. Rigged glyphs:
// p' = T(pivot + dz·ẑ) · Ry(tiltY) · Rx(tiltX) · T(−pivot), pivot = the glyph's em-cell
// centre at mid-depth of the main solid (title.ts). Both are matrices, so dragging them
// never rebuilds geometry.
//
// Rotation: rotZ is clockwise on screen (After Effects / Photoshop convention, same as the
// 2D renderer and per-character `rotate`); rotX / rotY follow three.js (right-handed, y-up).
// flipX / flipY negate the root's x / y scale: a mirror about the layer position in layer space,
// before the rotations. The lights and the shadow catcher are outside the root, so they stay put.
//
// Material slots: a block [face · bands 1..n · side (+ main back cap)] for the layer, then per
// enabled backplate: face (+ its bevel), side (+ its back cap), then one block per character
// with a 3D material override (CharAdjust face3d / bands3d / side3d, ascending char index; a
// missing override falls back to the layer's material). Sides resolve through model/sides.ts (an
// absent one follows its neighbour). The orb uses slot 0 only.
//
// Reflections: style3d.envLock looks the environment up with the layer-space normal, so a
// tilted title reflects what it reflects head-on (materials.ts).
//
// Render: MSAA HalfFloat target at `comp.supersample` × the layer resolution (premultiplied
// linear HDR; at supersample 1 the materials write compressed light and the resolve is
// expanded back, so bright edges antialias as if tone mapped per sample: hdrResolve.ts) →
// optional AO (ao.ts, multiplied in) → optional glint (glint.ts, on the HDR highlights, on
// the comp-locked grid) → tone map (adds the glint) → Mitchell downsample (resample.ts) when
// supersampled → layer target.
// A preview window (ctx.frame) draws through the camera's view offset (engine/surface.ts) at
// the whole render's supersample factor; the AO jitter, the glint grid and output lattice and
// the gems' rough-refraction blur are laid out on the whole render, so the window holds the
// whole render's pixels, but for what reaches in from past its edges (glint, AO, refraction).
//
// Part renders (ctx.parts, for per-part effects): the listed parts' slots draw colour, every
// other slot only depth (drawScene), so each part shows exactly its pixels of the full render
// and the part renders tile it. No shadow catcher there; the AO comes from the whole scene and
// the glint from the whole title's highlights, in the render that holds the face. A model is
// all face. `parts = []` draws just the catcher's matte shadow: every title material writes
// depth only (all of them still cast), so the shadow is hidden where the title hides it in the
// full render and shows under its transparent parts, and the part renders go over it.
//
// Models: when style3d.face.preset is 'custom' the GLB keeps its own materials (they get
// the layer's environment scaled by the face reflectivity); any other face preset replaces
// every model material with the face material.
// A GLB is parsed once per asset entry, asynchronously, and shared by every renderer of every
// engine (each draws its own clone with its own material copies); onModelReady fires once per
// parse and loadModel lets exports wait for it.
//
// Images: the decoded bitmap of the shared image cache (layer2d/images.ts; onImageReady
// re-renders, exports await decodeImage) is traced into an outline (src/text/trace.ts) that
// goes through the same pipeline as SVG and shapes; the layer's outline operations don't apply
// (as in 2D). style3d.faceImage projects the picture straight on over the face slots and
// style3d.edgeImage over the band and side slots, backplates never (materials.ts, header 2b),
// in the fitted box the outline was traced in.

const DEG = Math.PI / 180;
/** Shadow blur radius at softness 1, as a fraction of the title's on-screen size. */
const SHADOW_SOFT_MAX = 0.35;
/** VSM blur radius budget in shadow-map texels; softer shadows lower the map resolution instead. */
const SHADOW_BLUR_TEXELS = 10;
const SHADOW_MAP_MAX = 2048;
const SHADOW_MAP_MIN = 256;
/** Streak sources: highlight features up to about this size (% of source size) throw rays. */
const GLINT_DETAIL = 1.5;
/**
 * Most pixels a supersampled 3D render may have (≈ 1.1 GB of MSAA colour + depth): larger
 * exports lower the factor rather than exhausting GPU memory.
 */
const SUPERSAMPLE_BUDGET = 2 ** 25;
/** MSAA samples of the HDR render; supersampled renders need fewer for the same edges. */
const MSAA = 4;
const MSAA_SUPERSAMPLED = 2;

/** A parsed GLB, shared by every renderer of every engine. Never rendered itself: renderers draw clones. */
interface ModelTemplate {
  scene: THREE.Object3D; // centred on the origin
  fitSize: number; // larger bbox side in model units, measured at load (0 = not measurable)
  fitBox: THREE.Vector3; // bbox size in model units
  /** SkeletonUtils.clone: like Object3D.clone (shared geometry / materials), with skinned meshes rebound to the cloned bones. */
  clone: (o: THREE.Object3D) => THREE.Object3D;
  /** Renderers holding a clone; the shared geometry and textures are freed when none is left. */
  users: number;
}

interface ParsedModel {
  template: ModelTemplate | null; // null while parsing and after a failure
  settled: boolean;
  done: Promise<void>;
}

/** One parse per registry entry: re-registering an asset id with new data parses it again. */
const parsedModels = new WeakMap<AssetEntry, ParsedModel>();

interface ModelState {
  asset: AssetEntry;
  template: ModelTemplate | null; // set with `object`
  object: THREE.Object3D | null; // fitted wrapper holding this renderer's clone
  originals: Map<THREE.Mesh, THREE.Material | THREE.Material[]>; // the clone's own material copies
  fitSize: number; // the template's
  fitBox: THREE.Vector3;
}

const modelListeners = new Set<(assetId: string) => void>();

/**
 * Called once per GLB parse, when it settles (loaded or failed), with the model's asset id —
 * re-render then: layers showing that model drew nothing while it was parsing.
 */
export function onModelReady(cb: (assetId: string) => void): () => void {
  modelListeners.add(cb);
  return () => {
    modelListeners.delete(cb);
  };
}

/** The asset's shared parse, started on first request. */
function parseModel(asset: AssetEntry): ParsedModel {
  const have = parsedModels.get(asset);
  if (have) return have;
  // Dynamic: the GLTF loader is a lazy chunk, fetched once a GLB layer first renders (precached for offline use).
  const template = Promise.all([import('three/examples/jsm/loaders/GLTFLoader.js'), import('three/examples/jsm/utils/SkeletonUtils.js')])
    .then(([{ GLTFLoader }, { clone }]) =>
      new GLTFLoader().parseAsync(asset.data.slice(0), '').then((gltf): ModelTemplate => {
        const scene = gltf.scene;
        // measure in model space (unparented → world = local), centre on the origin
        scene.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(scene, true);
        const fitBox = new THREE.Vector3();
        let fitSize = 0;
        if (!box.isEmpty()) {
          box.getSize(fitBox);
          fitSize = Math.max(fitBox.x, fitBox.y, fitBox.z, 1e-6);
          scene.position.sub(box.getCenter(new THREE.Vector3()));
          scene.updateMatrixWorld(true);
        }
        return { scene, fitSize, fitBox, clone, users: 0 };
      }),
    )
    .catch((err: unknown) => {
      console.warn(`GLB "${asset.name}" failed to load`, err);
      return null;
    });
  const entry: ParsedModel = {
    template: null,
    settled: false,
    done: template.then((t) => {
      entry.template = t;
      entry.settled = true;
      for (const l of modelListeners) l(asset.id);
    }),
  };
  parsedModels.set(asset, entry);
  return entry;
}

export type ModelStatus = 'missing' | 'loading' | 'loaded' | 'failed';

/** Where the GLB parse of asset `assetId` stands (does not start it). */
export function modelStatus(assetId: string): ModelStatus {
  const asset = getAsset(assetId);
  if (!asset) return 'missing';
  const p = parsedModels.get(asset);
  if (!p || !p.settled) return 'loading';
  return p.template ? 'loaded' : 'failed';
}

/** Starts the shared GLB parse of asset `assetId` if needed; resolves once it has settled (at once for unknown assets). */
export function loadModel(assetId: string): Promise<void> {
  const asset = getAsset(assetId);
  return asset ? parseModel(asset).done : Promise.resolve();
}

function disposeObject(o: THREE.Object3D) {
  o.traverse((n) => {
    const m = n as THREE.Mesh;
    if (!m.isMesh) return;
    m.geometry?.dispose();
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    for (const mat of mats) {
      if (!mat) continue;
      for (const v of Object.values(mat)) if (v instanceof THREE.Texture) v.dispose();
      mat.dispose();
    }
  });
}

/** Text char indices with a 3D material override, ascending (their slot blocks follow the backplates). */
function overrideChars(layer: Title3DLayer): number[] {
  const src = layer.source;
  if (src.kind !== 'text') return [];
  return Object.keys(src.chars)
    .map(Number)
    .filter((k) => hasMaterialOverride(src.chars[k]))
    .sort((a, b) => a - b);
}

/** Material3D for every slot, in slot order (see header). */
function slotMaterials(layer: Title3DLayer): Material3D[] {
  const p = layer.style3d;
  const out = [p.face, ...p.bands.map((b) => b.material), sideMaterial(p)];
  for (const bp of p.backplates) if (bp.enabled) out.push(bp.face, plateSide(bp));
  if (layer.source.kind === 'text') {
    const chars = layer.source.chars;
    for (const k of overrideChars(layer)) {
      const a = chars[k];
      out.push(a.face3d ?? p.face, ...p.bands.map((b, i) => a.bands3d?.[i] ?? b.material), charSide(p, a));
    }
  }
  return out;
}

/** The reflections state of environment `e`, its lookups locked to the layer when `lock`. */
function envState(e: Environment3D, lock: boolean, ctx: LayerRenderContext): EnvState {
  return { map: ctx.envMap(e), rotation: e.rotation * DEG, intensity: Math.max(0, e.intensity), blur: e.blur, repeatX: e.repeatX, repeatY: e.repeatY, lock };
}

/** The reflections `mat` renders with: the layer's environment `layerEnv` (state `env`) with the values the part sets itself. */
function partEnv(mat: Material3D, layerEnv: Environment3D, env: EnvState, ctx: LayerRenderContext): EnvState {
  const e = resolveEnvironment(layerEnv, mat.environment);
  return e === layerEnv ? env : envState(e, env.lock, ctx);
}

/** The environments `layer` and its parts render with, for load waits. */
export function layerEnvironments(comp: Comp, layer: Title3DLayer): Environment3D[] {
  return [...slotMaterials(layer), layer.style3d.face].map((m) => effectiveLighting(comp, layer, m).environment);
}

/**
 * Style part of every slot, parallel to slotMaterials: a block's face / band i / side, both
 * slots of a plate (face and side) that plate. Rigged glyphs and character overrides draw with
 * these same slots. Inflate mode leaves the band slots empty.
 */
function slotParts(layer: Title3DLayer): PartKey[] {
  const p = layer.style3d;
  const block: PartKey[] = ['face', ...p.bands.map((b) => bandKey(b.id)), 'side'];
  const out = [...block];
  for (const bp of p.backplates) if (bp.enabled) out.push(plateKey(bp.id), plateKey(bp.id));
  for (let n = overrideChars(layer).length; n > 0; n--) out.push(...block);
  return out;
}

/** First slot of every overriding char's block: right after the backplate slots (see header). */
function charBlockSlots(layer: Title3DLayer): Map<number, number> {
  const p = layer.style3d;
  const block = p.bands.length + 2;
  let slot = block + 2 * p.backplates.filter((b) => b.enabled).length;
  const out = new Map<number, number>();
  for (const k of overrideChars(layer)) {
    out.set(k, slot);
    slot += block;
  }
  return out;
}

/**
 * Geometry-relevant part of the 3D style (materials, skew and rig values excluded: those are
 * matrices). `outputScale` = output px per layer px: large exports add bevel facets and orb
 * tessellation.
 */
function geometryKey(layer: Title3DLayer, outputScale: number): string {
  const p = layer.style3d;
  const src = layer.source;
  const size = src.size;
  const isOrb = src.kind === 'shape' && src.shape === 'orb';
  return JSON.stringify([
    size,
    p.depth,
    p.curveSegments,
    isOrb
      ? orbGridFor((size / 2) * Math.max(1, src.aspect) * outputScale)
      : p.mode === 'inflate'
        ? [p.mode, p.inflate, p.bands.length, inflateScale(outputScale)]
        : [p.bevelPosition, p.bevelPosition === 'inside' ? 0 : inflateScale(outputScale), p.bands.map((b) => [b.width, b.depth, b.profile, b.curve, effectiveSegments(b, outputScale)])],
    p.backplates.map((b) => [b.enabled, b.grow, b.join, b.fillCounters, b.plate, b.depth, b.zGap, b.bevel, effectiveSegments(b.bevel, outputScale)]),
    overrideChars(layer),
  ]);
}

/** Rigid transform of a rigged glyph (see header); `pivotZ` from title.ts. */
function rigMatrix(out: THREE.Matrix4, rig: GlyphRig, layer: Title3DLayer, pivotZ: number): THREE.Matrix4 {
  const a = layer.source.kind === 'text' ? layer.source.chars[rig.char] : undefined;
  const dz = ((a?.dz ?? 0) / 100) * layer.source.size;
  _euler.set((a?.tiltX ?? 0) * DEG, (a?.tiltY ?? 0) * DEG, 0, 'YXZ'); // X applied first, then Y
  out.makeRotationFromEuler(_euler);
  _pivot.set(rig.pivot.x, rig.pivot.y, pivotZ);
  _move.copy(_pivot).applyMatrix4(out); // R·pivot
  // T(pivot + dz) · R · T(−pivot): translation = pivot + dz − R·pivot
  return out.setPosition(_pivot.x - _move.x, _pivot.y - _move.y, pivotZ + dz - _move.z);
}
const _euler = new THREE.Euler();
const _pivot = new THREE.Vector3();
const _move = new THREE.Vector3();

/** A title Mesh; rigged glyph meshes carry their rig (matrix updated per render). */
interface TitleMesh {
  mesh: THREE.Mesh<THREE.BufferGeometry, PartMaterial[]>;
  rig?: GlyphRig;
}

class Layer3DRendererImpl implements LayerRenderer {
  private readonly scene = new THREE.Scene();
  private readonly root = new THREE.Group();
  private readonly content = new THREE.Group();
  /** Oblique-extrusion shear of the extruded solids (matrix set per render). */
  private readonly sheared = new THREE.Group();
  private readonly catcher: THREE.Mesh<THREE.CircleGeometry, THREE.ShadowMaterial>;
  private mats: PartMaterial[] = [];
  private lights: THREE.Light[] = [];
  private lightsKey = '';
  /** HDR render (MSAA, supersampled size). */
  private rt: THREE.WebGLRenderTarget | null = null;
  /** Same size scratch: the expanded HDR render at supersample 1, else the tone-mapped render before the downsample. */
  private post: THREE.WebGLRenderTarget | null = null;
  private expand: HdrExpand | null = null;
  private tonemap: THREE.ShaderMaterial | null = null;
  private glint: GlintPass | null = null;
  private ao: AOPass | null = null;
  private down: Downsampler | null = null;
  private readonly glintTint = new THREE.Color();
  private readonly layerInverse = new THREE.Matrix4();
  /** Layer axes → world: the rotation times the flip mirror (orthonormal; materials.ts PartSpace). */
  private readonly layerRot = new THREE.Matrix3();
  /** The layer's rotation alone (GLB envLock approximation: an Euler can't mirror). */
  private readonly turnRot = new THREE.Matrix3();
  private readonly rot4 = new THREE.Matrix4();
  private readonly mirror = new THREE.Vector3();
  private readonly viewport = new THREE.Vector2();
  /** Environment rotation of a GLB's own materials (envLock approximation). */
  private readonly envEuler = new THREE.Euler();

  // text / shape / svg / image caches
  private shapeKey = '';
  private shapeFont: FontEntry | undefined;
  private shapeAsset: AssetEntry | undefined;
  private shapeBitmap: ImageBitmap | undefined;
  private shapes: TitleShapes | null = null;
  private geoKey = '';
  private meshes: TitleMesh[] = [];
  /** Rig pivot z of the current geometry (title.ts). */
  private pivotZ = 0;
  /** Union over all title meshes of every slot's layer-space bounds (materials are shared). */
  private slotBounds: (THREE.Box2 | undefined)[] = [];

  private model: ModelState | null = null;
  private readonly box = new THREE.Box3();
  private readonly sphere = new THREE.Sphere();

  constructor() {
    this.scene.add(this.root);
    this.root.add(this.content);
    this.content.add(this.sheared);
    this.sheared.matrixAutoUpdate = false;
    this.root.rotation.order = 'ZYX'; // vector rotated about X first, then Y, then Z (After Effects order)
    this.catcher = new THREE.Mesh(new THREE.CircleGeometry(1, 96), compressHdrOutput(new THREE.ShadowMaterial({ depthWrite: false })));
    this.catcher.receiveShadow = true;
    this.catcher.visible = false;
    this.scene.add(this.catcher);
  }

  render(layer: Layer, ctx: LayerRenderContext, target: THREE.WebGLRenderTarget) {
    const { renderer, kit } = ctx;
    const tr = layer.transform;
    const comp = ctx.project.comp;
    const k = this.supersampleFactor(comp.supersample, ctx);
    if (layer.kind !== 'title3d' || !this.syncContent(layer, ctx.pxScale * Math.abs(tr.scale), ctx.draft)) {
      kit.clear(target);
      return;
    }
    // Part render (ctx.parts): per material slot, whether it draws colour (null = every slot;
    // a model is all face). `[]` draws only the matte shadow the whole title casts.
    const parts = ctx.parts;
    const shadowOnly = parts?.length === 0;
    const writes = parts && this.meshes.length ? slotParts(layer).map((key) => parts.includes(key)) : null;
    if (parts && !shadowOnly && !(writes ? writes.includes(true) : parts.includes('face'))) {
      kit.clear(target);
      return;
    }
    // some material only writes depth
    const masked = shadowOnly || (writes !== null && writes.includes(false));
    const W = ctx.width * k;
    const H = ctx.height * k;

    // transform; skew shear and per-glyph rigs are matrices below the root
    this.root.position.set(tr.x, tr.y, tr.z);
    this.root.rotation.set(tr.rotX * DEG, tr.rotY * DEG, -tr.rotZ * DEG);
    // flipX / flipY mirror in layer space, before the rotations (three draws the mirrored
    // meshes with clockwise front faces and the inverse-transpose normal matrix, so faces stay
    // front-facing and lit from outside)
    const s = tr.scale || 1e-6;
    this.root.scale.set(tr.flipX ? -s : s, tr.flipY ? -s : s, s);
    const skew = layer.style3d.skew;
    this.sheared.matrix.set(1, 0, -skew.x, 0, 0, 1, -skew.y, 0, 0, 0, 1, 0, 0, 0, 0, 1);
    for (const { mesh, rig } of this.meshes) if (rig) rigMatrix(mesh.matrix, rig, layer, this.pivotZ);
    this.scene.updateMatrixWorld(true);
    this.layerInverse.copy(this.root.matrixWorld).invert();
    this.rot4.makeRotationFromQuaternion(this.root.quaternion);
    this.turnRot.setFromMatrix4(this.rot4);
    this.layerRot.setFromMatrix4(this.rot4.scale(this.mirror.set(tr.flipX ? -1 : 1, tr.flipY ? -1 : 1, 1)));

    // materials, lights and tone mapping: the layer's effective lighting
    const lighting = effectiveLighting(comp, layer);
    const env = envState(lighting.environment, layer.style3d.envLock, ctx);
    this.syncMaterials(layer, lighting.environment, env, ctx, W, H);

    this.syncLights(lighting.lights);
    this.syncShadow(layer, !parts || shadowOnly);
    if (shadowOnly && !this.catcher.visible) {
      kit.clear(target);
      return;
    }
    // the materials of a masked render and their colour writes (a model has no slots)
    let mask: { mats: THREE.Material[]; writes: readonly boolean[] } | null = null;
    if (masked && writes) mask = { mats: this.mats.slice(0, writes.length), writes };
    else if (masked) {
      const mats = this.modelMaterials();
      mask = { mats, writes: mats.map(() => false) };
    }

    // render into our own MSAA target (fewer samples when supersampled); unsupersampled, the
    // materials compress their light so the resolve weights samples like the tone map does
    const samples = k > 1 ? MSAA_SUPERSAMPLED : MSAA;
    if (this.rt && this.rt.samples !== samples) {
      this.rt.dispose();
      this.rt = null;
    }
    if (!this.rt) {
      this.rt = new THREE.WebGLRenderTarget(W, H, { type: THREE.HalfFloatType, samples, depthBuffer: true });
      this.rt.texture.colorSpace = THREE.LinearSRGBColorSpace;
      if (k === 1) compressInto(this.rt);
    } else if (this.rt.width !== W || this.rt.height !== H) {
      this.rt.setSize(W, H);
    }
    const prevAutoClear = renderer.autoClear;
    const prevShadow = renderer.shadowMap.enabled;
    const prevShadowType = renderer.shadowMap.type;
    const prevShadowUpdate = renderer.shadowMap.autoUpdate;
    renderer.autoClear = false;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.VSMShadowMap;
    // part runs hide the catcher, the only shadow receiver: its map needs no refresh
    if (parts && !shadowOnly) renderer.shadowMap.autoUpdate = false;
    // clear alpha 0 also makes three clear the transmission buffer to (1, 1, 1, 0.5), which
    // the gem shader unmixes into coverage (materials.ts)
    renderer.setClearColor(0x000000, 0);
    setCompressionExposure(lighting.exposure);

    // AO on the HDR render, before the glint (skipped while dragging); the glint runs with the
    // full render and with part renders that hold the face
    const ao = layer.style3d.ao;
    const aoOn = ao.enabled && ao.intensity > 0 && ao.radius > 0 && !ctx.draft;
    const g = layer.style3d.glint;
    const glintOn = g.enabled && g.intensity > 0 && (!parts || parts.includes('face'));
    // masked with the glint: streaks rise from every highlight of the title (bevel edges
    // most), as in the full render, so the whole title is drawn first for the glint, then the
    // parts; both take the same AO
    const wholeFirst = masked && glintOn;
    let glint: GlintLight | null = null;
    if (wholeFirst) {
      this.drawScene(renderer, ctx.camera, null);
      const whole = this.resolveHdr(kit, W, H, k);
      if (aoOn) this.runAO(layer, ctx, whole);
      glint = this.runGlint(layer, ctx, k, whole);
    }
    this.drawScene(renderer, ctx.camera, mask);
    renderer.shadowMap.enabled = prevShadow;
    renderer.shadowMap.type = prevShadowType;
    renderer.shadowMap.autoUpdate = prevShadowUpdate;

    const hdr = this.resolveHdr(kit, W, H, k);
    // a masked render's occlusion comes from the whole scene too: the AO prepass draws every
    // part with its override material
    if (aoOn && wholeFirst) this.ao!.applyAgain(hdr);
    else if (aoOn) this.runAO(layer, ctx, hdr);
    renderer.autoClear = prevAutoClear;
    if (glintOn && !wholeFirst) glint = this.runGlint(layer, ctx, k, hdr);

    // tone map (+ glint) at the render resolution → target (premultiplied linear); a
    // supersampled render is tone mapped first and filtered down after, so bright HDR edges
    // antialias like the compressed 1× resolve
    this.tonemap ??= createTonemapMaterial(kit);
    const tu = this.tonemap.uniforms;
    tu.tSrc.value = hdr.texture;
    tu.tGlint.value = glint?.texture ?? null;
    tu.uGlint.value = glint !== null;
    if (glint) tu.uGlintUv.value.copy(glint.uv);
    tu.uMode.value = TONEMAP_IDS[lighting.toneMapping] ?? 0;
    tu.uExposure.value = Math.max(0, lighting.exposure);
    if (k === 1) {
      kit.run(this.tonemap, target);
      return;
    }
    const post = this.postTarget(W, H);
    kit.run(this.tonemap, post);
    this.down ??= new Downsampler(kit);
    this.down.run(post, target, k);
  }

  /**
   * Render the scene into the cleared HDR target. `mask` (masked part renders): per material,
   * whether it draws colour. Every unblended material lays down depth first, so the parts left
   * out hide exactly what they hide in the full render whatever the draw order; the scene then
   * draws again over that depth (and refreshes the shadow map, all casters visible), in colour
   * only from the listed materials and the shadow catcher when shown. Blended (transparent)
   * materials skip the depth pass and write their depth in their own place in the order, as in
   * the full render. Gems refract every part: three's transmission pre-render (into another
   * target) draws every material in colour.
   */
  private drawScene(renderer: THREE.WebGLRenderer, camera: THREE.Camera, mask: { mats: THREE.Material[]; writes: readonly boolean[] } | null) {
    const rt = this.rt!;
    renderer.setRenderTarget(rt);
    renderer.clear(true, true, true);
    if (!mask) {
      renderer.render(this.scene, camera);
      return;
    }
    const { mats, writes } = mask;
    for (const m of mats) {
      m.colorWrite = false;
      m.visible = !m.transparent;
    }
    const catcher = this.catcher.visible;
    const shadowUpdate = renderer.shadowMap.autoUpdate;
    this.catcher.visible = false;
    renderer.shadowMap.autoUpdate = false;
    renderer.render(this.scene, camera);
    this.catcher.visible = catcher;
    renderer.shadowMap.autoUpdate = shadowUpdate;
    // the MSAA resolve discarded the multisampled colour; the depth is kept
    renderer.clear(true, false, false);
    const hooks = mats.map((m, i) => {
      const before = m.onBeforeRender;
      m.visible = true;
      m.onBeforeRender = function (r, scene, cam, geometry, object, group) {
        m.colorWrite = writes[i] || r.getRenderTarget() !== rt;
        before.call(this, r, scene, cam, geometry, object, group);
      };
      return before;
    });
    renderer.render(this.scene, camera);
    mats.forEach((m, i) => {
      m.onBeforeRender = hooks[i];
      m.colorWrite = true;
    });
  }

  /** Every material the model draws with (as syncMaterials left them). */
  private modelMaterials(): THREE.Material[] {
    const out = new Set<THREE.Material>();
    for (const mesh of this.model?.originals.keys() ?? []) for (const m of [mesh.material].flat()) out.add(m);
    return [...out];
  }

  /** The HDR pixels of the last drawScene: the expanded compressed resolve at supersample 1, the plain resolve otherwise. */
  private resolveHdr(kit: PassKit, w: number, h: number, k: number): THREE.WebGLRenderTarget {
    if (k > 1) return this.rt!;
    const hdr = this.postTarget(w, h);
    this.expand ??= new HdrExpand(kit);
    this.expand.run(this.rt!.texture, hdr);
    return hdr;
  }

  /** AO multiplied into `hdr`; the radius is world units, so it covers the same part of the title at every export scale. */
  private runAO(layer: Title3DLayer, ctx: LayerRenderContext, hdr: THREE.WebGLRenderTarget) {
    const ao = layer.style3d.ao;
    this.ao ??= new AOPass(ctx.kit);
    this.ao.render(ctx.renderer, this.scene, ctx.camera, hdr, ctx.width, ctx.height, ctx.frame, [this.catcher], {
      radius: (ao.radius / 100) * layer.source.size * Math.abs(layer.transform.scale),
      intensity: ao.intensity,
    });
  }

  /** Glint on the HDR highlights of `hdr`; sizes are % of source.size → render px. */
  private runGlint(layer: Title3DLayer, ctx: LayerRenderContext, k: number, hdr: THREE.WebGLRenderTarget): GlintLight {
    const g = layer.style3d.glint;
    this.glint ??= new GlintPass(ctx.kit);
    const unit = (layer.source.size / 100) * Math.abs(layer.transform.scale) * ctx.pxScale;
    return this.glint.render(hdr.texture, ctx.width, ctx.height, ctx.frame, {
      threshold: g.threshold,
      intensity: g.intensity,
      radiusPx: Math.max(0, g.radius) * unit,
      streaks: g.streaks,
      lengthPx: Math.max(0, g.length) * unit,
      detailPx: GLINT_DETAIL * unit,
      pxScale: ctx.pxScale,
      supersample: k,
      angle: -g.angle * DEG, // clockwise on screen → uv (y-up) counter-clockwise
      tint: this.glintTint.set(g.tint),
    });
  }

  private postTarget(w: number, h: number): THREE.WebGLRenderTarget {
    if (!this.post) {
      this.post = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: false });
      this.post.texture.colorSpace = THREE.LinearSRGBColorSpace;
    } else if (this.post.width !== w || this.post.height !== h) this.post.setSize(w, h);
    return this.post;
  }

  /**
   * comp.supersample, lowered to fit the GPU's texture size and the memory budget of the whole
   * render (ctx.frame), so a preview window renders at the factor the whole render has.
   */
  private supersampleFactor(requested: number, ctx: LayerRenderContext): number {
    const maxSide = ctx.renderer.capabilities.maxTextureSize;
    const { width, height } = ctx.frame;
    let k = Math.max(1, Math.round(requested || 1));
    while (k > 1 && (width * height * k * k > SUPERSAMPLE_BUDGET || Math.max(width, height) * k > maxSide)) k--;
    return k;
  }

  /**
   * Make sure the content matches the layer source. `outputScale` = output px per layer px;
   * `draft` (a drag in progress) halves the curve tessellation and coarsens the inflate grid.
   * Returns false if nothing can be drawn yet.
   */
  private syncContent(layer: Title3DLayer, outputScale: number, draft: boolean): boolean {
    const src = layer.source;
    const p = layer.style3d;
    if (src.kind === 'model') {
      this.clearMeshes();
      this.shapeKey = '';
      return this.syncModel(src.assetId, src.size);
    }
    this.disposeModel();

    // 1) shapes (independent of extrusion params)
    const font = src.kind === 'text' ? getFont(src.fontId) : undefined;
    const asset = src.kind === 'svg' ? getAsset(src.assetId) : undefined;
    const bitmap = src.kind === 'image' ? getBitmap(src.assetId) : undefined;
    if (src.kind === 'text' && !font) return false;
    if (src.kind === 'svg' && !asset) return false;
    if (src.kind === 'image' && !bitmap) {
      void decodeImage(src.assetId);
      return false;
    }
    const eps = Math.max(1e-4, src.size * 1e-4);
    // per-char materials are slots and rig values are matrices: only whether a glyph is rigged
    // (extruded on its own) changes the outlines
    const keySrc =
      src.kind === 'text'
        ? { ...src, chars: Object.entries(src.chars).map(([k, c]) => [k, c.dx, c.dy, c.scale, c.hScale, c.vScale, c.rotate, hasRig(c)]) }
        : src;
    const curveSegments = draft ? Math.max(2, Math.ceil(p.curveSegments / 2)) : p.curveSegments;
    const assetOutline = src.kind === 'svg' || src.kind === 'image';
    const shapeKey = JSON.stringify([keySrc, curveSegments, assetOutline ? null : [layer.warp, layer.distort, layer.weight]]);
    if (shapeKey !== this.shapeKey || font !== this.shapeFont || asset !== this.shapeAsset || bitmap !== this.shapeBitmap || !this.shapes) {
      this.shapeKey = shapeKey;
      this.shapeFont = font;
      this.shapeAsset = asset;
      this.shapeBitmap = bitmap;
      this.geoKey = '';
      if (src.kind === 'text') this.shapes = textShapes(src, layer, font!, curveSegments, eps);
      else if (src.kind === 'shape') this.shapes = shapeShapes(src, layer, curveSegments, eps);
      else if (src.kind === 'image') this.shapes = imageTitleShapes(bitmap!, src, curveSegments, eps);
      else {
        try {
          this.shapes = svgTitleShapes(new TextDecoder().decode(asset!.data), src.size, curveSegments);
        } catch (err) {
          console.warn('SVG parse failed', err);
          this.shapes = flatShapes([]);
        }
      }
    }

    // 2) solids
    const geoKey = geometryKey(layer, outputScale) + (draft ? 'draft' : '');
    if (geoKey !== this.geoKey) {
      this.geoKey = geoKey;
      this.clearMeshes();
      const t = this.shapes!;
      if (t.parts.length || t.orb) {
        const built = buildTitle(t, { ...p, curveSegments }, src.size, eps, charBlockSlots(layer), outputScale, draft);
        this.pivotZ = built.pivotZ;
        const add = (g: { geometry: THREE.BufferGeometry; bounds: (THREE.Box2 | undefined)[] }, parent: THREE.Object3D, rig?: GlyphRig) => {
          const mesh = new THREE.Mesh<THREE.BufferGeometry, PartMaterial[]>(g.geometry, []);
          if (rig) mesh.matrixAutoUpdate = false;
          parent.add(mesh);
          this.meshes.push({ mesh, rig });
          g.bounds.forEach((b, slot) => {
            if (!b) return;
            if (this.slotBounds[slot]) this.slotBounds[slot].union(b);
            else this.slotBounds[slot] = b.clone();
          });
        };
        if (built.main) add(built.main, this.sheared);
        for (const r of built.rigged) add(r, this.sheared, r.rig);
        if (built.orb) add(built.orb, this.content);
      }
    }
    return this.meshes.length > 0;
  }

  private clearMeshes() {
    for (const { mesh } of this.meshes) {
      mesh.geometry.dispose();
      mesh.removeFromParent();
    }
    this.meshes = [];
    this.slotBounds = [];
  }

  /** `env`: the state of the layer's environment `layerEnv`; `width`×`height` = the (supersampled) render size. */
  private syncMaterials(layer: Title3DLayer, layerEnv: Environment3D, env: EnvState, ctx: LayerRenderContext, width: number, height: number) {
    const p = layer.style3d;
    const space = (bounds: THREE.Box2 | undefined): PartSpace => ({
      bounds,
      layerInverse: this.layerInverse,
      layerRot: this.layerRot,
      size: layer.source.size,
      viewport: this.viewport.set(width, height),
      frameSpan: ctx.frame.width / ctx.width,
    });
    if (this.meshes.length) {
      const defs = slotMaterials(layer);
      while (this.mats.length < defs.length) this.mats.push(createPartMaterial());
      const parts = slotParts(layer);
      const face = this.imageProjection(layer, 'face');
      const edges = this.imageProjection(layer, 'edges');
      defs.forEach((def, i) => {
        applyMaterial3D(this.mats[i], def, partEnv(def, layerEnv, env, ctx), ctx.kit, space(this.slotBounds[i]));
        const part = parts[i];
        applyImageProjection(this.mats[i], part === 'face' ? face : part === 'side' || part.startsWith('band:') ? edges : null);
      });
      for (const { mesh } of this.meshes) if (mesh.material.length !== defs.length) mesh.material = this.mats.slice(0, defs.length);
      return;
    }
    const st = this.model;
    if (!st?.object) return;
    const own = p.face.preset === 'custom';
    if (!own) {
      this.mats[0] ??= createPartMaterial();
      const half = st.fitBox.clone().multiplyScalar(st.object.scale.x / 2);
      const bounds = new THREE.Box2(new THREE.Vector2(-half.x, -half.y), new THREE.Vector2(half.x, half.y));
      applyMaterial3D(this.mats[0], p.face, partEnv(p.face, layerEnv, env, ctx), ctx.kit, space(bounds));
      applyImageProjection(this.mats[0], null);
    }
    const slotEnv = Math.max(0, p.face.reflectivity) * env.intensity;
    // the model's own materials have no layer-space lookup: approximate the lock by rotation
    envMapEuler(this.envEuler, env.rotation, env.lock ? this.turnRot : null);
    for (const [mesh, orig] of st.originals) {
      if (!own) {
        mesh.material = this.mats[0];
        continue;
      }
      mesh.material = orig;
      for (const mat of Array.isArray(orig) ? orig : [orig]) {
        const pm = mat as THREE.MeshStandardMaterial;
        if (!pm.isMeshStandardMaterial) continue;
        if (pm.envMap !== env.map) {
          pm.envMap = env.map;
          pm.needsUpdate = true;
        }
        pm.envMapRotation.copy(this.envEuler);
        pm.envMapIntensity = slotEnv;
        setEnvLookup(pm, env);
      }
    }
  }

  /**
   * The picture an image source projects on its face slots ('face', style3d.faceImage) or its
   * band and side slots ('edges', style3d.edgeImage); null for other sources, amount 0 or a
   * bitmap still decoding.
   */
  private imageProjection(layer: Title3DLayer, on: 'face' | 'edges'): ImageProjection | null {
    const src = layer.source;
    const amount = on === 'face' ? layer.style3d.faceImage : layer.style3d.edgeImage;
    if (src.kind !== 'image' || !(amount > 0)) return null;
    const bmp = getBitmap(src.assetId);
    if (!bmp) return null;
    const { hw, hh } = imageFit(bmp, src.size);
    const threshold = Math.min(255, Math.max(1, src.trace.threshold));
    const box = { x0: -hw, y0: -hh, x1: hw, y1: hh };
    return on === 'face'
      ? { texture: faceImageTexture(bmp), box, amount, edge: threshold / 255 }
      : { texture: edgeImageTexture(bmp, threshold), box, amount, edge: null };
  }

  // ---------- lights & shadow ----------

  private syncLights(defs: readonly Light3D[]) {
    const key = defs.map((l) => `${l.id}:${l.type}`).join('|');
    if (key !== this.lightsKey) {
      for (const l of this.lights) {
        this.scene.remove(l);
        if (l instanceof THREE.DirectionalLight) this.scene.remove(l.target);
        l.dispose();
      }
      this.lights = defs.map((def) => {
        let obj: THREE.Light;
        if (def.type === 'directional') {
          const d = new THREE.DirectionalLight();
          d.shadow.mapSize.set(SHADOW_MAP_MAX, SHADOW_MAP_MAX);
          d.shadow.blurSamples = 16;
          d.shadow.bias = -0.0005;
          this.scene.add(d.target);
          obj = d;
        } else if (def.type === 'point') obj = new THREE.PointLight(0xffffff, 1, 0, 0); // no falloff: comp-px distances
        else obj = new THREE.AmbientLight();
        this.scene.add(obj);
        return obj;
      });
      this.lightsKey = key;
    }
    // directional lights shine from (x,y,z) toward the comp origin
    defs.forEach((def, i) => {
      const l = this.lights[i];
      l.color.set(def.color);
      l.intensity = Math.max(0, def.intensity);
      l.position.set(def.x, def.y, def.z);
      if (l instanceof THREE.DirectionalLight) {
        l.target.position.set(0, 0, 0);
        l.target.updateMatrixWorld();
      }
    });
  }

  /**
   * Shadow catcher (Element 3D Matte Shadow): a wall just behind the layer that only shows the
   * title's shadow, tinted `shadow.color` at `shadow.opacity`. Soft shadows are variance
   * shadow maps blurred by a radius proportional to the title size × softness; very soft
   * shadows lower the map resolution so the blur stays within a few texels (smooth, cheap).
   * `full` = false (part renders): no catcher; the lights keep their shadow setting, so the
   * materials keep the full render's shader programs.
   */
  private syncShadow(layer: Title3DLayer, full: boolean) {
    const sh = layer.style3d.shadow;
    const dirs = this.lights.filter((l): l is THREE.DirectionalLight => l instanceof THREE.DirectionalLight);
    const cast = sh.enabled && sh.opacity > 0;
    this.catcher.visible = cast && dirs.length > 0;
    this.content.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) o.castShadow = cast;
    });
    for (const d of dirs) d.castShadow = this.catcher.visible;
    if (!full) this.catcher.visible = false;
    if (!this.catcher.visible) return;

    this.box.setFromObject(this.content);
    if (this.box.isEmpty()) {
      this.catcher.visible = false;
      return;
    }
    const mat = this.catcher.material;
    mat.color.set(sh.color);
    mat.opacity = Math.min(1, sh.opacity);
    this.box.getBoundingSphere(this.sphere);
    const R = Math.max(1, this.sphere.radius);
    const centre = this.sphere.center;
    const scale = Math.abs(layer.transform.scale) || 1;
    const titleSize = layer.source.size * scale;
    const gap = Math.max(10, titleSize * 0.3);

    const ext = R * 1.2 + titleSize * SHADOW_SOFT_MAX; // room for the blurred penumbra
    const catcherZ = this.box.min.z - gap;
    const blur = Math.max(0, Math.min(1, sh.softness)) * SHADOW_SOFT_MAX * titleSize; // world px
    const mapFit = THREE.MathUtils.floorPowerOfTwo((2 * ext * SHADOW_BLUR_TEXELS) / Math.max(blur, 1e-6));
    const mapSize = Math.max(SHADOW_MAP_MIN, Math.min(SHADOW_MAP_MAX, mapFit));
    const radius = Math.max(1, blur / ((2 * ext) / mapSize));
    const hits: THREE.Vector3[] = [];
    for (const d of dirs) {
      if (d.shadow.mapSize.x !== mapSize) {
        d.shadow.mapSize.set(mapSize, mapSize);
        d.shadow.map?.dispose();
        d.shadow.map = null;
      }
      d.shadow.radius = radius;
      // same direction, re-centred on the content so the ortho shadow frustum fits it tightly
      const dir = d.position.clone();
      if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
      dir.normalize();
      const dist = R * 3 + 100;
      d.target.position.copy(centre);
      d.position.copy(centre).addScaledVector(dir, dist);
      d.target.updateMatrixWorld();
      d.updateMatrixWorld();
      const cam = d.shadow.camera;
      cam.left = -ext;
      cam.right = ext;
      cam.top = ext;
      cam.bottom = -ext;
      cam.near = Math.max(1, dist - R * 1.5);
      // reach the catcher wall even for grazing light
      cam.far = dist + (R + gap) / Math.max(0.1, Math.abs(dir.z)) + R;
      cam.updateProjectionMatrix();
      // where this light's frustum axis meets the catcher plane
      const dz = Math.abs(dir.z) < 1e-3 ? 1e-3 : dir.z;
      hits.push(centre.clone().addScaledVector(dir, (catcherZ - centre.z) / dz));
    }

    // catcher: a disc in comp space just behind the layer's bounds, kept inside every light's
    // shadow frustum (a disc of radius ext around its axis hit always is) — past the frustum
    // edge the blurred variance map smears into faint streaks
    const mid = hits.reduce((s, h) => s.add(h), new THREE.Vector3()).divideScalar(hits.length);
    const spread = Math.max(...hits.map((h) => h.distanceTo(mid)));
    const r = Math.max(ext * 0.2, ext * 0.95 - spread);
    this.catcher.scale.set(r, r, 1);
    this.catcher.position.set(mid.x, mid.y, catcherZ);
    this.catcher.updateMatrixWorld();
  }

  // ---------- models ----------

  private syncModel(assetId: string, size: number): boolean {
    const asset = getAsset(assetId);
    if (!asset) {
      this.disposeModel();
      return false;
    }
    if (!this.model || this.model.asset !== asset) {
      this.disposeModel();
      this.model = { asset, template: null, object: null, originals: new Map(), fitSize: 0, fitBox: new THREE.Vector3() };
    }
    const st = this.model;
    if (!st.object) {
      // the parse is shared (parsedModels): a recreated renderer or another engine clones it at once
      const tpl = parseModel(asset).template;
      if (!tpl) return false;
      this.instantiateModel(st, tpl);
    }
    if (!st.object || st.fitSize <= 0) return false;
    st.object.scale.setScalar(size / st.fitSize);
    return true;
  }

  /** This renderer's clone of the template: shared geometry and textures, own materials (their env settings are per render). */
  private instantiateModel(st: ModelState, tpl: ModelTemplate) {
    const scene = tpl.clone(tpl.scene);
    const copies = new Map<THREE.Material, THREE.Material>();
    const copy = (m: THREE.Material) => {
      let c = copies.get(m);
      if (!c) copies.set(m, (c = compressHdrOutput(m.clone())));
      return c;
    };
    scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(copy) : copy(mesh.material);
      st.originals.set(mesh, mesh.material);
    });
    const wrapper = new THREE.Group();
    wrapper.add(scene);
    st.template = tpl;
    st.object = wrapper;
    st.fitSize = tpl.fitSize;
    st.fitBox = tpl.fitBox;
    tpl.users++;
    this.content.add(wrapper);
  }

  private disposeModel() {
    const st = this.model;
    if (!st) return;
    this.model = null;
    if (!st.object || !st.template) return;
    this.content.remove(st.object);
    // only the material copies are this renderer's; geometry and textures belong to the template
    for (const mat of new Set([...st.originals.values()].flat())) mat.dispose();
    // the template stays parsed: a later clone uploads its buffers again
    if (--st.template.users === 0) disposeObject(st.template.scene);
  }

  dispose() {
    this.clearMeshes();
    this.disposeModel();
    for (const l of this.lights) l.dispose();
    this.lights = [];
    for (const m of this.mats) m.dispose();
    this.mats = [];
    this.catcher.geometry.dispose();
    this.catcher.material.dispose();
    this.rt?.dispose();
    this.post?.dispose();
    this.expand?.dispose();
    this.tonemap?.dispose();
    this.glint?.dispose();
    this.ao?.dispose();
    this.down?.dispose();
  }
}

export function createLayer3DRenderer(): LayerRenderer {
  return new Layer3DRendererImpl();
}

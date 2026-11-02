import * as THREE from 'three';
import { getAsset } from '../../assets/registry';
import { effectReach } from '../../effects/registry';
import { decodeImage, getBitmap } from '../../engine/layer2d/images';
import { followTarget, generatorParams, getGenerator } from '../../generators/registry';
import { bandsGrow, letterOutside } from '../../model/bands';
import { isTitleLayer, parsePartKey, type TitleLayer } from '../../model/parts';
import type { Band3D, BevelShape3D, CharAdjust, Comp, EffectInstance, GeneratorLayer, ImageSource, Layer, PartKey, Title2DLayer, Title3DLayer } from '../../model/types';
import { outlinedShapeCmds, outlinedTextLayout } from '../../text/ink';
import { cmdsBounds, type Bounds, type PathCmd, type TextLayout } from '../../text/layout';
import { plateBaseCmds } from '../../text/plate';
import { traceImage } from '../../text/trace';

// Editor-side geometry for on-canvas manipulation. Everything is in comp space:
// px, origin = comp centre, +y UP. Layer transform convention (shared with the renderers):
// p_comp = position + R(-rotZ°) · (scale · F · p_layer), F = diag(flipX ? −1 : 1, flipY ? −1 : 1)
// — rotZ positive is clockwise on screen, the flip mirrors about the position before rotZ.
// `toComp` / `fromComp` / `boxCorners` / `layerCompBounds` are that flat affine map (3D layers
// approximated by their z = 0 footprint; store/arrange.ts relies on it). `layerView` is exact:
// 3D layers go through the layer's 3D transform and the comp camera, like the renderer.

export interface Pt {
  x: number;
  y: number;
}

const DEG = Math.PI / 180;

/** The layer's text layout after its warp → distort → weight, or null (not text / font loading). */
export function layerTextLayout(layer: Layer): TextLayout | null {
  if (!isTitleLayer(layer) || layer.source.kind !== 'text') return null;
  return outlinedTextLayout(layer.source, layer);
}

// Aspect ratios (w / h) of SVG assets, parsed once; images use the shared decoded bitmaps.
const aspects = new Map<string, number>();
const aspectListeners = new Set<() => void>();
export function onAspectsChanged(l: () => void): () => void {
  aspectListeners.add(l);
  return () => {
    aspectListeners.delete(l);
  };
}

/** The decoded bitmap of an image asset, or undefined while it decodes (the aspect listeners fire once it is decoded). */
function decodedImage(assetId: string): ImageBitmap | undefined {
  const bmp = getBitmap(assetId);
  if (!bmp)
    void decodeImage(assetId).then(() => {
      if (getBitmap(assetId)) aspectListeners.forEach((l) => l());
    });
  return bmp;
}

/** w / h of an image or SVG asset; 1 while an image decodes or when the asset is missing. */
function assetAspect(assetId: string, kind: 'svg' | 'image'): number {
  if (kind === 'image') {
    const bmp = decodedImage(assetId);
    return bmp ? bmp.width / bmp.height : 1;
  }
  const known = aspects.get(assetId);
  if (known !== undefined) return known;
  const a = getAsset(assetId);
  if (!a) return 1;
  const doc = new DOMParser().parseFromString(new TextDecoder().decode(a.data), 'image/svg+xml').documentElement;
  const vb = doc.getAttribute('viewBox')?.split(/[\s,]+/).map(Number);
  const w = vb?.length === 4 ? vb[2] : parseFloat(doc.getAttribute('width') ?? '');
  const h = vb?.length === 4 ? vb[3] : parseFloat(doc.getAttribute('height') ?? '');
  aspects.set(assetId, w > 0 && h > 0 ? w / h : 1);
  return aspects.get(assetId)!;
}

/**
 * A 3D image layer's traced outline (src/text/trace.ts, the one the renderer extrudes), or null
 * while the bitmap decodes: boxes then fall back to the fitted image and the aspect listeners
 * fire once it is decoded.
 */
function tracedImage(src: ImageSource): PathCmd[] | null {
  const bmp = decodedImage(src.assetId);
  return bmp ? traceImage(bmp, src.size, src.trace) : null;
}

/**
 * Box of the source itself in layer space (y-up, unscaled): outlined (warped / distorted /
 * weighted) ink bounds for text and shapes, the traced outline's bounds for 3D images, the
 * fitted asset box otherwise. This is the box a 'layer'-span gradient spans. Null for
 * backgrounds and groups.
 */
export function sourceBounds(layer: Layer): Bounds | null {
  if (!isTitleLayer(layer)) return null;
  const src = layer.source;
  if (src.kind === 'text') {
    const lay = outlinedTextLayout(src, layer);
    return lay && lay.glyphs.length > 0 ? lay.bounds : null;
  }
  if (src.kind === 'shape') {
    const cmds = outlinedShapeCmds(src, layer);
    return cmds.length > 0 ? cmdsBounds(cmds) : null;
  }
  if (src.kind === 'image' && layer.kind === 'title3d') {
    const cmds = tracedImage(src);
    if (cmds && cmds.length > 0) return cmdsBounds(cmds);
  }
  const ar = src.kind === 'model' ? 1 : assetAspect(src.assetId, src.kind);
  const w = ar >= 1 ? src.size : src.size * ar;
  const h = ar >= 1 ? src.size / ar : src.size;
  return { x0: -w / 2, y0: -h / 2, x1: w / 2, y1: h / 2 };
}

/**
 * Miter limits of the renderers, in multiples of the grow distance: 2D rims stroke on Canvas2D
 * (Title2DRenderer MITER_LIMIT; a sharper corner falls back to a bevel), 3D bands offset with
 * Clipper (outline.ts MITER_LIMIT; a sharper corner is squared off at the limit).
 */
const RIM_MITER_LIMIT = 4;
const PLATE_MITER_LIMIT = 2;

const grow = (b: Bounds, pad: number): Bounds => ({ x0: b.x0 - pad, y0: b.y0 - pad, x1: b.x1 + pad, y1: b.y1 + pad });
const union = (a: Bounds, b: Bounds): Bounds => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) });

/** The source's outline in layer space (all glyphs of a text; warped / distorted / weighted; a 3D image's trace), or null for other asset sources. */
const flatGlyphs = new WeakMap<TextLayout, PathCmd[]>();
export function sourceOutline(layer: TitleLayer): PathCmd[] | null {
  const src = layer.source;
  if (src.kind === 'shape') return outlinedShapeCmds(src, layer);
  if (src.kind === 'image' && layer.kind === 'title3d') return tracedImage(src);
  if (src.kind !== 'text') return null;
  const lay = outlinedTextLayout(src, layer);
  if (!lay) return null;
  let cmds = flatGlyphs.get(lay);
  if (!cmds) flatGlyphs.set(lay, (cmds = lay.glyphs.flatMap((g) => g.cmds)));
  return cmds;
}

/**
 * Bounds of the outline `cmds` grown by `g` px with `join`, as the renderers draw it: round
 * joins are the box grown by g; miter joins add each convex corner's miter tip (up to `limit`
 * × g; past it 'bevel' keeps only the edge offsets, 'square' cuts the tip at the limit). Curve
 * control points count as polygon vertices (a slight over-estimate on curves).
 */
function grownBounds(cmds: PathCmd[], g: number, join: 'miter' | 'round' | 'bevel', limit: number, past: 'bevel' | 'square'): Bounds {
  const b = cmdsBounds(cmds);
  if (!(g > 0) || join === 'round') return grow(b, Math.max(0, g));
  const out = { ...b };
  const add = (x: number, y: number) => {
    if (x < out.x0) out.x0 = x;
    if (x > out.x1) out.x1 = x;
    if (y < out.y0) out.y0 = y;
    if (y > out.y1) out.y1 = y;
  };
  const ring = (pts: Pt[]) => {
    if (pts.length > 1 && pts[0].x === pts.at(-1)!.x && pts[0].y === pts.at(-1)!.y) pts.pop();
    const n = pts.length;
    if (n < 3) return;
    let area = 0;
    for (let i = 0; i < n; i++) area += pts[i].x * pts[(i + 1) % n].y - pts[(i + 1) % n].x * pts[i].y;
    const s = area >= 0 ? 1 : -1; // outward normal of edge a→b is s·(dy, −dx) in y-up space
    for (let i = 0; i < n; i++) {
      const a = pts[(i + n - 1) % n];
      const v = pts[i];
      const c = pts[(i + 1) % n];
      const l1 = Math.hypot(v.x - a.x, v.y - a.y);
      const l2 = Math.hypot(c.x - v.x, c.y - v.y);
      if (l1 < 1e-9 || l2 < 1e-9) continue;
      const n1 = { x: (s * (v.y - a.y)) / l1, y: (-s * (v.x - a.x)) / l1 };
      const n2 = { x: (s * (c.y - v.y)) / l2, y: (-s * (c.x - v.x)) / l2 };
      add(v.x + n1.x * g, v.y + n1.y * g);
      add(v.x + n2.x * g, v.y + n2.y * g);
      if (join !== 'miter') continue;
      const turn = s * ((v.x - a.x) * (c.y - v.y) - (v.y - a.y) * (c.x - v.x));
      if (turn <= 0) continue; // concave: the miter tip falls inside the grown shape
      const mx = n1.x + n2.x;
      const my = n1.y + n2.y;
      const ml = Math.hypot(mx, my);
      if (ml < 1e-9) continue;
      const reach = 2 / ml; // miter length ÷ g = 1 / cos(half the turn)
      if (reach <= limit) add(v.x + (mx / ml) * g * reach, v.y + (my / ml) * g * reach);
      else if (past === 'square') add(v.x + (mx / ml) * g * limit, v.y + (my / ml) * g * limit);
    }
  };
  let pts: Pt[] = [];
  for (const c of cmds) {
    if (c.type === 'M') {
      ring(pts);
      pts = [{ x: c.x, y: c.y }];
    } else if (c.type === 'Z') {
      ring(pts);
      pts = [];
    } else {
      if (c.type === 'Q') pts.push({ x: c.x1, y: c.y1 });
      if (c.type === 'C') pts.push({ x: c.x1, y: c.y1 }, { x: c.x2, y: c.y2 });
      pts.push({ x: c.x, y: c.y });
    }
  }
  ring(pts);
  return out;
}

/** How far a 3D letter's bevel reaches past its outline, layer px (model/bands.ts letterOutside); 0 for 2D layers, models and orbs. */
function letterReach(layer: TitleLayer): number {
  if (layer.kind !== 'title3d') return 0;
  const src = layer.source;
  if (src.kind === 'model' || (src.kind === 'shape' && src.shape === 'orb')) return 0;
  return (letterOutside(layer.style3d) / 100) * src.size;
}

/**
 * How far each band's edge reaches beyond the outline, layer px, by band id: the letter's reach
 * plus the running sum of the enabled bands' grows, as the engine stacks them (a disabled band
 * counts its own grow, so it shows where it would sit). Empty for GLB models (no bands).
 */
function bandReaches(layer: Title3DLayer): Map<string, number> {
  const out = new Map<string, number>();
  if (layer.source.kind === 'model') return out;
  const k = layer.source.size / 100;
  let reach = letterReach(layer);
  for (const b of layer.style3d.bands) {
    const own = reach + Math.max(0, b.grow) * k;
    out.set(b.id, own);
    if (b.enabled) reach = own;
  }
  return out;
}

/** Box of band `b` grown `reach` from its base shape (contour / hull / box) of the outline `cmds`. */
function bandBounds(cmds: PathCmd[], b: Band3D, reach: number, size: number, shear: number): Bounds {
  return grownBounds(plateBaseCmds(cmds, b.shape, size, shear), reach, b.join, PLATE_MITER_LIMIT, 'square');
}

/**
 * Reach of the style outside the source box, layer px, for sources without vector outlines
 * (images / SVG / models): the running sum of rim widths (plus drops), or the letter's bevel
 * reach plus the enabled bands' grows.
 */
function uniformPad(layer: TitleLayer): number {
  const k = layer.source.size / 100;
  if (layer.kind === 'title2d') {
    let grown = 0;
    let off = 0;
    for (const r of layer.style.rims) {
      if (!r.enabled) continue;
      grown += r.width;
      off = Math.max(off, Math.hypot(r.offsetX, r.offsetY));
    }
    return (grown + off) * k;
  }
  return layer.source.kind === 'model' ? 0 : letterReach(layer) + bandsGrow(layer.style3d) * k;
}

const localBoundsCache = new WeakMap<Layer, Bounds>();

/**
 * The box a generator layer can draw into, layer space (y-up, unscaled): its def's
 * `bounds(params)`. Null for full-frame types (and unknown types), which cover the whole comp,
 * and for generators following a layer, whose box depends on that layer (followBounds): both are
 * picked only where they draw.
 */
export function generatorBounds(layer: GeneratorLayer): Bounds | null {
  const def = getGenerator(layer.generator.type);
  return def && !followTarget(layer.generator) ? def.bounds(generatorParams(layer.generator)) : null;
}

/**
 * Layer-space box a generator following a layer of `layers` draws into: that layer's comp box
 * (a group's: its members') grown by the def's `followReach`, seen through the generator's own
 * transform. Null when it is not following, the layer draws nothing or it then fills the comp.
 */
export function followBounds(layers: readonly Layer[], layer: GeneratorLayer): Bounds | null {
  const id = followTarget(layer.generator);
  const reach = id ? getGenerator(layer.generator.type)?.followReach?.(generatorParams(layer.generator)) : null;
  if (reach === null || reach === undefined) return null;
  const inside = new Set([id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const l of layers)
      if (l.parentId !== undefined && inside.has(l.parentId) && !inside.has(l.id)) {
        inside.add(l.id);
        grew = true;
      }
  }
  const boxes = layers.filter((l) => inside.has(l.id) && l.kind !== 'generator').map(layerCompBounds).filter((b): b is Bounds => b !== null);
  if (!boxes.length) return null;
  const b = grow(ptsBounds(boxes.flatMap((x) => [{ x: x.x0, y: x.y0 }, { x: x.x1, y: x.y1 }])), reach);
  return ptsBounds([{ x: b.x0, y: b.y0 }, { x: b.x1, y: b.y0 }, { x: b.x0, y: b.y1 }, { x: b.x1, y: b.y1 }].map((p) => fromComp(layer, p)));
}

/** A generator layer that fills the whole comp or follows a layer (no box of its own): picked only where it draws. */
export const isFullFrame = (layer: Layer): boolean => layer.kind === 'generator' && !layerLocalBounds(layer);

/**
 * Bounds of the layer's drawn content in layer space (y-up, unscaled), as rendered: the source
 * plus every enabled 2D rim (grown from its plate base by the running sum of widths, with its
 * join and drop offset), or the 3D letter's bevel reaching past the outline (bevelPosition) and
 * every enabled band grown from that silhouette; a generator's `bounds`, or with `layers` a
 * following one's followBounds. Null for backgrounds / groups / adjustments / full-frame
 * generators / loading / empty. Used for the selection box, picking, snapping and aligning.
 * Memoized per (immutable) layer object, except following generators.
 */
export function layerLocalBounds(layer: Layer, layers?: readonly Layer[]): Bounds | null {
  if (layer.kind === 'generator') {
    if (followTarget(layer.generator)) return layers ? followBounds(layers, layer) : null;
    const hit = localBoundsCache.get(layer);
    if (hit) return hit;
    const b = generatorBounds(layer);
    if (b) localBoundsCache.set(layer, b);
    return b;
  }
  if (!isTitleLayer(layer)) return null;
  const hit = localBoundsCache.get(layer);
  if (hit) return hit;
  const b = sourceBounds(layer);
  if (!b) return null;
  const cmds = sourceOutline(layer);
  const size = layer.source.size;
  const k = size / 100;
  let u = b;
  if (!cmds || cmds.length === 0) u = grow(b, uniformPad(layer));
  else {
    const shear = layer.source.kind === 'text' ? layer.source.shear : 0;
    let grown = letterReach(layer);
    if (layer.kind === 'title2d')
      for (const r of layer.style.rims) {
        if (!r.enabled || !(r.width > 0)) continue;
        grown += r.width * k;
        const rb = grownBounds(plateBaseCmds(cmds, r.plate, size, shear), grown, r.join, RIM_MITER_LIMIT, 'bevel');
        const dx = r.offsetX * k;
        const dy = -r.offsetY * k; // offsetY is +down on screen
        u = union(u, { x0: rb.x0 + dx, y0: rb.y0 + dy, x1: rb.x1 + dx, y1: rb.y1 + dy });
      }
    else {
      if (grown > 0) u = union(u, grownBounds(cmds, grown, 'miter', PLATE_MITER_LIMIT, 'square'));
      const reach = bandReaches(layer);
      for (const band of layer.style3d.bands) if (band.enabled) u = union(u, bandBounds(cmds, band, reach.get(band.id) ?? grown, size, shear));
    }
  }
  // An image still decoding has a square stand-in box (and a 3D one no trace yet): it must not stick.
  if (layer.source.kind !== 'image' || getBitmap(layer.source.assetId)) localBoundsCache.set(layer, u);
  return u;
}

/**
 * `layerLocalBounds` plus the reach of the layer's effects (glows, shadows) and of its widest
 * part's own effects (they act on that part's pixels, before the layer effects): the drawn
 * selection box. With `layers`, a generator following one of them has its box too.
 */
export function layerSelectionBounds(layer: Layer, layers?: readonly Layer[]): Bounds | null {
  const b = layerLocalBounds(layer, layers);
  if (!b) return null;
  const sum = (list: readonly EffectInstance[] | undefined) => (list ?? []).reduce((s, fx) => s + effectReach(fx), 0);
  const partReach = isTitleLayer(layer) ? Math.max(0, ...Object.values(layer.partEffects).map(sum)) : 0;
  const reach = sum(layer.effects) + partReach; // comp px; each effect grows the result of the ones below
  return reach > 0 ? grow(b, reach / Math.max(1e-6, Math.abs(layer.transform.scale))) : b;
}

/** One 2D rim as Title2DRenderer builds its element (layer px, +y up). */
export interface Rim2DFrame {
  /** Box of the plate base outline the rim grows from (before grow / offset). */
  base: Bounds;
  /** That outline; null for asset sources (their box grows uniformly). */
  baseCmds: PathCmd[] | null;
  /** Running sum of the enabled rim widths up to and including this rim. */
  grow: number;
  join: 'miter' | 'round' | 'bevel';
  /** Drop offset, +y up. */
  dx: number;
  dy: number;
}

/**
 * Rim `rimId` of a 2D layer as the renderer grows it: from its plate base by the running sum of
 * the enabled rim widths (a disabled rim counts its own width, so it shows where it would sit).
 * Null when the layer has no box yet or no such rim.
 */
export function rim2DFrame(layer: Title2DLayer, rimId: string): Rim2DFrame | null {
  const src = sourceBounds(layer);
  if (!src) return null;
  const cmds = sourceOutline(layer);
  const size = layer.source.size;
  const k = size / 100;
  const shear = layer.source.kind === 'text' ? layer.source.shear : 0;
  let g = 0;
  for (const r of layer.style.rims) {
    const w = Math.max(0, r.width) * k;
    if (r.id !== rimId) {
      if (r.enabled) g += w;
      continue;
    }
    const baseCmds = cmds && cmds.length > 0 ? plateBaseCmds(cmds, r.plate, size, shear) : null;
    return { base: baseCmds ? cmdsBounds(baseCmds) : src, baseCmds, grow: g + w, join: r.join, dx: r.offsetX * k, dy: -r.offsetY * k };
  }
  return null;
}

/**
 * Layer-space box of one style part as drawn: the 2D face is the source box; a 2D rim its grown
 * plate (join and drop offset included); the 3D face (with the letter's bevel) and side walls
 * the letter's silhouette; a 3D band its grown base shape. Null when there is no box or no such
 * part.
 */
export function partLocalBounds(layer: TitleLayer, part: PartKey): Bounds | null {
  const b = sourceBounds(layer);
  if (!b) return null;
  const { kind, id } = parsePartKey(part);
  if (layer.kind === 'title2d') {
    if (kind === 'face') return b;
    const f = kind === 'rim' && id ? rim2DFrame(layer, id) : null;
    if (!f) return null;
    const rb = f.baseCmds ? grownBounds(f.baseCmds, f.grow, f.join, RIM_MITER_LIMIT, 'bevel') : grow(f.base, f.grow);
    return { x0: rb.x0 + f.dx, y0: rb.y0 + f.dy, x1: rb.x1 + f.dx, y1: rb.y1 + f.dy };
  }
  const cmds = sourceOutline(layer);
  const pathed = !!cmds && cmds.length > 0;
  if (kind === 'face' || kind === 'side') {
    const reach = letterReach(layer);
    return !pathed ? grow(b, reach) : reach > 0 ? grownBounds(cmds, reach, 'miter', PLATE_MITER_LIMIT, 'square') : b;
  }
  const band = layer.style3d.bands.find((x) => x.id === id);
  const reach = band && bandReaches(layer).get(band.id);
  if (!band || reach === undefined) return null;
  const shear = layer.source.kind === 'text' ? layer.source.shear : 0;
  return pathed ? bandBounds(cmds, band, reach, layer.source.size, shear) : grow(b, reach);
}

/** The layer's flip as signs: −1 on a mirrored axis. */
const flipSigns = (t: Layer['transform']) => ({ fx: t.flipX ? -1 : 1, fy: t.flipY ? -1 : 1 });

export function toComp(layer: Layer, p: Pt): Pt {
  const t = layer.transform;
  const { fx, fy } = flipSigns(t);
  const a = -t.rotZ * DEG;
  const x = p.x * t.scale * fx;
  const y = p.y * t.scale * fy;
  return { x: t.x + x * Math.cos(a) - y * Math.sin(a), y: t.y + x * Math.sin(a) + y * Math.cos(a) };
}

export function fromComp(layer: Layer, p: Pt): Pt {
  const t = layer.transform;
  const { fx, fy } = flipSigns(t);
  const a = t.rotZ * DEG;
  const x = p.x - t.x;
  const y = p.y - t.y;
  const s = t.scale || 1e-6;
  return { x: ((x * Math.cos(a) - y * Math.sin(a)) / s) * fx, y: ((x * Math.sin(a) + y * Math.cos(a)) / s) * fy };
}

/**
 * Layer-space corners of `b` in the order that lands TL, TR, BR, BL on screen through the
 * layer's flip (a flipped layer's box keeps its handles' screen roles: the rotate stem on top,
 * the corner cursors matching their diagonals).
 */
export function flipCorners(b: Bounds, flip: { flipX: boolean; flipY: boolean }): Pt[] {
  const [l, r] = flip.flipX ? [b.x1, b.x0] : [b.x0, b.x1];
  const [t, d] = flip.flipY ? [b.y0, b.y1] : [b.y1, b.y0];
  return [
    { x: l, y: t },
    { x: r, y: t },
    { x: r, y: d },
    { x: l, y: d },
  ];
}

/** Corners of a layer-space box in comp space: TL, TR, BR, BL (screen order). */
export function boxCorners(layer: Layer, b: Bounds): Pt[] {
  return flipCorners(b, layer.transform).map((p) => toComp(layer, p));
}

export const inBounds = (b: Bounds, p: Pt) => p.x >= b.x0 && p.x <= b.x1 && p.y >= b.y0 && p.y <= b.y1;

/** Axis-aligned box around points. */
export function ptsBounds(pts: readonly Pt[]): Bounds {
  return {
    x0: Math.min(...pts.map((p) => p.x)),
    y0: Math.min(...pts.map((p) => p.y)),
    x1: Math.max(...pts.map((p) => p.x)),
    y1: Math.max(...pts.map((p) => p.y)),
  };
}

/** Axis-aligned comp-space box of the layer's (rotated, scaled) content box, or null. */
export function layerCompBounds(layer: Layer): Bounds | null {
  const b = layerLocalBounds(layer);
  return b ? ptsBounds(boxCorners(layer, b)) : null;
}

// ---------- exact layer → comp projection (3D layers through the comp camera) ----------

/**
 * Layer space ↔ comp space for one layer. `z` is layer-space depth (+ toward the viewer,
 * 0 = the front face); 2D layers ignore it.
 */
export interface LayerView {
  readonly is3D: boolean;
  /** The layer's flip (Transform.flipX / flipY), for screen-ordered corners (`flipCorners`). */
  readonly flipX: boolean;
  readonly flipY: boolean;
  toComp(p: Pt, z?: number): Pt;
  /** Comp point → layer-space point on the layer plane at depth `z`; null when that plane is edge-on or behind the camera. */
  fromComp(p: Pt, z?: number): Pt | null;
}

/** The comp camera exactly as Engine sets it up (1 world unit = 1 comp px on z = 0). */
export function compCamera(comp: Comp): THREE.PerspectiveCamera {
  const c = comp.camera;
  const fov = Math.min(170, Math.max(1, c.fov));
  const dist = comp.height / 2 / Math.tan((fov * DEG) / 2);
  const cam = new THREE.PerspectiveCamera(fov, comp.width / comp.height, Math.max(1, dist * 0.01), dist * 20);
  cam.position.set(c.x, c.y, dist + c.zOffset);
  cam.rotation.set(c.rotX * DEG, c.rotY * DEG, c.rotZ * DEG);
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld();
  return cam;
}

/** Layer → world matrix as in Layer3DRenderer (position, rotation X→Y→Z with rotZ clockwise, uniform scale; the flip mirrors layer x / y before the rotation). */
export function layerMatrix(layer: Layer): THREE.Matrix4 {
  const t = layer.transform;
  const { fx, fy } = flipSigns(t);
  const s = t.scale || 1e-6;
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(t.rotX * DEG, t.rotY * DEG, -t.rotZ * DEG, 'ZYX'));
  return new THREE.Matrix4().compose(new THREE.Vector3(t.x, t.y, t.z), q, new THREE.Vector3(s * fx, s * fy, s));
}

export function layerView(comp: Comp, layer: Layer): LayerView {
  const { flipX, flipY } = layer.transform;
  if (layer.kind !== 'title3d') {
    return { is3D: false, flipX, flipY, toComp: (p) => toComp(layer, p), fromComp: (p) => fromComp(layer, p) };
  }
  const cam = compCamera(comp);
  const m = layerMatrix(layer);
  const inv = m.clone().invert();
  // Oblique extrusion: every point is sheared by skew × its depth behind the front face.
  const { x: kx, y: ky } = layer.style3d.skew;
  const hw = comp.width / 2;
  const hh = comp.height / 2;
  const v = new THREE.Vector3();
  const o = new THREE.Vector3();
  return {
    is3D: true,
    flipX,
    flipY,
    toComp(p, z = 0) {
      v.set(p.x - kx * z, p.y - ky * z, z).applyMatrix4(m).project(cam);
      return { x: v.x * hw, y: v.y * hh };
    },
    fromComp(p, z = 0) {
      o.copy(cam.position).applyMatrix4(inv);
      v.set(p.x / hw, p.y / hh, 0.5).unproject(cam).applyMatrix4(inv).sub(o);
      if (Math.abs(v.z) < 1e-9) return null;
      const t = (z - o.z) / v.z;
      if (!(t > 0)) return null;
      return { x: o.x + v.x * t + kx * z, y: o.y + v.y * t + ky * z };
    },
  };
}

/** Corners of a layer-space box (at depth z) through `view`: TL, TR, BR, BL (screen order, see `flipCorners`). */
export function viewCorners(view: LayerView, b: Bounds, z = 0): Pt[] {
  return flipCorners(b, view).map((p) => view.toComp(p, z));
}

/** SVG path data of outline `cmds` mapped point by point through `map` onto the overlay (an affine map keeps curves exact). */
export function svgPath(cmds: readonly PathCmd[], map: (p: Pt) => Pt): string {
  const q = (x: number, y: number) => {
    const p = map({ x, y });
    return `${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
  };
  return cmds
    .map((c) =>
      c.type === 'Z' ? 'Z' : c.type === 'Q' ? `Q${q(c.x1, c.y1)} ${q(c.x, c.y)}` : c.type === 'C' ? `C${q(c.x1, c.y1)} ${q(c.x2, c.y2)} ${q(c.x, c.y)}` : `${c.type}${q(c.x, c.y)}`,
    )
    .join('');
}

/** Point-in-convex-or-not polygon (even-odd). */
export function inPolygon(poly: readonly Pt[], p: Pt): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y || 1e-12) + a.x) inside = !inside;
  }
  return inside;
}

/** Is p within `tol` of any edge of the closed polygon? */
export function nearPolygon(poly: readonly Pt[], p: Pt, tol: number): boolean {
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j];
    const b = poly[i];
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / (vx * vx + vy * vy || 1)));
    if (Math.hypot(p.x - a.x - vx * t, p.y - a.y - vy * t) <= tol) return true;
  }
  return false;
}

/** Does the comp-space polygon of the layer's content contain p (exact for 3D layers)? Never for boxless layers (full-frame generators: see pick.ts). */
export function layerHit(comp: Comp, layer: Layer, p: Pt): boolean {
  const b = layerLocalBounds(layer);
  return !!b && inPolygon(viewCorners(layerView(comp, layer), b), p);
}

// ---------- glyphs ----------

export interface GlyphBox {
  index: number;
  char: string;
  /** Line / column index (key of TextSource.lines). */
  line: number;
  /** Ink box, layer space (warped, per-character 2D adjustments applied). */
  box: Bounds;
  /** Pivot of the glyph's scale / rotate / tilt (PlacedGlyph.center). */
  center: Pt;
  /** Outline, layer space (warped, adjusted). */
  cmds: PathCmd[];
}

/** Glyph boxes (layer space, warped) of a text layer, for per-character picking/highlighting. */
export function glyphBoxes(layer: Layer): GlyphBox[] {
  const lay = layerTextLayout(layer);
  return lay ? lay.glyphs.map((g) => ({ index: g.index, char: g.char, line: g.line, box: cmdsBounds(g.cmds), center: g.center, cmds: g.cmds })) : [];
}

/** How far a bevel drops in z from its start (% of size): its depth, −depth for 'inset' (it rises), 0 for 'tube' (back at its start height); 0 without a bevel. */
const bevelDrop = (b: BevelShape3D): number => (b.width > 0 ? (b.profile === 'inset' ? -b.depth : b.profile === 'tube' ? 0 : b.depth) : 0);

/**
 * Depth of the per-glyph tilt pivot on 3D layers: the middle of the letter's solid (title.ts
 * pivotZ: half its back, the letter's bevel drop plus its depth; % of size → layer px).
 */
export function glyphPivotZ(layer: Layer): number {
  if (layer.kind !== 'title3d') return 0;
  const s = layer.style3d;
  const drop = s.mode === 'extrude' ? bevelDrop(s.bevel) : 0;
  return (-(drop + s.depth) / 2 / 100) * layer.source.size;
}

/**
 * A layer-space point of glyph `g` (z = 0 front face) after the 3D-only adjustments in `a`:
 * Rx(tiltX) then Ry(tiltY) about (center, pivotZ), then the z push. Same as Geo3D.
 */
export function glyphPoint3(layer: Layer, center: Pt, a: Pick<CharAdjust, 'dz' | 'tiltX' | 'tiltY'> | undefined, p: Pt, z = 0): { p: Pt; z: number } {
  if (layer.kind !== 'title3d' || !a) return { p, z };
  const zp = glyphPivotZ(layer);
  const tx = (a.tiltX ?? 0) * DEG;
  const ty = (a.tiltY ?? 0) * DEG;
  let x = p.x - center.x;
  let y = p.y - center.y;
  let w = z - zp;
  // Rx(tx)
  const y1 = y * Math.cos(tx) - w * Math.sin(tx);
  w = y * Math.sin(tx) + w * Math.cos(tx);
  y = y1;
  // Ry(ty)
  const x1 = x * Math.cos(ty) + w * Math.sin(ty);
  w = -x * Math.sin(ty) + w * Math.cos(ty);
  x = x1;
  return { p: { x: x + center.x, y: y + center.y }, z: w + zp + ((a.dz ?? 0) / 100) * layer.source.size };
}

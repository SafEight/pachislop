import type opentype from 'opentype.js';
import { getFont } from '../assets/registry';
import type { Distort, ShapeSource, TextSource, Title2DLayer, Title3DLayer, Warp } from '../model/types';
import { distortCmds, distortIsIdentity, distortLayout } from './distort';
import { cmdsBounds, layoutText, type Bounds, type PathCmd, type TextLayout } from './layout';
import { weightCmds } from './offset';
import { shapeCmds } from './shapes';
import { warpCmds, warpFrame, warpIsIdentity, warpLayout } from './warp';

export { distortPoint } from './distort';

// Source outlines after the layer's outline operations, in order warp → distort → weight
// (rims, bevels and extrusion then grow from the result, so ring widths stay even). Shared by
// the renderers and the editor (selection boxes, fit-to-content, picking, SVG export). Every
// stage is memoized on the identity of its input and of its op object (sources and ops are
// immutable store objects), so per-frame calls stay cheap and an identity op returns its
// input itself, keeping downstream caches hot.

/** The outline operations of a title layer. */
export type OutlineOpsOf = Pick<Title2DLayer | Title3DLayer, 'warp' | 'distort' | 'weight'>;

/** Weighted results kept per input (scrubbing the weight walks through values). */
const WEIGHT_KEEP = 4;

function memo<K extends object, O extends object, V>(cache: WeakMap<K, WeakMap<O, V>>, key: K, op: O, make: () => V): V {
  let inner = cache.get(key);
  if (!inner) cache.set(key, (inner = new WeakMap()));
  let v = inner.get(op);
  if (v === undefined) inner.set(op, (v = make()));
  return v;
}

function memoWeight<K extends object, V>(cache: WeakMap<K, Map<number, V>>, key: K, weight: number, make: () => V): V {
  let inner = cache.get(key);
  if (!inner) cache.set(key, (inner = new Map()));
  let v = inner.get(weight);
  if (v === undefined) {
    v = make();
    inner.set(weight, v);
    if (inner.size > WEIGHT_KEEP) inner.delete(inner.keys().next().value!);
  }
  return v;
}

// ---------- text ----------

const layoutCache = new WeakMap<TextSource, { font: opentype.Font; layout: TextLayout }>();
const warpCache = new WeakMap<TextLayout, WeakMap<Warp, TextLayout>>();
const distortCache = new WeakMap<TextLayout, WeakMap<Distort, TextLayout>>();
const weightCache = new WeakMap<TextLayout, Map<number, TextLayout>>();

/** Every glyph grown / shrunk by `delta` px; glyphs that vanish are dropped. */
function weightLayout(layout: TextLayout, delta: number, size: number): TextLayout {
  const glyphs = layout.glyphs.map((g) => ({ ...g, cmds: weightCmds(g.cmds, delta, size) })).filter((g) => g.cmds.length > 0);
  if (glyphs.length === 0) {
    const c = { x: (layout.frame.x0 + layout.frame.x1) / 2, y: (layout.frame.y0 + layout.frame.y1) / 2 };
    return { glyphs, bounds: { x0: c.x, y0: c.y, x1: c.x, y1: c.y }, frame: layout.frame };
  }
  const bounds = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const g of glyphs) cmdsBounds(g.cmds, bounds);
  return { glyphs, bounds, frame: layout.frame };
}

/** The layout after the warp only: its frame is the box the distort offsets refer to. */
function warpedLayout(src: TextSource, warp: Warp, font?: opentype.Font): TextLayout | null {
  const f = font ?? getFont(src.fontId)?.font;
  if (!f) return null;
  let entry = layoutCache.get(src);
  if (!entry || entry.font !== f) layoutCache.set(src, (entry = { font: f, layout: layoutText(src, f) }));
  const lay = entry.layout;
  return warpIsIdentity(warp) ? lay : memo(warpCache, lay, warp, () => warpLayout(lay, warp));
}

/**
 * A text source's layout after the layer's warp → distort → weight, per glyph (so picking and
 * per-character overrides follow), or null while its font loads. `font` defaults to the
 * registry font of `src.fontId`. `frame` is the warped, UNdistorted frame (the box the distort
 * offsets refer to); `bounds` / glyph `center`s follow every op (weight leaves centres).
 */
export function outlinedTextLayout(src: TextSource, ops: OutlineOpsOf, font?: opentype.Font): TextLayout | null {
  const warped = warpedLayout(src, ops.warp, font);
  if (!warped) return null;
  const d = ops.distort;
  const distorted = distortIsIdentity(d) ? warped : memo(distortCache, warped, d, () => distortLayout(warped, d));
  const delta = (ops.weight / 100) * src.size;
  if (delta === 0 || distorted.glyphs.length === 0) return distorted;
  return memoWeight(weightCache, distorted, ops.weight, () => weightLayout(distorted, delta, src.size));
}

// ---------- shapes ----------

interface ShapeStage {
  cmds: PathCmd[];
  /** The box the next op maps over (the warped frame after the warp). */
  frame: Bounds;
}

const shapeBase = new WeakMap<ShapeSource, ShapeStage>();
const shapeWarp = new WeakMap<ShapeStage, WeakMap<Warp, ShapeStage>>();
const shapeDistort = new WeakMap<ShapeStage, WeakMap<Distort, ShapeStage>>();
const shapeWeight = new WeakMap<ShapeStage, Map<number, ShapeStage>>();

function warpedShape(src: ShapeSource, warp: Warp): ShapeStage {
  let base = shapeBase.get(src);
  if (!base) {
    const cmds = shapeCmds(src);
    shapeBase.set(src, (base = { cmds, frame: cmds.length ? cmdsBounds(cmds) : { x0: 0, y0: 0, x1: 0, y1: 0 } }));
  }
  const b = base;
  if (warpIsIdentity(warp) || b.cmds.length === 0) return b;
  return memo(shapeWarp, b, warp, () => ({ cmds: warpCmds(b.cmds, b.frame, warp), frame: warpFrame(b.frame, warp) }));
}

/** A shape source's outline after the layer's warp → distort → weight (over the shape's own bounds). */
export function outlinedShapeCmds(src: ShapeSource, ops: OutlineOpsOf): PathCmd[] {
  const warped = warpedShape(src, ops.warp);
  if (warped.cmds.length === 0) return warped.cmds;
  const d = ops.distort;
  const distorted = distortIsIdentity(d)
    ? warped
    : memo(shapeDistort, warped, d, () => ({ cmds: distortCmds(warped.cmds, warped.frame, d), frame: warped.frame }));
  const delta = (ops.weight / 100) * src.size;
  if (delta === 0) return distorted.cmds;
  return memoWeight(shapeWeight, distorted, ops.weight, () => ({ cmds: weightCmds(distorted.cmds, delta, src.size), frame: distorted.frame })).cmds;
}

// ---------- editor helpers ----------

type TitleLike = Pick<Title2DLayer | Title3DLayer, 'source'>;

/**
 * The box a title's distort offsets refer to, in layer space (y-up): the warped, undistorted
 * frame of its text block / shape (`outlinedTextLayout(...).frame` for text). Null for SVG /
 * image / model sources, while the font loads, or when there is no outline.
 */
export function distortFrame(layer: TitleLike & Pick<Title2DLayer | Title3DLayer, 'warp'>, font?: opentype.Font): Bounds | null {
  const src = layer.source;
  if (src.kind === 'text') {
    const lay = warpedLayout(src, layer.warp, font);
    return lay && lay.glyphs.length > 0 ? lay.frame : null;
  }
  if (src.kind === 'shape') {
    const s = warpedShape(src, layer.warp);
    return s.cmds.length > 0 ? s.frame : null;
  }
  return null;
}

/**
 * Ink bounds of a title's text / shape outline after its warp → distort → weight, in layer
 * space (comp px at the source size, y-up, transform not applied, style reach not included).
 * Null for SVG / image / model sources, while the font loads, or when there is no outline.
 */
export function sourceInkBounds(layer: TitleLike & OutlineOpsOf, font?: opentype.Font): Bounds | null {
  const src = layer.source;
  if (src.kind === 'text') {
    const lay = outlinedTextLayout(src, layer, font);
    return lay && lay.glyphs.length > 0 ? lay.bounds : null;
  }
  if (src.kind === 'shape') {
    const cmds = outlinedShapeCmds(src, layer);
    return cmds.length > 0 ? cmdsBounds(cmds) : null;
  }
  return null;
}

import { isTitleLayer } from '../../model/parts';
import type { Layer, ShapeKind, ShapeSource } from '../../model/types';
import { msg, verbatim, type Text } from '../../store/msg';
import { distortFrame, distortPoint } from '../../text/ink';
import { cmdsBounds, type PathCmd } from '../../text/layout';
import { shapeCmds } from '../../text/shapes';
import { warpCmds } from '../../text/warp';
import type { Pt } from './geometry';

// On-canvas handles for parametric shape sources and the warp bend. Positions are layer space
// (y-up) on the warped and distorted outline; drags are read in unwarped shape space (exact
// without a warp / distort, close with one).

/** Which ShapeSource fields a kind uses (see ShapeKind docs in model/types.ts). */
export const SHAPE_FIELDS: Record<ShapeKind, { corner?: true; slant?: true; points?: 'Sides' | 'Points'; inner?: 'Inner' | 'Notch'; jitter?: true; tail?: 'bubble' | 'fold' }> = {
  rect: { corner: true },
  parallelogram: { corner: true, slant: true },
  ellipse: {},
  orb: {},
  polygon: { corner: true, points: 'Sides' },
  star: { points: 'Points', inner: 'Inner' },
  burst: { points: 'Points', inner: 'Inner', jitter: true },
  shield: { corner: true },
  speech: { corner: true, tail: 'bubble' },
  shout: { points: 'Points', inner: 'Inner', jitter: true, tail: 'bubble' },
  ribbon: { slant: true, inner: 'Notch', tail: 'fold' },
};

export type ShapeHandleKey = 'corner' | 'inner' | 'points' | 'tail';

export interface ShapeHandle {
  key: ShapeHandleKey;
  /** Layer space, on the warped outline. */
  at: Pt;
  /** Shown beside the handle and as its tooltip; translated where drawn (formatMsg). */
  label: Text;
  title: Text;
}

/** Screen px of horizontal drag per point / side on the count handle. */
export const POINTS_DRAG_PX = 12;
const INNER_MIN = 0.05;
const INNER_MAX = 0.98;

/** On-curve points of an outline. */
const vertices = (cmds: PathCmd[]): Pt[] => cmds.flatMap((c) => (c.type === 'Z' ? [] : [{ x: c.x, y: c.y }]));

/**
 * Where the top-left corner arc meets the flat top edge (the leftmost on-curve point on the
 * top line), and the corner's virtual vertex x (that point minus the current radius).
 */
function topCorner(src: ShapeSource, cmds: PathCmd[]): { at: Pt; vertexX: number } | null {
  const b = cmdsBounds(cmds);
  const eps = (b.y1 - b.y0) * 1e-4;
  let at: Pt | null = null;
  for (const v of vertices(cmds)) if (Math.abs(v.y - b.y1) <= eps && (!at || v.x < at.x)) at = v;
  if (!at) return null;
  const r = Math.min((Math.max(0, src.corner) / 100) * src.size, (b.y1 - b.y0) / 2);
  return { at, vertexX: at.x - r };
}

/** The deepest valley of a star-like outline: the vertex nearest the centre. */
function deepestValley(cmds: PathCmd[]): Pt | null {
  let best: Pt | null = null;
  for (const v of vertices(cmds)) if (!best || Math.hypot(v.x, v.y) < Math.hypot(best.x, best.y)) best = v;
  return best;
}

/** Topmost vertex (the first star / burst tip points straight up). */
function topVertex(cmds: PathCmd[]): Pt | null {
  let best: Pt | null = null;
  for (const v of vertices(cmds)) if (!best || v.y > best.y) best = v;
  return best;
}

/** The layer's shape handles (on its warped and distorted outline); none for other sources. */
export function shapeHandles(layer: Layer): ShapeHandle[] {
  if (!isTitleLayer(layer) || layer.source.kind !== 'shape') return [];
  const src = layer.source;
  const base = shapeCmds(src);
  if (base.length === 0) return [];
  const box = cmdsBounds(base);
  const frame = layer.distort.mode !== 'none' ? distortFrame(layer) : null;
  const distort = layer.distort;
  // Warp, then distort over the warped frame: where the drawn outline puts the point.
  return sourceShapeHandles(src, (p) => {
    const m = warpCmds([{ type: 'M', x: p.x, y: p.y }], box, layer.warp)[0];
    const q = m.type === 'M' ? { x: m.x, y: m.y } : p;
    return frame ? distortPoint(frame, distort, q) : q;
  });
}

/** Handles of a parametric shape in its own space (shape masks); `warp` places a point on a warped / distorted outline. */
export function sourceShapeHandles(src: ShapeSource, warp: (p: Pt) => Pt = (p) => p): ShapeHandle[] {
  const f = SHAPE_FIELDS[src.shape];
  const base = shapeCmds(src);
  if (base.length === 0) return [];
  const box = cmdsBounds(base);
  const h = src.size;
  const out: ShapeHandle[] = [];
  // Polygons have no flat top-left corner to grab; their Corner stays a panel control.
  const tc = f.corner && src.shape !== 'polygon' ? topCorner(src, base) : null;
  if (tc) out.push({ key: 'corner', at: warp(tc.at), label: 'Corner', title: msg('Corner radius {v}%: drag along the top edge (Shift: 5% steps)', { v: src.corner.toFixed(1) }) });
  if (f.inner === 'Inner') {
    const v = deepestValley(base);
    if (v) out.push({ key: 'inner', at: warp(v), label: 'Inner', title: msg('Inner radius {v}%: drag toward / away from the centre', { v: Math.round(src.inner * 100) }) });
  }
  if (f.points) {
    const t = f.points === 'Sides' ? { x: (box.x0 + box.x1) / 2, y: box.y1 } : topVertex(base);
    const title = f.points === 'Sides' ? msg('Sides: drag left / right ({px}px per step)', { px: POINTS_DRAG_PX }) : msg('Points: drag left / right ({px}px per step)', { px: POINTS_DRAG_PX });
    if (t) out.push({ key: 'points', at: warp(t), label: verbatim(`${src.points}`), title });
  }
  if (f.tail === 'bubble') out.push({ key: 'tail', at: warp({ x: (src.tail.x / 100) * h, y: (src.tail.y / 100) * h }), label: 'Tail', title: 'Tail tip: drag (Shift: 15° steps around the centre)' });
  return out;
}

/**
 * Shape fields after dragging handle `key`: `p` / `p0` are the current / pressed layer points,
 * `screenDx` the horizontal screen travel (count handle). `snap` = Shift.
 */
export function dragShapeHandle(src0: ShapeSource, key: ShapeHandleKey, p0: Pt, p: Pt, screenDx: number, snap: boolean): Partial<ShapeSource> {
  const h = src0.size;
  const box = cmdsBounds(shapeCmds(src0));
  switch (key) {
    case 'corner': {
      const tc = topCorner(src0, shapeCmds(src0));
      const r = Math.max(0, Math.min(p.x - (tc?.vertexX ?? box.x0), h / 2));
      const pct = (r / h) * 100;
      return { corner: Math.min(50, snap ? Math.round(pct / 5) * 5 : Math.round(pct * 10) / 10) };
    }
    case 'inner': {
      const d0 = Math.hypot(p0.x, p0.y);
      if (d0 < 1e-3) return {};
      const v = Math.max(INNER_MIN, Math.min(INNER_MAX, (src0.inner * Math.hypot(p.x, p.y)) / d0));
      return { inner: snap ? Math.round(v * 20) / 20 : Math.round(v * 1000) / 1000 };
    }
    case 'points': {
      const max = SHAPE_FIELDS[src0.shape].points === 'Sides' ? 16 : 64;
      return { points: Math.max(3, Math.min(max, Math.round(src0.points + screenDx / POINTS_DRAG_PX))) };
    }
    case 'tail': {
      let { x, y } = p;
      if (snap) {
        const len = Math.hypot(x, y);
        const a = Math.round(Math.atan2(y, x) / (Math.PI / 12)) * (Math.PI / 12);
        x = Math.cos(a) * len;
        y = Math.sin(a) * len;
      }
      return { tail: { ...src0.tail, x: Math.round((x / h) * 1000) / 10, y: Math.round((y / h) * 1000) / 10 } };
    }
  }
}

import type { PlateShape } from '../model/types';
import type { PathCmd } from './layout';
import { flattenCmds, flattenTol, pathsToCmds, roundOffset, unionNonZero } from './offset';
import type { Pt } from './remap';

// Base outline a rim (2D) or backplate (3D) grows from, shared so both match exactly. Input and
// output are y-up layer space; the rim / plate width is added on top by the caller.

const cache = new WeakMap<PathCmd[], Map<string, PathCmd[]>>();

/** Andrew's monotone chain; counter-clockwise (positive area, y-up). */
function convexHull(pts: Pt[]): Pt[] {
  const p = [...pts].sort((a, b) => a.x - b.x || a.y - b.y);
  if (p.length < 3) return p;
  const cross = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Pt[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: Pt[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/**
 * Leaning box around `pts`: sides parallel to the lean (x = u + k·y, k = tan lean), top and
 * bottom horizontal, each corner cut by a straight chamfer `chamfer` px along both edges
 * (clamped to half the shorter side). Counter-clockwise from the bottom-left.
 */
function leanBox(pts: Pt[], leanDeg: number, chamfer: number): Pt[] {
  const k = Math.tan((leanDeg * Math.PI) / 180);
  let u0 = Infinity, u1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of pts) {
    const u = p.x - k * p.y;
    if (u < u0) u0 = u;
    if (u > u1) u1 = u;
    if (p.y < y0) y0 = p.y;
    if (p.y > y1) y1 = p.y;
  }
  const corners: Pt[] = [
    { x: u0 + k * y0, y: y0 },
    { x: u1 + k * y0, y: y0 },
    { x: u1 + k * y1, y: y1 },
    { x: u0 + k * y1, y: y1 },
  ];
  const side = Math.min(u1 - u0, (y1 - y0) * Math.sqrt(1 + k * k));
  const c = Math.min(Math.max(chamfer, 0), side / 2);
  if (c <= 1e-6) return corners;
  const out: Pt[] = [];
  for (let i = 0; i < 4; i++) {
    const p = corners[i];
    const prev = corners[(i + 3) % 4];
    const next = corners[(i + 1) % 4];
    const toward = (q: Pt) => {
      const l = Math.hypot(q.x - p.x, q.y - p.y);
      return { x: p.x + ((q.x - p.x) * c) / l, y: p.y + ((q.y - p.y) * c) / l };
    };
    out.push(toward(prev), toward(next));
  }
  return out;
}

/**
 * The base outline a rim / plate grows from (see PlateShape), for element outlines `cmds` of
 * em / shape size `size` (px) and text shear `shear` (degrees, added to a box's lean).
 * 'contour' with close 0 returns `cmds` itself (identity, so callers can cache on it); every
 * other result is polygonal (M / L / Z) and memoized per `cmds` array and shape values.
 */
export function plateBaseCmds(cmds: PathCmd[], shape: PlateShape, size: number, shear: number): PathCmd[] {
  if (cmds.length === 0) return cmds;
  if (shape.kind === 'contour' && !(shape.close > 0)) return cmds;
  const key =
    shape.kind === 'contour' ? `c${shape.close},${size}` : shape.kind === 'hull' ? `h${size}` : `b${shape.corner},${shape.slant + shear},${size}`;
  let entry = cache.get(cmds);
  if (!entry) cache.set(cmds, (entry = new Map()));
  const hit = entry.get(key);
  if (hit) return hit;
  // A plate base is grown further by the rim / plate width, and its curves are mostly the
  // closing arcs, so it uses 4× the face tolerance (0.02 % of size; about 0.4 px when a 260 px
  // title is exported at 8×). That halves the point count and the cost of the closing offsets.
  const tol = 4 * flattenTol(size);
  const polys = flattenCmds(cmds, tol);
  let out: PathCmd[];
  if (shape.kind === 'contour') {
    const r = (shape.close / 100) * size;
    out = pathsToCmds(roundOffset(roundOffset(unionNonZero(polys), r, tol), -r, tol));
  } else {
    const pts = polys.flat();
    const ring = shape.kind === 'hull' ? convexHull(pts) : leanBox(pts, shape.slant + shear, (shape.corner / 100) * size);
    out = pathsToCmds(ring.length >= 3 ? [ring] : []);
  }
  entry.set(key, out);
  return out;
}

import { ClipType, EndType, FillRule, JoinType, booleanOpD, inflatePathsD, type PathD, type PathsD } from 'clipper2-ts';
import type { PathCmd } from './layout';

// Polygon plumbing for outline offsets (face weight, plate closing / hull / box). Curves are
// flattened adaptively to a tolerance tied to the element size, fine enough that the polygon
// edges stay invisible at large export scales (≈0.005 % of the size: 0.01 px on a 200 px title,
// 0.08 px when that title is exported at 8×).

/** Clipper's decimal grid: 0.001 px, well under the flattening tolerance. */
export const CLIPPER_PRECISION = 3;

/** Flattening / arc tolerance (px) for an element of em / shape size `size`. */
export function flattenTol(size: number): number {
  return Math.max(Math.abs(size) * 5e-5, 1e-3);
}

/**
 * Closed contours of `cmds` as polygons. Quadratic / cubic segments get just enough chords for
 * the chord error to stay under `tol` (the bound |B''|·h²/8 per segment of parameter step h).
 */
export function flattenCmds(cmds: PathCmd[], tol: number): PathsD {
  const out: PathsD = [];
  let cur: PathD = [];
  let x = 0;
  let y = 0;
  const close = () => {
    if (cur.length >= 3) out.push(cur);
    cur = [];
  };
  for (const c of cmds) {
    switch (c.type) {
      case 'M':
        close();
        cur.push({ x: c.x, y: c.y });
        break;
      case 'L':
        cur.push({ x: c.x, y: c.y });
        break;
      case 'Q': {
        const d = Math.hypot(x - 2 * c.x1 + c.x, y - 2 * c.y1 + c.y);
        const n = Math.max(1, Math.ceil(Math.sqrt(d / (4 * tol))));
        for (let i = 1; i <= n; i++) {
          const t = i / n;
          const s = 1 - t;
          cur.push({ x: s * s * x + 2 * s * t * c.x1 + t * t * c.x, y: s * s * y + 2 * s * t * c.y1 + t * t * c.y });
        }
        break;
      }
      case 'C': {
        const d = Math.max(Math.hypot(x - 2 * c.x1 + c.x2, y - 2 * c.y1 + c.y2), Math.hypot(c.x1 - 2 * c.x2 + c.x, c.y1 - 2 * c.y2 + c.y));
        const n = Math.max(1, Math.ceil(Math.sqrt((3 * d) / (4 * tol))));
        for (let i = 1; i <= n; i++) {
          const t = i / n;
          const s = 1 - t;
          const k0 = s * s * s, k1 = 3 * s * s * t, k2 = 3 * s * t * t, k3 = t * t * t;
          cur.push({ x: k0 * x + k1 * c.x1 + k2 * c.x2 + k3 * c.x, y: k0 * y + k1 * c.y1 + k2 * c.y2 + k3 * c.y });
        }
        break;
      }
      case 'Z':
        close();
        break;
    }
    if (c.type !== 'Z') {
      x = c.x;
      y = c.y;
    }
  }
  close();
  return out;
}

/** Polygons → closed M / L / Z contours. */
export function pathsToCmds(paths: PathsD): PathCmd[] {
  const out: PathCmd[] = [];
  for (const p of paths) {
    if (p.length < 3) continue;
    out.push({ type: 'M', x: p[0].x, y: p[0].y });
    for (let i = 1; i < p.length; i++) out.push({ type: 'L', x: p[i].x, y: p[i].y });
    out.push({ type: 'Z' });
  }
  return out;
}

/** Union under the non-zero rule: one consistent orientation (outers positive, holes negative). */
export function unionNonZero(paths: PathsD): PathsD {
  return paths.length ? booleanOpD(ClipType.Union, paths, null, FillRule.NonZero, CLIPPER_PRECISION) : paths;
}

/** Round-joined offset of normalised polygons by `delta` px (>0 grows, <0 shrinks). */
export function roundOffset(paths: PathsD, delta: number, tol: number): PathsD {
  if (!paths.length || delta === 0) return paths;
  return inflatePathsD(paths, delta, JoinType.Round, EndType.Polygon, 2, CLIPPER_PRECISION, tol);
}

/**
 * Face weight (Illustrator Offset Path): `cmds` grown by `delta` px with round joins (shrunk
 * when negative; strokes thinner than 2·|delta| vanish). Returns `cmds` itself for delta 0.
 */
export function weightCmds(cmds: PathCmd[], delta: number, size: number): PathCmd[] {
  if (delta === 0 || cmds.length === 0) return cmds;
  const tol = flattenTol(size);
  return pathsToCmds(roundOffset(unionNonZero(flattenCmds(cmds, tol)), delta, tol));
}

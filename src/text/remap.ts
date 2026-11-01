import type { PathCmd } from './layout';

// Non-linear point maps (warp, free distort) applied to outlines. The images of curves are
// re-fitted as quadratics through mapped samples, subdivided until the fit is within tolerance,
// so 2D renders stay smooth curves at any export scale instead of polylines.

export type Pt = { x: number; y: number };

/** A layer-space point map plus how finely its image must be re-fitted. */
export interface PointMap {
  map: (p: Pt) => Pt;
  /** Fit tolerance (px). */
  tol: number;
  /** Longest original-space span a single fitted piece may start from (px). */
  span: number;
  /** The map keeps straight lines straight (projective): lines map by their end points. */
  straight?: boolean;
}

/**
 * Append the mapped image of an original curve `at(t)`, t ∈ [0,1], as quadratics re-fitted
 * through mapped samples (or lines where the image stays straight).
 */
function fitMapped(out: PathCmd[], at: (t: number) => Pt, length: number, pm: PointMap) {
  const pieces = Math.max(1, Math.ceil(length / pm.span));
  const fit = (t0: number, p0: Pt, t1: number, p1: Pt, depth: number) => {
    const m = pm.map(at((t0 + t1) / 2));
    // Quadratic through p0, m (at t = ½), p1.
    const cx = 2 * m.x - (p0.x + p1.x) / 2;
    const cy = 2 * m.y - (p0.y + p1.y) / 2;
    const qa = pm.map(at(t0 + (t1 - t0) / 4));
    const qb = pm.map(at(t0 + ((t1 - t0) * 3) / 4));
    const ea = Math.hypot((9 * p0.x + 6 * cx + p1.x) / 16 - qa.x, (9 * p0.y + 6 * cy + p1.y) / 16 - qa.y);
    const eb = Math.hypot((p0.x + 6 * cx + 9 * p1.x) / 16 - qb.x, (p0.y + 6 * cy + 9 * p1.y) / 16 - qb.y);
    if (Math.max(ea, eb) > pm.tol && depth < 12) {
      const tm = (t0 + t1) / 2;
      fit(t0, p0, tm, m, depth + 1);
      fit(tm, m, t1, p1, depth + 1);
      return;
    }
    if (Math.hypot(cx - (p0.x + p1.x) / 2, cy - (p0.y + p1.y) / 2) < pm.tol) out.push({ type: 'L', x: p1.x, y: p1.y });
    else out.push({ type: 'Q', x1: cx, y1: cy, x: p1.x, y: p1.y });
  };
  let p0 = pm.map(at(0));
  for (let i = 1; i <= pieces; i++) {
    const t1 = i / pieces;
    const p1 = pm.map(at(t1));
    fit((i - 1) / pieces, p0, t1, p1, 0);
    p0 = p1;
  }
}

/** Map every contour of `cmds` through `pm`; returns closed contours of M / L / Q commands. */
export function remapCmds(cmds: PathCmd[], pm: PointMap): PathCmd[] {
  const out: PathCmd[] = [];
  let cur: Pt = { x: 0, y: 0 };
  let start: Pt = cur;
  const line = (a: Pt, b: Pt) => {
    if (pm.straight) {
      const p = pm.map(b);
      out.push({ type: 'L', x: p.x, y: p.y });
    } else fitMapped(out, (t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }), Math.hypot(b.x - a.x, b.y - a.y), pm);
  };
  for (const c of cmds) {
    switch (c.type) {
      case 'M': {
        const p = pm.map(c);
        out.push({ type: 'M', x: p.x, y: p.y });
        cur = start = { x: c.x, y: c.y };
        break;
      }
      case 'L':
        line(cur, c);
        cur = { x: c.x, y: c.y };
        break;
      case 'Q': {
        const a = cur;
        fitMapped(
          out,
          (t) => {
            const u = 1 - t;
            return { x: u * u * a.x + 2 * u * t * c.x1 + t * t * c.x, y: u * u * a.y + 2 * u * t * c.y1 + t * t * c.y };
          },
          Math.hypot(c.x1 - a.x, c.y1 - a.y) + Math.hypot(c.x - c.x1, c.y - c.y1),
          pm,
        );
        cur = { x: c.x, y: c.y };
        break;
      }
      case 'C': {
        const a = cur;
        fitMapped(
          out,
          (t) => {
            const u = 1 - t;
            const k0 = u * u * u, k1 = 3 * u * u * t, k2 = 3 * u * t * t, k3 = t * t * t;
            return { x: k0 * a.x + k1 * c.x1 + k2 * c.x2 + k3 * c.x, y: k0 * a.y + k1 * c.y1 + k2 * c.y2 + k3 * c.y };
          },
          Math.hypot(c.x1 - a.x, c.y1 - a.y) + Math.hypot(c.x2 - c.x1, c.y2 - c.y1) + Math.hypot(c.x - c.x2, c.y - c.y2),
          pm,
        );
        cur = { x: c.x, y: c.y };
        break;
      }
      case 'Z':
        // The implicit closing edge is straight in the original but may bend under the map.
        if (cur.x !== start.x || cur.y !== start.y) line(cur, start);
        out.push(c);
        cur = start;
        break;
    }
  }
  return out;
}

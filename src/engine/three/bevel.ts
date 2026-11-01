import type { BevelProfile3D, BevelShape3D, Title3DProps } from '../../model/types';

// Bevel cross-sections (Element 3D Bevel Segments / Bevel Curve), shared by the extruder and
// the Style3D cross-section preview. Pure maths, no three.js.
//
// Unit space: o = 0 inner edge → 1 outer edge; h = drop in z as a fraction of depth
// (negative = rises). A profile is a list of PIECES joined at facet corners; each piece is a
// polyline whose points carry the unit-space tangent where the surface is smooth (arcs, bent
// risers), so the extruder can give them analytic normals instead of faceted ones.
//
// `curve` bends every piece by an exponent on its drop: h = h0 + (h1 - h0) · s^p with
// p = 4^curve along the piece (arcs: along the arc angle). p > 1 keeps the bevel high longer
// and drops late (fuller / rounder); p < 1 drops right at the inner edge (pinched, cove-like).

export interface UnitPoint {
  o: number;
  h: number;
  /** Unit-space tangent (do, dh) where the profile is smooth; absent at facet corners. */
  t?: [number, number];
}

const QUARTER = Math.PI / 2;
const MAX_SEGMENTS = 24;
/** Parameter step of the finite-difference tangent (pieces are parametrised over 0..1). */
const DT = 1e-3;

type Piece = { f: (s: number) => [number, number]; segments: number; smooth: boolean };

/** Sample one piece; tangents by central differences (one-sided at the ends). */
function samplePiece({ f, segments, smooth }: Piece): UnitPoint[] {
  const out: UnitPoint[] = [];
  for (let k = 0; k <= segments; k++) {
    const s = k / segments;
    const [o, h] = f(s);
    if (!smooth) {
      out.push({ o, h });
      continue;
    }
    const s0 = Math.max(0, s - DT);
    const s1 = Math.min(1, s + DT);
    const a = f(s0);
    const b = f(s1);
    out.push({ o, h, t: [(b[0] - a[0]) / (s1 - s0), (b[1] - a[1]) / (s1 - s0)] });
  }
  return out;
}

/** Clamped integer facet count. */
export function bevelSegments(segments: number): number {
  return Math.max(1, Math.min(MAX_SEGMENTS, Math.round(segments) || 1));
}

/**
 * Pieces of a profile in unit space. `segments` facets every curved piece (arcs always,
 * straight risers only when bent by `curve`).
 */
export function unitBevel(profile: BevelProfile3D, segments: number, curve: number): UnitPoint[][] {
  const n = bevelSegments(segments);
  const p = 4 ** Math.max(-1, Math.min(1, curve || 0));
  const bent = Math.abs(p - 1) > 1e-6;
  const bend = (s: number) => (bent ? Math.max(0, s) ** p : s);
  // straight piece; a riser (both o and h change) bends into a smooth curve when curve ≠ 0
  const line = (o0: number, h0: number, o1: number, h1: number): Piece => {
    const riser = bent && o0 !== o1 && h0 !== h1;
    return { f: (s) => [o0 + (o1 - o0) * s, h0 + (h1 - h0) * (riser ? bend(s) : s)], segments: riser ? n : 1, smooth: riser };
  };
  // quarter arc from h = 0 to 1, parametrised by angle; the bend applies to the drop
  const arc = (o: (t: number) => number, h: (t: number) => number): Piece => ({
    f: (s) => [o(s * QUARTER), bend(h(s * QUARTER))],
    segments: n,
    smooth: true,
  });
  let pieces: Piece[];
  switch (profile) {
    case 'flat':
      // a flat ring at the inner height, then a vertical step down at the outer edge
      pieces = [line(0, 0, 1, 0), line(1, 0, 1, 1)];
      break;
    case 'chamfer':
      pieces = [line(0, 0, 1, 1)];
      break;
    case 'round':
      // convex quarter round: flat where it meets the inner part, vertical at the outer edge
      pieces = [arc(Math.sin, (t) => 1 - Math.cos(t))];
      break;
    case 'cove':
      // concave quarter: drops steeply from the inner edge and runs out flat
      pieces = [arc((t) => 1 - Math.cos(t), Math.sin)];
      break;
    case 'step':
      // two risers with a front-facing ledge between them, ending on a ledge
      pieces = [line(0, 0, 0.15, 0.5), line(0.15, 0.5, 0.5, 0.5), line(0.5, 0.5, 0.65, 1), line(0.65, 1, 1, 1)];
      break;
    case 'inset':
      // a raised rim: rises from the inner edge, flat on top (the inner part sits recessed)
      pieces = [line(0, 0, 0.4, -1), line(0.4, -1, 1, -1)];
      break;
    case 'tube':
      // a half-round tube: rises from the inner edge to a crest `depth` high at mid-width and
      // falls back to the inner height at the outer edge (round rims, neon tubes); the bend makes
      // the crest fuller (> 0) or narrower (< 0)
      pieces = [
        {
          f: (s) => [(1 - Math.cos(s * Math.PI)) / 2, -(Math.sin(s * Math.PI) ** (1 / p))],
          segments: 2 * n,
          smooth: true,
        },
      ];
      break;
  }
  return pieces.map(samplePiece);
}

/**
 * Effective facet count of a bevel at an output scale (`outputPxPerUnit` = output px per layer
 * px): the user's `segments` at 1× and below, raised on larger exports so each facet keeps the
 * sagitta (in output px) it has at 1× — a facet's sagitta grows linearly with the scale and
 * shrinks with the square of the count, so the count grows with √scale (capped at 24).
 */
export function effectiveSegments(shape: BevelShape3D, outputPxPerUnit: number): number {
  return Math.min(MAX_SEGMENTS, Math.ceil(bevelSegments(shape.segments) * Math.sqrt(Math.max(1, outputPxPerUnit))));
}

/** Share of the bevel band stack that lies outside the glyph outline (Title3DProps.bevelPosition). */
export const BEVEL_OUTSIDE_SHARE: Record<Title3DProps['bevelPosition'], number> = { outside: 1, center: 0.5, inside: 0 };

/**
 * How far the bevel bands reach past the glyph outline, % of size: the outermost band edge (the
 * extruded silhouette) sits this far out, and backplates grow from there. 0 in inflate mode,
 * whose front ignores the bands.
 */
export function bandsOutside(p: Pick<Title3DProps, 'mode' | 'bands' | 'bevelPosition'>): number {
  if (p.mode === 'inflate') return 0;
  return p.bands.reduce((s, b) => s + Math.max(0, b.width), 0) * BEVEL_OUTSIDE_SHARE[p.bevelPosition];
}

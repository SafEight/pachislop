import type { Distort } from '../model/types';
import { cmdsBounds, type Bounds, type PathCmd, type TextLayout } from './layout';
import { remapCmds, type PointMap, type Pt } from './remap';

// Free distort (Photoshop Distort / Perspective, Kittl mesh warp) over a frame box, in y-up
// layer space. Offsets are fractions of the frame (x of its width, y of its height, +y up).
// - 'corners': the projective map (homography) sending the frame rect to the 4 moved corners,
//   so straight lines stay straight (a true パース trapezoid).
// - 'mesh': a bicubic Bézier patch whose 4×4 control points start evenly spaced over the frame.
// Both maps extend smoothly past the frame (per-character nudges can leave it): the homography
// continues as itself, the patch continues linearly along its edge derivatives (C1).

/** True when the distort leaves outlines untouched. */
export function distortIsIdentity(d: Distort): boolean {
  if (d.mode === 'corners') return d.corners.every((c) => c.x === 0 && c.y === 0);
  if (d.mode === 'mesh') return d.mesh.every((c) => c.x === 0 && c.y === 0);
  return true;
}

/** Smallest homography denominator kept: points past the vanishing line stay finite. */
const MIN_W = 0.02;

function cornersMap(f: Bounds, d: Distort): (p: Pt) => Pt {
  const w = f.x1 - f.x0;
  const h = f.y1 - f.y0;
  const [tl, tr, br, bl] = d.corners;
  // Unit square (u right, v down from the top edge) → quad TL (0,0), TR (1,0), BR (1,1), BL (0,1).
  const x0 = f.x0 + tl.x * w, y0 = f.y1 + tl.y * h;
  const x1 = f.x1 + tr.x * w, y1 = f.y1 + tr.y * h;
  const x2 = f.x1 + br.x * w, y2 = f.y0 + br.y * h;
  const x3 = f.x0 + bl.x * w, y3 = f.y0 + bl.y * h;
  // Heckbert's square-to-quad.
  const dx3 = x0 - x1 + x2 - x3;
  const dy3 = y0 - y1 + y2 - y3;
  let a: number, b: number, c: number, e: number, g = 0, k = 0;
  if (Math.abs(dx3) < 1e-9 && Math.abs(dy3) < 1e-9) {
    a = x1 - x0;
    b = x2 - x1;
    c = y1 - y0;
    e = y2 - y1;
  } else {
    const dx1 = x1 - x2, dx2 = x3 - x2, dy1 = y1 - y2, dy2 = y3 - y2;
    const det = dx1 * dy2 - dx2 * dy1;
    if (Math.abs(det) > 1e-12) {
      g = (dx3 * dy2 - dx2 * dy3) / det;
      k = (dx1 * dy3 - dx3 * dy1) / det;
    }
    a = x1 - x0 + g * x1;
    b = x3 - x0 + k * x3;
    c = y1 - y0 + g * y1;
    e = y3 - y0 + k * y3;
  }
  return (p) => {
    const u = (p.x - f.x0) / w;
    const v = (f.y1 - p.y) / h;
    const den = Math.max(g * u + k * v + 1, MIN_W);
    return { x: (a * u + b * v + x0) / den, y: (c * u + e * v + y0) / den };
  };
}

/** Cubic Bernstein weights and their derivatives at t. */
function cubic(t: number, b: number[], db: number[]) {
  const s = 1 - t;
  b[0] = s * s * s;
  b[1] = 3 * t * s * s;
  b[2] = 3 * t * t * s;
  b[3] = t * t * t;
  db[0] = -3 * s * s;
  db[1] = 3 * s * s - 6 * t * s;
  db[2] = 6 * t * s - 3 * t * t;
  db[3] = 3 * t * t;
}

function meshMap(f: Bounds, d: Distort): (p: Pt) => Pt {
  const w = f.x1 - f.x0;
  const h = f.y1 - f.y0;
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < 16; i++) {
    const o = d.mesh[i] ?? { x: 0, y: 0 };
    xs.push(f.x0 + ((i % 4) / 3) * w + o.x * w);
    ys.push(f.y1 - (Math.floor(i / 4) / 3) * h + o.y * h);
  }
  const bu = [0, 0, 0, 0], du = [0, 0, 0, 0], bv = [0, 0, 0, 0], dv = [0, 0, 0, 0];
  return (p) => {
    const u = (p.x - f.x0) / w;
    const v = (f.y1 - p.y) / h;
    const uc = Math.min(1, Math.max(0, u));
    const vc = Math.min(1, Math.max(0, v));
    cubic(uc, bu, du);
    cubic(vc, bv, dv);
    // S + Δu·Su + Δv·Sv + Δu·Δv·Suv: the patch inside, its C1 linear extension outside.
    const eu = u - uc;
    const ev = v - vc;
    let x = 0, y = 0;
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) {
        const kk = bu[c] * bv[r] + eu * du[c] * bv[r] + ev * bu[c] * dv[r] + eu * ev * du[c] * dv[r];
        x += kk * xs[r * 4 + c];
        y += kk * ys[r * 4 + c];
      }
    }
    return { x, y };
  };
}

function makeDistorter(frame: Bounds, d: Distort): PointMap | null {
  const w = frame.x1 - frame.x0;
  const h = frame.y1 - frame.y0;
  if (!(w > 1e-6) || !(h > 1e-6) || distortIsIdentity(d)) return null;
  const size = Math.max(w, h);
  return {
    map: d.mode === 'corners' ? cornersMap(frame, d) : meshMap(frame, d),
    tol: Math.max(size * 1.5e-4, 1e-3),
    span: size / 8,
    straight: d.mode === 'corners',
  };
}

let last: { x0: number; y0: number; x1: number; y1: number; d: Distort; pm: PointMap | null } | null = null;

/**
 * The distort's forward map of one layer-space point (y-up) over `frame` (the undistorted box
 * the offsets refer to). For on-canvas handles; the last frame / distort pair is cached.
 */
export function distortPoint(frame: Bounds, d: Distort, p: Pt): Pt {
  if (!last || last.d !== d || last.x0 !== frame.x0 || last.y0 !== frame.y0 || last.x1 !== frame.x1 || last.y1 !== frame.y1) {
    last = { x0: frame.x0, y0: frame.y0, x1: frame.x1, y1: frame.y1, d, pm: makeDistorter(frame, d) };
  }
  return last.pm ? last.pm.map(p) : { x: p.x, y: p.y };
}

/** Distort outlines over `frame`; returns `cmds` itself for an identity distort. */
export function distortCmds(cmds: PathCmd[], frame: Bounds, d: Distort): PathCmd[] {
  const pm = makeDistorter(frame, d);
  return pm ? remapCmds(cmds, pm) : cmds;
}

/**
 * Distort every glyph of a (warped) layout over its frame. `frame` stays the undistorted box
 * (what the offsets refer to); `bounds` and each glyph's `center` follow the map. Returns
 * `layout` itself for an identity distort.
 */
export function distortLayout(layout: TextLayout, d: Distort): TextLayout {
  if (layout.glyphs.length === 0) return layout;
  const pm = makeDistorter(layout.frame, d);
  if (!pm) return layout;
  const glyphs = layout.glyphs.map((g) => ({ ...g, cmds: remapCmds(g.cmds, pm), center: pm.map(g.center) }));
  const bounds = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const g of glyphs) cmdsBounds(g.cmds, bounds);
  return { glyphs, bounds, frame: layout.frame };
}

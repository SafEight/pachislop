import type { ShapeSource } from '../model/types';
import type { PathCmd } from './layout';

// Parametric title shapes (plates, bands, badges, bubbles) as path commands in the same
// LAYER SPACE as text outlines: comp px, y-UP, centred on the origin. Every contour winds
// CLOCKWISE in y-up like TrueType glyph outlines (all built-in fonts are TTF), so the
// renderers' non-zero fills, counter detection and Clipper offsets treat shapes and glyphs
// alike. Corners are true circular arcs (cubic approximation), so rims grown around them
// stay even.

type Pt = { x: number; y: number };

/** One piece of a closed contour; each segment starts where the previous one ends. */
type Seg = { type: 'L'; p0: Pt; p1: Pt } | { type: 'C'; p0: Pt; c1: Pt; c2: Pt; p1: Pt };

const DEG = Math.PI / 180;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const lerp = (a: Pt, b: Pt, t: number): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const dist = (a: Pt, b: Pt) => Math.hypot(b.x - a.x, b.y - a.y);

/** mulberry32: small, fast, deterministic per seed (burst / shout jitter must be stable). */
function rng(seed: number): () => number {
  let a = (Math.round(seed) ^ 0x9e3779b9) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- segments → commands ----------

function emit(segs: Seg[], out: PathCmd[] = []): PathCmd[] {
  if (segs.length === 0) return out;
  out.push({ type: 'M', x: segs[0].p0.x, y: segs[0].p0.y });
  for (const s of segs) {
    if (s.type === 'L') out.push({ type: 'L', x: s.p1.x, y: s.p1.y });
    else out.push({ type: 'C', x1: s.c1.x, y1: s.c1.y, x2: s.c2.x, y2: s.c2.y, x: s.p1.x, y: s.p1.y });
  }
  out.push({ type: 'Z' });
  return out;
}

/** Closed polyline (vertices in travel order) → straight segments. */
function polySegs(pts: Pt[]): Seg[] {
  return pts.map((p0, i) => ({ type: 'L', p0, p1: pts[(i + 1) % pts.length] }));
}

/**
 * Convex polygon (clockwise, y-up) with corner `radius[i]` at vertex i, as lines + circular
 * arcs. A radius is clamped so its arc uses at most half of each adjacent edge: neighbouring
 * corners never overlap and the largest radius turns a rectangle into a capsule.
 */
function roundedPolySegs(pts: Pt[], radius: number[]): Seg[] {
  const n = pts.length;
  const corners = pts.map((v, i) => {
    const prev = pts[(i + n - 1) % n];
    const next = pts[(i + 1) % n];
    const l1 = dist(v, prev);
    const l2 = dist(v, next);
    const r = radius[i];
    if (!(r > 0) || l1 < 1e-9 || l2 < 1e-9) return { t1: v, t2: v, c1: v, c2: v, arc: false };
    const u1 = { x: (prev.x - v.x) / l1, y: (prev.y - v.y) / l1 };
    const u2 = { x: (next.x - v.x) / l2, y: (next.y - v.y) / l2 };
    const interior = Math.acos(clamp(u1.x * u2.x + u1.y * u2.y, -1, 1));
    if (interior > Math.PI - 1e-6) return { t1: v, t2: v, c1: v, c2: v, arc: false }; // collinear
    const tanHalf = Math.tan(interior / 2);
    const d = Math.min(r / tanHalf, l1 / 2, l2 / 2);
    const rEff = d * tanHalf;
    const k = (4 / 3) * Math.tan((Math.PI - interior) / 4) * rEff;
    const t1 = { x: v.x + u1.x * d, y: v.y + u1.y * d };
    const t2 = { x: v.x + u2.x * d, y: v.y + u2.y * d };
    return { t1, t2, c1: { x: t1.x - u1.x * k, y: t1.y - u1.y * k }, c2: { x: t2.x - u2.x * k, y: t2.y - u2.y * k }, arc: true };
  });
  const segs: Seg[] = [];
  for (let i = 0; i < n; i++) {
    const c = corners[i];
    const next = corners[(i + 1) % n];
    if (c.arc) segs.push({ type: 'C', p0: c.t1, c1: c.c1, c2: c.c2, p1: c.t2 });
    if (dist(c.t2, next.t1) > 1e-9) segs.push({ type: 'L', p0: c.t2, p1: next.t1 });
  }
  return segs;
}

/** Scale (and optionally centre) a polyline so its bounds are exactly w × h. */
function fitBox(pts: Pt[], w: number, h: number, centre: boolean): Pt[] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  if (!centre) {
    // Keep the origin: scale so the farthest point on each axis touches the box.
    const sx = w / 2 / Math.max(Math.abs(x0), Math.abs(x1), 1e-9);
    const sy = h / 2 / Math.max(Math.abs(y0), Math.abs(y1), 1e-9);
    return pts.map((p) => ({ x: p.x * sx, y: p.y * sy }));
  }
  const sx = w / Math.max(x1 - x0, 1e-9);
  const sy = h / Math.max(y1 - y0, 1e-9);
  const mx = (x0 + x1) / 2;
  const my = (y0 + y1) / 2;
  return pts.map((p) => ({ x: (p.x - mx) * sx, y: (p.y - my) * sy }));
}

// ---------- tails (speech / shout) ----------

function segPoint(s: Seg, t: number): Pt {
  if (s.type === 'L') return lerp(s.p0, s.p1, t);
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return { x: a * s.p0.x + b * s.c1.x + c * s.c2.x + d * s.p1.x, y: a * s.p0.y + b * s.c1.y + c * s.c2.y + d * s.p1.y };
}

/** The part of a segment between parameters t0 < t1 (de Casteljau for cubics). */
function segPart(s: Seg, t0: number, t1: number): Seg {
  if (s.type === 'L') return { type: 'L', p0: lerp(s.p0, s.p1, t0), p1: lerp(s.p0, s.p1, t1) };
  // Split at t1, keep the head; then split the head at t0 / t1, keep the tail.
  const ab = lerp(s.p0, s.c1, t1), bc = lerp(s.c1, s.c2, t1), cd = lerp(s.c2, s.p1, t1);
  const abc = lerp(ab, bc, t1), bcd = lerp(bc, cd, t1);
  const head = { p0: s.p0, c1: ab, c2: abc, p1: lerp(abc, bcd, t1) };
  const r = t1 > 1e-12 ? t0 / t1 : 0;
  const e = lerp(head.p0, head.c1, r), f = lerp(head.c1, head.c2, r), g = lerp(head.c2, head.p1, r);
  const ef = lerp(e, f, r), fg = lerp(f, g, r);
  return { type: 'C', p0: lerp(ef, fg, r), c1: fg, c2: g, p1: head.p1 };
}

/**
 * Where the ray from the origin at angle `phi` leaves a contour that is star-shaped about the
 * origin and travels clockwise (polar angle decreasing along travel).
 */
function rayHit(segs: Seg[], phi: number): { i: number; t: number; p: Pt } | null {
  const N = 24;
  const off = (p: Pt) => {
    const a = Math.atan2(p.y, p.x) - phi;
    return a - 2 * Math.PI * Math.round(a / (2 * Math.PI)); // wrapped to [-π, π]
  };
  for (let i = 0; i < segs.length; i++) {
    let ta = 0;
    let da = off(segPoint(segs[i], 0));
    for (let k = 1; k <= N; k++) {
      const tb = k / N;
      const db = off(segPoint(segs[i], tb));
      if (da >= 0 && db < 0 && da - db < Math.PI) {
        let lo = ta, hi = tb;
        for (let it = 0; it < 30; it++) {
          const mid = (lo + hi) / 2;
          if (off(segPoint(segs[i], mid)) >= 0) lo = mid;
          else hi = mid;
        }
        const t = (lo + hi) / 2;
        return { i, t, p: segPoint(segs[i], t) };
      }
      ta = tb;
      da = db;
    }
  }
  return null;
}

/**
 * Union of a star-shaped body and a triangular tail as ONE contour (no overlapping rims):
 * the boundary between the two base points is replaced by base → tip → base. Base points
 * are found by angle around the origin, so the result stays star-shaped and never
 * self-intersects. A tip inside the body adds no tail.
 */
function withTail(segs: Seg[], tip: Pt, baseWidth: number): Seg[] {
  const theta = Math.atan2(tip.y, tip.x);
  const hit = rayHit(segs, theta);
  if (!hit) return segs;
  const rho = Math.hypot(hit.p.x, hit.p.y);
  if (Math.hypot(tip.x, tip.y) <= rho * 1.02) return segs;
  const delta = clamp(Math.atan2(baseWidth / 2, rho), 0.01, 0.9);
  const a = rayHit(segs, theta + delta); // reached first along clockwise travel
  const b = rayHit(segs, theta - delta);
  if (!a || !b) return segs;
  const out: Seg[] = [];
  const n = segs.length;
  if (b.t < 1 - 1e-9) out.push(segPart(segs[b.i], b.t, 1));
  for (let k = 1; k <= n; k++) {
    const i = (b.i + k) % n;
    if (i === a.i) {
      if (a.t > 1e-9) out.push(segPart(segs[i], 0, a.t));
      break;
    }
    out.push(segs[i]);
  }
  out.push({ type: 'L', p0: a.p, p1: tip }, { type: 'L', p0: tip, p1: b.p });
  return out;
}

// ---------- shapes ----------

/** Rounded rectangle body, clockwise from the top-left corner. */
function rectSegs(w: number, h: number, r: number): Seg[] {
  const pts = [
    { x: -w / 2, y: h / 2 },
    { x: w / 2, y: h / 2 },
    { x: w / 2, y: -h / 2 },
    { x: -w / 2, y: -h / 2 },
  ];
  return roundedPolySegs(pts, [r, r, r, r]);
}

function ellipseSegs(rx: number, ry: number): Seg[] {
  const k = 0.5522847498;
  const top = { x: 0, y: ry };
  const right = { x: rx, y: 0 };
  const bottom = { x: 0, y: -ry };
  const left = { x: -rx, y: 0 };
  return [
    { type: 'C', p0: top, c1: { x: rx * k, y: ry }, c2: { x: rx, y: ry * k }, p1: right },
    { type: 'C', p0: right, c1: { x: rx, y: -ry * k }, c2: { x: rx * k, y: -ry }, p1: bottom },
    { type: 'C', p0: bottom, c1: { x: -rx * k, y: -ry }, c2: { x: -rx, y: -ry * k }, p1: left },
    { type: 'C', p0: left, c1: { x: -rx, y: ry * k }, c2: { x: -rx * k, y: ry }, p1: top },
  ];
}

/** Regular polygon with a flat bottom edge, fitted to w × h. */
function polygonSegs(w: number, h: number, sides: number, r: number): Seg[] {
  const pts: Pt[] = [];
  // Bottom edge spans the angles -90° ± 180°/n; vertices run clockwise (angle decreasing).
  for (let i = 0; i < sides; i++) {
    const a = -Math.PI / 2 - Math.PI / sides - (2 * Math.PI * i) / sides;
    pts.push({ x: Math.cos(a), y: Math.sin(a) });
  }
  const fitted = fitBox(pts, w, h, true);
  return roundedPolySegs(fitted, fitted.map(() => r));
}

/** Regular star, first point straight up, fitted to w × h. */
function starSegs(w: number, h: number, points: number, inner: number): Seg[] {
  const pts: Pt[] = [];
  for (let i = 0; i < points * 2; i++) {
    const a = Math.PI / 2 - (Math.PI * i) / points;
    const rad = i % 2 === 0 ? 1 : inner;
    pts.push({ x: Math.cos(a) * rad, y: Math.sin(a) * rad });
  }
  return polySegs(fitBox(pts, w, h, true));
}

/**
 * Jagged starburst around an ellipse: spike tips on the ellipse (radius 1), valleys at
 * `inner`; jitter shortens spikes and shifts them sideways (seeded, so stable per seed).
 * Spike angles stay within their own sector, so the outline stays star-shaped about the
 * origin (needed by the shout tail).
 */
function burstPoints(points: number, inner: number, jitter: number, seed: number): Pt[] {
  const rand = rng(seed);
  const step = (2 * Math.PI) / points;
  const tips: { a: number; r: number }[] = [];
  for (let i = 0; i < points; i++) {
    const a = Math.PI / 2 - i * step + (rand() - 0.5) * jitter * step * 0.7;
    const r = inner + (1 - inner) * (1 - 0.8 * jitter * rand());
    tips.push({ a, r });
  }
  const pts: Pt[] = [];
  for (let i = 0; i < points; i++) {
    const t = tips[i];
    const next = tips[(i + 1) % points];
    const nextA = i + 1 < points ? next.a : next.a - 2 * Math.PI;
    const va = (t.a + nextA) / 2;
    const vr = Math.min(inner * (1 + (rand() - 0.5) * jitter * 0.2), t.r * 0.97, next.r * 0.97);
    pts.push({ x: Math.cos(t.a) * t.r, y: Math.sin(t.a) * t.r });
    pts.push({ x: Math.cos(va) * vr, y: Math.sin(va) * vr });
  }
  return pts;
}

/** Emblem (heater) shield: flat top with rounded corners, straight sides, curved to a bottom point. */
function shieldSegs(w: number, h: number, corner: number): Seg[] {
  const top = h / 2;
  const shoulder = top - h * 0.42; // where the sides start curving in
  const r = clamp(corner, 0, Math.min(w / 2, h * 0.42));
  const k = 0.5522847498 * r;
  const tip = { x: 0, y: -h / 2 };
  const segs: Seg[] = [];
  const tl = { x: -w / 2 + r, y: top };
  const tr = { x: w / 2 - r, y: top };
  const rt = { x: w / 2, y: top - r };
  const lt = { x: -w / 2, y: top - r };
  const rs = { x: w / 2, y: shoulder };
  const ls = { x: -w / 2, y: shoulder };
  if (dist(tl, tr) > 1e-9) segs.push({ type: 'L', p0: tl, p1: tr });
  if (r > 0) segs.push({ type: 'C', p0: tr, c1: { x: tr.x + k, y: top }, c2: { x: w / 2, y: rt.y + k }, p1: rt });
  if (dist(rt, rs) > 1e-9) segs.push({ type: 'L', p0: rt, p1: rs });
  segs.push({ type: 'C', p0: rs, c1: { x: w / 2, y: shoulder - h * 0.3 }, c2: { x: w * 0.2, y: tip.y + h * 0.13 }, p1: tip });
  segs.push({ type: 'C', p0: tip, c1: { x: -w * 0.2, y: tip.y + h * 0.13 }, c2: { x: -w / 2, y: shoulder - h * 0.3 }, p1: ls });
  if (dist(ls, lt) > 1e-9) segs.push({ type: 'L', p0: ls, p1: lt });
  if (r > 0) segs.push({ type: 'C', p0: lt, c1: { x: -w / 2, y: lt.y + k }, c2: { x: tl.x - k, y: top }, p1: tl });
  return segs;
}

/**
 * Banner: the front band on top, and at each end a tail one band-height lower that tucks
 * behind the band and ends in a V notch. Separate overlapping contours (same winding): the
 * fill / rims see their union, whose stepped silhouette reads as the fold.
 */
function ribbonCmds(w: number, h: number, notch: number, foldLen: number, slant: number): PathCmd[] {
  const tail = clamp(foldLen, 0, w * 0.45); // visible tail length beyond the band end
  const band = tail > 1e-6 ? h * 0.74 : h; // height of the strip (band and tails alike)
  const xb = w / 2 - tail; // band half-width
  const tuck = Math.min(tail * 0.45, xb); // how far each tail runs on under the band
  const bandTop = h / 2;
  const bandBottom = h / 2 - band;
  const tailTop = -h / 2 + band;
  const tailBottom = -h / 2;
  const v = Math.min(clamp(notch, 0, 1) * band, tail * 0.95); // notch depth: fraction of the end height
  const k = Math.tan(clamp(slant, -60, 60) * DEG);
  const shear = (pts: Pt[]) => pts.map((p) => ({ x: p.x + k * p.y, y: p.y }));
  const out: PathCmd[] = [];
  if (tail > 1e-6) {
    const midY = (tailTop + tailBottom) / 2;
    const left: Pt[] = [
      { x: -w / 2, y: tailTop },
      { x: -xb + tuck, y: tailTop },
      { x: -xb + tuck, y: tailBottom },
      { x: -w / 2, y: tailBottom },
    ];
    if (v > 1e-6) left.push({ x: -w / 2 + v, y: midY });
    const right: Pt[] = [
      { x: xb - tuck, y: tailTop },
      { x: w / 2, y: tailTop },
    ];
    if (v > 1e-6) right.push({ x: w / 2 - v, y: midY });
    right.push({ x: w / 2, y: tailBottom }, { x: xb - tuck, y: tailBottom });
    emit(polySegs(shear(left)), out);
    emit(polySegs(shear(right)), out);
  }
  emit(
    polySegs(
      shear([
        { x: -xb, y: bandTop },
        { x: xb, y: bandTop },
        { x: xb, y: bandBottom },
        { x: -xb, y: bandBottom },
      ]),
    ),
    out,
  );
  return out;
}

/**
 * Outline of a shape source: closed contours, centred, y-up layer space, clockwise like
 * glyph outlines. The body is `size` tall and `size * aspect` wide; speech / shout tails
 * reach out to their tip beyond that box. Degenerate parameters are clamped.
 */
export function shapeCmds(src: ShapeSource): PathCmd[] {
  const h = src.size;
  if (!(h > 0)) return [];
  const w = h * Math.max(src.aspect, 0.01);
  const corner = (Math.max(src.corner, 0) / 100) * h;
  const inner = clamp(src.inner, 0.05, 1);
  const jitter = clamp(src.jitter, 0, 1);
  switch (src.shape) {
    case 'rect':
      return emit(rectSegs(w, h, corner));
    case 'parallelogram': {
      // Total width stays w: the lean shifts the top edge right and the bottom edge left.
      const off = clamp(h * Math.tan(clamp(src.slant, -80, 80) * DEG), -w * 0.95, w * 0.95);
      const a = Math.abs(off);
      const s = Math.sign(off);
      const pts = [
        { x: -w / 2 + (s > 0 ? a : 0), y: h / 2 },
        { x: w / 2 - (s < 0 ? a : 0), y: h / 2 },
        { x: w / 2 - (s > 0 ? a : 0), y: -h / 2 },
        { x: -w / 2 + (s < 0 ? a : 0), y: -h / 2 },
      ];
      return emit(roundedPolySegs(pts, [corner, corner, corner, corner]));
    }
    case 'ellipse':
    case 'orb': // the 2D silhouette of the 3D sphere / ellipsoid
      return emit(ellipseSegs(w / 2, h / 2));
    case 'polygon':
      return emit(polygonSegs(w, h, clamp(Math.round(src.points), 3, 64), corner));
    case 'star':
      return emit(starSegs(w, h, clamp(Math.round(src.points), 3, 100), inner));
    case 'burst': {
      const pts = burstPoints(clamp(Math.round(src.points), 3, 200), inner, jitter, src.seed);
      return emit(polySegs(fitBox(pts, w, h, true)));
    }
    case 'shield':
      return emit(shieldSegs(w, h, corner));
    case 'speech': {
      const tip = { x: (src.tail.x / 100) * h, y: (src.tail.y / 100) * h };
      return emit(withTail(rectSegs(w, h, corner), tip, (Math.max(src.tail.width, 1) / 100) * h));
    }
    case 'shout': {
      // Keep the burst centred on the origin (not on its bounds) so the tail tip is
      // relative to the bubble's centre and the tail splice sees a star-shaped body.
      const pts = burstPoints(clamp(Math.round(src.points), 3, 200), inner, jitter, src.seed);
      const tip = { x: (src.tail.x / 100) * h, y: (src.tail.y / 100) * h };
      return emit(withTail(polySegs(fitBox(pts, w, h, false)), tip, (Math.max(src.tail.width, 1) / 100) * h));
    }
    case 'ribbon':
      return ribbonCmds(w, h, src.inner, (Math.max(src.tail.x, 0) / 100) * h, src.slant);
  }
}

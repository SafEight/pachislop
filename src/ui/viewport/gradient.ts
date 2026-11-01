import type { Bounds } from '../../text/layout';
import type { Pt } from './geometry';

// On-canvas gradient tool (Illustrator style) for a fill's angle / scale / offset, in layer
// space (y-up). Mirrors the 2D shader mapping (engine/layer2d) with v = p − c, hs = half box,
// dir = (cos a, −sin a), ext = |dir.x|·hs.x + |dir.y|·hs.y, s = scale:
// - linear:    t = dot(v, dir) / (2·ext·s) + 0.5 − offset
// - reflected: t = |dot(v, dir)| / (ext·s) − offset
// - radial:    t = |v| / (|hs|·s) − offset
// - diamond:   t = (|v.x| + |v.y|) / ((hs.x + hs.y)·s) − offset (angle ignored)
// - angle:     t = θ / (2π·s) − offset, θ clockwise on screen from dir.
// Handle `a` sits where t = 0 and `b` where t = 1 (angle: `b` only marks the start direction).

export type GradKind = 'linear' | 'reflected' | 'radial' | 'diamond' | 'angle';

export interface GradParams {
  kind: GradKind;
  angle: number; // degrees, clockwise on screen, 0 = left → right
  scale: number;
  offset: number; // −1..1
}

export interface GradHandles {
  c: Pt;
  /** t = 0 (absent when it cannot be dragged: angle gradients). */
  a: Pt | null;
  /** t = 1. */
  b: Pt;
}

const DEG = Math.PI / 180;
const MIN_SCALE = 0.05;
const clampOffset = (o: number) => Math.max(-1, Math.min(1, o));
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const r1 = (v: number) => Math.round(v * 10) / 10;

const dirOf = (angle: number): Pt => ({ x: Math.cos(angle * DEG), y: -Math.sin(angle * DEG) });
const angleOf = (d: Pt) => {
  const a = Math.atan2(-d.y, d.x) / DEG;
  return a < 0 ? a + 360 : a;
};
const half = (b: Bounds) => ({ x: (b.x1 - b.x0) / 2, y: (b.y1 - b.y0) / 2 });
const centre = (b: Bounds): Pt => ({ x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 });
const extOf = (d: Pt, hs: Pt) => Math.max(1e-3, Math.abs(d.x) * hs.x + Math.abs(d.y) * hs.y);
const at = (c: Pt, d: Pt, k: number): Pt => ({ x: c.x + d.x * k, y: c.y + d.y * k });

/** Radius unit of the radial-like kinds (t = 1 at that radius when scale = 1, offset = 0). */
const radiusOf = (kind: 'radial' | 'diamond', hs: Pt) => Math.max(1e-3, kind === 'radial' ? Math.hypot(hs.x, hs.y) : hs.x + hs.y);

export function gradientHandles(g: GradParams, box: Bounds): GradHandles {
  const c = centre(box);
  const hs = half(box);
  const s = Math.max(g.scale, 1e-3);
  if (g.kind === 'radial' || g.kind === 'diamond') {
    // Angle-free kinds: the handles lie on +x so they never jump while dragging.
    const R = radiusOf(g.kind, hs) * s;
    const x = { x: 1, y: 0 };
    return { c, a: at(c, x, g.offset * R), b: at(c, x, (1 + g.offset) * R) };
  }
  const d = dirOf(g.angle);
  const ext = extOf(d, hs);
  if (g.kind === 'linear') return { c, a: at(c, d, (g.offset - 0.5) * 2 * ext * s), b: at(c, d, (g.offset + 0.5) * 2 * ext * s) };
  if (g.kind === 'reflected') return { c, a: at(c, d, g.offset * ext * s), b: at(c, d, (1 + g.offset) * ext * s) };
  return { c, a: null, b: at(c, d, ext) };
}

/**
 * New angle / scale / offset after dragging handle `which` to layer point `p` (the other handle
 * stays put). `snap` rounds the angle to 15°.
 */
export function dragGradientHandle(g: GradParams, box: Bounds, which: 'a' | 'b', p: Pt, snap: boolean): Partial<GradParams> {
  const c = centre(box);
  const hs = half(box);
  const h = gradientHandles(g, box);
  const snapA = (a: number) => (snap ? (Math.round(a / 15) * 15) % 360 : r1(a));
  if (g.kind === 'linear') {
    let A = which === 'a' ? p : h.a!;
    let B = which === 'b' ? p : h.b;
    if (snap) {
      // Snap the line's direction, keeping the dragged handle's distance from the fixed one.
      const fixed = which === 'a' ? B : A;
      const moving = which === 'a' ? A : B;
      const len = Math.hypot(moving.x - fixed.x, moving.y - fixed.y);
      const sgn = which === 'a' ? -1 : 1;
      const ang = snapA(angleOf({ x: (moving.x - fixed.x) * sgn, y: (moving.y - fixed.y) * sgn }));
      const d = dirOf(ang);
      const q = at(fixed, d, sgn * len);
      if (which === 'a') A = q;
      else B = q;
    }
    const L = Math.hypot(B.x - A.x, B.y - A.y);
    if (L < 1e-3) return {};
    const d = { x: (B.x - A.x) / L, y: (B.y - A.y) / L };
    const ext = extOf(d, hs);
    const m = { x: (A.x + B.x) / 2 - c.x, y: (A.y + B.y) / 2 - c.y };
    return { angle: snapA(angleOf(d)), scale: r3(Math.max(MIN_SCALE, L / (2 * ext))), offset: r3(clampOffset((m.x * d.x + m.y * d.y) / L)) };
  }
  const v = { x: p.x - c.x, y: p.y - c.y };
  const s = Math.max(g.scale, 1e-3);
  if (g.kind === 'reflected') {
    if (which === 'b') {
      const len = Math.hypot(v.x, v.y);
      if (len < 1e-3) return {};
      const angle = snapA(angleOf({ x: v.x / len, y: v.y / len }));
      const ext = extOf(dirOf(angle), hs);
      return { angle, scale: r3(Math.max(MIN_SCALE, len / ((1 + g.offset) * ext))) };
    }
    const d = dirOf(g.angle);
    return { offset: r3(clampOffset((v.x * d.x + v.y * d.y) / (extOf(d, hs) * s))) };
  }
  if (g.kind === 'radial' || g.kind === 'diamond') {
    const R = radiusOf(g.kind, hs);
    const dist = g.kind === 'radial' ? Math.hypot(v.x, v.y) : Math.abs(v.x) + Math.abs(v.y);
    if (which === 'b') return { scale: r3(Math.max(MIN_SCALE, dist / Math.max(0.05, 1 + g.offset) / R)) };
    return { offset: r3(clampOffset(v.x / (R * s))) };
  }
  // angle: the handle sets the start direction.
  if (Math.hypot(v.x, v.y) < 1e-3) return {};
  return { angle: snapA(angleOf(v)) };
}

/** Drag the whole line by `delta` (layer px): only the component along the axis moves the offset. */
export function dragGradientLine(g: GradParams, box: Bounds, start: GradParams, delta: Pt): Partial<GradParams> {
  const hs = half(box);
  const s = Math.max(start.scale, 1e-3);
  if (g.kind === 'linear' || g.kind === 'reflected') {
    const d = dirOf(start.angle);
    const along = delta.x * d.x + delta.y * d.y;
    const span = (g.kind === 'linear' ? 2 : 1) * extOf(d, hs) * s;
    return { offset: r3(clampOffset(start.offset + along / span)) };
  }
  if (g.kind === 'radial' || g.kind === 'diamond') return { offset: r3(clampOffset(start.offset + delta.x / (radiusOf(g.kind, hs) * s))) };
  return {};
}

/**
 * Photoshop Gradient tool: the params of a gradient laid by a drag from layer point `a`
 * (t = 0) to `b` (t = 1); the kind stays. `snap` rounds the angle to 15°. Radial / diamond
 * take the length (and `a`'s x as the offset); angle gradients only the start direction.
 */
export function gradientFromLine(g: GradParams, box: Bounds, a: Pt, b: Pt, snap: boolean): Partial<GradParams> {
  const c = centre(box);
  const hs = half(box);
  const v = { x: b.x - a.x, y: b.y - a.y };
  const L = Math.hypot(v.x, v.y);
  if (L < 1e-3) return {};
  const raw = angleOf({ x: v.x / L, y: v.y / L });
  const angle = snap ? (Math.round(raw / 15) * 15) % 360 : r1(raw);
  if (g.kind === 'radial' || g.kind === 'diamond') {
    const R = radiusOf(g.kind, hs);
    const s = Math.max(MIN_SCALE, (g.kind === 'radial' ? L : Math.abs(v.x) + Math.abs(v.y)) / R);
    return { scale: r3(s), offset: r3(clampOffset((a.x - c.x) / (R * s))) };
  }
  if (g.kind === 'angle') return { angle };
  const d = dirOf(angle);
  const len = Math.max(1e-3, v.x * d.x + v.y * d.y); // the drag's length along the (snapped) axis
  const ext = extOf(d, hs);
  if (g.kind === 'linear') {
    const m = { x: a.x + (d.x * len) / 2 - c.x, y: a.y + (d.y * len) / 2 - c.y };
    return { angle, scale: r3(Math.max(MIN_SCALE, len / (2 * ext))), offset: r3(clampOffset((m.x * d.x + m.y * d.y) / len)) };
  }
  return { angle, scale: r3(Math.max(MIN_SCALE, len / ext)), offset: r3(clampOffset(((a.x - c.x) * d.x + (a.y - c.y) * d.y) / len)) };
}

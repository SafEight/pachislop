import * as THREE from 'three';
import type { GeneratorContext, ParamDef } from '../../engine/contracts';
import { sampleGradientRgba } from '../../model/gradient';
import type { Gradient } from '../../model/types';

// Helpers shared by the line generators (speed lines, light streaks, sunburst).

/** `d` shown only while param `key` equals `value` (or one of `value`). */
export const when = (d: ParamDef, key: string, value: string | boolean | string[]): ParamDef => ({ ...d, when: { key, value } });

export const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);

/** Render px per layer-space px (the layer transform is a similarity: one scale for both axes). */
export const pxPerLayer = (m: THREE.Matrix3) => Math.hypot(m.elements[0], m.elements[1]) || 1;

/**
 * The WHOLE frame's corners (ctx.frame, not a preview window's target) in layer space (comp px,
 * +y up), in order around the frame: lines laid out over the frame land the same in a window.
 */
export function framePolygon(ctx: GeneratorContext): [number, number][] {
  const inv = ctx.layerToRender.clone().invert();
  const v = new THREE.Vector2();
  const f = ctx.frame;
  // The frame's edges in target px (0 − x: +0 for a whole frame, as the target's own corners).
  const x0 = 0 - f.x;
  const y0 = 0 - f.y;
  const x1 = f.width - f.x;
  const y1 = f.height - f.y;
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ].map(([x, y]) => {
    v.set(x, y).applyMatrix3(inv);
    return [v.x, v.y] as [number, number];
  });
}

/** True when (x, y) lies inside the convex polygon `poly` (either winding). */
export function insideConvex(poly: [number, number][], x: number, y: number): boolean {
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const [ax, ay] = poly[i];
    const [bx, by] = poly[(i + 1) % poly.length];
    const c = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
    if (c === 0) continue;
    if (sign === 0) sign = Math.sign(c);
    else if (Math.sign(c) !== sign) return false;
  }
  return true;
}

/**
 * Distance along the unit ray (ox, oy) + t·(dx, dy) at which it leaves the convex polygon `poly`,
 * or −1 when it never reaches the inside (t ≥ 0).
 */
export function rayExit(poly: [number, number][], ox: number, oy: number, dx: number, dy: number): number {
  let cx = 0;
  let cy = 0;
  for (const [x, y] of poly) {
    cx += x / poly.length;
    cy += y / poly.length;
  }
  let t0 = -Infinity;
  let t1 = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const [ax, ay] = poly[i];
    const [bx, by] = poly[(i + 1) % poly.length];
    // Edge normal pointing inside (towards the centroid), whatever the winding.
    let nx = ay - by;
    let ny = bx - ax;
    if (nx * (cx - ax) + ny * (cy - ay) < 0) {
      nx = -nx;
      ny = -ny;
    }
    const dist = nx * (ox - ax) + ny * (oy - ay); // > 0 inside this edge
    const den = nx * dx + ny * dy;
    if (Math.abs(den) < 1e-12) {
      if (dist < 0) return -1;
      continue;
    }
    const t = -dist / den;
    if (den > 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
  }
  return t1 >= Math.max(t0, 0) ? t1 : -1;
}

/**
 * Taper (入り抜き) as fractions of the length over which each end grows from a point to full
 * width: tail = the start (t = 0), head = the end (t = 1). Both 100% meet in the middle.
 */
export function taperFractions(tailPct: number, headPct: number): [number, number] {
  const a = clamp(tailPct / 100, 0, 1);
  const b = clamp(headPct / 100, 0, 1);
  const s = a + b > 1 ? 1 / (a + b) : 1;
  return [a * s, b * s];
}

/** GLSL twin of taperFractions: width factor 0..1 at t along the line. */
export const TAPER_GLSL = /* glsl */ `
float taperAt(float t, float tail, float head) {
  float w = 1.0;
  if (tail > 0.0) w = min(w, t / tail);
  if (head > 0.0) w = min(w, (1.0 - t) / head);
  return clamp(w, 0.0, 1.0);
}
`;

const tmp = new THREE.Color();

/** Gradient at pos 0..1 as straight-alpha LINEAR [r, g, b, a] (the lookup textures' encoding). */
export function gradientLinear(g: Gradient, pos: number): [number, number, number, number] {
  const [r, gg, b, a] = sampleGradientRgba(g, pos);
  tmp.setRGB(r, gg, b, THREE.SRGBColorSpace);
  return [tmp.r, tmp.g, tmp.b, a];
}

import type { BevelProfile2D, Curve, CurvePoint, GlossContour } from '../../model/types';

// Contours / curves shared by the 2D renderer (baked to LUTs) and the UI (icons, curve
// editor, seeding a custom curve from a preset). The preset functions here are the exact
// JS twins of the GLSL in shaders.ts (HEIGHT_FRAG profile(), ELEMENT_FRAG contour()), so an
// icon or a seeded custom curve looks like what the renderer draws.

const smoothstep = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** 2D bevel height (0 = edge, 1 = plateau) at t ∈ [0,1] from the edge to `size` inside. */
export const PROFILE_2D_FN: Record<Exclude<BevelProfile2D, 'custom'>, (t: number) => number> = {
  smooth: (t) => Math.sin(t * 1.5707963),
  button: (t) => 1 - (1 - t) ** 3,
  mesa: (t) => 1 - (1 - Math.min(t / 0.45, 1)) ** 2,
  chamfer: (t) => t,
  ridge: (t) => 1 - Math.abs(2 * t - 1),
  cove: (t) => t * t,
  stepped: (t) => {
    const f = Math.min(t, 0.9999) * 3;
    return (Math.floor(f) + smoothstep(0.55, 1, f - Math.floor(f))) / 3;
  },
};

/** Gloss contour: output for input x ∈ [0,1] (contour(0) = 0 keeps flat areas neutral). */
export const GLOSS_FN: Record<Exclude<GlossContour, 'custom'>, (x: number) => number> = {
  linear: (x) => x,
  ring: (x) => Math.sin(x * 2.6) ** 2,
  doubleRing: (x) => Math.sin(x * 5.5) ** 2,
  cove: (x) => 1 - Math.sqrt(Math.max(1 - x * x, 0)),
  roundedSteps: (x) => {
    const f = Math.min(x, 0.9999) * 4;
    return (Math.floor(f) + smoothstep(0.3, 0.7, f - Math.floor(f))) / 4;
  },
  sawtooth: (x) => ((Math.min(x, 0.9999) * 3) % 1) * (0.6 + 0.4 * x),
};

// ---------- curve evaluation ----------

/** Points sorted by x and clamped to the unit square, with endpoints at x = 0 and x = 1. */
export function curvePoints(c: Curve): CurvePoint[] {
  const pts = c.points
    .map((p) => ({ x: Math.min(1, Math.max(0, p.x)), y: Math.min(1, Math.max(0, p.y)), corner: p.corner }))
    .sort((a, b) => a.x - b.x);
  if (pts.length === 0) return [{ x: 0, y: 0, corner: false }, { x: 1, y: 1, corner: false }];
  if (pts[0].x > 0) pts.unshift({ x: 0, y: pts[0].y, corner: false });
  if (pts[pts.length - 1].x < 1) pts.push({ x: 1, y: pts[pts.length - 1].y, corner: false });
  return pts;
}

/**
 * Evaluator y(x) for a curve: monotone cubic Hermite (PCHIP / Fritsch–Butland tangents, so a
 * smooth point at a local extremum gets a flat tangent and nothing overshoots); a corner point
 * takes the secant of each neighbouring segment as its one-sided tangent, so the curve kinks
 * there and two corners in a row are joined by a straight line. Output clamped to 0..1.
 */
export function curveFn(c: Curve): (x: number) => number {
  const p = curvePoints(c);
  const n = p.length;
  if (n === 1) return () => p[0].y;
  const h: number[] = [];
  const d: number[] = [];
  for (let k = 0; k < n - 1; k++) {
    h.push(p[k + 1].x - p[k].x);
    d.push(h[k] > 1e-6 ? (p[k + 1].y - p[k].y) / h[k] : 0);
  }
  // tin[k]: tangent arriving at point k; tout[k]: tangent leaving it.
  const tin = new Array<number>(n).fill(0);
  const tout = new Array<number>(n).fill(0);
  tout[0] = d[0];
  tin[n - 1] = d[n - 2];
  for (let k = 1; k < n - 1; k++) {
    if (p[k].corner) {
      tin[k] = d[k - 1];
      tout[k] = d[k];
    } else if (d[k - 1] * d[k] <= 0) {
      tin[k] = tout[k] = 0;
    } else {
      const w1 = 2 * h[k] + h[k - 1];
      const w2 = h[k] + 2 * h[k - 1];
      tin[k] = tout[k] = (w1 + w2) / (w1 / d[k - 1] + w2 / d[k]);
    }
  }
  return (xIn: number) => {
    const x = Math.min(1, Math.max(0, xIn));
    let k = 0;
    while (k < n - 2 && x > p[k + 1].x) k++;
    // Coincident x (a vertical jump): the later segment wins from x onwards.
    if (h[k] <= 1e-6) return Math.min(1, Math.max(0, p[k + 1].y));
    const t = (x - p[k].x) / h[k];
    const t2 = t * t;
    const t3 = t2 * t;
    const y =
      (2 * t3 - 3 * t2 + 1) * p[k].y +
      (t3 - 2 * t2 + t) * h[k] * tout[k] +
      (-2 * t3 + 3 * t2) * p[k + 1].y +
      (t3 - t2) * h[k] * tin[k + 1];
    return Math.min(1, Math.max(0, y));
  };
}

/** Bake a curve to `n` samples at x = i / (n − 1) (the renderers' 256-entry LUT). */
export function bakeCurve(c: Curve, n = 256): Float32Array {
  const f = curveFn(c);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = f(i / (n - 1));
  return out;
}

// ---------- presets as editable curves ----------

const pt = (x: number, y: number, corner = false): CurvePoint => ({ x, y, corner });

/**
 * Fit a smooth function with as few smooth points as keep the curve within `tol` of it:
 * greedy insertion of the sample nearest the worst error (max 16 points).
 */
function fitCurve(fn: (x: number) => number, tol = 0.012): Curve {
  const S = 64;
  const test = 256;
  const points: CurvePoint[] = [pt(0, fn(0)), pt(1, fn(1))];
  for (let iter = 0; iter < 14; iter++) {
    const f = curveFn({ points });
    let worst = 0;
    let worstX = 0;
    for (let i = 0; i <= test; i++) {
      const x = i / test;
      const e = Math.abs(f(x) - fn(x));
      if (e > worst) {
        worst = e;
        worstX = x;
      }
    }
    if (worst < tol) break;
    const sx = Math.round(worstX * S) / S;
    if (points.some((q) => Math.abs(q.x - sx) < 0.5 / S)) break;
    points.push(pt(sx, fn(sx)));
    points.sort((a, b) => a.x - b.x);
  }
  return { points: points.map((q) => ({ ...q, x: round3(q.x), y: round3(q.y) })) };
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

/** `steps` flat treads with smooth risers spanning [lo, hi] of each step (stepped / rounded steps). */
function stepsCurve(steps: number, lo: number, hi: number): Curve {
  const points: CurvePoint[] = [pt(0, 0)];
  for (let k = 0; k < steps; k++) {
    points.push(pt((k + lo) / steps, k / steps), pt((k + hi) / steps, (k + 1) / steps));
  }
  if (points[points.length - 1].x < 1) points.push(pt(1, 1));
  return { points: points.map((q) => ({ ...q, x: round3(q.x), y: round3(q.y) })) };
}

/** Editable curve reproducing a bevel profile (seed for profile = 'custom'). */
export function profileCurve(profile: BevelProfile2D): Curve {
  if (profile === 'custom') return fitCurve(PROFILE_2D_FN.smooth);
  if (profile === 'chamfer') return { points: [pt(0, 0), pt(1, 1)] };
  if (profile === 'ridge') return { points: [pt(0, 0), pt(0.5, 1, true), pt(1, 0)] };
  if (profile === 'stepped') return stepsCurve(3, 0.55, 1);
  return fitCurve(PROFILE_2D_FN[profile]);
}

/** Editable curve reproducing a gloss contour (seed for gloss = 'custom'). */
export function glossCurve(gloss: GlossContour): Curve {
  if (gloss === 'custom' || gloss === 'linear') return { points: [pt(0, 0), pt(1, 1)] };
  if (gloss === 'roundedSteps') return stepsCurve(4, 0.3, 0.7);
  if (gloss === 'sawtooth') {
    const f = GLOSS_FN.sawtooth;
    const e = 0.002;
    return {
      points: [pt(0, 0, true), pt(1 / 3 - e, f(1 / 3 - e), true), pt(1 / 3, 0, true), pt(2 / 3 - e, f(2 / 3 - e), true), pt(2 / 3, 0, true), pt(1, 1, true)].map(
        (q) => ({ ...q, x: round3(q.x), y: round3(q.y) }),
      ),
    };
  }
  return fitCurve(GLOSS_FN[gloss]);
}

export interface CurvePreset {
  label: string;
  curve: Curve;
}

/** Photoshop-style contour presets (gloss contour, satin contour…). */
export function contourPresets(): CurvePreset[] {
  return [
    { label: 'Linear', curve: { points: [pt(0, 0), pt(1, 1)] } },
    { label: 'Gaussian', curve: { points: [pt(0, 0), pt(0.25, 0.15), pt(0.5, 1), pt(0.75, 0.15), pt(1, 0)] } },
    { label: 'Cone', curve: { points: [pt(0, 0), pt(0.5, 1, true), pt(1, 0)] } },
    { label: 'Cone – inverted', curve: { points: [pt(0, 1), pt(0.5, 0, true), pt(1, 1)] } },
    { label: 'Half round', curve: fitCurve((x) => Math.sqrt(Math.max(0, 1 - (1 - x) * (1 - x)))) },
    { label: 'Ring', curve: glossCurve('ring') },
    { label: 'Ring – double', curve: glossCurve('doubleRing') },
    { label: 'Cove – deep', curve: glossCurve('cove') },
    { label: 'Rolling slope', curve: { points: [pt(0, 1), pt(0.35, 0.2), pt(0.65, 0.8), pt(1, 0)] } },
    { label: 'Rounded steps', curve: glossCurve('roundedSteps') },
    { label: 'Sawtooth', curve: glossCurve('sawtooth') },
  ];
}

/** Bevel profile presets as editable curves (x = edge → inside, y = height). */
export function profilePresets(): CurvePreset[] {
  const names: [Exclude<BevelProfile2D, 'custom'>, string][] = [
    ['smooth', 'Smooth'],
    ['button', 'Button'],
    ['mesa', 'Mesa'],
    ['chamfer', 'Chamfer'],
    ['ridge', 'Ridge'],
    ['cove', 'Cove'],
    ['stepped', 'Stepped'],
  ];
  return names.map(([id, label]) => ({ label, curve: profileCurve(id) }));
}

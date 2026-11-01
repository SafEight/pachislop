import type { Gradient, GradientStop, Material2D, ParamValue } from './types';

// ParamValue guards (structured params), then gradient sampling.

export const isGradient = (v: ParamValue | undefined): v is Gradient =>
  typeof v === 'object' && v !== null && 'stops' in v;

/** A 'material2d' param's value (the stored object, not a scalar left by a hand-edited file). */
export const isMaterial2D = (v: unknown): v is Material2D =>
  typeof v === 'object' && v !== null && 'fill' in v && 'bevel' in v;

type RGB = [number, number, number];
type RGBA = [number, number, number, number];

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Stops sorted by position, cached per stops array (store values are immutable). */
const sortedCache = new WeakMap<GradientStop[], GradientStop[]>();
function sorted(g: Gradient): GradientStop[] {
  let s = sortedCache.get(g.stops);
  if (!s) sortedCache.set(g.stops, (s = [...g.stops].sort((a, b) => a.pos - b.pos)));
  return s;
}

/**
 * Photoshop colour midpoint (same curve as a CSS colour hint): remaps the 0..1 blend between two
 * stops so the half-way colour sits at `mid` of the gap. `mid` 0.5 = linear.
 */
export function midpointBlend(x: number, mid = 0.5): number {
  const m = Math.min(0.95, Math.max(0.05, mid));
  if (Math.abs(m - 0.5) < 1e-4 || x <= 0 || x >= 1) return x;
  return Math.pow(x, Math.log(0.5) / Math.log(m));
}

// ---------- OKLCH ('vivid' interpolation) ----------

const toLin = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const toSrgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

/** sRGB 0..1 → OKLCH [L, C, h radians]. */
function oklch([r, g, b]: RGB): RGB {
  const R = toLin(r);
  const G = toLin(g);
  const B = toLin(b);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const Bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [L, Math.hypot(A, Bb), Math.atan2(Bb, A)];
}

/** OKLab → linear sRGB (unclamped). */
function labToLinear(L: number, A: number, B: number): RGB {
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/** OKLCH → sRGB, reducing chroma (hue and lightness kept) until it fits the sRGB gamut. */
function fromOklch(L: number, C: number, h: number): RGB {
  const fits = (c: RGB) => c.every((v) => v >= -1e-4 && v <= 1 + 1e-4);
  let lin = labToLinear(L, C * Math.cos(h), C * Math.sin(h));
  if (!fits(lin)) {
    let lo = 0;
    let hi = C;
    for (let i = 0; i < 14; i++) {
      const mid = (lo + hi) / 2;
      if (fits(labToLinear(L, mid * Math.cos(h), mid * Math.sin(h)))) lo = mid;
      else hi = mid;
    }
    lin = labToLinear(L, lo * Math.cos(h), lo * Math.sin(h));
  }
  return [clamp01(toSrgb(clamp01(lin[0]))), clamp01(toSrgb(clamp01(lin[1]))), clamp01(toSrgb(clamp01(lin[2])))];
}

/** Below this chroma a colour's hue is meaningless (white, greys): it takes the other stop's hue. */
const ACHROMATIC = 0.004;

/** OKLCH blend along the shorter hue arc, so blue → white stays blue instead of greying out. */
function mixVivid(a: RGB, b: RGB, t: number): RGB {
  const [La, Ca, ha0] = oklch(a);
  const [Lb, Cb, hb0] = oklch(b);
  const ha = Ca < ACHROMATIC ? hb0 : ha0;
  const hb = Cb < ACHROMATIC ? ha0 : hb0;
  let dh = hb - ha;
  if (dh > Math.PI) dh -= 2 * Math.PI;
  else if (dh < -Math.PI) dh += 2 * Math.PI;
  return fromOklch(La + (Lb - La) * t, Ca + (Cb - Ca) * t, ha + dh * t);
}

// ---------- sampling ----------

/**
 * Sample a gradient at pos 0..1 → [r, g, b, a] in 0..1 (sRGB colour, straight alpha). Colour and
 * opacity blend separately like Photoshop's colour / opacity stops; the stop's `mid` bends both,
 * and `interp: 'vivid'` blends the colour in OKLCH.
 */
export function sampleGradientRgba(g: Gradient, pos: number): RGBA {
  const s = sorted(g);
  if (s.length === 0) return [1, 1, 1, 1];
  const at = (st: GradientStop): RGBA => [...hexToRgb(st.color), st.alpha ?? 1];
  if (pos <= s[0].pos) return at(s[0]);
  for (let i = 0; i < s.length - 1; i++) {
    const a = s[i];
    const b = s[i + 1];
    if (pos > b.pos) continue;
    const span = b.pos - a.pos;
    const x = midpointBlend(span > 0 ? (pos - a.pos) / span : 0, a.mid);
    const ca = hexToRgb(a.color);
    const cb = hexToRgb(b.color);
    const c: RGB =
      g.interp === 'vivid' && a.color !== b.color
        ? mixVivid(ca, cb, x)
        : [ca[0] + (cb[0] - ca[0]) * x, ca[1] + (cb[1] - ca[1]) * x, ca[2] + (cb[2] - ca[2]) * x];
    const aa = a.alpha ?? 1;
    return [c[0], c[1], c[2], aa + ((b.alpha ?? 1) - aa) * x];
  }
  return at(s[s.length - 1]);
}

/** Sample a gradient's colour at pos 0..1 → [r, g, b] in 0..1 (sRGB); see sampleGradientRgba. */
export function sampleGradient(g: Gradient, pos: number): RGB {
  const [r, gg, b] = sampleGradientRgba(g, pos);
  return [r, gg, b];
}

/** `n` evenly spaced samples (pos 0 … 1) as RGBA8 (sRGB colour, straight alpha) for lookup textures. */
export function bakeGradient(g: Gradient, n = 256): Uint8Array {
  const data = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const c = sampleGradientRgba(g, n > 1 ? i / (n - 1) : 0);
    for (let k = 0; k < 4; k++) data[i * 4 + k] = Math.round(clamp01(c[k]) * 255);
  }
  return data;
}

/** True when some stop is not fully opaque. */
export const gradientHasAlpha = (g: Gradient) => g.stops.some((s) => (s.alpha ?? 1) < 1);

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.replace(/./g, (c) => c + c) : h, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export const solid = (color: string): Gradient => ({ stops: [{ pos: 0, color }] });

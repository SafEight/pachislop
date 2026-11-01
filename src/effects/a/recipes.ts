import type { EffectParams } from '../../engine/contracts';
import { hexToRgb } from '../../model/gradient';
import { defaultAdjustment } from '../../model/defaults';
import type { Adjustment, Gradient, GradientStop } from '../../model/types';

// Settings of general effects for looks that used to be effects of their own: a rainbow and a
// swept glint band (Gradient Overlay), a flat long shadow (Extrude). Used by the effects' presets,
// the factory looks and the effect migration (io/migrate/effectDedupe.ts), so all build the same.

const toLin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toSrgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
const hex = (rgb: readonly number[]) =>
  `#${rgb.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('')}`;
const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * The hue wheel at HSV saturation `saturation` and full value, red → … → red over 0..1. HSV is
 * piecewise linear in sRGB between the six primaries / secondaries, and gradients blend in sRGB,
 * so these seven stops are the wheel exactly.
 */
export function hueWheel(saturation = 1): Gradient {
  const s = Math.min(1, Math.max(0, saturation));
  const corners = [
    [1, 0, 0],
    [1, 1, 0],
    [0, 1, 0],
    [0, 1, 1],
    [0, 0, 1],
    [1, 0, 1],
    [1, 0, 0],
  ];
  return { stops: corners.map((c, i) => ({ pos: i / 6, color: hex(c.map((v) => 1 - s + s * v)) })) };
}

/**
 * A rainbow repeating `bands` times across the layer along `angle` (screen-clockwise degrees),
 * shifted by `phase` (fraction of a band): Gradient Overlay with the hue wheel, wrapping.
 */
export function rainbowOverlay(o: { bands: number; angle: number; phase: number; saturation: number; amount: number; mode: string }): EffectParams {
  const bands = Math.max(0.1, o.bands);
  // Gradient position (boxPos − 0.5) / scale + 0.5 + offset = bands · boxPos − phase (mod 1).
  const off = 0.5 * bands - 0.5 - o.phase;
  return {
    gradient: hueWheel(o.saturation),
    style: 'linear',
    angle: o.angle,
    scale: 1 / bands,
    offset: off - Math.floor(off),
    wrap: 'repeat',
    amount: o.amount,
    mode: o.mode,
  };
}

/**
 * A glint band swept across the layer: Gradient Overlay, Sweep style, added as light.
 * - angle: travel direction (screen-clockwise degrees);
 * - position: −100…100 % = from just off one side of the layer to just off the other;
 * - width: half-width of the band (comp px), softness 0…100 % of it feathered;
 * - double: a second thin band (0.32 × width, 80 %) trailing 2.1 widths behind;
 * - intensity: 0…100 % (beyond 100 % brightens the colour up to white).
 * The gradient is 5 widths long, so the band leaves the layer at ±100 %.
 */
export function glintOverlay(o: { angle: number; position: number; width: number; softness: number; double: boolean; color: string; intensity: number }): EffectParams {
  const soft = Math.min(0.999, Math.max(0, o.softness / 100));
  const w = Math.max(0.5, o.width);
  const len = 5 * w;
  const k = Math.max(0, o.intensity / 100);
  const amount = Math.min(1, k);
  const gain = amount > 0 ? k / amount : 1;
  const col = hexToRgb(o.color).map(toLin);
  // Bands in gradient units around the gradient's centre: [centre, half-width, peak].
  const bands: [number, number, number][] = [[0.5, w / len, 1]];
  if (o.double) bands.push([0.5 - (2.1 * w) / len, (0.32 * w) / len, 0.8]);
  const value = (x: number) => bands.reduce((v, [m, h, peak]) => v + peak * (1 - smoothstep(h * (1 - soft), h, Math.abs(x - m))), 0);
  // Stops: the band edges sampled finely (16 per feather), flat cores and the zero ends.
  const xs = new Set<number>([0, 1]);
  const SEG = 16;
  for (const [m, h] of bands) {
    const hi = h * (1 - soft);
    for (const side of [-1, 1]) for (let i = 0; i <= SEG; i++) xs.add(m + side * (hi + ((h - hi) * i) / SEG));
  }
  const stops: GradientStop[] = [...xs]
    .filter((x) => x >= 0 && x <= 1)
    .sort((a, b) => a - b)
    .map((x) => {
      const v = value(x) * gain;
      return { pos: Math.round(x * 1e5) / 1e5, color: hex(col.map((c) => toSrgb(Math.min(1, c * v)))) };
    });
  return {
    gradient: { stops },
    style: 'sweep',
    angle: o.angle,
    length: len,
    position: o.position,
    wrap: 'clamp',
    amount,
    mode: 'light',
  };
}

/** A flat shadow cast `length` px toward `angle` (screen-clockwise), fading by `fade` toward its end: Extrude, unshaded. */
export function longShadowExtrude(o: { angle: number; length: number; fade: number; color: string; opacity: number }): EffectParams {
  return {
    angle: o.angle,
    length: o.length,
    gradient: { stops: [{ pos: 0, color: o.color }] },
    shading: 0,
    edge: 0,
    fade: o.fade,
    opacity: o.opacity,
  };
}

/** A Levels adjustment on the composite (RGB) channel, levels 0…255 (fractions allowed). */
export function levels(inBlack: number, inWhite: number, gamma: number, outBlack = 0, outWhite = 255): Adjustment {
  const lv = defaultAdjustment('levels') as Extract<Adjustment, { type: 'levels' }>;
  lv.channels.rgb = { inBlack, inWhite, gamma, outBlack, outWhite };
  return lv;
}

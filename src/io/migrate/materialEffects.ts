import { bevel2D, curve, glass2D, linearFill, material2D, sheen2D, solidFill } from '../../model/defaults';
import { isGradient } from '../../model/gradient';
import type { Bevel2D, BevelProfile2D, Curve, EffectInstance, Gradient, Layer, Material2D, ParamValue, PartEffects, Project, Texture2D } from '../../model/types';

// Migration step 3 (see src/io/migrate/): the Bevel, Chrome, Glass and Metal Texture effects
// became presets of the one Material effect (effects/b/material.ts), whose param is a Material2D
// shaded by the title parts' own shader. Each old instance becomes a Material effect at the same
// place in the stack, with the same id and enabled flag, Size 200 px (so 1 % = 2 px), and:
//
//   every bevel     Bevel width → bevel size; the old profile curve (round button, mesa, ridge,
//                   stepped, cove; sampled into a custom profile, chamfer stays chamfer); height
//                   % → depth (old normal slope = width × height, new = size × depth × 0.35);
//                   Smoothness → soften (old blur σ = smoothness, new σ = soften / 2); light angle /
//                   elevation as is, following the global light only when the instance did (a
//                   missing flag predates it: own light). The old Phong lift + specular becomes the
//                   PS highlight (linear gloss contour, opacity 0.85 × highlight brightness), the
//                   Lambert shading the shadow multiply (opacity: the old full-shade darkening, in
//                   sRGB).
//   Bevel           Layer colours.
//   Chrome          Fill: the reflection map (silver / gold / rainbow / dark or the custom one) as a
//                   top → bottom linear gradient, scaled 1 / 0.85 and offset by the horizon as the
//                   old map was, the tint folded into its stops, once per line when it repeated;
//                   distortion → negative refraction (up-facing slopes show what is above): the old
//                   shift was half the distortion × the layer height, taken as the 200 px size.
//                   Horizon wave and Keep layer colour have no equivalent and are dropped.
//   Glass           Layer colours; Glass2D with the old colour, body opacity, tint, edge
//                   darkening and caustic; refraction px → %; no shadow (the old glass had none).
//   Metal Texture   Layer colours, bevel off; texture brushed / hairline → Hairline (hairline at
//                   0.45 × the grain size, as before), spun → Spun, flakes → Flakes, at the grain
//                   size, direction and strength (overlay: b · (1 + 2 s (v − ½)) on darks, the old
//                   grain); the sheen → Sheen2D.
//
// Idempotent: only the four removed types are touched.

const REMOVED: readonly string[] = ['bevel', 'chrome', 'glass', 'metalTexture'];

/** The Material effect Size the migrated percentages refer to (its default). */
const SIZE = 200;
const pct = (px: number) => (px / SIZE) * 100;
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

interface Reader {
  n(k: string, def: number): number;
  s(k: string, def: string): string;
  b(k: string, def: boolean): boolean;
  raw(k: string): ParamValue | undefined;
}

/** Old param `k` of `fx`, or `def` (the removed effect's default) when missing or mistyped. */
function reader(fx: EffectInstance): Reader {
  const p = fx.params;
  return {
    n: (k, def) => (typeof p[k] === 'number' ? (p[k] as number) : def),
    s: (k, def) => (typeof p[k] === 'string' ? (p[k] as string) : def),
    b: (k, def) => (typeof p[k] === 'boolean' ? (p[k] as boolean) : def),
    raw: (k) => p[k],
  };
}

// ---------- bevel ----------

const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const roundP = (x: number) => Math.sqrt(Math.max(0, 1 - (1 - clamp(x, 0, 1)) ** 2));

/** The old effects' bevel profiles (height 0..1 at x = inside distance / width), with the x of their kinks. */
const OLD_PROFILES: Record<string, { f: (x: number) => number; corners: number[] }> = {
  button: { f: roundP, corners: [] },
  mesa: { f: (x) => x * x * (3 - 2 * x), corners: [] },
  ridge: { f: (x) => (x < 0.5 ? roundP(2 * x) : 1 - 0.45 * smoothstep(0.5, 1, x)), corners: [0.5] },
  stepped: { f: (x) => 0.55 * roundP(x / 0.45) + 0.45 * roundP((x - 0.55) / 0.45), corners: [0.45, 0.55] },
  cove: { f: (x) => 1 - Math.sqrt(Math.max(0, 1 - x * x)), corners: [] },
};

/** Sample points, dense at the edge where the round profiles rise steeply. */
const XS = [0, 0.01, 0.03, 0.06, 0.1, 0.16, 0.24, 0.33, 0.45, 0.5, 0.55, 0.65, 0.78, 0.9, 1];

function oldProfile(name: string): { profile: BevelProfile2D; profileCurve?: Curve } {
  if (name === 'chamfer') return { profile: 'chamfer' };
  const { f, corners } = OLD_PROFILES[name] ?? OLD_PROFILES.button;
  const xs = [...new Set([...XS, ...corners])].sort((a, b) => a - b);
  return { profile: 'custom', profileCurve: curve(...xs.map((x): [number, number, boolean] => [x, clamp(f(x), 0, 1), corners.includes(x)])) };
}

const DEG = Math.PI / 180;

/** sRGB multiply opacity whose full strength darkens linear light by `d` (0..1). */
const srgbShadow = (d: number) => clamp(1 - (1 - clamp(d, 0, 1)) ** (1 / 2.2), 0, 1);

/**
 * The Bevel2D of an old bevel / chrome / glass instance. `shade(Lz)`: how much the old shading
 * darkened a slope facing away from the light (linear light), for the shadow opacity.
 */
function oldBevel(r: Reader, d: { width: number; depth: number; elevation: number; highlight: number }, shade: (lz: number) => number): Bevel2D {
  const elevation = r.n('elevation', d.elevation);
  return bevel2D({
    ...oldProfile(r.s('profile', 'button')),
    size: pct(Math.max(0.5, r.n('width', d.width))),
    sizeMode: 'fixed',
    depth: clamp(r.n('depth', d.depth) / 100 / 0.35, 0, 10),
    soften: pct(2 * r.n('smooth', 2)),
    lightAngle: r.n('angle', 135),
    lightAltitude: elevation,
    // Files from before the flag lit their effects with their own angle.
    useGlobalLight: r.b('useGlobalLight', false),
    gloss: 'linear',
    highlightColor: r.s('highlightColor', '#ffffff'),
    highlightOpacity: clamp(0.85 * (r.n('highlight', d.highlight) / 100), 0, 1),
    shadowColor: '#000000',
    shadowOpacity: srgbShadow(shade(Math.sin(clamp(elevation, 0, 90) * DEG))),
  });
}

// ---------- chrome maps ----------

const g = (...s: [number, string][]): Gradient => ({ stops: s.map(([pos, color]) => ({ pos, color })) });

/** The old Chrome reflection maps, pos 0 = top of the sky, 0.5 = horizon, 1 = bottom of the ground. */
const CHROME_MAPS: Record<string, Gradient> = {
  silver: g([0, '#36568e'], [0.24, '#a6c1ea'], [0.45, '#ffffff'], [0.5, '#eef3ff'], [0.506, '#101219'], [0.62, '#38373e'], [0.82, '#a29d96'], [1, '#f7f4ee']),
  gold: g([0, '#a35c0c'], [0.2, '#ffcf5a'], [0.44, '#fffbe2'], [0.5, '#ffe9a0'], [0.506, '#3d1c00'], [0.62, '#8a4a00'], [0.82, '#eaa628'], [1, '#fff3b8']),
  rainbow: g(
    [0, '#ff3df2'],
    [0.12, '#5a7bff'],
    [0.25, '#38e8ff'],
    [0.42, '#ffffff'],
    [0.5, '#fff5a0'],
    [0.506, '#300c40'],
    [0.6, '#ff2a2a'],
    [0.72, '#ff9b00'],
    [0.86, '#fff200'],
    [1, '#2bff3a'],
  ),
  dark: g([0, '#2a303c'], [0.3, '#7f8899'], [0.47, '#e8eef8'], [0.5, '#ffffff'], [0.506, '#000000'], [0.78, '#141519'], [1, '#5a5e66']),
};

const hex = (c: string, i: number) => parseInt(c.slice(i, i + 2), 16);

/** `gr` with every stop multiplied by `tint` (sRGB) to `amount`: the old tint (a multiply after the map lookup). */
function tinted(gr: Gradient, tint: string, amount: number): Gradient {
  if (!(amount > 0)) return gr;
  const t = [1, 3, 5].map((i) => hex(tint, i) / 255);
  const mul = (c: string) => {
    const v = [1, 3, 5].map((i, k) => Math.round(clamp(hex(c, i) * (1 + (t[k] - 1) * amount), 0, 255)));
    return `#${v.map((x) => x.toString(16).padStart(2, '0')).join('')}`;
  };
  return { ...gr, stops: gr.stops.map((s) => ({ ...s, color: mul(s.color) })) };
}

// ---------- the four effects ----------

function bevelMaterial(r: Reader): Material2D {
  const shadow = r.n('shadow', 70) / 100;
  return material2D(solidFill('#ffffff'), {
    bevel: oldBevel(r, { width: 16, depth: 100, elevation: 40, highlight: 110 }, (lz) => (shadow * lz) / (1 - shadow + shadow * lz)),
  });
}

function chromeMaterial(r: Reader): Material2D {
  const map = r.s('map', 'silver');
  const custom = r.raw('gradient');
  const base = map === 'custom' ? (isGradient(custom) ? custom : CHROME_MAPS.silver) : (CHROME_MAPS[map] ?? CHROME_MAPS.silver);
  const shading = r.n('shading', 50) / 100;
  const fill = {
    ...linearFill(tinted(base, r.s('tint', '#ffffff'), r.n('tintAmount', 0) / 100), 90, Math.round(r.n('repeat', 1)) > 1 ? 'line' : 'layer'),
    scale: 1 / 0.85,
    offset: -0.425 * (r.n('horizon', 0) / 100),
  };
  return material2D(fill, {
    bevel: oldBevel(r, { width: 14, depth: 100, elevation: 45, highlight: 120 }, (lz) => shading * (1 - 0.45 / (0.45 + 0.55 * lz))),
    refraction: -pct((0.5 * (r.n('distortion', 70) / 100) * SIZE) / 0.85),
  });
}

function glassMaterial(r: Reader): Material2D {
  return material2D(solidFill('#ffffff'), {
    bevel: { ...oldBevel(r, { width: 18, depth: 120, elevation: 50, highlight: 200 }, () => 0), shadowOpacity: 0 },
    refraction: pct(r.n('refraction', 12)),
    glass: glass2D({
      enabled: true,
      color: r.s('color', '#3cc8ff'),
      tint: clamp(r.n('tint', 100) / 100, 0, 1),
      opacity: clamp(r.n('opacity', 70) / 100, 0, 1),
      edge: clamp(r.n('edge', 70) / 100, 0, 1),
      caustic: clamp(r.n('caustic', 70) / 100, 0, 2),
    }),
  });
}

const METAL_KINDS: Record<string, Texture2D['kind']> = { brushed: 'hairline', hairline: 'hairline', radial: 'spun', flake: 'flakes' };

function metalMaterial(r: Reader): Material2D {
  const mode = r.s('mode', 'brushed');
  const grain = Math.max(0.25, r.n('scale', 3)) * (mode === 'hairline' ? 0.45 : 1);
  const m = material2D(solidFill('#ffffff'));
  return {
    ...m,
    texture: { ...m.texture, kind: METAL_KINDS[mode] ?? 'hairline', amount: clamp(r.n('strength', 30) / 100, 0, 1), scale: pct(grain), blend: 'overlay', target: 'color', angle: r.n('angle', 0) },
    sheen: sheen2D({
      enabled: r.b('sheen', true),
      color: r.s('sheenColor', '#ffffff'),
      amount: clamp(r.n('sheenAmount', 70) / 100, 0, 3),
      position: clamp(r.n('sheenPosition', -25) / 100, -1, 1),
      width: clamp(r.n('sheenWidth', 35) / 100, 0.05, 2),
    }),
  };
}

/** The Material effect replacing one instance (itself when it is not a removed type). */
function replace(fx: EffectInstance): EffectInstance {
  if (!REMOVED.includes(fx.type)) return fx;
  const r = reader(fx);
  const material = fx.type === 'bevel' ? bevelMaterial(r) : fx.type === 'chrome' ? chromeMaterial(r) : fx.type === 'glass' ? glassMaterial(r) : metalMaterial(r);
  return { id: fx.id, type: 'material', enabled: fx.enabled, params: { colorMode: fx.type === 'chrome' ? 'fill' : 'layer', size: SIZE, material } };
}

/** `effects` with every removed material effect replaced (see above); the same array when there is none. */
export function migrateMaterialEffects(effects: EffectInstance[]): EffectInstance[] {
  return effects.some((fx) => REMOVED.includes(fx.type)) ? effects.map(replace) : effects;
}

/** Step 3 over a whole project: every layer's, group's, adjustment's and part's effect stack. */
export function materialEffects(project: Project): Project {
  const layers = project.layers.map((l): Layer => {
    const effects = migrateMaterialEffects(l.effects);
    if (!('partEffects' in l)) return effects === l.effects ? l : { ...l, effects };
    const partEffects = Object.fromEntries(Object.entries(l.partEffects).map(([k, fx]) => [k, fx && migrateMaterialEffects(fx)])) as PartEffects;
    return { ...l, effects, partEffects };
  });
  return { ...project, layers };
}

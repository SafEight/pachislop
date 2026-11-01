import type { EffectParams } from '../engine/contracts';
import type { BlendMode, EffectInstance, GeneratorInstance } from '../model/types';
import { particleGlow } from './particles';

// Content effects (effects that drew new content: sparkles, fire, burst rays…) became follow
// generators. FROM_EFFECT maps one stored instance of such an old effect type to the companion
// generator layer that replaces it (src/io/migrate/contentEffects.ts, user presets). Each entry
// gets the instance's params AS STORED (the old effect defs are gone: an entry fills the old
// defaults itself) and returns the generator type and params (missing keys take the generator's
// defaults; `follow` absent = follows the layer the effect was on, '' = free), where it goes
// relative to that layer, and the layer-level look (blend, opacity, effects) that reproduces how
// the effect composited: an additive light effect is an 'add' companion above (the generator
// writes the light with alpha = its brightest channel, exactly the old addLight), a 'behind'
// effect a Normal companion below.

/**
 * A generator a look brings with it (glints on the highlights, fire behind the title): applied to
 * a layer it becomes a generator layer marked `companionOf` that layer, `place`d directly above
 * or below it, with `blend` (default Normal), `opacity` (default 1) and its own `effects`, in a
 * group with the layer (see presets/apply.ts applyPresetToProject). Its `follow` param: '' = free
 * (its handle params are relative to the layer position, as effect handles were), anything else or
 * absent = follows the layer it is applied to. Params in px scale with the look's `refSize`.
 * `outer`: it follows that group instead (the layer, its other companions and the look's
 * `groupEffects`), in a group around it: a look's companion that comes after its group effects.
 */
export interface Companion {
  generator: GeneratorInstance;
  place: 'above' | 'below';
  blend?: BlendMode;
  opacity?: number;
  effects?: EffectInstance[];
  outer?: true;
}

/** One companion an old effect instance becomes. */
export type FromEffectLayer = Omit<Companion, 'generator'> & { type: string; params: EffectParams };
/** An old effect instance → its companion(s), bottom first relative to its place (Particle Burst behind and in front: two). */
export type FromEffect = (p: EffectParams) => FromEffectLayer | FromEffectLayer[];

/** Old Sparkles defaults (its keys are Glints' keys). */
const SPARKLES = {
  placement: 'highlights',
  count: 40,
  large: 5,
  small: 6,
  heroWidth: 80,
  heroThickness: 100,
  heroCross: 22,
  heroAngle: 0,
  heroStars: 3,
  size: 50,
  sizeVariation: 60,
  threshold: 30,
  spacing: 80,
  faceBias: 70,
  jitter: 50,
  spread: 60,
  inside: true,
  rays: '4',
  spectral: false,
  color: '#fff4c0',
  intensity: 130,
  brightnessVariation: 50,
  seed: 1,
};

/** Old Star Glint defaults. */
const STAR_GLINT = { placement: 'auto', count: 5, threshold: 75, x: 0, y: 0, size: 110, rays: '8', spectral: false, thickness: 100, color: '#fff1b8', intensity: 130, rotation: 0, variation: 50 };

/** Old Burst Rays defaults. */
const BURST_RAYS = {
  style: 'burst',
  placement: 'clip',
  x: 0,
  y: 0,
  count: 28,
  width: 50,
  widthVariation: 40,
  lengthVariation: 60,
  inner: 240,
  innerSoftness: 60,
  rotation: 0,
  color: '#fff3c4',
  alternate: false,
  color2: '#ff4a1c',
  opacity: 70,
  seed: 1,
};

/** Old Particle Burst defaults (its look params: the Particles generator's keys). */
const PARTICLE_BURST = {
  source: 'edge',
  edgeWidth: 4,
  direction: 'normal',
  x: 0,
  y: 0,
  angle: 90,
  distance: 180,
  distanceRandom: 100,
  cone: 30,
  place: 'both',
  shape: 'dot',
  glintMix: 5,
  count: 700,
  size: 6,
  sizeRandom: 60,
  depth: 50,
  streak: 40,
  ring: 30,
  rotation: 20,
  tumble: 0,
  sheen: 50,
  colorMode: 'radial',
  color: '#ffd166',
  opacity: 100,
  opacityRandom: 40,
  glow: 10,
  seed: 1,
};

/** Particle Burst's light shapes added onto the layer; its opaque ones (confetti, petals, hearts) covered it. */
const SOLID_SHAPES = ['confetti', 'petal', 'heart'];

export const FROM_EFFECT: Record<string, FromEffect> = {
  // Sparkles: the light added over the layer; the same keys and meanings in Glints.
  sparkles: (p) => ({ type: 'glints', params: { ...SPARKLES, ...p }, place: 'above', blend: 'add' }),
  // Star Glint: big flare stars on the hottest peaks ('auto') or one at a fixed point ('manual').
  starGlint: (p) => {
    const o = { ...STAR_GLINT, ...p };
    const params: EffectParams = {
      placement: o.placement === 'manual' ? 'point' : 'peaks',
      stars: o.count,
      threshold: o.threshold,
      x: o.x,
      y: o.y,
      size: o.size,
      rays: o.rays,
      spectral: o.spectral,
      thickness: o.thickness,
      color: o.color,
      intensity: o.intensity,
      rotation: o.rotation,
      sizeVariation: o.variation,
    };
    return { type: 'glints', params, place: 'above', blend: 'add' };
  },
  // Burst Rays: a Sunburst at the same comp-px centre; On layer → on the layer's pixels only, Over
  // everything → on them and around (both above), Behind → rays everywhere, below.
  burstRays: (p) => {
    const o = { ...BURST_RAYS, ...p };
    const params: EffectParams = {
      style: o.style === 'focus' ? 'focus' : o.style === 'rings' ? 'rings' : 'wedges',
      centre: 'point',
      onLayer: o.placement === 'behind' ? 'all' : o.placement === 'over' ? 'over' : 'clip',
      x: o.x,
      y: o.y,
      rays: o.count,
      width: o.width,
      widthVariation: o.widthVariation,
      lengthVariation: o.lengthVariation,
      inner: o.inner,
      innerSoftness: o.innerSoftness,
      rotation: o.rotation,
      colorA: o.color,
      alternate: o.alternate,
      colorB: o.color2,
      opacity: o.opacity,
      seed: o.seed,
    };
    return { type: 'sunburst', params, place: o.placement === 'behind' ? 'below' : 'above' };
  },
  // Particle Burst: Particles bursting from the followed layer; Behind → below, In front → above
  // (added as light unless the shape is opaque), both → the back half below and the front half
  // above. Its Glow is the particle preset glow effect.
  particleBurst: (p) => {
    const { place, distance, angle, glow, ...rest } = { ...PARTICLE_BURST, ...p };
    const params: EffectParams = { ...rest, emitter: 'layer', travel: distance, heading: angle, split: 'all' };
    const effects = Number(glow) > 0 ? [particleGlow(Number(glow))] : [];
    const front: FromEffectLayer = { type: 'particles', params, place: 'above', blend: SOLID_SHAPES.includes(String(rest.shape)) ? 'normal' : 'add', effects };
    const back: FromEffectLayer = { type: 'particles', params, place: 'below', effects };
    if (place === 'front') return front;
    if (place === 'behind') return back;
    return [
      { ...back, params: { ...params, split: 'back' } },
      { ...front, params: { ...params, split: 'front' } },
    ];
  },
  // Fire, smoke, corona, lightning, ink splatter, backlight and lens flare kept every param they
  // still have with the same key, meaning and default, so stored values pass through and missing
  // ones take the generator's (= the old) defaults; only the params that became layer order, blend
  // or opacity are read, with their old defaults.
  // Fire: Placement 'behind' (default) → below; 'around' (licking over the edges) → above, its
  // flames clearing inside the shape (Over the edges).
  fire: ({ mode = 'behind', ...params }) => {
    const over = mode === 'around';
    return { type: 'fire', params: { ...params, overEdge: over }, place: over ? 'above' : 'below' };
  },
  // Smoke: drawn behind; its Opacity (default 75 %) is the layer opacity.
  smoke: ({ opacity = 75, ...params }) => ({ type: 'smoke', params, place: 'below', opacity: Number(opacity) / 100 }),
  // Corona: Behind layer (default on) → Normal below; off (added as light over the layer) → Add above.
  corona: ({ behind = true, ...params }) =>
    behind === false ? { type: 'corona', params, place: 'above', blend: 'add' } : { type: 'corona', params, place: 'below' },
  // Lightning: always added as light over the layer.
  lightning: (params) => ({ type: 'lightning', params, place: 'above', blend: 'add' }),
  // Ink Splatter: Placement 'behind' (default) → below, 'over' → above; Opacity (default 100 %) → layer opacity.
  inkSplatter: ({ placement = 'behind', opacity = 100, ...params }) => ({
    type: 'inkSplatter',
    params,
    place: placement === 'over' ? 'above' : 'below',
    opacity: Number(opacity) / 100,
  }),
  // Backlight: rays behind the layer.
  backlight: (params) => ({ type: 'backlight', params, place: 'below' }),
  // Lens Flare: added as light over the layer; it never read the layer, and its position was in
  // comp px, so it stays free (the companion layer sits at the comp origin).
  lensFlare: (params) => ({ type: 'lensFlare', params: { ...params, follow: '' }, place: 'above', blend: 'add' }),
};

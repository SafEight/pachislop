import { lightGlow, presetEffect } from '../../generators/common';
import { halftoneFade } from '../../generators/lines/speedLines';
import { vignette } from '../../generators/lines/sunburst';
import { particleGlow } from '../../generators/particles';
import { generatorFromPreset, lookEffect } from '../../generators/registry';
import { layerBase, uid } from '../../model/defaults';
import type { EffectInstance, GeneratorLayer, GradientMask, Layer, ParamValue, Project } from '../../model/types';

// Migration step 1 (see src/io/migrate/): generator params that were layer-level post-processing
// become the effect, mask, layer property or layer that does the same job, on or next to the
// same generator layer. The new effects go to the bottom of the layer's stack (they ran inside
// the generator, before the layer's effects) in the generator's own order, marked `fromPreset`
// (a preset set them, so the next preset replaces them, as it used to reset the params).
//
//   glow (particles, speed lines, shockwave, magic circle, brush swirl)
//                  → Outer Glow, From layer, Additive with the glow over the face, Spread 0:
//                    the same Gaussian of the layer's own colours, added with alpha union
//                    (radius: comp px for particles / speed lines; layer px × scale for rings;
//                    × 0.8 for particles, × 0.6 for brush swirl, as before)
//   patternFill opacity
//                  → the layer's opacity × the old value
//   speedLines edgeBlur
//                  → Gaussian Blur: σ = 0.4 × edgeBlur for lines (their linear edge ramp of that
//                    width has the slope of that Gaussian edge), edgeBlur / 3 for ベタフラ (its
//                    mask blur, radius ≈ 3σ)
//   speedLines halftone + dotSize (ベタフラ)
//                  → Halftone Dissolve, dotSize cells at 45°, Fade 4 × dotSize (after the edge
//                    blur's Gaussian Blur: the same AM screen on the same softened fill)
//   speedLines fillBurst + burstColor (ベタフラ)
//                  → a Sunburst layer just below, both colours the burst colour (a solid fill),
//                    with the layer's blend, opacity × the lines' own opacity (which scaled the
//                    burst too), clipping, group and masks
//   sunburst vignette
//                  → Gradient Overlay, Radial, Shade (linear multiply) by the old darkening (`vignette`)
//   patternFill fade + feather (+ fadeX / fadeY / fadeRadius, fadeAngle / fadeDistance)
//                  → a linked gradient mask: the old smoothstep over `feather` becomes the linear
//                    ramp of the same slope (⅔ feather wide), radial or linear
//
// Idempotent: a generator layer with none of the removed params passes unchanged. Removed params a
// layer lacks take the defaults the old renderer filled in for them.

/** Removed params per generator type, with the defaults the old renderer used for missing keys. */
const REMOVED: Record<string, Record<string, ParamValue>> = {
  particles: { glow: 8 },
  speedLines: { edgeBlur: 0, glow: 0, halftone: false, dotSize: 6, fillBurst: true, burstColor: '#ffffff' },
  sunburst: { vignette: 45 },
  shockwave: { glow: 20 },
  magicCircle: { glow: 14 },
  brushSwirl: { glow: 0 },
  patternFill: { opacity: 100, fade: 'none', fadeX: 0, fadeY: 0, fadeRadius: 600, fadeAngle: 90, fadeDistance: 300, feather: 400 },
};

/** Glow amount of the ring-family generators (their glow radius was in layer px). */
const RING_GLOW: Record<string, number> = { shockwave: 1, magicCircle: 1, brushSwirl: 0.6 };

/** A linked gradient mask in the layer's own space. */
const gradientMask = (m: Pick<GradientMask, 'shape' | 'x' | 'y' | 'angle' | 'length' | 'inner'>): GradientMask => ({
  id: uid(),
  enabled: true,
  invert: false,
  feather: 0,
  density: 1,
  linked: true,
  kind: 'gradient',
  mid: 0.5,
  ...m,
});

/** `l` without its removed params, and the layer to insert just below it (the ベタフラ burst fill), if any. */
function migrateGenerator(l: GeneratorLayer): { layer: GeneratorLayer; below: GeneratorLayer | null } {
  const removed = REMOVED[l.generator.type];
  const stored = l.generator.params;
  if (!removed || !Object.keys(removed).some((k) => k in stored)) return { layer: l, below: null };
  const params = { ...stored };
  for (const k of Object.keys(removed)) delete params[k];
  const n = (k: string) => (typeof stored[k] === 'number' ? (stored[k] as number) : (removed[k] as number));
  const b = (k: string) => (typeof stored[k] === 'boolean' ? (stored[k] as boolean) : (removed[k] as boolean));
  const s = (k: string) => (typeof stored[k] === 'string' ? (stored[k] as string) : (removed[k] as string));
  const scale = l.transform.scale;
  const fx: EffectInstance[] = [];
  let opacity = 1;
  let below: GeneratorLayer | null = null;
  const masks = [...l.masks];

  switch (l.generator.type) {
    case 'particles':
      if (n('glow') > 0) fx.push(particleGlow(n('glow')));
      break;
    case 'speedLines': {
      const beta = (typeof stored.type === 'string' ? stored.type : 'focus') === 'beta';
      const edge = Math.max(0, n('edgeBlur')) * scale;
      if (edge > 0) fx.push(presetEffect('gaussianBlur', { radius: beta ? edge / 3 : 0.4 * edge }));
      if (beta && b('halftone')) fx.push(halftoneFade(Math.max(2, n('dotSize')) * scale));
      if (n('glow') > 0) fx.push(lightGlow(n('glow')));
      if (beta && b('fillBurst')) {
        const burst = s('burstColor');
        // The lines' own opacity (a kept param) scaled the burst too.
        const own = Math.min(1, Math.max(0, (typeof stored.opacity === 'number' ? stored.opacity : 85) / 100));
        const gen = generatorFromPreset('sunburst')!;
        gen.params = { ...gen.params, colorMode: 'ab', colorA: burst, colorB: burst, glow: 0 };
        below = {
          ...layerBase(`${l.name} burst`),
          kind: 'generator',
          generator: gen,
          visible: l.visible,
          guide: l.guide,
          blend: l.blend,
          clip: l.clip,
          ...(l.parentId ? { parentId: l.parentId } : {}),
          transform: { ...l.transform, opacity: l.transform.opacity * own },
          masks: l.masks.map((m) => ({ ...m, id: uid() })),
        };
      }
      break;
    }
    case 'sunburst':
      if (n('vignette') > 0) fx.push(vignette(Math.min(1, n('vignette') / 100)));
      break;
    case 'shockwave':
    case 'magicCircle':
    case 'brushSwirl':
      if (n('glow') > 0) fx.push(lightGlow(n('glow') * scale, RING_GLOW[l.generator.type]));
      break;
    case 'patternFill': {
      opacity = Math.min(1, Math.max(0, n('opacity') / 100));
      // The old fade: 1 − smoothstep over `feather` around the edge; the mask ramp of equal slope is ⅔ as wide.
      const half = Math.max(0, n('feather')) / 3;
      if (s('fade') === 'radial') {
        const length = Math.max(0, n('fadeRadius')) + half;
        masks.push(gradientMask({ shape: 'radial', x: n('fadeX'), y: n('fadeY'), angle: 0, length, inner: length > 0 ? Math.max(0, length - 2 * half) / length : 0 }));
      } else if (s('fade') === 'linear') {
        const a = (n('fadeAngle') * Math.PI) / 180;
        const start = n('fadeDistance') - half;
        masks.push(gradientMask({ shape: 'linear', x: Math.cos(a) * start, y: Math.sin(a) * start, angle: n('fadeAngle'), length: 2 * half, inner: 0 }));
      }
      break;
    }
  }

  return {
    layer: {
      ...l,
      generator: { ...l.generator, params },
      transform: { ...l.transform, opacity: l.transform.opacity * opacity },
      effects: [...fx.map(lookEffect), ...l.effects],
      masks,
    },
    below,
  };
}

/** Migration step 1: generator post-processing params → effects, masks, opacity and layers (see above). */
export function generatorParams(project: Project): Project {
  let changed = false;
  const layers: Layer[] = [];
  for (const l of project.layers) {
    if (l.kind !== 'generator') {
      layers.push(l);
      continue;
    }
    const { layer, below } = migrateGenerator(l);
    if (layer !== l) changed = true;
    if (below) layers.push(below);
    layers.push(layer);
  }
  return changed ? { ...project, layers } : project;
}

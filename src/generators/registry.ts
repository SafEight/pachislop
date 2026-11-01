import type { EffectParams, GeneratorDef, GeneratorPreset } from '../engine/contracts';
import { getEffect } from '../effects/registry';
import { layerBase, uid } from '../model/defaults';
import type { EffectInstance, GeneratorInstance, GeneratorLayer, ParamValue } from '../model/types';
import { corona, fire, lightning, smoke } from './energy';
import { glints } from './glints';
import { inkSplatter } from './inkSplatter';
import { backlight, lensFlare } from './light';
import { brushSwirl, magicCircle, shockwave } from './rings';
import { lightStreaks, speedLines, sunburst } from './lines';
import { particles } from './particles';
import { patternFill } from './pattern';

// Generator layers (GeneratorLayer): procedural content drawn on its own. Order = add-menu order
// (the UI groups by category).
const ALL: GeneratorDef[] = [
  particles,
  inkSplatter,
  speedLines,
  lightStreaks,
  sunburst,
  shockwave,
  magicCircle,
  brushSwirl,
  glints,
  lensFlare,
  backlight,
  fire,
  smoke,
  corona,
  lightning,
  patternFill,
];

const byType = new Map(ALL.map((d) => [d.type, d]));

export const listGenerators = (): readonly GeneratorDef[] => ALL;
export const getGenerator = (type: string): GeneratorDef | undefined => byType.get(type);

/** `g.params` with the defaults of its def filled in for missing keys (unknown type: the params as stored). */
export function generatorParams(g: GeneratorInstance): EffectParams {
  const def = byType.get(g.type);
  const p: EffectParams = { ...g.params };
  if (def) for (const pd of def.params) if (!(pd.key in p)) p[pd.key] = pd.default;
  return p;
}

/** The layer id generator `g` follows ('' = free, or its type has no `follow` param). */
export function followTarget(g: GeneratorInstance): string {
  const v = byType.get(g.type)?.follow ? g.params.follow : '';
  return typeof v === 'string' ? v : '';
}

/**
 * Generator `g` draws over the whole comp with its params: free, its def's `bounds` is null;
 * following a layer, its `followReach` is (see GeneratorDef). False for unknown types.
 */
export function generatorFillsComp(g: GeneratorInstance): boolean {
  const def = byType.get(g.type);
  if (!def) return false;
  const p = generatorParams(g);
  return followTarget(g) && def.followReach ? def.followReach(p) === null : def.bounds(p) === null;
}

/** A new generator instance of `type`, starting from `preset` (default: the def's first preset). */
export function generatorFromPreset(type: string, presetId?: string): GeneratorInstance | null {
  const def = byType.get(type);
  if (!def) return null;
  const preset: GeneratorPreset | undefined = def.presets.find((x) => x.id === presetId) ?? def.presets[0];
  const params: GeneratorInstance['params'] = {};
  for (const pd of def.params) params[pd.key] = pd.default;
  if (preset) for (const [k, v] of Object.entries(preset.params)) if (v !== undefined) params[k] = v;
  return { type, params };
}

/**
 * `fx` as a layer's own copy of a look effect: a fresh id, every param present (the effect's
 * defaults under `fx.params`, structured values copied), marked `fromPreset`.
 */
export function lookEffect(fx: EffectInstance): EffectInstance {
  const params: Record<string, ParamValue> = {};
  for (const pd of getEffect(fx.type)?.params ?? []) params[pd.key] = structuredClone(pd.default);
  return { ...fx, id: uid(), params: { ...params, ...structuredClone(fx.params) }, fromPreset: true };
}

/** Copies of `preset`'s effects for a layer (see GeneratorPreset.effects). */
export const presetEffects = (preset: GeneratorPreset | undefined): EffectInstance[] => (preset?.effects ?? []).map(lookEffect);

/** A new generator layer of `type` from `presetId` (default: the first preset), named after the preset, with its blend, opacity and effects; null for an unknown type. */
export function createGeneratorLayer(type: string, presetId?: string): GeneratorLayer | null {
  const def = byType.get(type);
  const generator = generatorFromPreset(type, presetId);
  if (!def || !generator) return null;
  const preset = def.presets.find((x) => x.id === presetId) ?? def.presets[0];
  const base = layerBase(preset?.label ?? def.label);
  const transform = preset?.opacity !== undefined ? { ...base.transform, opacity: preset.opacity } : base.transform;
  return { ...base, transform, kind: 'generator', generator, blend: preset?.blend ?? 'normal', effects: presetEffects(preset) };
}
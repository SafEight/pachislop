import type { Comp, Environment3D, EnvironmentOverrides, Lighting3D, LightingOverrides, Material3D, Title3DProps } from './types';

// Lighting inheritance, value by value, like a browser's style inspector: a part overrides its
// layer, a layer overrides the document (Comp). Every environment value (preset with its custom
// HDR, intensity, rotation, tint, contrast, saturation, blur, repeat ↔ / ↕) inherits on its own; a
// layer also overrides tone mapping, exposure and the lights (one value: the whole list). An
// absent value is inherited. effectiveLighting resolves what a layer or a part renders with, for
// the renderer, the load waits, thumbnails and looks alike.

/** The environment values that inherit one by one (`preset` carries `customAssetId` with it). */
export const ENV_KEYS = ['preset', 'intensity', 'rotation', 'tint', 'contrast', 'saturation', 'blur', 'repeatX', 'repeatY'] as const satisfies readonly (keyof Environment3D)[];
export type EnvKey = (typeof ENV_KEYS)[number];

/** Every lighting value a layer can set: the environment's, tone mapping, exposure and the lights. */
export const LIGHTING_KEYS = [...ENV_KEYS, 'toneMapping', 'exposure', 'lights'] as const;
export type LightingKey = (typeof LIGHTING_KEYS)[number];

/** Where an effective value comes from. */
export type LightingLevel = 'document' | 'layer' | 'part';

/** A layer's lighting that sets nothing: everything is the document's. */
export const noLighting = (): LightingOverrides => ({ environment: {} });

export const isEnvKey = (k: LightingKey): k is EnvKey => (ENV_KEYS as readonly string[]).includes(k);

/** Whether overrides `o` set environment value `key`. */
export const setsEnv = (o: EnvironmentOverrides, key: EnvKey): boolean => o[key] !== undefined;

/** Whether a layer's overrides `o` set lighting value `key`. */
export const setsLighting = (o: LightingOverrides, key: LightingKey): boolean => (isEnvKey(key) ? setsEnv(o.environment, key) : o[key] !== undefined);

/** The environment values `o` sets, in editor order. */
export const envKeysSet = (o: EnvironmentOverrides): EnvKey[] => ENV_KEYS.filter((k) => setsEnv(o, k));

/** The lighting values a layer's overrides `o` set, in editor order. */
export const lightingKeysSet = (o: LightingOverrides): LightingKey[] => LIGHTING_KEYS.filter((k) => setsLighting(o, k));

/** `base` with the values `o` sets (`base` itself when it sets none, so renderers can cache by identity). */
export function resolveEnvironment(base: Environment3D, o: EnvironmentOverrides): Environment3D {
  const keys = envKeysSet(o);
  if (keys.length === 0) return base;
  const out: Environment3D = { ...base };
  for (const k of keys) Object.assign(out, { [k]: o[k] });
  if (setsEnv(o, 'preset')) {
    if (o.customAssetId === undefined) delete out.customAssetId;
    else out.customAssetId = o.customAssetId;
  }
  return out;
}

/**
 * The lighting `layer` renders with (the document's for every value it doesn't set; `null` = a
 * layer that sets none), or with `part`, the lighting that part renders with: the layer's with the
 * part's own environment values. Lights and tone mapping are always the layer's.
 */
export function effectiveLighting(comp: Comp, layer: { style3d: Pick<Title3DProps, 'lighting'> } | null, part?: Material3D | null): Lighting3D {
  const o = layer?.style3d.lighting;
  const environment = resolveEnvironment(comp.environment, o?.environment ?? {});
  return {
    environment: part ? resolveEnvironment(environment, part.environment) : environment,
    lights: o?.lights ?? comp.lights,
    toneMapping: o?.toneMapping ?? comp.toneMapping,
    exposure: o?.exposure ?? comp.exposure,
  };
}

/** Where `layer`'s value `key` comes from, or with `part`, that part's (environment values only). */
export function lightingSource(layer: { style3d: Pick<Title3DProps, 'lighting'> }, key: LightingKey, part?: Material3D | null): LightingLevel {
  if (part && isEnvKey(key) && setsEnv(part.environment, key)) return 'part';
  return setsLighting(layer.style3d.lighting, key) ? 'layer' : 'document';
}

/** `o` setting environment value `key` to `from`'s (the preset with its custom HDR). */
export function withEnvValue(o: EnvironmentOverrides, key: EnvKey, from: Environment3D): EnvironmentOverrides {
  if (key !== 'preset') return { ...o, [key]: from[key] };
  const { customAssetId: _, ...rest } = o;
  return { ...rest, preset: from.preset, ...(from.customAssetId !== undefined ? { customAssetId: from.customAssetId } : {}) };
}

/** `o` inheriting environment value `key` again. */
export function withoutEnvValue(o: EnvironmentOverrides, key: EnvKey): EnvironmentOverrides {
  const out = { ...o };
  delete out[key];
  if (key === 'preset') delete out.customAssetId;
  return out;
}

/** A layer's overrides `o` setting value `key` to `from`'s (lights: a copy of the list). */
export function withLightingValue(o: LightingOverrides, key: LightingKey, from: Lighting3D): LightingOverrides {
  if (isEnvKey(key)) return { ...o, environment: withEnvValue(o.environment, key, from.environment) };
  return { ...o, [key]: key === 'lights' ? structuredClone(from.lights) : from[key] };
}

/** A layer's overrides `o` inheriting value `key` again. */
export function withoutLightingValue(o: LightingOverrides, key: LightingKey): LightingOverrides {
  if (isEnvKey(key)) return { ...o, environment: withoutEnvValue(o.environment, key) };
  const out = { ...o };
  delete out[key];
  return out;
}

/** Overrides setting every value to `l`'s (a look's lighting: what a layer captured renders with). */
export const allLighting = (l: Lighting3D): LightingOverrides => structuredClone(l);

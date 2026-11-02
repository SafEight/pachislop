import type { EffectDef, EffectParams } from '../engine/contracts';
import type { Comp, EffectInstance } from '../model/types';
import { angleFromGlobal, followsGlobalLight, globalLightSpec, type GlobalLightSpec } from './globalLight';
import { GROUP_A } from './groupA';
import { GROUP_B } from './groupB';

// Order = order in the UI (the UI groups by category).
const ALL: EffectDef[] = [...GROUP_A, ...GROUP_B];

const byType = new Map(ALL.map((d) => [d.type, d]));

export const listEffects = (): readonly EffectDef[] => ALL;
export const getEffect = (type: string): EffectDef | undefined => byType.get(type);

/** `fx.params` with the defaults of `def` filled in for missing keys. */
function resolved(def: EffectDef, fx: EffectInstance): EffectParams {
  const p: EffectParams = { ...fx.params };
  for (const pd of def.params) if (!(pd.key in p)) p[pd.key] = pd.default;
  return p;
}

/**
 * How far (comp px, conservative) an effect instance draws outside the layer's ink, with its
 * defaults filled in: 0 when disabled, unknown, ink-bound or full-comp (see EffectDef.reach).
 */
export function effectReach(fx: EffectInstance): number {
  const def = byType.get(fx.type);
  if (!fx.enabled || !def?.reach) return 0;
  return Math.max(0, def.reach(resolved(def, fx)));
}

/** True when the enabled effect instance draws to every canvas edge (see EffectDef.fillsComp). */
export function effectFillsComp(fx: EffectInstance): boolean {
  const def = byType.get(fx.type);
  return !!(fx.enabled && def?.fillsComp?.(resolved(def, fx)));
}

/**
 * True when an enabled effect of `effects` traces the ink (EffectDef.outline): only then does the
 * engine render the ink of what holds light apart (LayerRenderer.addsLight, light effects).
 */
export const effectsTraceInk = (effects: readonly EffectInstance[]): boolean => effects.some((fx) => fx.enabled && byType.get(fx.type)?.outline);

/** True when an enabled effect of `effects` adds light with its params (EffectDef.addsLight). */
export function effectsAddLight(effects: readonly EffectInstance[]): boolean {
  return effects.some((fx) => {
    const def = byType.get(fx.type);
    return !!(fx.enabled && def?.addsLight?.(resolved(def, fx)));
  });
}

/**
 * How far (comp px) back into its input an effect instance looks, with its defaults filled in
 * (see EffectDef.gather): 0 when disabled or of an unknown type (it does nothing), null when it
 * may depend on the whole layer.
 */
export function effectGather(fx: EffectInstance): number | null {
  const def = byType.get(fx.type);
  if (!fx.enabled || !def) return 0;
  const g = def.gather?.(resolved(def, fx));
  return g === undefined || g === null ? null : Math.max(0, g);
}

/**
 * The Use Global Light spec of `fx` when its direction param `angleKey` currently follows
 * comp.globalLight, else null. On-canvas direction handles for such a param show
 * `angleFromGlobal(spec, comp.globalLight.angle)` and write `globalFromAngle(spec, dragged)` to
 * `comp.globalLight.angle` instead of the param.
 */
export function globalLitAngle(fx: EffectInstance, angleKey: string): GlobalLightSpec | null {
  const spec = globalLightSpec(fx.type);
  return spec && spec.angle === angleKey && followsGlobalLight(fx.params) ? spec : null;
}

/** Effective value of number param `key` of `fx` (stored or default), honouring Use Global Light. */
export function effectAngle(fx: EffectInstance, key: string, comp: Comp): number {
  const spec = globalLitAngle(fx, key);
  if (spec) return angleFromGlobal(spec, comp.globalLight.angle);
  const v = fx.params[key];
  const pd = byType.get(fx.type)?.params.find((d) => d.key === key);
  return typeof v === 'number' ? v : pd?.kind === 'number' ? pd.default : 0;
}

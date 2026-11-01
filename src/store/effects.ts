import { getEffect } from '../effects/registry';
import { ADJUSTMENT_NAMES, uid } from '../model/defaults';
import { isTitleLayer, partEffectsOf } from '../model/parts';
import type { Adjustment, EffectInstance, Layer, ParamValue, PartKey, Project } from '../model/types';
import { msg, type Msg } from './msg';
import type { EffectOwner } from './store';
import { hasPart } from './tree';

// Effect stacks of layers and title parts (pure; the store's effect actions are in effectsOps.ts).

/** A new effect of `type` with its default params, or `init`'s value for the params it names. */
export function makeEffect(type: string, init?: Readonly<Record<string, ParamValue>>): EffectInstance | null {
  const def = getEffect(type);
  if (!def) return null;
  const params: Record<string, ParamValue> = {};
  // Gradients and structured values (Material2D, Adjustment) are copied, so instances never share one.
  for (const pd of def.params) {
    const v = init?.[pd.key] ?? pd.default;
    params[pd.key] = typeof v === 'object' ? structuredClone(v) : v;
  }
  return { id: uid(), type, enabled: true, params };
}

/** The effect stack of `owner` (empty when the layer or part doesn't exist). */
export function effectsOf(project: Project, owner: EffectOwner): EffectInstance[] {
  const l = project.layers.find((x) => x.id === owner.layerId);
  if (!l) return [];
  if (owner.part === null) return l.effects;
  return isTitleLayer(l) ? partEffectsOf(l, owner.part) : [];
}

/** Whether `l` can carry effects on `part` (null = its own): only existing parts (see hasPart). */
export const takesEffects = (l: Layer | undefined, part: PartKey | null): boolean => !!l && (part === null || (isTitleLayer(l) && hasPart(l, part)));

/** `project` with `owner`'s effect stack replaced (an empty part stack is dropped). */
export function setEffects(project: Project, owner: EffectOwner, effects: EffectInstance[]): Project {
  const layers = project.layers.map((l): Layer => {
    if (l.id !== owner.layerId) return l;
    if (owner.part === null) return { ...l, effects };
    if (!isTitleLayer(l)) return l;
    const partEffects = { ...l.partEffects };
    if (effects.length) partEffects[owner.part] = effects;
    else delete partEffects[owner.part];
    return { ...l, partEffects };
  });
  return { ...project, layers };
}

/** Name of effect `fx`: its effect's label, or for an Adjust effect its adjustment's name (“Levels”). */
export function effectName(fx: EffectInstance): Msg {
  const adj = fx.type === 'adjust' ? fx.params.adjustment : undefined;
  const name = typeof adj === 'object' && adj !== null ? ADJUSTMENT_NAMES[(adj as Adjustment).type] : undefined;
  return name ? msg(name, undefined, 'adjustment') : msg(getEffect(fx.type)?.label ?? 'Effect');
}

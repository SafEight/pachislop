import type { EffectDef, EffectParams, ParamDef } from '../engine/contracts';
import type { Comp } from '../model/types';

// Photoshop "Use Global Light" for effects. Directional effects carry a bool param
// `useGlobalLight` (default true); while it is on, their angle (and light elevation) come from
// `comp.globalLight` instead of their own params, so one change relights every shadow, bevel
// and extrusion in the comp.

/** Key of the bool param that switches an effect to comp.globalLight. */
export const USE_GLOBAL_LIGHT = 'useGlobalLight';

/**
 * How an effect's angle param relates to the global light G (degrees CCW from +x, the
 * direction the light comes FROM; 120 = upper-left):
 * - 'from': the param is the light-from direction itself (bevel, chrome, extrude shading);
 * - 'away': the param is the direction a flat shadow or offset falls, opposite the light
 *   (drop, long and inner shadow; G 120 → falls down-right);
 * - 'floor': the param is a floor cast-shadow direction. The light is in front of the title,
 *   so the shadow recedes up the screen: 'away' mirrored vertically (G 120 → up-right).
 */
export type GlobalLightRelation = 'from' | 'away' | 'floor';

export interface GlobalLightSpec {
  /** Number param (degrees) derived from G. */
  angle: string;
  /** Convention of `angle`, as in EffectDef.directions. */
  convention: 'cwFromRight' | 'ccwFromRight';
  relation: GlobalLightRelation;
  /** Optional number param (degrees above the surface) derived from the global altitude. */
  elevation?: string;
}

/** Wrap to (−180, 180]. */
const wrap180 = (d: number) => {
  const r = (((d % 360) + 360) % 360);
  return r > 180 ? r - 360 : r;
};

/** The value of `spec.angle` (its own convention, −180..180) for global light angle `g`. */
export function angleFromGlobal(spec: GlobalLightSpec, g: number): number {
  const ccw = spec.relation === 'from' ? g : spec.relation === 'away' ? g + 180 : -(g + 180);
  return wrap180(spec.convention === 'cwFromRight' ? -ccw : ccw);
}

/** Inverse of angleFromGlobal: the global light angle (0..360) that gives param value `v`. */
export function globalFromAngle(spec: GlobalLightSpec, v: number): number {
  const ccw = spec.convention === 'cwFromRight' ? -v : v;
  const g = spec.relation === 'from' ? ccw : spec.relation === 'away' ? ccw - 180 : -ccw - 180;
  return (((g % 360) + 360) % 360);
}

/** True when `p` (resolved or stored params) currently follows the global light. */
export const followsGlobalLight = (p: Record<string, unknown>) => p[USE_GLOBAL_LIGHT] !== false;

/** `p` with the spec's angle / elevation replaced from comp.globalLight while the flag is on. */
export function withGlobalLight(spec: GlobalLightSpec, p: EffectParams, comp: Comp): EffectParams {
  if (!followsGlobalLight(p)) return p;
  const out: EffectParams = { ...p, [spec.angle]: angleFromGlobal(spec, comp.globalLight.angle) };
  if (spec.elevation) out[spec.elevation] = comp.globalLight.altitude;
  return out;
}

const specs = new Map<string, GlobalLightSpec>();

/** The Use Global Light spec of effect type `type`, if it has one (see lit()). */
export const globalLightSpec = (type: string): GlobalLightSpec | undefined => specs.get(type);

/**
 * `def` with Use Global Light: a `useGlobalLight` bool param (default on) right after its angle
 * param, and an apply() that reads the angle / elevation from `ctx.comp.globalLight` while it is on.
 */
export function lit(def: EffectDef, spec: GlobalLightSpec): EffectDef {
  specs.set(def.type, spec);
  const flag: ParamDef = { key: USE_GLOBAL_LIGHT, label: 'Use global light', kind: 'bool', default: true };
  const at = def.params.findIndex((d) => d.key === spec.angle) + 1;
  return {
    ...def,
    params: [...def.params.slice(0, at), flag, ...def.params.slice(at)],
    apply: (ctx, input, output, p) => def.apply(ctx, input, output, withGlobalLight(spec, p, ctx.comp)),
  };
}

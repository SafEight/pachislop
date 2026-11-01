import type { ParamDef } from '../../engine/contracts';

// Reading the number / select params that effect and generator handles drag (EffectDef /
// GeneratorDef handles, directions, sizes).

export type ParamNum = Extract<ParamDef, { kind: 'number' }>;

/** Number param `key` among `defs`: its stored value in `values` (else its default) and its def. */
export function numParam(defs: readonly ParamDef[], values: Readonly<Record<string, unknown>>, key: string): { v: number; pd?: ParamNum } {
  const pd = defs.find((p): p is ParamNum => p.key === key && p.kind === 'number');
  const raw = values[key];
  return { v: typeof raw === 'number' ? raw : (pd?.default ?? 0), pd };
}

export const clampTo = (pd: ParamNum | undefined, v: number) => (pd ? Math.max(pd.min, Math.min(pd.max, v)) : v);

/** Express angle `a` (degrees) inside the param's range by ±360 wraps. */
export function wrapAngle(pd: ParamNum | undefined, a: number) {
  let x = ((a % 360) + 360) % 360;
  if (pd) {
    if (x > pd.max) x -= 360;
    if (x < pd.min) x += 360;
  }
  return clampTo(pd, x);
}

/** Does a handle's `when` hold: select param `key` (unset: its default) equals `value`? No `when`: always. */
export function whenOk(defs: readonly ParamDef[], values: Readonly<Record<string, unknown>>, when?: { key: string; value: string }) {
  if (!when) return true;
  const pd = defs.find((p) => p.key === when.key);
  const v = values[when.key] ?? (pd && pd.kind === 'select' ? pd.default : undefined);
  return v === when.value;
}

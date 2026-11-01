import type { ParamDef } from '../../engine/contracts';
import type { ParamValue } from '../../model/types';

/** Whether a param's control shows for the current values `values` of a params list `defs` (ParamDef.when; missing values take their defaults). */
export function paramShown(defs: readonly ParamDef[], values: Readonly<Record<string, ParamValue>>, pd: ParamDef): boolean {
  if (!pd.when) return true;
  const { key, value } = pd.when;
  const v = values[key] ?? defs.find((d) => d.key === key)?.default;
  return Array.isArray(value) ? value.includes(v as string) : v === value;
}

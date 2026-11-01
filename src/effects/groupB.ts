import type { EffectDef } from '../engine/contracts';
import { MATERIAL_EFFECTS } from './b/material';
import { SHATTER_EFFECTS } from './b/shatter';

// Eye Candy style effects: material, shatter.
export const GROUP_B: EffectDef[] = [...MATERIAL_EFFECTS, ...SHATTER_EFFECTS];

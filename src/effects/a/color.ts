import type { EffectDef } from '../../engine/contracts';
import { adjustmentIsIdentity, applyAdjustment } from '../../engine/adjustments';
import type { Adjustment } from '../../model/types';

// ---------- adjust ----------

/**
 * One adjustment (Levels, Curves, Hue/Saturation, Gradient Map, Exposure…) as an effect: the same
 * operation, code and editor as an adjustment layer, applied to the pixels of whatever the effect
 * is on (a layer, a group, one style part).
 */
const adjust: EffectDef = {
  type: 'adjust',
  label: 'Adjust',
  category: 'Color',
  description: 'An adjustment (Levels, Curves, Hue/Saturation, Gradient Map…) on just this layer, group or part: the same as the adjustment layer.',
  params: [
    {
      key: 'adjustment',
      label: 'Adjustment',
      kind: 'adjustment',
      default: { type: 'hueSaturation', hue: 0, saturation: 25, lightness: 0, colorize: false },
    },
  ],
  gather: () => 0,
  apply(ctx, input, output, p) {
    const adj = p.adjustment as Adjustment;
    if (adjustmentIsIdentity(adj)) ctx.kit.copy(input, output);
    else applyAdjustment(ctx.kit, input, adj, output);
  },
};

export const COLOR_EFFECTS: EffectDef[] = [adjust];

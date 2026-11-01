import type { EffectDef } from '../engine/contracts';
import { BLUR_EFFECTS } from './a/blur';
import { COLOR_EFFECTS } from './a/color';
import { DISTORT_EFFECTS } from './a/distort';
import { FINISH_EFFECTS } from './a/finish';
import { GLOW_EFFECTS } from './a/glow';
import { SHADOW_EFFECTS } from './a/shadow';
import { STYLIZE_EFFECTS } from './a/stylize';

// Eye Candy-style layer effects: glows and contour lines, Photoshop blurs, strokes / extrude /
// gradient overlay / trails / halftone, shadows, colour, distortions, and finishing passes
// (keyline, gradient map, grain, glitch).
export const GROUP_A: EffectDef[] = [
  ...GLOW_EFFECTS,
  ...BLUR_EFFECTS,
  ...STYLIZE_EFFECTS,
  ...SHADOW_EFFECTS,
  ...COLOR_EFFECTS,
  ...DISTORT_EFFECTS,
  ...FINISH_EFFECTS,
];

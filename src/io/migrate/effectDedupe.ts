import { angleFromGlobal } from '../../effects/globalLight';
import { glintOverlay, levels, longShadowExtrude, rainbowOverlay } from '../../effects/a/recipes';
import { defaultComp, GRADIENTS } from '../../model/defaults';
import type { Adjustment, EffectInstance, Gradient, Layer, ParamValue, PartEffects, Project } from '../../model/types';
import { makeEffect } from '../../store/effects';

// Migration step 2 (see src/io/migrate/): effects that were another effect or a composition of
// effects become that effect / composition, at the same place in the stack, with the same
// enabled flag (part effects stay on their part). Idempotent: only the removed types are touched.
//
//   Gradient Glow  → Outer Glow (or Inner Glow when `inner`): Gradient from the edge, Precise,
//                    Size = width, Spread / Choke = 1 − softness, Intensity 1 (inner: Normal mode)
//   Multi Stroke   → one Keyline per ring with width > 0. First in its stack (it traced the layer
//                    itself): rings outermost first, each Following the layer with the cumulative
//                    width, so every ring is cut from the one silhouette exactly as before. After
//                    other effects (it traced what they drew): ring 1 first, each Following the
//                    stack below (ring n traced around rings 1…n−1), alpha threshold
//                    min(0.5, opacity / 2) so a translucent ring still counts as edge.
//   Long Shadow    → Extrude, one-colour, Shading and Edge Darkening 0, same Fade; a shadow that
//                    followed the global light gets the angle it had (Extrude's direction is its own)
//   Shine          → Gradient Overlay, Sweep, Add light: the band profile baked into the gradient
//                    (recipes.glintOverlay; Shine's angle was counter-clockwise)
//   Rainbow        → Gradient Overlay, hue wheel, Repeat (recipes.rainbowOverlay); Tint / Color
//                    modes → the Color blend (Keep Highlights has no equivalent)
//   Hue/Saturation → Adjust: Hue/Saturation (old saturation s > 0 scaled chroma by 1 + 1.5 s,
//                    Photoshop's +S by 1 / (1 − S): S = 1.5 s / (1 + 1.5 s))
//   Color Adjust   → Adjust chain: Exposure, Levels (input black / white, gamma), Levels (the old
//                    brightness + contrast line, clipped, as input / output ranges)
//   Gradient Map   → Adjust: Gradient Map (Amount → the stops' opacity)

const REMOVED: readonly string[] = ['gradientGlow', 'stroke', 'longShadow', 'shine', 'rainbow', 'hueSaturation', 'colorAdjust', 'gradientMap'];

/** Old param `k` of `fx`, or the removed effect's default. */
function reader(fx: EffectInstance) {
  const n = (k: string, def: number) => (typeof fx.params[k] === 'number' ? (fx.params[k] as number) : def);
  const s = (k: string, def: string) => (typeof fx.params[k] === 'string' ? (fx.params[k] as string) : def);
  const b = (k: string, def: boolean) => (typeof fx.params[k] === 'boolean' ? (fx.params[k] as boolean) : def);
  const g = (k: string, def: Gradient): Gradient => {
    const v = fx.params[k];
    return v && typeof v === 'object' && 'stops' in v ? (v as Gradient) : def;
  };
  return { n, s, b, g };
}

const OLD_GRADIENT_GLOW = { stops: [{ pos: 0, color: '#ffffff' }, { pos: 0.22, color: '#fff36b' }, { pos: 0.55, color: '#ff8a00' }, { pos: 1, color: '#e01400' }] };

/** The replacement(s) of one effect instance (itself when it is not a removed type). */
function replace(fx: EffectInstance, globalLight: number, first: boolean): EffectInstance[] {
  const { n, s, b, g } = reader(fx);
  const make = (type: string, init: Record<string, ParamValue>) => makeEffect(type, init)!;
  let out: EffectInstance[];
  switch (fx.type) {
    case 'gradientGlow': {
      const common = { fill: 'distance', gradient: g('gradient', OLD_GRADIENT_GLOW), technique: 'precise', size: n('width', 34), intensity: 1, opacity: n('opacity', 1) };
      const soft = Math.min(1, Math.max(0, n('softness', 0.75)));
      out = [
        b('inner', false)
          ? make('innerGlow', { ...common, choke: 1 - soft, mode: 'normal', source: 'edge' })
          : make('outerGlow', { ...common, spread: 1 - soft, mode: 'behind' }),
      ];
      break;
    }
    case 'stroke': {
      const opacity = n('opacity', 1);
      const rings: [number, string][] = [
        [n('width1', 5), s('color1', '#ffffff')],
        [n('width2', 9), s('color2', '#d90000')],
        [n('width3', 4), s('color3', '#2a0000')],
      ];
      if (first) {
        let edge = 0;
        const cumulative = rings.map(([w, color]): [number, string] => [(edge += Math.max(0, w)), color]).filter((_, i) => rings[i][0] > 0);
        out = cumulative.reverse().map(([width, color]) => make('keyline', { width, color, opacity, softness: 0, threshold: 0.5, follow: 'layer' }));
      } else {
        const threshold = Math.max(0.05, Math.min(0.5, opacity / 2));
        out = rings.filter(([w]) => w > 0).map(([width, color]) => make('keyline', { width, color, opacity, softness: 0, threshold, follow: 'stack' }));
      }
      break;
    }
    case 'longShadow': {
      // Long Shadow followed the light 'away' (falls opposite it), screen-clockwise degrees.
      const followed = fx.params.useGlobalLight === true;
      const angle = followed ? angleFromGlobal({ angle: 'angle', convention: 'cwFromRight', relation: 'away' }, globalLight) : n('angle', 45);
      out = [make('extrude2d', longShadowExtrude({ angle, length: n('length', 260), fade: n('fade', 1), color: s('color', '#000000'), opacity: n('opacity', 0.55) }))];
      break;
    }
    case 'shine':
      out = [
        make(
          'gradientOverlay',
          glintOverlay({
            angle: -n('angle', -30),
            position: n('position', -20),
            width: n('width', 70),
            softness: n('softness', 85),
            double: b('double', true),
            color: s('color', '#ffffff'),
            intensity: n('intensity', 90),
          }),
        ),
      ];
      break;
    case 'rainbow': {
      const mode = s('mode', 'tint');
      out = [
        make(
          'gradientOverlay',
          rainbowOverlay({
            bands: n('scale', 1),
            angle: n('angle', 20),
            phase: n('phase', 0),
            saturation: n('saturation', 0.9),
            amount: n('amount', 1),
            mode: mode === 'tint' || mode === 'color' ? 'color' : mode,
          }),
        ),
      ];
      break;
    }
    case 'hueSaturation': {
      const hue = n('hue', 0);
      const sat = n('saturation', 0.25);
      const light = n('lightness', 0) * 100;
      const colorize = b('colorize', false);
      const adjustment: Adjustment = colorize
        ? { type: 'hueSaturation', hue: ((hue % 360) + 360) % 360, saturation: Math.min(100, Math.max(0, (0.5 + 0.5 * sat) * 100)), lightness: light, colorize }
        : { type: 'hueSaturation', hue: ((((hue + 180) % 360) + 360) % 360) - 180, saturation: sat < 0 ? sat * 100 : (150 * sat) / (1 + 1.5 * sat), lightness: light, colorize };
      out = [make('adjust', { adjustment })];
      break;
    }
    case 'colorAdjust': {
      const exposure = n('exposure', 0);
      const black = n('black', 0);
      const white = n('white', 1);
      const gamma = Math.max(0.05, n('gamma', 1));
      // Brightness then contrast: v ↦ (v + brightness − ½)(1 + contrast) + ½ = A·v + B, clipped to 0…1.
      const A = 1 + n('contrast', 0.15);
      const B = (n('brightness', 0) - 0.5) * A + 0.5;
      const chain: Adjustment[] = [];
      if (exposure !== 0) chain.push({ type: 'exposure', exposure, offset: 0, gamma: 1 });
      if (black !== 0 || white !== 1 || gamma !== 1) chain.push(levels(black * 255, Math.max(white, black + 1 / 255) * 255, gamma));
      if (A !== 1 || B !== 0) {
        const f = (v: number) => Math.min(1, Math.max(0, A * v + B));
        // Inputs where the line leaves 0…1 (the whole range when it stays inside, or is flat); it
        // is 0 / 1 exactly there, else its value at the range end.
        const lo = A > 0 ? Math.min(1, Math.max(0, -B / A)) : 0;
        const hi = A > 0 ? Math.min(1, Math.max(0, (1 - B) / A)) : 1;
        const outLo = lo > 0 ? 0 : f(0);
        const outHi = hi < 1 ? 1 : f(1);
        chain.push(hi > lo ? levels(lo * 255, hi * 255, 1, outLo * 255, outHi * 255) : levels(0, 255, 1, f(0) * 255, f(0) * 255));
      }
      out = chain.map((adjustment) => make('adjust', { adjustment }));
      break;
    }
    case 'gradientMap': {
      const amount = Math.min(1, Math.max(0, n('amount', 1)));
      const gradient = g('gradient', GRADIENTS.silverRamp);
      out = [
        make('adjust', {
          adjustment: {
            type: 'gradientMap',
            gradient: amount < 1 ? { ...gradient, stops: gradient.stops.map((st) => ({ ...st, alpha: (st.alpha ?? 1) * amount })) } : gradient,
            reverse: b('reverse', false),
          },
        }),
      ];
      break;
    }
    default:
      return [fx];
  }
  // The first replacement keeps the instance's id (selection, part effects by position).
  return out.map((r, i) => ({ ...r, id: i === 0 ? fx.id : r.id, enabled: fx.enabled }));
}

/**
 * `effects` with every removed effect replaced (see above); the same array when there is none.
 * `globalLight`: comp.globalLight.angle, for Long Shadows that followed it (looks outside a
 * project: the default comp's).
 */
export function dedupeEffects(effects: EffectInstance[], globalLight = defaultComp().globalLight.angle): EffectInstance[] {
  if (!effects.some((fx) => REMOVED.includes(fx.type))) return effects;
  // `first`: no enabled effect runs before it, so its input is the layer itself.
  return effects.flatMap((fx, i) => replace(fx, globalLight, !effects.slice(0, i).some((e) => e.enabled)));
}

/** Step 2 over a whole project: every layer's, group's, adjustment's and part's effect stack. */
export function effectDedupe(project: Project): Project {
  const angle = project.comp.globalLight.angle;
  const layers = project.layers.map((l): Layer => {
    const effects = dedupeEffects(l.effects, angle);
    if (!('partEffects' in l)) return effects === l.effects ? l : { ...l, effects };
    const partEffects = Object.fromEntries(Object.entries(l.partEffects).map(([k, fx]) => [k, fx && dedupeEffects(fx, angle)])) as PartEffects;
    return { ...l, effects, partEffects };
  });
  return { ...project, layers };
}

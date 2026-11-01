import type { EffectParams, GeneratorDef } from '../../engine/contracts';
import { C, col, DEG, N, num, S, sel } from '../../effects/b/common';
import { clearTarget, drawInstancedQuads, glowInto, rng } from '../common';
import { clamp, pxPerLayer, TAPER_GLSL, taperFractions } from './shared';

// ストリーク光: thin white-cored lines with a coloured halo (DS "初動インパクト" streaks, Optical
// Flares / S_Streaks). Anamorphic = lens streaks centred on the origin; bundle = a fan of beams
// out of the origin (a corner, an edge); spears = arrow-tapered lines flying out along the angle.
// Each streak is one instanced quad shaded analytically across its width (core band + soft
// edge falloff, per-channel offset across the streak for the chromatic split); the halo is the
// edge colour alone blurred and added on top. Both are the streak's own light, not layer
// post-processing: a layer glow would bloom the white core too, and a Chromatic Aberration effect
// splits along one direction for the whole layer (not across each fanned streak) and resamples
// sub-pixel hairlines instead of shading each channel's profile.

const MAX_STREAKS = 200;

interface Streak {
  x: number; // centre, layer px
  y: number;
  rot: number; // radians, ccw; +x of the quad = head end
  len: number;
  thick: number; // full width, layer px
  intensity: number;
}

/** The streaks of params `p` (a pure function of the params: shared by bounds and render). */
function streaks(p: EffectParams): Streak[] {
  const mode = S(p, 'mode');
  const n = Math.round(clamp(N(p, 'count'), 1, MAX_STREAKS));
  const ox = N(p, 'x');
  const oy = N(p, 'y');
  const a0 = N(p, 'angle') * DEG;
  const spread = clamp(N(p, 'spread'), 0, 360) * DEG;
  const L = Math.max(1, N(p, 'length'));
  const lr = clamp(N(p, 'lengthRandom') / 100, 0, 1);
  const T = Math.max(0.1, N(p, 'thickness'));
  const tr = clamp(N(p, 'thicknessRandom') / 100, 0, 1);
  const r = rng(N(p, 'seed'));
  const out: Streak[] = [];
  for (let i = 0; i < n; i++) {
    const [h1, h2, h3, h4, h5, h6] = [r(), r(), r(), r(), r(), r()];
    // The first anamorphic streak is the hero: full length and thickness, on the origin.
    const hero = mode === 'anamorphic' && i === 0;
    const len = hero ? L : L * (1 - lr * h1);
    const thick = hero ? T : T * (1 - tr * h2);
    const a = hero ? a0 : a0 + (h3 - 0.5) * spread;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    let along: number; // streak centre along its own direction from the origin
    let side = 0; // and across it
    let intensity: number;
    if (mode === 'anamorphic') {
      // Stacked tight around the hero (within ±2 thicknesses), slightly shifted along.
      along = hero ? 0 : (h5 - 0.5) * 0.3 * len;
      side = hero ? 0 : (h4 - 0.5) * T * 4;
      intensity = hero ? 1 : 0.3 + 0.5 * h6;
    } else if (mode === 'spears') {
      // Scattered along the flight line, each starting anywhere up to 90% of the length out.
      along = 0.9 * L * h4 + 0.5 * len;
      side = (h5 - 0.5) * T * 4;
      intensity = 0.55 + 0.45 * h6;
    } else {
      // Bundle: every beam leaves the origin (a little staggered).
      along = 0.15 * L * h4 + 0.5 * len;
      intensity = 0.45 + 0.55 * h6;
    }
    out.push({ x: ox + dx * along - dy * side, y: oy + dy * along + dx * side, rot: a, len, thick, intensity });
  }
  return out;
}

const streakFrag = /* glsl */ `
uniform vec3 uCore, uEdge; uniform float uCoreW, uCoreK, uTail, uHead, uChroma, uBright;
${TAPER_GLSL}
// Light at x render px from the axis of a streak of half width hw: soft coloured falloff to the
// edge plus an anti-aliased core band × uCoreK (2: burns out to white under Add, like the
// references' white-cored streaks; 0: the glow source, edge colour only).
vec3 lightAt(float x, float hw) {
  float q = clamp(1.0 - x * x / (hw * hw), 0.0, 1.0);
  float cw = hw * uCoreW;
  float core = clamp(max(cw, 0.5) - x + 0.5, 0.0, 1.0) * min(1.0, 2.0 * cw);
  return uEdge * (q * q) + uCore * (uCoreK * core);
}
// vExtra: half thickness and length in render px, intensity, end margin in render px.
void main() {
  float L = vExtra.y;
  float s = ((0.5 + 0.5 * vQuad.x) * vSizePx.x - vExtra.w) / L; // 0 = tail, 1 = head
  float tp = taperAt(clamp(s, 0.0, 1.0), uTail, uHead);
  float hw0 = vExtra.x * tp;
  float hw = max(hw0, 0.5);
  // Sub-pixel widths fade by their true width; tapered ends also dim.
  float k = vExtra.z * uBright * min(1.0, 2.0 * hw0) * sqrt(tp)
          * clamp(s * L + 0.5, 0.0, 1.0) * clamp((1.0 - s) * L + 0.5, 0.0, 1.0);
  float y = vQuad.y * 0.5 * vSizePx.y;
  vec3 light = vec3(lightAt(abs(y - uChroma), hw).r, lightAt(abs(y), hw).g, lightAt(abs(y + uChroma), hw).b) * k;
  o = vec4(light, clamp(max(max(light.r, light.g), light.b), 0.0, 1.0));
}`;

export const lightStreaks: GeneratorDef = {
  type: 'lightStreaks',
  label: 'Light Streaks',
  category: 'Light',
  description:
    'ストリーク光: white-cored light lines with a coloured edge. Anamorphic lens streaks through the origin, a bundle of beams fanning out of it, or arrow-tapered spears. Brightness above 100% goes HDR; set the layer blend to Add.',
  params: [
    sel('mode', 'Mode', 'anamorphic', [
      ['anamorphic', 'Anamorphic'],
      ['bundle', 'Bundle'],
      ['spears', 'Spears'],
    ]),
    num('x', 'Origin X', 0, -4000, 4000, 'px'),
    num('y', 'Origin Y', 0, -4000, 4000, 'px'),
    num('angle', 'Angle', 0, -180, 180, 'deg'),
    num('spread', 'Spread', 3, 0, 360, 'deg'),
    num('count', 'Count', 6, 1, MAX_STREAKS, undefined, 1),
    num('length', 'Length', 1600, 10, 6000, 'px'),
    num('lengthRandom', 'Length random', 55, 0, 100, '%'),
    num('thickness', 'Thickness', 16, 0.5, 200, 'px'),
    num('thicknessRandom', 'Thickness random', 60, 0, 100, '%'),
    num('taperHead', 'Taper head', 100, 0, 100, '%'),
    num('taperTail', 'Taper tail', 100, 0, 100, '%'),
    col('coreColor', 'Core colour', '#ffffff'),
    col('edgeColor', 'Edge colour', '#3d8bff'),
    num('coreWidth', 'Core width', 25, 0, 100, '%'),
    num('brightness', 'Brightness', 250, 0, 400, '%'),
    num('glow', 'Halo', 140, 0, 400, 'px'),
    num('chroma', 'Chromatic split', 0, 0, 40, 'px'),
    num('seed', 'Seed', 1, 0, 999, undefined, 1),
  ],
  presets: [
    { id: 'anamorphic', label: 'Anamorphic', blend: 'add', params: {} },
    {
      id: 'bundle',
      label: 'Light bundle',
      blend: 'add',
      params: {
        mode: 'bundle',
        x: -900,
        y: 480,
        angle: -25,
        spread: 30,
        count: 28,
        length: 1500,
        lengthRandom: 50,
        thickness: 12,
        taperHead: 20,
        taperTail: 100,
        edgeColor: '#ff9a2e',
        glow: 90,
      },
    },
    {
      id: 'spears',
      label: 'Spears',
      blend: 'add',
      params: {
        mode: 'spears',
        x: -500,
        spread: 8,
        count: 14,
        length: 900,
        lengthRandom: 50,
        thickness: 12,
        thicknessRandom: 50,
        taperHead: 100,
        taperTail: 60,
        edgeColor: '#ffb347',
        brightness: 180,
      },
    },
    {
      id: 'cyan',
      label: 'Cyan streak',
      blend: 'add',
      params: { spread: 0, count: 3, length: 2400, thickness: 12, edgeColor: '#00e1ff', coreWidth: 20, brightness: 300, glow: 180, chroma: 3 },
    },
  ],
  handles: [{ x: 'x', y: 'y', label: 'Origin' }],
  directions: [{ angle: 'angle', length: 'length', label: 'Streak direction', convention: 'ccwFromRight' }],
  bounds(p) {
    const pad = Math.max(0, N(p, 'glow')) + Math.max(0, N(p, 'chroma')) + 2;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const s of streaks(p)) {
      const c = Math.cos(s.rot);
      const sn = Math.sin(s.rot);
      const ex = Math.abs(c) * s.len * 0.5 + Math.abs(sn) * s.thick * 0.5 + pad;
      const ey = Math.abs(sn) * s.len * 0.5 + Math.abs(c) * s.thick * 0.5 + pad;
      x0 = Math.min(x0, s.x - ex);
      y0 = Math.min(y0, s.y - ey);
      x1 = Math.max(x1, s.x + ex);
      y1 = Math.max(y1, s.y + ey);
    }
    return { x0, y0, x1, y1 };
  },
  render(ctx, target, p) {
    const k = pxPerLayer(ctx.layerToRender);
    const list = streaks(p);
    const n = list.length;
    const chroma = Math.max(0, N(p, 'chroma'));
    const center = new Float32Array(n * 2);
    const size = new Float32Array(n * 2);
    const rotation = new Float32Array(n);
    const color = new Float32Array(n * 4).fill(1);
    const extra = new Float32Array(n * 4);
    const margin = 1 / k; // one render px of anti-aliasing room past each end
    list.forEach((s, i) => {
      center[i * 2] = s.x;
      center[i * 2 + 1] = s.y;
      size[i * 2] = s.len + 2 * margin;
      size[i * 2 + 1] = 2 * (Math.max(0.5 * s.thick * k, 0.5) / k + chroma + margin);
      rotation[i] = s.rot;
      extra.set([0.5 * s.thick * k, s.len * k, s.intensity, 1], i * 4);
    });
    const [tail, head] = taperFractions(N(p, 'taperTail'), N(p, 'taperHead'));
    const draw = (dst: typeof target, coreK: number) =>
      drawInstancedQuads(ctx, dst, {
        count: n,
        center,
        size,
        rotation,
        color,
        extra,
        toRender: ctx.layerToRender,
        fragmentShader: streakFrag,
        uniforms: {
          uCore: { value: C(p, 'coreColor') },
          uEdge: { value: C(p, 'edgeColor') },
          uCoreW: { value: clamp(N(p, 'coreWidth') / 100, 0, 1) },
          uCoreK: { value: coreK },
          uTail: { value: tail },
          uHead: { value: head },
          uChroma: { value: chroma * k },
          uBright: { value: Math.max(0, N(p, 'brightness') / 100) },
        },
        blend: 'add',
        minPx: 0,
      });
    // The halo is blurred from the edge colour alone: the white core stays a thin hot line inside
    // a coloured bloom (a tight bright one plus a wide soft one).
    const glow = Math.max(0, N(p, 'glow'));
    clearTarget(ctx, target);
    draw(target, 2);
    if (glow > 0) {
      const edges = ctx.kit.acquire();
      clearTarget(ctx, edges);
      draw(edges, 0);
      glowInto(ctx, edges.texture, target, glow * 0.25, 1.5);
      glowInto(ctx, edges.texture, target, glow, 1.2);
      ctx.kit.release(edges);
    }
  },
};

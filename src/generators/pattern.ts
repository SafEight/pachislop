import * as THREE from 'three';
import type { GeneratorDef } from '../engine/contracts';
import { PATTERN_GLSL, PATTERN_UNIFORMS_GLSL, patternUniforms, setPatternUniforms } from '../engine/patterns';
import type { Pattern, PatternKind } from '../model/types';
import { C, col, DEG, HEAD, material, N, num, S, sel } from '../effects/b/common';
import { LAYER_FRAG, type LayerUniforms, layerUniforms, setLayerUniforms } from './common';

// Full-frame 柄 (pattern fill): the procedural patterns of src/engine/patterns.ts that titles and
// 3D materials use, drawn over the whole frame on a solid background, optionally laid on a
// receding floor plane. Fading it out is a gradient layer mask.

/** Procedural kinds; 'custom' tiles an image asset, which a generator param cannot pick. */
const KINDS: [Exclude<PatternKind, 'none' | 'custom'>, string][] = [
  ['zebra', 'Zebra ゼブラ'],
  ['tiger', 'Tiger 虎'],
  ['giraffe', 'Giraffe キリン'],
  ['leopard', 'Leopard 豹'],
  ['checker', 'Checker チェッカー'],
  ['hazard', 'Hazard DANGER'],
  ['stripes', 'Stripes ストライプ'],
  ['dots', 'Polka dots 水玉'],
  ['sakura', 'Sakura 桜'],
  ['seigaiha', 'Seigaiha 青海波'],
  ['asanoha', 'Asanoha 麻の葉'],
  ['shippo', 'Shippo 七宝'],
  ['kikko', 'Kikko 亀甲'],
  ['uroko', 'Uroko 鱗'],
];

const frag = /* glsl */ `
uniform vec3 uBg; uniform float uBgA;
uniform vec2 uTilt;    // (sin, cos) of the floor tilt
uniform float uFocal;  // viewing distance, layer px
${LAYER_FRAG}
${PATTERN_GLSL}
${PATTERN_UNIFORMS_GLSL}
void main() {
  vec2 lp = layerPos();
  // Floor plane tilted back about the layer's x axis, seen from uFocal in front of the layer
  // origin: screen y = f·v·cos t / (f + v·sin t), screen x = f·u / (f + v·sin t), inverted here.
  // The horizon sits at y = f·cos t / sin t, where den reaches 0.
  float den = uFocal * uTilt.y - lp.y * uTilt.x;
  float v = lp.y * uFocal / max(den, 1e-3 * uFocal);
  vec2 plane = vec2(lp.x * (uFocal + v * uTilt.x) / uFocal, v);
  vec4 pat = patternAt(plane);
  // Motif units per layer px: past ~4 px per motif the marks only shimmer, so they fade out
  // toward the horizon (resolution independent: the same in the preview and every export).
  float k = length(fwidth(patternCoord(plane))) * layerPxScale();
  float a = den > 0.0 ? 1.0 - smoothstep(0.25, 0.7, k) : 0.0;
  vec4 c = vec4(uBg * uBgA, uBgA);
  c = mix(c, vec4(uPatColor, 1.0), pat.x);
  c = mix(c, vec4(uPatColor2, 1.0), pat.y);
  o = c * a;
}`;

export const patternFill: GeneratorDef = {
  type: 'patternFill',
  label: 'Pattern Fill',
  category: 'Pattern',
  description:
    'Full-frame 柄: zebra, giraffe, leopard, tiger, checker, hazard and 和柄 over a background colour, optionally on a floor plane receding to a horizon. Fade it out with a gradient layer mask.',
  params: [
    sel('kind', 'Pattern', 'zebra', KINDS),
    col('color', 'Colour', '#121212'),
    col('color2', 'Colour 2', '#ffffff'),
    col('background', 'Background', '#f2efe8'),
    num('bgOpacity', 'Background opacity', 100, 0, 100, '%'),
    num('scale', 'Motif size', 140, 8, 2000, 'px'),
    num('rotation', 'Rotation', 0, -180, 180, 'deg'),
    num('tilt', 'Perspective tilt', 0, 0, 80, 'deg'),
    num('seed', 'Seed', 1, 0, 999, undefined, 1),
  ],
  presets: [
    { id: 'zebra', label: 'Zebra', params: {} },
    { id: 'giraffe', label: 'Giraffe', params: { kind: 'giraffe', color: '#7a3f16', background: '#f0d39a', scale: 160 } },
    {
      id: 'leopard',
      label: 'Leopard',
      params: { kind: 'leopard', color: '#1e1208', color2: '#b5621c', background: '#e9b860', scale: 90 },
    },
    // Lying stripes, slightly tilted: upright ones read as a row of blobs.
    { id: 'tiger', label: 'Tiger', params: { kind: 'tiger', color: '#140c06', background: '#f07f12', scale: 75, rotation: 80 } },
    { id: 'checker', label: 'Checker', params: { kind: 'checker', color: '#111111', color2: '#f5f5f5', scale: 80 } },
    { id: 'hazard', label: 'Hazard', params: { kind: 'hazard', color: '#141414', color2: '#ffd200', scale: 120 } },
    { id: 'seigaiha', label: 'Seigaiha', params: { kind: 'seigaiha', color: '#e9c66b', background: '#0f2350', scale: 140 } },
    { id: 'asanoha', label: 'Asanoha', params: { kind: 'asanoha', color: '#ffffff', background: '#b3122e', scale: 160 } },
    { id: 'shippo', label: 'Shippo', params: { kind: 'shippo', color: '#f1cf6e', background: '#3b1258', scale: 120 } },
  ],
  bounds: () => null,
  render(ctx, target, p) {
    const m = material(ctx.kit, 'gen-pattern', {
      uniforms: {
        ...layerUniforms(),
        ...patternUniforms(),
        uBg: { value: new THREE.Color() },
        uBgA: { value: 1 },
        uTilt: { value: new THREE.Vector2(0, 1) },
        uFocal: { value: 1000 },
      },
      fragmentShader: HEAD + frag,
    });
    const u = m.uniforms;
    setLayerUniforms(u as unknown as LayerUniforms, ctx, ctx.layerToRender);
    const kind = S(p, 'kind');
    const pattern: Pattern = {
      kind: KINDS.some(([k]) => k === kind) ? (kind as PatternKind) : 'zebra',
      color: S(p, 'color'),
      color2: S(p, 'color2'),
      opacity: 1,
      scale: 100, // of `size` below: one motif = the size param in layer px
      angle: N(p, 'rotation'),
      seed: N(p, 'seed'),
      shade: 0,
      relief: 0,
    };
    setPatternUniforms(u, pattern, Math.max(1, N(p, 'scale')), { linear: true });
    u.uBg.value.copy(C(p, 'background'));
    u.uBgA.value = N(p, 'bgOpacity') / 100;
    const t = Math.min(80, Math.max(0, N(p, 'tilt'))) * DEG;
    u.uTilt.value.set(Math.sin(t), Math.cos(t));
    // A camera about one comp height away: at 45° the horizon sits a comp height above the origin.
    u.uFocal.value = Math.max(1, ctx.comp.height);
    ctx.kit.run(m, target);
  },
};

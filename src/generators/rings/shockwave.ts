import * as THREE from 'three';
import type { EffectParams, GeneratorDef } from '../../engine/contracts';
import { C, col, DEG, N, num, S, sel } from '../../effects/b/common';
import { NOISE_GLSL } from '../../effects/lib';
import { clearTarget, lightGlow } from '../common';
import { BOX_GLSL, centreParams, drawBox, ellipseBox } from './shared';

// 衝撃波 (shockwave): concentric light rings around a centre, the impact / 当たり告知 ring of AE
// Radio Waves, with a band profile, soft inner and outer edges, a fibrous or broken-up texture, a
// radial smear, a chromatic fringe and a white-hot core flash. It cannot refract the layers below
// (generators don't read them): use a Wave / displacement effect on those layers for that.

const PROFILES = ['hard', 'soft', 'sine', 'double', 'fibrous'] as const;

/** Most rings drawn (the shader loop's bound). */
const MAX_RINGS = 8;

const frag = /* glsl */ `
uniform vec2 uCenter;
uniform vec2 uAxis;    // (cos, sin) of the squash axis tilt
uniform float uSquash; // height / width of the ellipse
uniform float uRadius, uSpacing, uHalf, uSoftIn, uSoftOut, uFibre;
uniform int uCount, uProfile;
uniform float uBreak, uBreakScale, uSmear, uSplit, uFlash, uSeed;
uniform vec3 uInner, uOuter;
uniform vec2 uColSpan; // radii where the colour is all inner / all outer
${NOISE_GLSL}
${BOX_GLSL}
const float PI = 3.14159265;

// Brightness across the band, u = −1 at the inner edge … +1 at the outer edge.
float profileAt(float u) {
  if (uProfile == 1) return 1.0 - 0.6 * u * u;                                        // soft
  if (uProfile == 2) return (0.55 + 0.45 * cos(2.0 * PI * u)) * (1.0 - 0.25 * u * u); // sine: crests at the middle and both rims
  if (uProfile == 3) return smoothstep(0.35, 0.65, abs(u));                           // double: two rims, dark between
  return 1.0;                                                                          // hard, fibrous
}

// One band edge at signed distance d (> 0 outward) past half-width h with soft tail s.
float bandAt(float d, float hIn, float hOut, float sIn, float sOut, float aa) {
  bool inner = d < 0.0;
  float u = d / (inner ? hIn : hOut);
  float e = abs(d) - (inner ? hIn : hOut); // > 0 beyond the edge
  float s = inner ? sIn : sOut;
  float cov = clamp(0.5 - e / aa, 0.0, 1.0);
  // Cubic tail: a soft side that glows off the band without filling the inside of the ring.
  float tail = e <= 0.0 ? 1.0 : (s > 0.0 ? pow(max(1.0 - e / s, 0.0), 3.0) : 0.0);
  return profileAt(clamp(u, -1.0, 1.0)) * max(cov, tail);
}

void main() {
  vec2 p = boxPos() - uCenter;
  // Into the ring's own frame: undo the tilt, then stretch the squashed axis back to a circle.
  vec2 q = vec2(uAxis.x * p.x + uAxis.y * p.y, -uAxis.y * p.x + uAxis.x * p.y);
  q.y /= uSquash;
  float r = length(q);
  vec2 dir = r > 1e-4 ? q / r : vec2(1.0, 0.0);
  float aa = max(fwidth(r), 1e-4);
  // Chromatic split: red is drawn split px further out, blue split px further in.
  vec3 rc = r - vec3(uSplit, 0.0, -uSplit);

  vec3 rings = vec3(0.0);
  for (int i = 0; i < ${MAX_RINGS}; i++) {
    if (i >= uCount) break;
    float Ri = uRadius - float(i) * uSpacing;
    if (Ri <= 0.0) break;
    float hIn = uHalf, hOut = uHalf, sIn = uSoftIn, sOut = uSoftOut;
    float gain = pow(0.72, float(i)); // trailing rings fade
    if (uProfile == 4) {
      // Fibres: noise sampled on a circle (seamless), one feature per ~uFibre px of circumference;
      // it frays both edges and streaks the brightness.
      vec2 fq = dir * (Ri / uFibre) + vec2(uSeed * 7.3 + float(i) * 13.1);
      float f1 = vnoise(fq), f2 = vnoise(fq * 1.7 + 41.0), f3 = vnoise(fq * 3.1 + 77.0);
      hIn *= 0.35 + 1.3 * f1;
      hOut *= 0.5 + f2;
      sIn *= 0.3 + 1.4 * f1;
      sOut *= 0.3 + 1.4 * f2;
      gain *= 0.4 + 0.6 * f3;
    }
    vec3 d = rc - Ri;
    rings += gain * vec3(
      bandAt(d.r, hIn, hOut, sIn, sOut, aa),
      bandAt(d.g, hIn, hOut, sIn, sOut, aa),
      bandAt(d.b, hIn, hOut, sIn, sOut, aa));
  }

  // Breakup: gaps cut across the rings, stretched along them (noise on the circle) with a little
  // 2D noise so they don't line up radially.
  if (uBreak > 0.0) {
    float n = 0.7 * fbm(dir * (uRadius / uBreakScale) + uSeed * 3.7) + 0.3 * vnoise(q / (0.5 * uBreakScale) + 19.0);
    float c = mix(0.18, 0.72, uBreak);
    rings *= smoothstep(c - 0.12, c + 0.12, n);
  }

  vec3 t = smoothstep(uColSpan.x, uColSpan.y, rc);
  vec3 light = rings * mix(uInner, uOuter, t);

  // Radial smear: streaks of the ring colour thrown inward from the leading ring and outward past
  // it, each to its own length (an explosion's 放射状のにじみ, not a grey haze).
  if (uSmear > 0.0) {
    vec2 sq = dir * (uRadius / max(1.5 * uFibre, 1.0)) + uSeed * 3.1 + 211.0;
    float n = 0.6 * vnoise(sq) + 0.4 * vnoise(sq * 2.3 + 5.0);
    n = n * n * n * 2.5; // sparse bright streaks over a dark gap
    float reach = (0.1 + 0.25 * vnoise(sq * 0.7 + 63.0)) * uRadius + uHalf;
    float din = uRadius - r;
    float fall = din > 0.0 ? exp(-din / (0.22 * uRadius)) : pow(1.0 - smoothstep(0.0, reach, -din), 2.0);
    fall *= smoothstep(0.0, 0.3 * uRadius, r);
    light += uSmear * 0.6 * n * fall * uOuter;
  }

  // Core flash in the inner colour: a small white-hot core with a faint halo (a broad bright disc
  // would fill the ring and hide it).
  float rr = r / max(uRadius, 1.0);
  light += uFlash * (exp(-40.0 * rr * rr) + 0.1 * exp(-6.0 * rr * rr)) * uInner;

  light = max(light, 0.0);
  o = vec4(light, clamp(max(max(light.r, light.g), light.b), 0.0, 1.0));
}`;

const uniforms: Record<string, THREE.IUniform> = {
  uCenter: { value: new THREE.Vector2() },
  uAxis: { value: new THREE.Vector2(1, 0) },
  uSquash: { value: 1 },
  uRadius: { value: 1 },
  uSpacing: { value: 0 },
  uHalf: { value: 1 },
  uSoftIn: { value: 0 },
  uSoftOut: { value: 0 },
  uFibre: { value: 1 },
  uCount: { value: 1 },
  uProfile: { value: 0 },
  uBreak: { value: 0 },
  uBreakScale: { value: 1 },
  uSmear: { value: 0 },
  uSplit: { value: 0 },
  uFlash: { value: 0 },
  uSeed: { value: 0 },
  uInner: { value: new THREE.Color() },
  uOuter: { value: new THREE.Color() },
  uColSpan: { value: new THREE.Vector2() },
};

/** Furthest the drawn rings reach from the centre along the unsquashed axis (layer px). */
function reach(p: EffectParams) {
  const R = Math.max(1, N(p, 'radius'));
  const h = Math.max(0.5, N(p, 'width') / 2);
  const fibrous = S(p, 'profile') === 'fibrous';
  const soft = Math.max(0, N(p, 'softOut')) * (fibrous ? 1.7 : 1);
  const smear = N(p, 'smear') > 0 ? 0.35 * R + h : 0;
  return R + Math.max((fibrous ? 1.5 : 1) * h + soft, smear) + Math.abs(N(p, 'split')) + 2;
}

/** Layer-space box of the rings. */
function coreBox(p: EffectParams) {
  const E = reach(p);
  const squash = Math.min(1, Math.max(0.05, N(p, 'squash') / 100));
  return ellipseBox(N(p, 'cx'), N(p, 'cy'), E, E * squash, N(p, 'tilt') * DEG);
}

export const shockwave: GeneratorDef = {
  type: 'shockwave',
  label: 'Shockwave',
  category: 'Rings',
  description:
    '衝撃波: concentric light rings with a hard, soft, sine, double or fibrous band profile, soft inner and outer edges, ' +
    'squashed and tilted onto a floor, broken up by noise, smeared radially, with a chromatic fringe and a core flash. ' +
    'Set the layer to Add. It does not refract the layers below.',
  params: [
    ...centreParams(),
    num('radius', 'Radius', 380, 10, 3000, 'px'),
    num('rings', 'Rings', 2, 1, MAX_RINGS, undefined, 1),
    num('spacing', 'Ring spacing', 60, 0, 1000, 'px'),
    num('width', 'Width', 24, 1, 600, 'px'),
    sel('profile', 'Profile', 'soft', [
      ['hard', 'Hard'],
      ['soft', 'Soft'],
      ['sine', 'Sine ripple'],
      ['double', 'Double rim'],
      ['fibrous', 'Fibrous'],
    ]),
    num('softIn', 'Inner softness', 30, 0, 800, 'px'),
    num('softOut', 'Outer softness', 6, 0, 800, 'px'),
    num('squash', 'Squash', 100, 5, 100, '%'),
    num('tilt', 'Tilt', 0, -90, 90, 'deg'),
    num('breakup', 'Breakup', 25, 0, 100, '%'),
    num('breakupScale', 'Breakup scale', 40, 2, 1000, 'px'),
    num('smear', 'Radial smear', 0, 0, 100, '%'),
    num('split', 'Chromatic split', 0, 0, 60, 'px'),
    num('flash', 'Core flash', 15, 0, 200, '%'),
    col('inner', 'Inner colour', '#ffffff'),
    col('outer', 'Outer colour', '#d8ecff'),
    num('seed', 'Seed', 1, 0, 999, undefined, 1),
  ],
  presets: [
    {
      id: 'white',
      label: 'Shockwave (white)',
      blend: 'add',
      params: { rings: 2, spacing: 46, width: 14, profile: 'soft', softIn: 50, softOut: 2, breakup: 6, smear: 0, split: 4, flash: 0, inner: '#ffffff', outer: '#d8ecff' },
      effects: [lightGlow(24)],
    },
    {
      id: 'red',
      label: 'Red shockwave',
      blend: 'add',
      params: {
        rings: 1, width: 50, profile: 'fibrous', softIn: 40, softOut: 14, breakup: 20, breakupScale: 50, smear: 60, split: 0, flash: 80,
        inner: '#fff4f0', outer: '#ff1830',
      },
      effects: [lightGlow(30)],
    },
    {
      id: 'neon',
      label: 'Neon rings',
      blend: 'add',
      params: {
        radius: 420, rings: 5, spacing: 55, width: 7, profile: 'hard', softIn: 10, softOut: 10, breakup: 0, smear: 0, split: 0, flash: 0,
        inner: '#ff6ec8', outer: '#ff1e5a',
      },
      effects: [lightGlow(28)],
    },
    {
      id: 'halo',
      label: 'Ring of light',
      blend: 'add',
      params: { radius: 300, rings: 1, width: 14, profile: 'soft', softIn: 14, softOut: 14, breakup: 0, smear: 0, split: 0, flash: 0, inner: '#fff3c4', outer: '#ffc640' },
      effects: [lightGlow(40)],
    },
    {
      id: 'ground',
      label: 'Ground shockwave',
      blend: 'add',
      params: {
        radius: 520, rings: 2, spacing: 90, width: 36, profile: 'fibrous', softIn: 50, softOut: 10, squash: 28, tilt: -6, breakup: 25, breakupScale: 40,
        smear: 50, split: 0, flash: 15, inner: '#fff2d0', outer: '#ff8a30',
      },
      effects: [lightGlow(24)],
    },
  ],
  handles: [{ x: 'cx', y: 'cy', label: 'Ring centre' }],
  sizes: [{ rx: 'radius', x: 'cx', y: 'cy', label: 'Radius' }],
  bounds: (p) => coreBox(p),
  render(ctx, target, p) {
    clearTarget(ctx, target);
    const R = Math.max(1, N(p, 'radius'));
    const count = Math.round(Math.min(MAX_RINGS, Math.max(1, N(p, 'rings'))));
    const spacing = Math.max(0, N(p, 'spacing'));
    const width = Math.max(1, N(p, 'width'));
    const half = width / 2;
    const softIn = Math.max(0, N(p, 'softIn'));
    const softOut = Math.max(0, N(p, 'softOut'));
    const tilt = N(p, 'tilt') * DEG;
    const u = uniforms;
    u.uCenter.value.set(N(p, 'cx'), N(p, 'cy'));
    u.uAxis.value.set(Math.cos(tilt), Math.sin(tilt));
    u.uSquash.value = Math.min(1, Math.max(0.05, N(p, 'squash') / 100));
    u.uRadius.value = R;
    u.uSpacing.value = spacing;
    u.uHalf.value = half;
    u.uSoftIn.value = softIn;
    u.uSoftOut.value = softOut;
    u.uFibre.value = 2 + 0.12 * width;
    u.uCount.value = count;
    u.uProfile.value = Math.max(0, PROFILES.indexOf(S(p, 'profile') as (typeof PROFILES)[number]));
    u.uBreak.value = Math.min(1, Math.max(0, N(p, 'breakup') / 100));
    u.uBreakScale.value = Math.max(2, N(p, 'breakupScale'));
    u.uSmear.value = Math.max(0, N(p, 'smear') / 100);
    u.uSplit.value = Math.max(0, N(p, 'split'));
    u.uFlash.value = Math.max(0, N(p, 'flash') / 100);
    u.uSeed.value = N(p, 'seed');
    u.uInner.value.copy(C(p, 'inner'));
    u.uOuter.value.copy(C(p, 'outer'));
    // Inner colour from the innermost ring's soft inner edge to full outer colour at the leading
    // ring's middle: a hot inner edge on a ring of the outer colour.
    const innermost = Math.max(0, R - (count - 1) * spacing - half - softIn);
    u.uColSpan.value.set(innermost, Math.max(innermost + 1, R));
    drawBox(ctx, target, coreBox(p), frag, uniforms);
  },
};

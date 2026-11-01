import * as THREE from 'three';
import type { GeneratorDef } from '../../engine/contracts';
import { NOISE_GLSL } from '../../effects/lib';
import { B, bool, C, col, common, DEG, HEAD, material, N, num } from '../../effects/b/common';
import { pxPerLayer } from '../lines/shared';
import { ANAMORPHIC_GLSL, clearTarget, followed, followParam } from '../common';

// Anamorphic lens flare drawn as light (set to Add): hot core, horizontal streak, starburst,
// chromatic halo ring and ghosts along the axis through the comp centre. Free, it sits at its
// own x / y; following a layer, x / y are an offset from the centre of that layer's ink, so the
// flare moves with it.

const frag = /* glsl */ `
uniform vec2 uPos; uniform float uSize, uStreak, uIntensity, uRot, uRays, uSeed;
uniform vec3 uCol; uniform bool uGhosts;
${NOISE_GLSL}
${ANAMORPHIC_GLSL}
void main() {
  vec2 v = gl_FragCoord.xy - uPos;
  float c = cos(uRot), sn = sin(uRot);
  vec2 lv = vec2(c * v.x + sn * v.y, -sn * v.x + c * v.y);
  float r = length(v) / uSize;
  vec3 L = vec3(0.0);
  // Hot core + soft bloom.
  L += vec3(1.0) * (exp(-r * r * 18.0) * 2.0 + 0.25 / (1.0 + r * r * 6.0));
  L += uCol * 0.35 / (1.0 + r * r * 1.5);
  L += anamorphicStreak(lv, uSize, uStreak, uCol);
  // Starburst spikes.
  float ang = atan(v.y, v.x);
  vec2 cd = vec2(cos(ang), sin(ang));
  float sp = pow(vnoise(cd * 9.0 + uSeed), 3.0) * 2.5 + pow(vnoise(cd * 23.0 + uSeed * 2.0), 6.0) * 4.0;
  L += mix(uCol, vec3(1.0), 0.6) * sp * uRays * 0.5 / (1.0 + r * r * 2.5) * smoothstep(0.0, 0.15, r);
  // Chromatic halo ring.
  vec3 ring = vec3(exp(-pow((r - 2.35) / 0.07, 2.0)), exp(-pow((r - 2.25) / 0.07, 2.0)), exp(-pow((r - 2.15) / 0.07, 2.0)));
  L += ring * 0.18;
  if (uGhosts) {
    vec2 axis = 0.5 * uRes - uPos;
    for (int i = 0; i < 6; i++) {
      float fi = float(i);
      float k = 0.35 + fi * 0.33 + (hash12(vec2(fi, uSeed)) - 0.5) * 0.2;
      float gs = uSize * (0.25 + 0.9 * hash12(vec2(fi + 9.0, uSeed)));
      vec2 gp = uPos + axis * k * 2.0;
      float d = length(gl_FragCoord.xy - gp) / gs;
      float disc = (1.0 - smoothstep(0.9, 1.0, d)) * (0.35 + 0.65 * d * d);
      vec3 tint = 0.5 + 0.5 * cos(6.2831 * (fi * 0.17 + vec3(0.0, 0.33, 0.67) + uSeed * 0.1));
      L += tint * mix(uCol, vec3(1.0), 0.3) * disc * 0.16;
    }
  }
  o = lightPremul(L * uIntensity);
}`;

const pos = new THREE.Vector2();

export const lensFlare: GeneratorDef = {
  type: 'lensFlare',
  label: 'Lens Flare',
  category: 'Light',
  description:
    'Anamorphic lens flare: hot core, horizontal streak, starburst, halo ring and ghosts, added as light. Drag its position on the canvas; following a layer, it is placed from that layer’s centre and moves with it.',
  follow: 'optional',
  params: [
    followParam(),
    num('x', 'Position X', -380, -4000, 4000, 'px'),
    num('y', 'Position Y', 120, -4000, 4000, 'px'),
    num('size', 'Size', 70, 4, 1000, 'px'),
    num('streak', 'Streak length', 700, 0, 4000, 'px'),
    num('rotation', 'Streak angle', 0, -180, 180, 'deg'),
    num('rays', 'Starburst', 60, 0, 200, '%'),
    bool('ghosts', 'Ghosts', true),
    col('color', 'Colour', '#7cc4ff'),
    num('intensity', 'Intensity', 100, 0, 400, '%'),
    num('seed', 'Seed', 1, 0, 999, undefined, 1),
  ],
  presets: [
    { id: 'blue', label: 'Blue flare', params: {}, blend: 'add' },
    { id: 'gold', label: 'Gold flare', params: { x: 360, y: 110, size: 60, streak: 900, color: '#ffd27a', intensity: 110 }, blend: 'add' },
    { id: 'streak', label: 'Long streak', params: { x: 0, y: 0, size: 40, streak: 2400, rays: 20, ghosts: false, color: '#5ab0ff', intensity: 120 }, blend: 'add' },
  ],
  handles: [{ x: 'x', y: 'y', label: 'Flare' }],
  // Bloom, streak and ghosts reach every canvas edge wherever the flare sits.
  bounds: () => null,
  followReach: () => null,
  render(ctx, target, p) {
    const id = followed(p);
    const box = id ? ctx.layerBounds(id) : null;
    // Following a layer that draws nothing: no flare.
    if (id && !box) return clearTarget(ctx, target);
    const m = material(ctx.kit, 'gen-flare', {
      uniforms: {
        uPos: { value: new THREE.Vector2() },
        uSize: { value: 60 },
        uStreak: { value: 500 },
        uIntensity: { value: 1 },
        uRot: { value: 0 },
        uRays: { value: 0.6 },
        uSeed: { value: 0 },
        uCol: { value: new THREE.Color() },
        uGhosts: { value: true },
      },
      fragmentShader: HEAD + frag,
    });
    common(m, ctx);
    const u = m.uniforms;
    const e = ctx.layerToRender.elements;
    const k = pxPerLayer(ctx.layerToRender);
    pos.set(N(p, 'x'), N(p, 'y'));
    if (box) pos.add({ x: 0.5 * (box.x0 + box.x1), y: 0.5 * (box.y0 + box.y1) });
    u.uPos.value.copy(pos.applyMatrix3(ctx.layerToRender));
    u.uSize.value = Math.max(1, N(p, 'size') * k);
    u.uStreak.value = N(p, 'streak') * k;
    u.uRot.value = N(p, 'rotation') * DEG + Math.atan2(e[1], e[0]);
    u.uRays.value = N(p, 'rays') / 100;
    u.uSeed.value = (N(p, 'seed') % 97) * 1.37;
    u.uCol.value.copy(C(p, 'color'));
    u.uGhosts.value = B(p, 'ghosts');
    u.uIntensity.value = N(p, 'intensity') / 100;
    ctx.kit.run(m, target);
  },
};

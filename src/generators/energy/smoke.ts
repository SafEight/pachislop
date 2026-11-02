import * as THREE from 'three';
import type { GeneratorDef } from '../../engine/contracts';
import { NOISE_GLSL, sdf } from '../../effects/lib';
import { C, col, common, DEG, HEAD, material, N, num } from '../../effects/b/common';
import { clearTarget, drawFollowed, followed, followParam } from '../common';
import { SD_GLSL, sdUniforms, setSdf } from './shared';

// Soft billowing smoke rising from the edges of the followed layer's own pixels; a companion
// below the layer. Its transparency is the layer opacity.

const frag = /* glsl */ `
uniform vec2 uDir; uniform float uH, uW, uPhase, uSeed, uSide, uSoft;
uniform vec3 uCol, uCol2;
${NOISE_GLSL}
${SD_GLSL}
float soft3(vec2 p) { return 0.55 * vnoise(p) + 0.3 * vnoise(p * 2.07 + 9.1) + 0.15 * vnoise(p * 4.3 + 3.7); }
void main() {
  vec2 pc = compPos();
  vec2 perp = vec2(-uDir.y, uDir.x);
  float fy = dot(pc, uDir), fx = dot(pc, perp);
  float tt = uPhase;
  vec2 seed = vec2(uSeed * 11.7, uSeed * 3.9);
  // Billows drift up with the flow and slowly churn (domain warp).
  vec2 q = vec2(fx, fy - tt * uW * 1.1) / (uW * 2.0) + seed;
  vec2 w = vec2(soft3(q * 0.6 + vec2(0.0, tt * 0.12)), soft3(q * 0.6 + vec2(5.2, 1.3 - tt * 0.09))) - 0.5;
  float bil = soft3(q + w * 1.5);
  // Columns of smoke reach different heights and sway as they rise.
  float plume = soft3(vec2(fx / (uW * 2.5), tt * 0.08) + seed.yx);
  vec2 frag = gl_FragCoord.xy + perp * w.x * uW * 2.0 * uPx;
  float Hr = uH * uPx;
  float len = Hr * (0.45 + 0.9 * plume);
  float E = upstream(frag, uDir, Hr * 1.4, uSide);
  float I = clamp(1.0 - E / max(len, 1.0), 0.0, 1.0);
  float dens = pow(I, 0.8) * (0.3 + 1.1 * bil);
  dens = smoothstep(0.08, 0.08 + uSoft, dens);
  vec3 c = mix(uCol2, uCol, smoothstep(0.3, 0.75, bil));
  o = vec4(c * dens, dens);
}`;

export const smoke: GeneratorDef = {
  type: 'smoke',
  label: 'Smoke',
  category: 'Energy',
  description: 'Soft billowing smoke rising from the edges of the layer it follows (direction 90° = up); put it below that layer.',
  follow: 'required',
  params: [
    followParam(),
    num('height', 'Smoke height', 220, 10, 800, 'px'),
    num('width', 'Billow size', 40, 5, 300, 'px'),
    num('angle', 'Direction', 90, -180, 180, 'deg'),
    num('spread', 'Side spread', 35, 0, 100, '%'),
    num('softness', 'Softness', 60, 5, 100, '%'),
    col('color', 'Highlight colour', '#d8d2e6'),
    col('shadowColor', 'Shadow colour', '#4a4458'),
    num('phase', 'Evolution', 0, 0, 10, undefined, 0.01),
    num('seed', 'Seed', 1, 0, 999, undefined, 1),
  ],
  presets: [
    { id: 'grey', label: 'Grey smoke', params: {}, place: 'below', opacity: 0.75 },
    { id: 'steam', label: 'White steam', params: { height: 260, width: 50, softness: 80, color: '#ffffff', shadowColor: '#a8b0c0' }, place: 'below', opacity: 0.6 },
    { id: 'black', label: 'Black smoke', params: { height: 240, width: 36, softness: 45, color: '#4a4448', shadowColor: '#0c0a0c' }, place: 'below', opacity: 0.8 },
  ],
  directions: [{ angle: 'angle', length: 'height', label: 'Smoke', convention: 'ccwFromRight' }],
  bounds: () => ({ x0: 0, y0: 0, x1: 0, y1: 0 }),
  // tallest plume = 1.35 × height, plus the sideways billow warp
  followReach: (p) => 1.35 * N(p, 'height') + N(p, 'width'),
  render(ctx, target, p) {
    const content = ctx.layerContent(followed(p));
    if (!content) return clearTarget(ctx, target);
    drawFollowed(ctx, target, (out) => {
      const field = sdf(ctx, content, 0.5);
      const m = material(ctx.kit, 'gen-smoke', {
        uniforms: {
          ...sdUniforms(),
          uDir: { value: new THREE.Vector2() },
          uH: { value: 100 },
          uW: { value: 30 },
          uPhase: { value: 0 },
          uSeed: { value: 1 },
          uSide: { value: 2 },
          uSoft: { value: 0.6 },
          uCol: { value: new THREE.Color() },
          uCol2: { value: new THREE.Color() },
        },
        fragmentShader: HEAD + frag,
      });
      common(m, ctx);
      const u = m.uniforms;
      const a = N(p, 'angle') * DEG;
      setSdf(m, ctx, field.texture);
      u.uDir.value.set(Math.cos(a), Math.sin(a));
      u.uH.value = Math.max(1, N(p, 'height'));
      u.uW.value = Math.max(1, N(p, 'width'));
      u.uPhase.value = N(p, 'phase');
      u.uSeed.value = N(p, 'seed') % 97;
      u.uSide.value = 1 / Math.max(0.08, N(p, 'spread') / 100);
      u.uSoft.value = Math.max(0.02, N(p, 'softness') / 100);
      u.uCol.value.copy(C(p, 'color'));
      u.uCol2.value.copy(C(p, 'shadowColor'));
      ctx.kit.run(m, out);
    });
  },
};

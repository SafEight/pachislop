import * as THREE from 'three';
import type { GeneratorDef } from '../../engine/contracts';
import { NOISE_GLSL, sdf } from '../../effects/lib';
import { B, bool, common, DEG, G, grad, HEAD, material, N, num } from '../../effects/b/common';
import { GRADIENTS } from '../../model/defaults';
import { clearTarget, drawFollowed, followed, followParam } from '../common';
import { SD_GLSL, stops } from './shared';

// Eye Candy Fire: flames rising from the edges of the followed layer's own pixels. Behind the
// layer it is a companion below it; licking over the edges, a companion above it whose flames
// clear out over the outer band of the shape, so the layer shows through.

const frag = /* glsl */ `
uniform sampler2D tGrad; uniform vec2 uDir; uniform float uH, uW, uTurb, uPhase, uSeed, uSide, uIntensity, uInside;
uniform bool uOverEdge;
${NOISE_GLSL}
${SD_GLSL}
void main() {
  vec2 pc = compPos();
  vec2 perp = vec2(-uDir.y, uDir.x);
  float fy = dot(pc, uDir), fx = dot(pc, perp);
  float tt = uPhase;
  vec2 seed = vec2(uSeed * 17.31, uSeed * 7.13);
  // Sideways sway of the whole flame body.
  float sway = fbm(vec2(fx / (uW * 3.0), fy / (uW * 3.5) - tt * 0.7) + seed) - 0.5;
  vec2 frag = gl_FragCoord.xy + perp * sway * uW * uTurb * 1.4 * uPx;
  float Hr = uH * uPx;
  float E = upstream(frag, uDir, Hr * 1.6, uSide);
  // Rising tongue noise: narrow across the flow, stretched along it, scrolling with the flow.
  float n = 0.7 * fbm(vec2(fx / uW, fy / (uW * 4.0) - tt * 1.1) + seed)
          + 0.3 * vnoise(vec2(fx / (uW * 0.5), fy / (uW * 1.6) - tt * 2.0) + seed.yx);
  n = clamp((n - 0.5) * (1.6 + 1.6 * uTurb) + 0.5, 0.0, 1.0);
  // Each tongue gets its own length; fine flicker roughens only the outer part.
  float len = Hr * mix(1.0, 0.3 + 1.3 * n, clamp(uTurb * 1.3, 0.0, 1.0));
  float f = clamp(1.0 - E / max(len, 1.0), 0.0, 1.0);
  f += (vnoise(vec2(fx / (uW * 0.3), fy / (uW * 0.6) - tt * 3.0) + seed) - 0.5) * 0.9 * f * (1.0 - f);
  f = clamp(f, 0.0, 1.0);
  float a = smoothstep(0.0, 0.35, f);
  float gp = 1.0 - f;
  vec3 c = texture(tGrad, vec2(gp, 0.5)).rgb;
  c *= 1.0 + 0.6 * smoothstep(0.8, 1.0, f); // white-hot core
  vec4 fire = vec4(c * uIntensity * a, a);
  // Over the edge: the flames also lick over the outer band of the shape and clear inside it.
  if (uOverEdge) fire *= 1.0 - smoothstep(0.0, uInside * uPx, max(-sd(gl_FragCoord.xy), 0.0));
  o = fire;
}`;

const FIRE_GRADIENT = stops([0, '#ffffff'], [0.18, '#fff27a'], [0.4, '#ffb000'], [0.65, '#ff4800'], [0.85, '#c40c00'], [1, '#4a0000']);

export const fire: GeneratorDef = {
  type: 'fire',
  label: 'Fire',
  category: 'Energy',
  description:
    'Eye Candy Fire: flames rising from the edges of the layer it follows (direction 90° = up), behind it, or over the edges where they clear out inside the shape.',
  follow: 'required',
  params: [
    followParam(),
    bool('overEdge', 'Over the edges', false),
    num('height', 'Flame height', 150, 5, 600, 'px'),
    num('width', 'Flame width', 22, 3, 200, 'px'),
    num('turbulence', 'Turbulence', 60, 0, 150, '%'),
    num('angle', 'Direction', 90, -180, 180, 'deg'),
    num('spread', 'Side burn', 35, 0, 100, '%'),
    { ...num('inside', 'Over-edge depth', 12, 0, 100, 'px'), when: { key: 'overEdge', value: true } },
    num('phase', 'Evolution', 0, 0, 10, undefined, 0.01),
    num('intensity', 'Intensity', 110, 0, 300, '%'),
    grad('gradient', 'Colours (core → tips)', FIRE_GRADIENT),
    num('seed', 'Seed', 1, 0, 999, undefined, 1),
  ],
  presets: [
    { id: 'behind', label: 'Flames behind', params: {}, place: 'below' },
    { id: 'overEdges', label: 'Flames over the edges', params: { overEdge: true }, place: 'above' },
    {
      id: 'red',
      label: '激アツ fire',
      params: { height: 120, width: 22, turbulence: 70, spread: 25, inside: 8, intensity: 105, gradient: GRADIENTS.fire, seed: 7 },
      place: 'below',
    },
    {
      id: 'blaze',
      label: 'Tall blaze',
      params: { height: 260, width: 40, turbulence: 70, spread: 30, inside: 10, intensity: 90, gradient: GRADIENTS.fire, seed: 12 },
      place: 'below',
    },
  ],
  directions: [{ angle: 'angle', length: 'height', label: 'Flames', convention: 'ccwFromRight' }],
  bounds: () => ({ x0: 0, y0: 0, x1: 0, y1: 0 }),
  // longest tongue = 1.6 × height (turbulent), plus the sideways sway of the flame body
  followReach: (p) => 1.6 * N(p, 'height') + 0.7 * N(p, 'width') * (N(p, 'turbulence') / 100),
  render(ctx, target, p) {
    const content = ctx.layerContent(followed(p));
    if (!content) return clearTarget(ctx, target);
    drawFollowed(ctx, target, (out) => {
      const field = sdf(ctx, content, 0.5);
      const m = material(ctx.kit, 'gen-fire', {
        uniforms: {
          tSdf: { value: null },
          tGrad: { value: null },
          uDir: { value: new THREE.Vector2() },
          uH: { value: 100 },
          uW: { value: 20 },
          uTurb: { value: 0.6 },
          uPhase: { value: 0 },
          uSeed: { value: 1 },
          uSide: { value: 3 },
          uIntensity: { value: 1 },
          uInside: { value: 10 },
          uOverEdge: { value: false },
        },
        fragmentShader: HEAD + frag,
      });
      common(m, ctx);
      const u = m.uniforms;
      const a = N(p, 'angle') * DEG;
      u.tSdf.value = field.texture;
      u.tGrad.value = ctx.kit.gradientTexture(G(p, 'gradient'));
      u.uDir.value.set(Math.cos(a), Math.sin(a));
      u.uH.value = Math.max(1, N(p, 'height'));
      u.uW.value = Math.max(1, N(p, 'width'));
      u.uTurb.value = N(p, 'turbulence') / 100;
      u.uPhase.value = N(p, 'phase');
      u.uSeed.value = N(p, 'seed') % 97;
      // 0% → only straight up from edges; 100% → sides burn nearly as tall as tops.
      u.uSide.value = 1 / Math.max(0.08, N(p, 'spread') / 100);
      u.uIntensity.value = N(p, 'intensity') / 100;
      u.uInside.value = Math.max(0.5, N(p, 'inside'));
      u.uOverEdge.value = B(p, 'overEdge');
      ctx.kit.run(m, out);
    });
  },
};

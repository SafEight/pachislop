import type { GeneratorDef } from '../../engine/contracts';
import { blur, NOISE_GLSL, sdf } from '../../effects/lib';
import { common, G, grad, HEAD, material, N, num, S, sel } from '../../effects/b/common';
import { GRADIENTS } from '../../model/defaults';
import { clearTarget, drawFollowed, followed, followParam } from '../common';
import { SD_GLSL, sdUniforms, setSdf, stops } from './shared';

// Eye Candy Corona: energy tendrils, or an aura of tongues, growing from the edges of the
// followed layer's own pixels, drawn as light. Behind the layer it is a companion below it
// (Normal); added over it, a companion above it set to Add.

const coronaFrag = /* glsl */ `
uniform sampler2D tGrad, tBlur; uniform float uLen, uWisp, uPhase, uIntensity, uDensity, uSeed, uGlow;
${NOISE_GLSL}
${SD_GLSL}
float ridge(vec2 p) { return 1.0 - abs(2.0 * vnoise(p) - 1.0); }
void main() {
  vec2 frag = gl_FragCoord.xy;
  float d = sd(frag);
  // Normals from a blurred distance field: continuous across the creases between letters,
  // so the radial streaks bend smoothly instead of flipping.
  vec2 e = 3.0 / uRes;
  float gx = texture(tBlur, vUv + vec2(e.x, 0.0)).r - texture(tBlur, vUv - vec2(e.x, 0.0)).r;
  float gy = texture(tBlur, vUv + vec2(0.0, e.y)).r - texture(tBlur, vUv - vec2(0.0, e.y)).r;
  vec2 nrm = normalize(vec2(gx, gy) + 1e-6);
  float dc = max(d, 0.0) / uPx;
  vec2 pc = compPos();
  float tt = uPhase;
  vec2 seed = vec2(uSeed * 13.1, uSeed * 5.7);
  // Nearest edge point: constant along each outward normal → radial streaks.
  vec2 q = pc - nrm * dc;
  // Curl grows with distance so tendrils bend and wisp out toward their tips.
  vec2 wp = pc / (uLen * 0.7) + seed;
  vec2 warp = vec2(fbm(wp + vec2(0.0, -tt * 0.3)), fbm(wp + vec2(4.3, 2.1 - tt * 0.3))) - 0.5;
  vec2 qw = q + warp * uWisp * dc * 1.1;
  float k = dc / uLen;
  float sc = 0.16 / uDensity;
  float t1 = pow(ridge(qw / (uLen * sc) + vec2(tt * 0.25, -tt * 0.15) + seed), 6.0);
  float t2 = pow(ridge(qw / (uLen * sc * 0.4) + vec2(-tt * 0.4, tt * 0.25) + seed.yx), 14.0);
  // Pulses travelling outward along each tendril.
  float pulse = 0.55 + 0.45 * vnoise(vec2(k * 4.0 - tt * 1.6, dot(q, vec2(0.013, 0.017)) * uDensity * 8.0) + seed);
  float fall = pow(clamp(1.0 - k, 0.0, 1.0), 1.6);
  float tend = (t1 * 0.9 + t2 * 0.7) * pulse * fall;
  float glow = exp(-k * 7.0) * uGlow;
  float inner = d < 0.0 ? exp(d / (uLen * 0.06 * uPx)) : 1.0;
  float I = (tend + glow) * inner * uIntensity;
  vec3 c = texture(tGrad, vec2(clamp(k + (1.0 - tend) * 0.15, 0.0, 1.0), 0.5)).rgb * I;
  o = lightPremul(c);
}`;

// Aura (オーラ強 / 弱): a soft halo hugging the silhouette broken into flickering tongues. Each
// stretch of the edge gets its own tongue length from noise at the turbulence scale; fine streaks
// run along the flow (outward along the edge normals, or straight up with the sides licking up
// too) and the outer half breaks into holes.
const auraFrag = /* glsl */ `
uniform sampler2D tGrad, tBlur; uniform float uLen, uScale, uBreak, uPhase, uIntensity, uSeed, uGlow, uStrong;
uniform bool uUp;
${NOISE_GLSL}
${SD_GLSL}
float ridge(vec2 p) { return 1.0 - abs(2.0 * vnoise(p) - 1.0); }
void main() {
  vec2 frag = gl_FragCoord.xy;
  float d = sd(frag);
  vec2 pc = compPos();
  float tt = uPhase;
  vec2 seed = vec2(uSeed * 9.7, uSeed * 4.3);
  float dc;          // distance from the silhouette along the flow, comp px
  vec2 qn, sq, qh;   // tongue-length, streak and hole noise coordinates
  float L = uLen;
  if (uUp) {
    // Rising flames: tongues stand taller than outward ones and sway more the higher they get.
    L *= 1.6;
    dc = upstream(frag, vec2(0.0, 1.0), L * 1.5 * uPx, 2.0) / uPx;
    float xs = pc.x + (fbm(vec2(pc.x / uScale, pc.y / (uScale * 2.0) - tt * 0.5) + seed) - 0.5) * dc * 0.8;
    qn = vec2(xs / uScale, tt * 0.4);
    sq = vec2(xs / (uScale * 0.18), pc.y / (uScale * 2.0) - tt);
    qh = vec2(xs / (uScale * 0.35), pc.y / (uScale * 0.9) - tt);
  } else {
    // Normals from the blurred distance field, as for the tendrils.
    vec2 e = 3.0 / uRes;
    float gx = texture(tBlur, vUv + vec2(e.x, 0.0)).r - texture(tBlur, vUv - vec2(e.x, 0.0)).r;
    float gy = texture(tBlur, vUv + vec2(0.0, e.y)).r - texture(tBlur, vUv - vec2(0.0, e.y)).r;
    vec2 nrm = normalize(vec2(gx, gy) + 1e-6);
    dc = max(d, 0.0) / uPx;
    // Nearest edge point (constant along each normal), bent sideways with distance so the
    // tongues curl as they reach out.
    vec2 q = pc - nrm * dc;
    vec2 warp = vec2(fbm(pc / uScale + seed), fbm(pc / uScale + seed + 5.1)) - 0.5;
    vec2 qw = q + warp * dc * 0.8;
    qn = qw / uScale + tt * 0.1;
    sq = qw / (uScale * 0.18) + tt * 0.3;
    qh = qw / (uScale * 0.35) + dc / (uScale * 0.9) - tt;
  }
  // fbm sits near 0.5: stretch it so neighbouring tongues differ a lot in length.
  float n = clamp((fbm(qn + seed) - 0.5) * 3.2 + 0.5, 0.0, 1.0);
  float len = L * (0.2 + 1.3 * n);
  float k = dc / max(len, 1.0);
  float tongue = pow(clamp(1.0 - k, 0.0, 1.0), 1.4);
  float streak = 0.55 + 0.45 * pow(ridge(sq + seed.yx), 3.0);
  float hole = smoothstep(0.4, 0.65, fbm(qh + seed * 1.7));
  float brk = 1.0 - uBreak * hole * smoothstep(0.05, 0.5, k);
  float halo = exp(-dc / (uLen * 0.22)) * uGlow * 0.4;
  float inner = d < 0.0 ? exp(d / (uLen * 0.08 * uPx)) : 1.0;
  float I = (tongue * streak * brk + halo) * inner * uIntensity * mix(0.55, 1.0, uStrong);
  vec3 c = texture(tGrad, vec2(clamp(k * 0.85 + (1.0 - streak) * 0.1, 0.0, 1.0), 0.5)).rgb * I;
  o = lightPremul(c);
}`;

const CORONA_GRADIENT = stops([0, '#ffffff'], [0.2, '#c6f4ff'], [0.45, '#3ab4ff'], [0.75, '#6a2cff'], [1, '#d01cff']);

const TENDRILS = { key: 'mode', value: 'tendrils' };
const AURA = { key: 'mode', value: 'aura' };

export const corona: GeneratorDef = {
  type: 'corona',
  label: 'Corona',
  category: 'Energy',
  description:
    'Eye Candy Corona: wispy, flowing energy tendrils radiating from the edges of the layer it follows, or an aura (オーラ, strong or weak) of flickering tongues hugging its silhouette. Below the layer it glows from behind; above it set to Add, it lights the layer too.',
  follow: 'required',
  params: [
    followParam(),
    sel('mode', 'Style', 'tendrils', [
      ['tendrils', 'Tendrils'],
      ['aura', 'Aura (オーラ)'],
    ]),
    { ...num('length', 'Tendril length', 120, 10, 600, 'px'), when: TENDRILS },
    { ...num('wispiness', 'Wispiness', 60, 0, 200, '%'), when: TENDRILS },
    { ...num('density', 'Tendril density', 100, 20, 400, '%'), when: TENDRILS },
    {
      ...sel('aura', 'Aura', 'strong', [
        ['strong', 'Strong (強)'],
        ['weak', 'Weak (弱)'],
      ]),
      when: AURA,
    },
    {
      ...sel('flow', 'Direction', 'outward', [
        ['outward', 'Outward'],
        ['up', 'Up'],
      ]),
      when: AURA,
    },
    { ...num('tongue', 'Tongue length', 90, 5, 600, 'px'), when: AURA },
    { ...num('turbulenceScale', 'Turbulence scale', 60, 5, 400, 'px'), when: AURA },
    { ...num('breakup', 'Breakup', 50, 0, 100, '%'), when: AURA },
    num('glow', 'Edge glow', 60, 0, 200, '%'),
    num('intensity', 'Intensity', 140, 0, 400, '%'),
    grad('gradient', 'Colours (edge → tips)', CORONA_GRADIENT),
    num('phase', 'Evolution', 0, 0, 10, undefined, 0.01),
    num('seed', 'Seed', 1, 0, 999, undefined, 1),
  ],
  presets: [
    { id: 'tendrils', label: 'Blue tendrils', params: {}, place: 'below' },
    {
      id: 'purple',
      label: 'Purple tendrils',
      params: { length: 110, wispiness: 70, density: 110, glow: 70, intensity: 150, gradient: GRADIENTS.coronaPurple, seed: 3 },
      place: 'below',
    },
    { id: 'auraStrong', label: 'Aura (強)', params: { mode: 'aura' }, place: 'below' },
    { id: 'auraWeakUp', label: 'Rising aura (弱)', params: { mode: 'aura', aura: 'weak', flow: 'up' }, place: 'below' },
  ],
  bounds: () => ({ x0: 0, y0: 0, x1: 0, y1: 0 }),
  // Aura: the longest tongue is 1.5 × its length, rising flames 1.6 × taller (strong; weak ones are shorter).
  followReach: (p) => (S(p, 'mode') === 'aura' ? (S(p, 'flow') === 'up' ? 2.4 : 1.5) * N(p, 'tongue') : N(p, 'length')),
  render(ctx, target, p) {
    const content = ctx.layerContent(followed(p));
    if (!content) return clearTarget(ctx, target);
    drawFollowed(ctx, target, (out) => {
      const field = sdf(ctx, content, 0.5);
      if (S(p, 'mode') === 'aura') {
        const strong = S(p, 'aura') !== 'weak';
        // Weak: shorter, dimmer and more broken (DS オーラ(弱) under オーラ(強)).
        const len = Math.max(1, N(p, 'tongue')) * (strong ? 1 : 0.6);
        const m = material(ctx.kit, 'gen-aura', {
          uniforms: {
            ...sdUniforms(),
            tGrad: { value: null },
            tBlur: { value: null },
            uLen: { value: 100 },
            uScale: { value: 60 },
            uBreak: { value: 0.4 },
            uPhase: { value: 0 },
            uIntensity: { value: 1 },
            uSeed: { value: 1 },
            uGlow: { value: 0.6 },
            uStrong: { value: 1 },
            uUp: { value: false },
          },
          fragmentShader: HEAD + auraFrag,
        });
        common(m, ctx);
        const u = m.uniforms;
        const up = S(p, 'flow') === 'up';
        setSdf(m, ctx, field.texture);
        u.tBlur.value = up ? field.texture : blur(ctx, field.texture, len * ctx.pxScale * 0.3, 'gen-corona').texture;
        u.tGrad.value = ctx.kit.gradientTexture(G(p, 'gradient'));
        u.uLen.value = len;
        u.uScale.value = Math.max(1, N(p, 'turbulenceScale'));
        u.uBreak.value = Math.min(1, N(p, 'breakup') / 100 + (strong ? 0 : 0.3));
        u.uGlow.value = N(p, 'glow') / 100;
        u.uIntensity.value = N(p, 'intensity') / 100;
        u.uStrong.value = strong ? 1 : 0;
        u.uUp.value = up;
        u.uPhase.value = N(p, 'phase');
        u.uSeed.value = N(p, 'seed') % 97;
        ctx.kit.run(m, out);
        return;
      }
      const m = material(ctx.kit, 'gen-corona', {
        uniforms: {
          ...sdUniforms(),
          tGrad: { value: null },
          tBlur: { value: null },
          uLen: { value: 100 },
          uWisp: { value: 0.6 },
          uPhase: { value: 0 },
          uIntensity: { value: 1 },
          uDensity: { value: 1 },
          uSeed: { value: 1 },
          uGlow: { value: 0.6 },
        },
        fragmentShader: HEAD + coronaFrag,
      });
      common(m, ctx);
      const u = m.uniforms;
      setSdf(m, ctx, field.texture);
      u.tBlur.value = blur(ctx, field.texture, N(p, 'length') * ctx.pxScale * 0.3, 'gen-corona').texture;
      u.tGrad.value = ctx.kit.gradientTexture(G(p, 'gradient'));
      u.uLen.value = Math.max(1, N(p, 'length'));
      u.uWisp.value = N(p, 'wispiness') / 100;
      u.uDensity.value = Math.max(0.05, N(p, 'density') / 100);
      u.uGlow.value = N(p, 'glow') / 100;
      u.uIntensity.value = N(p, 'intensity') / 100;
      u.uPhase.value = N(p, 'phase');
      u.uSeed.value = N(p, 'seed') % 97;
      ctx.kit.run(m, out);
    });
  },
};

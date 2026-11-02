import * as THREE from 'three';
import type { GeneratorDef } from '../../engine/contracts';
import { centreX, centreY } from '../../engine/frame';
import { bounds, BOUNDS_GLSL, NOISE_GLSL } from '../../effects/lib';
import { C, col, common, DEG, HEAD, material, N, num, S, sel } from '../../effects/b/common';
import { clearTarget, drawFollowed, followed, followParam } from '../common';

// Eye Candy Backlight: god rays streaming out from behind the followed layer's own silhouette
// (its pixels before its effects: a glow or shadow on it neither emits rays nor moves the
// centre), from its centre or a chosen point; a companion below that layer.

const raySrcFrag = /* glsl */ `
uniform sampler2D tSrc; uniform vec2 uLight; uniform bool uAuto; uniform float uRays, uNoise, uRot, uSeed;
${BOUNDS_GLSL}
${NOISE_GLSL}
vec2 centre() {
  if (!uAuto) return uLight;
  vec4 bb = layerBox() * uRes.xyxy;
  return 0.5 * (bb.xy + bb.zw);
}
void main() {
  float a = texture(tSrc, vUv).a;
  vec2 d = gl_FragCoord.xy - centre();
  float ang = atan(d.y, d.x) + uRot;
  vec2 cdir = vec2(cos(ang), sin(ang));
  float rad = uRays / 6.2831853;
  float n = 0.6 * vnoise(cdir * rad + uSeed) + 0.4 * vnoise(cdir * rad * 2.7 + uSeed * 1.7);
  float mask = mix(1.0, pow(smoothstep(0.25, 0.85, n), 1.5) * 1.8, uNoise);
  o = vec4(a * mask, 0.0, 0.0, 1.0);
}`;

const radialFrag = /* glsl */ `
uniform sampler2D tIn; uniform vec2 uLight; uniform bool uAuto; uniform float uLen; uniform bool uFalloff;
${BOUNDS_GLSL}
vec2 centre() {
  if (!uAuto) return uLight;
  vec4 bb = layerBox() * uRes.xyxy;
  return 0.5 * (bb.xy + bb.zw);
}
void main() {
  vec2 p = gl_FragCoord.xy;
  vec2 toC = centre() - p;
  float dist = length(toC);
  float span = min(dist, uLen);
  vec2 dir = toC / max(dist, 1e-3);
  float acc = 0.0, wsum = 0.0;
  for (int i = 0; i < 40; i++) {
    float f = (float(i) + 0.5) / 40.0;
    float w = uFalloff ? pow(1.0 - f, 1.3) : 1.0;
    acc += texture(tIn, (p + dir * span * f) / uRes).r * w;
    wsum += w;
  }
  float v = acc / wsum;
  // Rays stop at uLen from their source edge rather than averaging out to nothing.
  o = vec4(uFalloff ? v * span / max(uLen, 1.0) * 2.0 : v, 0.0, 0.0, 1.0);
}`;

const colourFrag = /* glsl */ `
uniform sampler2D tRays; uniform vec3 uCol, uCol2; uniform float uIntensity;
void main() {
  float r = texture(tRays, vUv).r * uIntensity;
  o = lightPremul(mix(uCol2, uCol, clamp(r, 0.0, 1.0)) * r);
}`;

export const backlight: GeneratorDef = {
  type: 'backlight',
  label: 'Backlight',
  category: 'Light',
  description: 'Eye Candy Backlight: god rays streaming out from behind the layer it follows, from its centre or a chosen point; put it below that layer.',
  follow: 'required',
  params: [
    followParam(),
    sel('centreMode', 'Light centre', 'shape', [
      ['shape', 'Shape centre'],
      ['manual', 'Manual'],
    ]),
    num('x', 'Centre X', 0, -4000, 4000, 'px'),
    num('y', 'Centre Y', 0, -4000, 4000, 'px'),
    num('length', 'Ray length', 260, 10, 2000, 'px'),
    num('intensity', 'Intensity', 240, 0, 600, '%'),
    col('color', 'Inner colour', '#fff6d0'),
    col('outerColor', 'Outer colour', '#ffa318'),
    num('rays', 'Ray count', 36, 2, 120, undefined, 1),
    num('noise', 'Ray noise', 90, 0, 100, '%'),
    num('rotation', 'Rotation', 0, -180, 180, 'deg'),
    num('seed', 'Seed', 1, 0, 999, undefined, 1),
  ],
  presets: [
    { id: 'godRays', label: 'God rays', params: {}, place: 'below' },
    {
      id: 'jackpot',
      label: '大当り rays',
      params: { length: 200, intensity: 130, color: '#fff6d0', outerColor: '#ff9a10', rays: 40, noise: 90, seed: 3 },
      place: 'below',
    },
    { id: 'blue', label: 'Blue rays', params: { length: 320, intensity: 200, color: '#e6f6ff', outerColor: '#2a8aff', rays: 28, noise: 80 }, place: 'below' },
  ],
  handles: [{ x: 'x', y: 'y', label: 'Light centre', when: { key: 'centreMode', value: 'manual' } }],
  bounds: () => ({ x0: 0, y0: 0, x1: 0, y1: 0 }),
  followReach: (p) => N(p, 'length') * (1 + 1 / 40), // coarse ray pass + fine gap-fill pass
  render(ctx, target, p) {
    const content = ctx.layerContent(followed(p));
    if (!content) return clearTarget(ctx, target);
    drawFollowed(ctx, target, (out) => {
      const { kit } = ctx;
      const bb = bounds(ctx, content);
      const auto = S(p, 'centreMode') !== 'manual';
      const centre = new THREE.Vector2(N(p, 'x') * ctx.pxScale + centreX(ctx.frame), N(p, 'y') * ctx.pxScale + centreY(ctx.frame));
      const src = material(kit, 'gen-raysrc', {
        uniforms: {
          tSrc: { value: null },
          tBounds: { value: null },
          uLight: { value: new THREE.Vector2() },
          uAuto: { value: true },
          uRays: { value: 20 },
          uNoise: { value: 0.8 },
          uRot: { value: 0 },
          uSeed: { value: 0 },
        },
        fragmentShader: HEAD + raySrcFrag,
      });
      common(src, ctx);
      src.uniforms.tSrc.value = content;
      src.uniforms.tBounds.value = bb.texture;
      src.uniforms.uLight.value.copy(centre);
      src.uniforms.uAuto.value = auto;
      src.uniforms.uRays.value = N(p, 'rays');
      src.uniforms.uNoise.value = N(p, 'noise') / 100;
      src.uniforms.uRot.value = N(p, 'rotation') * DEG;
      src.uniforms.uSeed.value = (N(p, 'seed') % 97) * 3.17;
      const a = kit.acquire();
      const b = kit.acquire();
      kit.run(src, a);
      const rad = material(kit, 'gen-radial', {
        uniforms: {
          tIn: { value: null },
          tBounds: { value: null },
          uLight: { value: new THREE.Vector2() },
          uAuto: { value: true },
          uLen: { value: 100 },
          uFalloff: { value: true },
        },
        fragmentShader: HEAD + radialFrag,
      });
      common(rad, ctx);
      const len = Math.max(1, N(p, 'length') * ctx.pxScale);
      rad.uniforms.tBounds.value = bb.texture;
      rad.uniforms.uLight.value.copy(centre);
      rad.uniforms.uAuto.value = auto;
      // Coarse pass over the full length, then a fine pass to fill the gaps between taps.
      rad.uniforms.tIn.value = a.texture;
      rad.uniforms.uLen.value = len;
      rad.uniforms.uFalloff.value = true;
      kit.run(rad, b);
      rad.uniforms.tIn.value = b.texture;
      rad.uniforms.uLen.value = len / 40;
      rad.uniforms.uFalloff.value = false;
      kit.run(rad, a);
      const m = material(kit, 'gen-backlight', {
        uniforms: {
          tRays: { value: null },
          uCol: { value: new THREE.Color() },
          uCol2: { value: new THREE.Color() },
          uIntensity: { value: 1 },
        },
        fragmentShader: HEAD + colourFrag,
      });
      m.uniforms.tRays.value = a.texture;
      m.uniforms.uCol.value.copy(C(p, 'color'));
      m.uniforms.uCol2.value.copy(C(p, 'outerColor'));
      m.uniforms.uIntensity.value = N(p, 'intensity') / 100;
      kit.run(m, out);
      kit.release(a);
      kit.release(b);
    });
  },
};

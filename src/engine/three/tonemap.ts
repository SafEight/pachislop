import type * as THREE from 'three';
import type { Comp } from '../../model/types';
import type { PassKit } from '../passkit';

// Tone mapping for 3D layer output. three.js skips tone mapping when rendering into a
// render target, so the renderer resolves its MSAA target through this pass. Operators are
// ported from three's tonemapping_pars_fragment (ACES fitted, AgX, Khronos PBR Neutral);
// 'punch' is ours (below).
// Input and output are premultiplied linear; tone mapping runs on straight colour so
// antialiased edges keep their colour instead of darkening. The optional glint (glint.ts,
// any resolution, sampled bilinearly) is added HDR light: it is summed in before tone
// mapping and raises alpha by its brightness, so glints stand on transparent pixels too.

export const TONEMAP_IDS: Record<Comp['toneMapping'], number> = { none: 0, aces: 1, agx: 2, neutral: 3, punch: 4 };

const FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform sampler2D tGlint;
uniform bool uGlint;
uniform int uMode;
uniform float uExposure;
in vec2 vUv;
out vec4 o;

vec3 RRTAndODTFit(vec3 v) {
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}
vec3 acesFilmic(vec3 color) {
  const mat3 ACESInputMat = mat3(
    vec3(0.59719, 0.07600, 0.02840),
    vec3(0.35458, 0.90834, 0.13383),
    vec3(0.04823, 0.01566, 0.83777));
  const mat3 ACESOutputMat = mat3(
    vec3(1.60475, -0.10208, -0.00327),
    vec3(-0.53108, 1.10813, -0.07276),
    vec3(-0.07367, -0.00605, 1.07602));
  color /= 0.6;
  color = ACESInputMat * color;
  color = RRTAndODTFit(color);
  color = ACESOutputMat * color;
  return clamp(color, 0.0, 1.0);
}

const mat3 LINEAR_REC2020_TO_LINEAR_SRGB = mat3(
  vec3(1.6605, -0.1246, -0.0182),
  vec3(-0.5876, 1.1329, -0.1006),
  vec3(-0.0728, -0.0083, 1.1187));
const mat3 LINEAR_SRGB_TO_LINEAR_REC2020 = mat3(
  vec3(0.6274, 0.0691, 0.0164),
  vec3(0.3293, 0.9195, 0.0880),
  vec3(0.0433, 0.0113, 0.8956));
vec3 agxDefaultContrastApprox(vec3 x) {
  vec3 x2 = x * x;
  vec3 x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}
vec3 agx(vec3 color) {
  const mat3 AgXInsetMatrix = mat3(
    vec3(0.856627153315983, 0.137318972929847, 0.11189821299995),
    vec3(0.0951212405381588, 0.761241990602591, 0.0767994186031903),
    vec3(0.0482516061458583, 0.101439036467562, 0.811302368396859));
  const mat3 AgXOutsetMatrix = mat3(
    vec3(1.1271005818144368, -0.1413297634984383, -0.14132976349843826),
    vec3(-0.11060664309660323, 1.157823702216272, -0.11060664309660294),
    vec3(-0.016493938717834573, -0.016493938717834257, 1.2519364065950405));
  const float AgxMinEv = -12.47393;
  const float AgxMaxEv = 4.026069;
  color = LINEAR_SRGB_TO_LINEAR_REC2020 * color;
  color = AgXInsetMatrix * color;
  color = max(color, 1e-10);
  color = log2(color);
  color = (color - AgxMinEv) / (AgxMaxEv - AgxMinEv);
  color = clamp(color, 0.0, 1.0);
  color = agxDefaultContrastApprox(color);
  color = AgXOutsetMatrix * color;
  color = pow(max(vec3(0.0), color), vec3(2.2));
  color = LINEAR_REC2020_TO_LINEAR_SRGB * color;
  return clamp(color, 0.0, 1.0);
}

vec3 neutral(vec3 color) {
  const float StartCompression = 0.8 - 0.04;
  const float Desaturation = 0.15;
  float x = min(color.r, min(color.g, color.b));
  float offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
  color -= offset;
  float peak = max(color.r, max(color.g, color.b));
  if (peak < StartCompression) return color;
  float d = 1.0 - StartCompression;
  float newPeak = 1.0 - d * d / (peak + d - StartCompression);
  color *= newPeak / peak;
  float g = 1.0 - 1.0 / (Desaturation * (peak - newPeak) + 1.0);
  return mix(color, vec3(newPeak), g);
}

// Punch: hue- and saturation-preserving. The shoulder compresses the pixel's brightest
// channel and every channel is scaled by the same factor, so the RGB ratios (hue and
// saturation) survive: saturated gold and red stay saturated where ACES / AgX / Neutral pull
// them toward grey. Compressing luminance instead would push saturated colours out of gamut
// (a luminance-1 orange needs red > 1) and re-clip them. Toe and shoulder are Neutral's, so
// mid tones match Neutral (the toe's small black-level offset is what keeps Neutral's darks
// clean). Only the very hottest light (peak several × white) blends toward white, so specular
// highlights and glints still read white-hot instead of flat yellow.
vec3 punch(vec3 color) {
  const float Start = 0.8 - 0.04;
  const float HotFrom = 3.0; // peak where the whitening starts…
  const float HotTo = 16.0; // …and where a highlight is fully white
  float x = min(color.r, min(color.g, color.b));
  color -= x < 0.08 ? x - 6.25 * x * x : 0.04;
  float peak = max(color.r, max(color.g, color.b));
  if (peak < Start) return color;
  float d = 1.0 - Start;
  float newPeak = 1.0 - d * d / (peak + d - Start);
  color *= newPeak / peak;
  return mix(color, vec3(newPeak), smoothstep(HotFrom, HotTo, peak));
}

void main() {
  vec4 c = texture(tSrc, vUv);
  if (uGlint) {
    vec3 g = texture(tGlint, vUv).rgb;
    c.rgb += g;
    c.a += (1.0 - c.a) * clamp(max(g.r, max(g.g, g.b)), 0.0, 1.0);
  }
  float a = clamp(c.a, 0.0, 1.0);
  if (a <= 1e-5) { o = vec4(0.0); return; }
  vec3 col = max(c.rgb / a, vec3(0.0)) * uExposure;
  if (uMode == 1) col = acesFilmic(col);
  else if (uMode == 2) col = agx(col);
  else if (uMode == 3) col = neutral(col);
  else if (uMode == 4) col = punch(col);
  o = vec4(col * a, a);
}
`;

export function createTonemapMaterial(kit: PassKit): THREE.ShaderMaterial {
  return kit.shader({
    uniforms: { tSrc: { value: null }, tGlint: { value: null }, uGlint: { value: false }, uMode: { value: 0 }, uExposure: { value: 1 } },
    fragmentShader: FRAG,
    defines: {}, // PassKit forwards `defines: undefined`, which three warns about
  });
}

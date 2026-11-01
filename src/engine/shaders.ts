import * as THREE from 'three';
import type { BlendMode } from '../model/types';
import type { PassKit } from './passkit';

/**
 * How the compositor combines two layers: a layer blend mode, or 'disjoint' (Porter-Duff
 * disjoint over, for stacking runs of a 3D title whose coverage partitions the pixel).
 */
export type Composite = BlendMode | 'disjoint';

export const BLEND_IDS: Record<Composite, number> = { normal: 0, add: 1, screen: 2, multiply: 3, overlay: 4, disjoint: 5 };

/** Separable blend of straight colours `b` (backdrop) and `s` (source) by `uMode` (BLEND_IDS). */
const BLEND_FN = /* glsl */ `
  vec3 blendFn(vec3 b, vec3 s) {
    if (uMode == 1) return b + s;
    if (uMode == 2) return b + s - b * s;
    if (uMode == 3) return b * s;
    if (uMode == 4) return mix(2.0 * b * s, 1.0 - 2.0 * (1.0 - b) * (1.0 - s), step(0.5, b));
    return s;
  }`;

/**
 * `tSrc` over `tDst` with blend `uMode` (BLEND_IDS) and `uOpacity`.
 * tSrc is sampled through uSrcUv (destination uv → source uv) so a cached bitmap can be
 * drawn moved / rotated / scaled; outside the source the layer is empty. uMasked: a clipped
 * node, shown only inside its base's content alpha (tMask).
 */
export function blendMaterial(kit: PassKit): THREE.ShaderMaterial {
  return kit.shader({
    uniforms: {
      tDst: { value: null },
      tSrc: { value: null },
      tMask: { value: null },
      uMasked: { value: false },
      uSrcUv: { value: new THREE.Matrix3() },
      uOpacity: { value: 1 },
      uMode: { value: 0 },
    },
    fragmentShader: /* glsl */ `
      uniform sampler2D tDst, tSrc, tMask; uniform bool uMasked; uniform mat3 uSrcUv; uniform float uOpacity; uniform int uMode;
      in vec2 vUv; out vec4 o;
      ${BLEND_FN}
      void main() {
        vec4 d = texture(tDst, vUv);
        vec2 su = (uSrcUv * vec3(vUv, 1.0)).xy;
        bool inside = all(greaterThanEqual(su, vec2(0.0))) && all(lessThanEqual(su, vec2(1.0)));
        vec4 s = inside ? texture(tSrc, su) * uOpacity : vec4(0.0);
        if (uMasked) s *= texture(tMask, vUv).a;
        if (uMode == 0) { o = s + d * (1.0 - s.a); return; }
        // disjoint over: the backdrop fills only the coverage the source leaves free
        if (uMode == 5) { o = s + d * (d.a > 0.0 ? min(1.0, (1.0 - s.a) / d.a) : 1.0); return; }
        if (uMode == 1) { o = vec4(d.rgb + s.rgb, s.a + d.a - s.a * d.a); return; }
        vec3 cb = d.a > 0.0 ? d.rgb / d.a : vec3(0.0);
        vec3 cs = s.a > 0.0 ? s.rgb / s.a : vec3(0.0);
        vec3 co = s.rgb * (1.0 - d.a) + d.rgb * (1.0 - s.a) + s.a * d.a * blendFn(cb, cs);
        o = vec4(co, s.a + d.a - s.a * d.a);
      }`,
  });
}

/**
 * Adjustment layer: mix(below, blend(below, adjusted), opacity); a clipped adjustment only
 * inside its base's content alpha (tMask), a masked one only where its layer masks show (the
 * red channel of tLayerMask, see masks.ts). Like the adjustments themselves (adjustments.ts) and
 * Photoshop, the mix runs on sRGB-encoded straight colour clamped to 0..1 (Invert at 50 %
 * gives flat mid grey, not a lighter linear-light average); where the mix weight is 0 the
 * backdrop passes through untouched (no clamp). The adjustment layer's effects may change
 * the coverage (a blur softens edges, a wave moves pixels): the alpha mixes from below's to
 * the adjusted one's, the colour mixes premultiplied by those alphas, and adjusted colour
 * with no backdrop under it shows as it is (w: the backdrop's share of its coverage). With
 * the coverage unchanged this is mix(cb, blend(cb, ca), k) at below's alpha.
 */
export function adjustMaterial(kit: PassKit): THREE.ShaderMaterial {
  return kit.shader({
    uniforms: {
      tDst: { value: null },
      tSrc: { value: null },
      tMask: { value: null },
      uMasked: { value: false },
      tLayerMask: { value: null },
      uLayerMasked: { value: false },
      uOpacity: { value: 1 },
      uMode: { value: 0 },
    },
    fragmentShader: /* glsl */ `
      uniform sampler2D tDst, tSrc, tMask, tLayerMask; uniform bool uMasked, uLayerMasked; uniform float uOpacity; uniform int uMode;
      in vec2 vUv; out vec4 o;
      ${BLEND_FN}
      vec3 toSRGB(vec3 c) { c = clamp(c, 0.0, 1.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
      vec3 toLinear(vec3 c) { c = clamp(c, 0.0, 1.0); return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
      void main() {
        vec4 d = texture(tDst, vUv);
        float k = uOpacity * (uMasked ? texture(tMask, vUv).a : 1.0) * (uLayerMasked ? texture(tLayerMask, vUv).r : 1.0);
        vec4 a = texture(tSrc, vUv);
        if (k <= 0.0 || (d.a <= 0.0 && a.a <= 0.0)) { o = d; return; }
        vec3 cb = toSRGB(d.a > 0.0 ? d.rgb / d.a : vec3(0.0));
        vec3 ca = toSRGB(a.a > 0.0 ? a.rgb / a.a : vec3(0.0));
        float w = a.a > 0.0 ? min(1.0, d.a / a.a) : 1.0;
        vec3 cr = mix(ca, blendFn(cb, ca), w);
        float oa = mix(d.a, a.a, k);
        o = oa > 0.0 ? vec4(toLinear(mix(cb * d.a, cr * a.a, k) / oa) * oa, oa) : vec4(0.0);
      }`,
  });
}

/** `tSrc` inside the alpha of `tMask`. */
export function maskMaterial(kit: PassKit): THREE.ShaderMaterial {
  return kit.shader({
    uniforms: { tSrc: { value: null }, tMask: { value: null } },
    fragmentShader: /* glsl */ `
      uniform sampler2D tSrc, tMask; in vec2 vUv; out vec4 o;
      void main() { o = texture(tSrc, vUv) * texture(tMask, vUv).a; }`,
  });
}

/**
 * Linear premultiplied → sRGB. For the canvas we keep premultiplied output; for export
 * we un-premultiply so PNGs carry straight alpha, and for 8-bit output dither before the
 * quantize: amplified low alpha (3D haze, glow tails) bands visibly in 1/255 steps otherwise.
 * The noise stays under half a code, so exact codes (alpha 0 / 1, flat colours) never move.
 * 16-bit export writes a float target undithered and quantizes on readback.
 */
export function outputMaterial(kit: PassKit): THREE.ShaderMaterial {
  return kit.shader({
    uniforms: { tSrc: { value: null }, uUnpremultiply: { value: false }, uDither: { value: true } },
    fragmentShader: /* glsl */ `
      uniform sampler2D tSrc; uniform bool uUnpremultiply, uDither; in vec2 vUv; out vec4 o;
      vec3 toSRGB(vec3 c) {
        c = clamp(c, 0.0, 1.0);
        return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
      }
      // interleaved gradient noise in [0, 1)
      float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
      void main() {
        vec4 c = texture(tSrc, vUv);
        float a = clamp(c.a, 0.0, 1.0);
        vec3 straight = a > 0.0 ? c.rgb / a : vec3(0.0);
        vec3 s = toSRGB(straight);
        if (!uUnpremultiply) { o = vec4(s * a, a); return; }
        if (a > 0.0 && uDither) {
          s += (ign(gl_FragCoord.xy) - 0.5) * (0.98 / 255.0);
          if (a < 1.0) a = clamp(a + (ign(gl_FragCoord.xy + vec2(47.0, 17.0)) - 0.5) * (0.98 / 255.0), 0.0, 1.0);
        }
        o = vec4(s, a);
      }`,
  });
}

/** Flat `uColor` (premultiplied linear). */
export function backgroundMaterial(kit: PassKit): THREE.ShaderMaterial {
  return kit.shader({
    uniforms: { uColor: { value: new THREE.Vector4() } },
    fragmentShader: /* glsl */ `uniform vec4 uColor; in vec2 vUv; out vec4 o; void main() { o = uColor; }`,
  });
}

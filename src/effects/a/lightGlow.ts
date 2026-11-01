import * as THREE from 'three';
import type { EffectContext } from '../../engine/contracts';
import { COMMON_GLSL, pass } from './util';

// Physically motivated light glow (Deep Glow): scattered light with a heavy-tailed point-spread
// function built from Gaussians on a downsampled pyramid, plus the over-exposure colour response
// of a camera. See `deepGlow` in ./glow.ts for the parameters.
//
// PSF: veiling glare / lens bloom fall off close to an inverse power law I(r) ∝ r^-p. A
// scale mixture of unit-energy Gaussians Σ w(σ) G_σ with w ∝ σ^(2-p) per log-σ step equals
// r^-p for σmin ≪ r ≪ σmax, so the octaves sit one octave apart (1.5 in drafts) from σmin =
// 1 comp px up to σmax = Radius / 3 and the weights are normalised to sum 1: unit energy, so
// Radius and Falloff reshape the light without changing how much there is.

/** Falloff 0 % → long haze (p = 1.6) … 100 % → tight (p = 3.2). */
export const P_LONG = 1.6;
export const P_TIGHT = 3.2;
export const falloffExponent = (falloffPct: number) => P_LONG + (P_TIGHT - P_LONG) * Math.min(1, Math.max(0, falloffPct / 100));

/** Smallest octave σ, comp px. */
const SIGMA_MIN = 1;
/** Chromatic scatter at ±100 %: R / G / B PSF radius = 120 / 100 / 80 % (Deep Glow 2 aberration). */
const CHROMA_SPREAD = 0.2;

export interface GlowOctave {
  /** Gaussian σ per channel, render px. */
  sigma: [number, number, number];
  /** Energy weight (sum over octaves = 1). */
  weight: number;
  /** Position of the octave over the radius, 0 = innermost … 1 = outermost (tint gradient). */
  t: number;
}

/**
 * The PSF as octaves. `radius` comp px (the glow reach; top octave σ = radius / 3), `p` the
 * power-law exponent, `chroma` −1..1 (+ widens red / narrows blue), `step` octaves between
 * Gaussians (1, or 1.5 for drafts: fewer passes, ≤ ~20 % ripple on the power law), `pxScale` render px per comp px.
 */
export function psfOctaves(radius: number, p: number, chroma: number, step: number, pxScale: number): GlowOctave[] {
  const sMax = Math.max(SIGMA_MIN, radius / 3);
  const span = Math.log2(sMax / SIGMA_MIN);
  const n = Math.max(1, Math.ceil(span / step - 1e-6) + 1);
  const d = n > 1 ? span / (n - 1) : 0;
  const k = CHROMA_SPREAD * Math.max(-1, Math.min(1, chroma));
  const scale: [number, number, number] = [1 + k, 1, 1 - k];
  const out: GlowOctave[] = [];
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const s = SIGMA_MIN * 2 ** (i * d);
    const weight = s ** (2 - p);
    sum += weight;
    const sr = s * pxScale;
    out.push({ sigma: [sr * scale[0], sr * scale[1], sr * scale[2]], weight, t: n > 1 ? i / (n - 1) : 0 });
  }
  for (const o of out) o.weight /= sum;
  return out;
}

// ---------- GPU ----------

const rts = new Map<string, THREE.WebGLRenderTarget>();

function rt(key: string, w: number, h: number) {
  let t = rts.get(key);
  if (!t) {
    t = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
    });
    rts.set(key, t);
  } else if (t.width !== w || t.height !== h) t.setSize(w, h);
  return t;
}

export function disposeLightGlow() {
  for (const t of rts.values()) t.dispose();
  rts.clear();
}

/** Shared by the emission and final passes: the part of the light above the threshold. */
const EMIT_GLSL = /* glsl */ `
uniform float uThresh, uKnee;
// Fraction of a pixel's light above the luminance threshold, soft knee of width uKnee
// (quadratic toe, then linear): the threshold is subtracted, so only the excess emits.
float emitFraction(vec4 L) {
  if (uThresh <= 0.0) return 1.0;
  float b = luma(unpremul(L));
  float x = b - uThresh;
  float e = x;
  if (uKnee > 1e-4) { float q = clamp(x + uKnee, 0.0, 2.0 * uKnee); e = max(x, q * q / (4.0 * uKnee)); }
  return max(e, 0.0) / max(b, 1e-4);
}
// Replace chroma, keep the brightest channel (a saturated colour keeps its full strength).
vec3 colorize(vec3 c, vec3 t) { return max(c.r, max(c.g, c.b)) * t / max(max(t.r, max(t.g, t.b)), 1e-4); }
`;

// Emitter = layer light above the threshold × 2^exposure (premultiplied, so AA edges emit their share).
const emitFrag = /* glsl */ `
uniform sampler2D tSrc; uniform float uGain; uniform bool uCustom; uniform vec3 uColor;
${EMIT_GLSL}
void main() {
  vec4 L = texture(tSrc, vUv);
  vec3 e = L.rgb * emitFraction(L) * uGain;
  if (uCustom) e = colorize(e, uColor);
  o = vec4(max(e, 0.0), 0.0);
}`;

// 2× reduction: four bilinear taps landing on the four source texels (a 2×2 box when the size halves exactly).
const downFrag = /* glsl */ `
uniform sampler2D tSrc; uniform vec2 uSrcTexel;
void main() {
  vec2 h = 0.5 * uSrcTexel;
  o = 0.25 * (texture(tSrc, vUv + vec2(-h.x, -h.y)) + texture(tSrc, vUv + vec2(h.x, -h.y)) +
              texture(tSrc, vUv + vec2(-h.x, h.y)) + texture(tSrc, vUv + vec2(h.x, h.y)));
}`;

// One axis of a Gaussian with a σ per channel (chromatic scatter); zero outside the frame, so
// light leaves the picture instead of piling up at its edges.
const blurFrag = /* glsl */ `
uniform sampler2D tSrc; uniform vec2 uDir; uniform vec3 uSigma; uniform int uTaps;
void main() {
  vec3 k = 0.5 / max(uSigma * uSigma, vec3(1e-4));
  vec3 acc = vec3(0.0), ws = vec3(0.0);
  for (int i = -48; i <= 48; i++) {
    if (i < -uTaps || i > uTaps) continue;
    float f = float(i);
    vec3 w = exp(-f * f * k);
    ws += w;
    vec2 uv = vUv + uDir * f;
    if (uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0) acc += texture(tSrc, uv).rgb * w;
  }
  o = vec4(acc / ws, 0.0);
}`;

// acc += weight ⊙ (octave, tinted toward the inner→outer tint at its radius).
const accumFrag = /* glsl */ `
uniform sampler2D tOct; uniform vec3 uTint; uniform float uWeight, uTintAmt;
${EMIT_GLSL}
void main() {
  vec3 c = texture(tOct, vUv).rgb;
  if (uTintAmt > 0.0) c = mix(c, colorize(c, uTint), uTintAmt);
  o = vec4(c * uWeight, 0.0);
}`;

const accumMats = new WeakMap<object, THREE.ShaderMaterial>();

function accumMaterial(ctx: EffectContext) {
  let m = accumMats.get(ctx.kit);
  if (!m) {
    m = ctx.kit.shader({
      uniforms: {
        uRes: { value: [1, 1] },
        uPx: { value: 1 },
        tOct: { value: null },
        uWeight: { value: 0 },
        uTint: { value: new THREE.Color() },
        uTintAmt: { value: 0 },
        uThresh: { value: 0 },
        uKnee: { value: 0 },
      },
      fragmentShader: COMMON_GLSL + accumFrag,
      blending: THREE.CustomBlending,
    });
    m.blendEquation = THREE.AddEquation;
    m.blendSrc = THREE.OneFactor;
    m.blendDst = THREE.OneFactor;
    m.blendSrcAlpha = THREE.OneFactor;
    m.blendDstAlpha = THREE.OneFactor;
    accumMats.set(ctx.kit, m);
  }
  return m;
}

export interface ScatterOptions {
  /** Exposure gain 2^stops. */
  gain: number;
  threshold: number;
  knee: number;
  /** Custom glow colour (linear), or null for the layer's own colours. */
  color: THREE.Color | null;
  octaves: GlowOctave[];
  /** Energy scattered into the glow. */
  intensity: number;
  tintInner: THREE.Color;
  tintOuter: THREE.Color;
  tintAmount: number;
}

/**
 * Variance (render px²) the pyramid adds at level l: l 2×2 box reductions (level j adds
 * ¼ · (2^(j−1))², summing to (4^l − 1) / 12), then the bilinear upsample (a tent, 4^l / 6).
 */
const levelVariance = (l: number) => (l === 0 ? 0 : (4 ** l - 1) / 12 + 4 ** l / 6);

/**
 * Scattered light of `input` (PSF ⊗ emitter × intensity) added into `acc` (full render size,
 * cleared here). RGB only; alpha stays 0.
 */
export function scatterLight(ctx: EffectContext, input: THREE.Texture, acc: THREE.WebGLRenderTarget, o: ScatterOptions) {
  const { kit, width, height } = ctx;
  kit.clear(acc);
  const emit = kit.acquire();
  pass(
    ctx,
    'lightGlowEmit',
    emitFrag,
    { tSrc: input, uGain: o.gain, uThresh: o.threshold, uKnee: o.knee, uCustom: o.color !== null, uColor: o.color ?? new THREE.Color(1, 1, 1) },
    emit,
  );
  // Pyramid level per octave: the coarsest whose texels keep the narrowest channel σ ≥ 2 texels.
  const levels = o.octaves.map((oc) => {
    let l = 0;
    while (Math.min(...oc.sigma) / 2 ** (l + 1) >= 2 && Math.ceil(Math.min(width, height) / 2 ** (l + 1)) >= 4) l++;
    return l;
  });
  const top = Math.max(0, ...levels);
  const pyr: THREE.Texture[] = [emit.texture];
  let w = width;
  let h = height;
  for (let l = 1; l <= top; l++) {
    const sw = w;
    const sh = h;
    w = Math.ceil(w / 2);
    h = Math.ceil(h / 2);
    const t = rt(`lg-pyr-${l}`, w, h);
    pass(ctx, 'lightGlowDown', downFrag, { tSrc: pyr[l - 1], uSrcTexel: [1 / sw, 1 / sh] }, t);
    pyr.push(t.texture);
  }
  const m = accumMaterial(ctx);
  o.octaves.forEach((oc, i) => {
    const l = levels[i];
    const f = 2 ** l;
    const lw = Math.max(1, Math.ceil(width / f));
    const lh = Math.max(1, Math.ceil(height / f));
    // Blur left to do at this level so the total variance is σ² per channel.
    const s = oc.sigma.map((v) => Math.sqrt(Math.max(0, v * v - levelVariance(l))) / f) as [number, number, number];
    const taps = Math.min(48, Math.ceil(3 * Math.max(...s)));
    const tmp = rt(`lg-tmp-${l}`, lw, lh);
    const oct = rt(`lg-oct-${i}`, lw, lh);
    pass(ctx, 'lightGlowBlur', blurFrag, { tSrc: pyr[l], uDir: [1 / lw, 0], uSigma: s, uTaps: taps }, tmp);
    pass(ctx, 'lightGlowBlur', blurFrag, { tSrc: tmp.texture, uDir: [0, 1 / lh], uSigma: s, uTaps: taps }, oct);
    const wgt = oc.weight * o.intensity;
    m.uniforms.tOct.value = oct.texture;
    m.uniforms.uWeight.value = wgt;
    m.uniforms.uTint.value.copy(o.tintInner).lerp(o.tintOuter, oc.t);
    m.uniforms.uTintAmt.value = o.tintAmount;
    kit.run(m, acc, false);
  });
  kit.release(emit);
}

/**
 * Final composite: direct light of the layer (its emitting part × 2^exposure) + the scattered
 * glow (kept off the face by `onFace`), through the over-exposure colour response, with alpha
 * encoding the added light for transparent export.
 *
 * Over-exposure response (`uShift` h, `uWhite` w), on HDR light x. Exactly the identity for every
 * channel ≤ 1 that nothing pushed up: adding the glow never dims or recolours the layer itself.
 *   bleed(e) = ½ (e.g, e.r + e.b, e.g)        excess spills into its spectral neighbours (R↔G↔B)
 *            + ½ w (e.b, 0, e.r)               and, by Core whiteness, straight into the far channel
 *   e₀ = max(x − 1, 0)                         light past each channel's clip
 *   x₁ = x + h · bleed(e₀)
 *   x₂ = x + h · bleed(max(x₁ − 1, 0))        second step: a neighbour pushed past its clip spills on,
 *                                              so blue → cyan → white, red → orange → yellow → white
 *   y  = min(x₂, 1) + ½ (1 − e^−2·max(x₂ − 1, 0)) per channel: identity up to 1, then a soft
 *                                              roll-off to 1.5 (the display clips at 1, where the
 *                                              bleed takes over: the others catch up to white)
 *   out = x + (y − x) · smoothstep(0, 0.25, h)
 */
export const lightGlowComposeFrag = /* glsl */ `
uniform sampler2D tSrc, tGlow; uniform float uGain, uOnFace, uShift, uWhite;
${EMIT_GLSL}
vec3 shoulder(vec3 x) { return min(x, 1.0) + 0.5 * (1.0 - exp(-2.0 * max(x - 1.0, 0.0))); }
vec3 bleed(vec3 e) { return 0.5 * vec3(e.g, e.r + e.b, e.g) + 0.5 * uWhite * vec3(e.b, 0.0, e.r); }
vec3 overexpose(vec3 x) {
  vec3 x1 = x + uShift * bleed(max(x - 1.0, 0.0));
  vec3 x2 = x + uShift * bleed(max(x1 - 1.0, 0.0));
  // x + (y − x)·k, not mix(): stays bit-exact where y == x.
  return x + (shoulder(x2) - x) * smoothstep(0.0, 0.25, uShift);
}
void main() {
  vec4 L = texture(tSrc, vUv);
  vec3 g = texture(tGlow, vUv).rgb * (1.0 - (1.0 - uOnFace) * L.a);
  vec3 direct = L.rgb * (1.0 + emitFraction(L) * (uGain - 1.0));
  vec3 c = overexpose(max(direct + g, 0.0));
  float la = clamp(max(max(c.r, c.g), c.b), 0.0, 1.0);
  o = vec4(c, max(L.a, la));
}`;

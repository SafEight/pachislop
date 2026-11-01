import * as THREE from 'three';
import { hexToRgb } from '../model/gradient';
import type { AdjustChannel, Adjustment, LevelsChannel } from '../model/types';
import { bakeCurve, curvePoints } from './layer2d/contours';
import type { PassKit } from './passkit';

// Photoshop adjustment layers on the GPU. Every pass reads a premultiplied linear target (the
// PassKit convention), unpremultiplies, clamps to 0..1 and sRGB-encodes (Photoshop adjusts the
// encoded 8-bit document values, and the final output clips at 1 anyway), applies the
// Photoshop formula, decodes and premultiplies again with the alpha unchanged.
//
// Tone-curve types (Brightness/Contrast, Levels, Curves) are baked on the CPU into one 256-entry
// RGBA lookup (R, G, B = the red, green, blue output for each input level), like Photoshop's own
// 8-bit transfer tables; the others are closed-form in GLSL.

const LUT_SIZE = 256;

const HEAD = /* glsl */ `
uniform sampler2D tSrc;
in vec2 vUv;
out vec4 o;
vec3 toSRGB(vec3 c) { c = max(c, 0.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
vec3 toLinear(vec3 c) { c = max(c, 0.0); return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
// Photoshop's luminosity (Luminosity / Color blend modes; Lum() of the PDF blend-mode spec).
float lum(vec3 c) { return dot(c, vec3(0.3, 0.59, 0.11)); }
vec3 clipColor(vec3 c) {
  float l = lum(c);
  float n = min(c.r, min(c.g, c.b));
  float x = max(c.r, max(c.g, c.b));
  if (n < 0.0) c = l + (c - l) * l / max(l - n, 1e-6);
  if (x > 1.0) c = l + (c - l) * (1.0 - l) / max(x - l, 1e-6);
  return c;
}
// SetLum() of the PDF spec: c's hue and saturation with luminosity l (the Color blend mode).
vec3 setLum(vec3 c, float l) { return clipColor(c + (l - lum(c))); }
vec3 rgb2hsl(vec3 c) {
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
  float l = (mx + mn) * 0.5;
  float d = mx - mn;
  if (d < 1e-6) return vec3(0.0, 0.0, l);
  float s = l < 0.5 ? d / (mx + mn) : d / (2.0 - mx - mn);
  float h;
  if (mx == c.r) h = (c.g - c.b) / d + (c.g < c.b ? 6.0 : 0.0);
  else if (mx == c.g) h = (c.b - c.r) / d + 2.0;
  else h = (c.r - c.g) / d + 4.0;
  return vec3(h / 6.0, s, l);
}
float hueChannel(float p, float q, float t) {
  t = fract(t);
  if (t < 1.0 / 6.0) return p + (q - p) * 6.0 * t;
  if (t < 0.5) return q;
  if (t < 2.0 / 3.0) return p + (q - p) * (2.0 / 3.0 - t) * 6.0;
  return p;
}
vec3 hsl2rgb(vec3 h) {
  if (h.y <= 0.0) return vec3(h.z);
  float q = h.z < 0.5 ? h.z * (1.0 + h.y) : h.z + h.y - h.z * h.y;
  float p = 2.0 * h.z - q;
  return vec3(hueChannel(p, q, h.x + 1.0 / 3.0), hueChannel(p, q, h.x), hueChannel(p, q, h.x - 1.0 / 3.0));
}
// Texel centre of 8-bit level x (0..1) in a 256-wide lookup texture.
float lutU(float x) { return x * (255.0 / 256.0) + 0.5 / 256.0; }
`;

const MAIN = /* glsl */ `
void main() {
  vec4 s = texture(tSrc, vUv);
  if (s.a <= 0.0) { o = vec4(0.0); return; }
  vec3 c = toSRGB(clamp(s.rgb / s.a, 0.0, 1.0));
  c = clamp(adjust(c), 0.0, 1.0);
  o = vec4(toLinear(c) * s.a, s.a);
}`;

/** `vec3 adjust(vec3 c)` bodies on sRGB-encoded straight colour 0..1, one per shader. */
const BODIES = {
  lut: /* glsl */ `
uniform sampler2D tLut;
vec3 adjust(vec3 c) {
  return vec3(texture(tLut, vec2(lutU(c.r), 0.5)).r, texture(tLut, vec2(lutU(c.g), 0.5)).g, texture(tLut, vec2(lutU(c.b), 0.5)).b);
}`,
  // Adobe: Exposure "performs calculations in a linear color space (gamma 1.0)": exposure scales,
  // offset adds, gamma is a plain power; all on linear light.
  exposure: /* glsl */ `
uniform float uExposure, uOffset, uGamma;
vec3 adjust(vec3 c) {
  vec3 l = clamp(toLinear(c) * exp2(uExposure) + uOffset, 0.0, 1.0);
  return toSRGB(pow(l, vec3(1.0 / uGamma)));
}`,
  // Chroma scaled around the luminosity; Vibrance weights the boost by how unsaturated the
  // colour already is, and both stop where a channel would clip (Photoshop's Vibrance and its
  // Saturation slider never clip, unlike Hue/Saturation's).
  vibrance: /* glsl */ `
uniform float uVibrance, uSaturation;
// Largest chroma scale <= k keeping every channel of l + (c - l) * k inside 0..1.
float fitScale(vec3 c, float l, float k) {
  vec3 d = c - l;
  float m = k;
  for (int i = 0; i < 3; i++) {
    if (d[i] > 1e-6) m = min(m, (1.0 - l) / d[i]);
    else if (d[i] < -1e-6) m = min(m, -l / d[i]);
  }
  return m;
}
vec3 scaleChroma(vec3 c, float k) {
  float l = lum(c);
  return l + (c - l) * (k > 1.0 ? fitScale(c, l, k) : k);
}
vec3 adjust(vec3 c) {
  float sat = max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b));
  c = scaleChroma(c, 1.0 + uVibrance * (1.0 - sat));
  return scaleChroma(c, 1.0 + uSaturation);
}`,
  // Hue rotates in HSL. Saturation is the widely published reverse-engineering of Photoshop's
  // (scale around HSL lightness; +100 drives the colour to full HSL saturation, -100 to the
  // HSL-lightness grey). Lightness blends toward white / black (±100 = white / black).
  // Colorize: HSL(hue, saturation, the pixel's luminosity).
  hueSaturation: /* glsl */ `
uniform float uHue, uSat, uLight;
uniform bool uColorize;
vec3 adjust(vec3 c) {
  if (uColorize) {
    c = hsl2rgb(vec3(uHue, uSat, lum(c)));
  } else {
    vec3 h = rgb2hsl(c);
    h.x = fract(h.x + uHue);
    c = hsl2rgb(h);
    float mx = max(c.r, max(c.g, c.b));
    float mn = min(c.r, min(c.g, c.b));
    float d = mx - mn;
    if (d > 1e-6) {
      float v = mx + mn;
      float L = v * 0.5;
      float S = L < 0.5 ? d / v : d / (2.0 - v);
      if (uSat >= 0.0) {
        float a = uSat + S >= 1.0 ? S : 1.0 - uSat;
        c = c + (c - L) * (1.0 / a - 1.0);
      } else {
        c = L + (c - L) * (1.0 + uSat);
      }
    }
  }
  return uLight >= 0.0 ? c + (1.0 - c) * uLight : c * (1.0 + uLight);
}`,
  // Color Balance acts like a Curves adjustment per channel (Preserve Luminosity off) that
  // never moves pure black or pure white: each range adds a bump to the channel's own value,
  // peaking at 1/3 (shadows), 1/2 (midtones) and 2/3 (highlights). ±100 moves the midtone peak by
  // ±0.2 and the shadow / highlight peaks by ±0.14, the most that keeps each curve monotone.
  // Preserve Luminosity puts the original luminosity back (Color blend), so only the hue moves.
  colorBalance: /* glsl */ `
uniform vec3 uShadows, uMidtones, uHighlights;
uniform bool uPreserve;
vec3 adjust(vec3 c) {
  vec3 s = 6.75 * c * (1.0 - c) * (1.0 - c);
  vec3 m = 4.0 * c * (1.0 - c);
  vec3 h = 6.75 * c * c * (1.0 - c);
  vec3 r = clamp(c + uShadows * 0.14 * s + uMidtones * 0.2 * m + uHighlights * 0.14 * h, 0.0, 1.0);
  return uPreserve ? setLum(r, lum(c)) : r;
}`,
  // Photoshop Black & White: grey = min + (mid - min) * secondary + (max - mid) * primary, where
  // primary is the weight of the largest channel (Reds / Greens / Blues) and secondary that of
  // the two largest together (Yellows / Cyans / Magentas). Pure red → Reds %, yellow → Yellows %.
  // Tint: the tint colour at that grey's luminosity (Color blend).
  blackWhite: /* glsl */ `
uniform float uReds, uYellows, uGreens, uCyans, uBlues, uMagentas;
uniform bool uTint;
uniform vec3 uTintColor;
vec3 adjust(vec3 c) {
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
  float md = c.r + c.g + c.b - mx - mn;
  float wp, ws;
  if (c.r >= c.g && c.r >= c.b) { wp = uReds; ws = c.g >= c.b ? uYellows : uMagentas; }
  else if (c.g >= c.b) { wp = uGreens; ws = c.r >= c.b ? uYellows : uCyans; }
  else { wp = uBlues; ws = c.r >= c.g ? uMagentas : uCyans; }
  float g = clamp(mn + (md - mn) * ws + (mx - md) * wp, 0.0, 1.0);
  return uTint ? setLum(uTintColor, g) : vec3(g);
}`,
  // A coloured filter multiplies the light by its colour; Density mixes it in; Preserve
  // Luminosity puts the original luminosity back (Color blend), so the filter only tints.
  photoFilter: /* glsl */ `
uniform vec3 uColor;
uniform float uDensity;
uniform bool uPreserve;
vec3 adjust(vec3 c) {
  vec3 r = mix(c, c * uColor, uDensity);
  return uPreserve ? setLum(r, lum(c)) : r;
}`,
  // The gradient replaces each pixel by its luminosity (left stop = shadows); opacity stops
  // let the original show through.
  gradientMap: /* glsl */ `
uniform sampler2D tGrad;
uniform bool uReverse;
vec3 adjust(vec3 c) {
  float l = clamp(lum(c), 0.0, 1.0);
  vec4 g = texture(tGrad, vec2(lutU(uReverse ? 1.0 - l : l), 0.5));
  return mix(c, toSRGB(g.rgb), g.a);
}`,
  invert: /* glsl */ `
vec3 adjust(vec3 c) { return 1.0 - c; }`,
  // Photoshop on 8-bit levels: index = floor(v * n / 256), output = round(index * 255 / (n - 1)).
  posterize: /* glsl */ `
uniform float uLevels;
vec3 adjust(vec3 c) {
  vec3 i = floor(floor(c * 255.0 + 0.5) * uLevels / 256.0);
  return floor(i * 255.0 / (uLevels - 1.0) + 0.5) / 255.0;
}`,
  // White where the 8-bit luminosity is at or above the level, black below.
  threshold: /* glsl */ `
uniform float uLevel;
vec3 adjust(vec3 c) { return vec3(step(uLevel, floor(lum(c) * 255.0 + 0.5))); }`,
} as const;

type ShaderName = keyof typeof BODIES;

interface KitState {
  mats: Map<ShaderName, THREE.ShaderMaterial>;
  /** Shared tone lookup, re-uploaded when an adjustment with different settings runs. */
  lut: THREE.DataTexture;
  lutKey: string;
}

const kits = new WeakMap<PassKit, KitState>();

function kitState(kit: PassKit): KitState {
  let s = kits.get(kit);
  if (!s) {
    const lut = new THREE.DataTexture(new Uint16Array(LUT_SIZE * 4), LUT_SIZE, 1, THREE.RGBAFormat, THREE.HalfFloatType);
    lut.minFilter = THREE.LinearFilter;
    lut.magFilter = THREE.LinearFilter;
    lut.wrapS = THREE.ClampToEdgeWrapping;
    lut.wrapT = THREE.ClampToEdgeWrapping;
    s = { mats: new Map(), lut, lutKey: '' };
    kits.set(kit, s);
  }
  return s;
}

const UNIFORMS: Record<ShaderName, string[]> = {
  lut: ['tLut'],
  exposure: ['uExposure', 'uOffset', 'uGamma'],
  vibrance: ['uVibrance', 'uSaturation'],
  hueSaturation: ['uHue', 'uSat', 'uLight', 'uColorize'],
  colorBalance: ['uShadows', 'uMidtones', 'uHighlights', 'uPreserve'],
  blackWhite: ['uReds', 'uYellows', 'uGreens', 'uCyans', 'uBlues', 'uMagentas', 'uTint', 'uTintColor'],
  photoFilter: ['uColor', 'uDensity', 'uPreserve'],
  gradientMap: ['tGrad', 'uReverse'],
  invert: [],
  posterize: ['uLevels'],
  threshold: ['uLevel'],
};

function material(kit: PassKit, name: ShaderName): THREE.ShaderMaterial {
  const s = kitState(kit);
  let m = s.mats.get(name);
  if (!m) {
    const uniforms: Record<string, THREE.IUniform> = { tSrc: { value: null } };
    for (const u of UNIFORMS[name]) uniforms[u] = { value: null };
    m = kit.shader({ uniforms, fragmentShader: HEAD + BODIES[name] + MAIN });
    s.mats.set(name, m);
  }
  return m;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

// ---------- tone curves (CPU) ----------

/** Photoshop Levels on one 0..1 level: input range → gamma (v^(1/γ), γ > 1 lightens) → output range. */
function levelsFn(ch: LevelsChannel): (x: number) => number {
  const lo = ch.inBlack / 255;
  const hi = Math.max(ch.inWhite, ch.inBlack + 1) / 255;
  const g = Math.max(0.01, ch.gamma);
  return (x) => (ch.outBlack + clamp01((x - lo) / (hi - lo)) ** (1 / g) * (ch.outWhite - ch.outBlack)) / 255;
}

/**
 * Modern (non-legacy) Brightness/Contrast. Adobe documents only its behaviour: unlike Legacy it
 * never clips, keeping black and white put, and acts like a Curves move. Brightness is a midtone
 * power curve (+150 ≈ γ 2.5, −150 ≈ γ 0.4); Contrast an S-curve pivoting on 50 % grey whose
 * midtone slope is 1 + contrast/100 (Photoshop pivots on the image mean, which would make the
 * result depend on content outside the layer, so a fixed pivot is used).
 */
function brightnessContrastFn(brightness: number, contrast: number): (x: number) => number {
  const b = brightness / 100;
  const e = b >= 0 ? 1 / (1 + b) : 1 - b;
  const k = Math.max(0.05, 1 + contrast / 100);
  return (x) => {
    const y = clamp01(x) ** e;
    return y < 0.5 ? 0.5 * (2 * y) ** k : 1 - 0.5 * (2 * (1 - y)) ** k;
  };
}

/**
 * The tone lookup of a tone-curve adjustment: 256 RGBA entries, channel c of entry i = output of
 * channel c for input level i / 255.
 */
function bakeToneLut(adj: Extract<Adjustment, { type: 'brightnessContrast' | 'levels' | 'curves' }>): Float32Array {
  const out = new Float32Array(LUT_SIZE * 4);
  const x = (i: number) => i / (LUT_SIZE - 1);
  if (adj.type === 'brightnessContrast') {
    const f = brightnessContrastFn(adj.brightness, adj.contrast);
    for (let i = 0; i < LUT_SIZE; i++) out.fill(f(x(i)), i * 4, i * 4 + 3);
  } else if (adj.type === 'levels') {
    // Composite first, then each channel's own levels.
    const rgb = levelsFn(adj.channels.rgb);
    const per = [levelsFn(adj.channels.r), levelsFn(adj.channels.g), levelsFn(adj.channels.b)];
    for (let i = 0; i < LUT_SIZE; i++) {
      const v = rgb(x(i));
      for (let c = 0; c < 3; c++) out[i * 4 + c] = clamp01(per[c](v));
    }
  } else {
    // Photoshop applies each channel's curve, then the composite (RGB) curve on its result.
    const rgb = bakeCurve(adj.channels.rgb, LUT_SIZE);
    const per = [bakeCurve(adj.channels.r, LUT_SIZE), bakeCurve(adj.channels.g, LUT_SIZE), bakeCurve(adj.channels.b, LUT_SIZE)];
    const at = (lut: Float32Array, v: number) => {
      const p = clamp01(v) * (LUT_SIZE - 1);
      const i = Math.min(LUT_SIZE - 2, Math.floor(p));
      return lut[i] + (lut[i + 1] - lut[i]) * (p - i);
    };
    for (let i = 0; i < LUT_SIZE; i++) for (let c = 0; c < 3; c++) out[i * 4 + c] = at(rgb, per[c][i]);
  }
  for (let i = 0; i < LUT_SIZE; i++) out[i * 4 + 3] = 1;
  return out;
}

function toneLut(kit: PassKit, adj: Extract<Adjustment, { type: 'brightnessContrast' | 'levels' | 'curves' }>): THREE.DataTexture {
  const s = kitState(kit);
  const key = JSON.stringify(adj);
  if (key !== s.lutKey) {
    const data = s.lut.image.data as Uint16Array;
    bakeToneLut(adj).forEach((v, i) => (data[i] = THREE.DataUtils.toHalfFloat(v)));
    s.lut.needsUpdate = true;
    s.lutKey = key;
  }
  return s.lut;
}

// ---------- public API ----------

/**
 * Apply `adj` to `src` into `target` (both premultiplied linear, PassKit convention; `target`
 * must not be `src`'s target). Alpha passes through unchanged. Shared by adjustment layers and
 * the Adjust effect. Never for identity adjustments (adjustmentIsIdentity), `effectsOnly` included.
 */
export function applyAdjustment(kit: PassKit, src: THREE.Texture, adj: Adjustment, target: THREE.WebGLRenderTarget): void {
  let name: ShaderName;
  const u: Record<string, unknown> = {};
  switch (adj.type) {
    case 'brightnessContrast':
    case 'levels':
    case 'curves':
      name = 'lut';
      u.tLut = toneLut(kit, adj);
      break;
    case 'exposure':
      name = 'exposure';
      u.uExposure = adj.exposure;
      u.uOffset = adj.offset;
      u.uGamma = Math.max(0.01, adj.gamma);
      break;
    case 'vibrance':
      name = 'vibrance';
      u.uVibrance = adj.vibrance / 100;
      u.uSaturation = adj.saturation / 100;
      break;
    case 'hueSaturation':
      name = 'hueSaturation';
      u.uHue = (((adj.hue / 360) % 1) + 1) % 1;
      // Colorize saturation is Photoshop's 0..100 colour saturation; otherwise a −1..1 change.
      u.uSat = adj.colorize ? clamp01(adj.saturation / 100) : adj.saturation / 100;
      u.uLight = adj.lightness / 100;
      u.uColorize = adj.colorize;
      break;
    case 'colorBalance': {
      name = 'colorBalance';
      const v = (r: { cyanRed: number; magentaGreen: number; yellowBlue: number }) => new THREE.Vector3(r.cyanRed / 100, r.magentaGreen / 100, r.yellowBlue / 100);
      u.uShadows = v(adj.shadows);
      u.uMidtones = v(adj.midtones);
      u.uHighlights = v(adj.highlights);
      u.uPreserve = adj.preserveLuminosity;
      break;
    }
    case 'blackWhite':
      name = 'blackWhite';
      u.uReds = adj.reds / 100;
      u.uYellows = adj.yellows / 100;
      u.uGreens = adj.greens / 100;
      u.uCyans = adj.cyans / 100;
      u.uBlues = adj.blues / 100;
      u.uMagentas = adj.magentas / 100;
      u.uTint = adj.tint;
      u.uTintColor = new THREE.Vector3(...hexToRgb(adj.tintColor)); // sRGB-encoded, like the shader's colour
      break;
    case 'photoFilter':
      name = 'photoFilter';
      u.uColor = new THREE.Vector3(...hexToRgb(adj.color)); // sRGB-encoded, like the shader's colour
      u.uDensity = clamp01(adj.density / 100);
      u.uPreserve = adj.preserveLuminosity;
      break;
    case 'gradientMap':
      name = 'gradientMap';
      u.tGrad = kit.gradientTexture(adj.gradient);
      u.uReverse = adj.reverse;
      break;
    case 'invert':
      name = 'invert';
      break;
    case 'posterize':
      name = 'posterize';
      u.uLevels = Math.min(255, Math.max(2, Math.round(adj.levels)));
      break;
    case 'threshold':
      name = 'threshold';
      u.uLevel = Math.min(255, Math.max(1, Math.round(adj.level)));
      break;
    case 'effectsOnly':
      throw new Error('effectsOnly adjustments are identity: the engine never applies them');
  }
  const m = material(kit, name);
  m.uniforms.tSrc.value = src;
  for (const k of UNIFORMS[name]) m.uniforms[k].value = u[k];
  kit.run(m, target);
}

const CHANNELS: readonly AdjustChannel[] = ['rgb', 'r', 'g', 'b'];

/** True when `adj` leaves every pixel as it is (the engine skips the pass). */
export function adjustmentIsIdentity(adj: Adjustment): boolean {
  switch (adj.type) {
    case 'brightnessContrast':
      return adj.brightness === 0 && adj.contrast === 0;
    case 'levels':
      return CHANNELS.every((c) => {
        const ch = adj.channels[c];
        return ch.inBlack === 0 && ch.inWhite === 255 && ch.gamma === 1 && ch.outBlack === 0 && ch.outWhite === 255;
      });
    case 'curves':
      // Points on the diagonal give the straight identity spline (curvePoints adds the endpoints).
      return CHANNELS.every((c) => curvePoints(adj.channels[c]).every((p) => Math.abs(p.y - p.x) < 1e-4));
    case 'exposure':
      return adj.exposure === 0 && adj.offset === 0 && adj.gamma === 1;
    case 'vibrance':
      return adj.vibrance === 0 && adj.saturation === 0;
    case 'hueSaturation':
      return !adj.colorize && adj.hue % 360 === 0 && adj.saturation === 0 && adj.lightness === 0;
    case 'colorBalance':
      return [adj.shadows, adj.midtones, adj.highlights].every((r) => r.cyanRed === 0 && r.magentaGreen === 0 && r.yellowBlue === 0);
    case 'photoFilter':
      return adj.density === 0;
    case 'effectsOnly':
      return true;
    case 'blackWhite':
    case 'gradientMap':
    case 'invert':
    case 'posterize':
    case 'threshold':
      return false;
  }
}

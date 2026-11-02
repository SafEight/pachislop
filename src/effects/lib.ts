import * as THREE from 'three';
import type { PassContext } from '../engine/contracts';
import { centreX, centreY } from '../engine/frame';
import type { PassKit } from '../engine/passkit';
import type { Bounds } from '../text/layout';

// Shared GPU helpers for effects. Results are private RTs owned by this module and
// stay valid until the next call of the same helper, so consume them before calling again
// (or copy into a kit.acquire() target).

// ---------- private RT cache (sizes other than the pool's) ----------

const cache = new Map<string, THREE.WebGLRenderTarget>();

function rt(key: string, w: number, h: number, type: THREE.TextureDataType = THREE.HalfFloatType) {
  const k = `${key}:${type}`;
  let t = cache.get(k);
  if (!t) {
    t = new THREE.WebGLRenderTarget(w, h, {
      type,
      format: THREE.RGBAFormat,
      minFilter: type === THREE.FloatType ? THREE.NearestFilter : THREE.LinearFilter,
      magFilter: type === THREE.FloatType ? THREE.NearestFilter : THREE.LinearFilter,
      depthBuffer: false,
    });
    cache.set(k, t);
  } else if (t.width !== w || t.height !== h) t.setSize(w, h);
  return t;
}

const mats = new WeakMap<PassKit, Record<string, THREE.ShaderMaterial>>();

function mat(kit: PassKit, name: string, make: () => THREE.ShaderMaterial) {
  let m = mats.get(kit);
  if (!m) mats.set(kit, (m = {}));
  return (m[name] ??= make());
}

// ---------- GLSL chunks ----------

/** Value noise, fbm and hash. Paste into fragment shaders. */
export const NOISE_GLSL = /* glsl */ `
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 hash22(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = p * 2.03 + 17.1; a *= 0.5; } return s; }
`;

/** sRGB→linear for colours passed as uniforms from hex. Prefer THREE.Color (already linear). */
export const linearColor = (hex: string) => new THREE.Color(hex);

// ---------- blur ----------

const blurFrag = /* glsl */ `
uniform sampler2D tSrc; uniform vec2 uDir; uniform float uSigma; in vec2 vUv; out vec4 o;
void main() {
  if (uSigma < 0.01) { o = texture(tSrc, vUv); return; }
  int r = int(ceil(uSigma * 3.0));
  vec4 acc = vec4(0.0); float wsum = 0.0;
  for (int i = -24; i <= 24; i++) {
    if (i < -r || i > r) continue;
    float w = exp(-0.5 * float(i * i) / (uSigma * uSigma));
    acc += texture(tSrc, vUv + uDir * float(i)) * w; wsum += w;
  }
  o = acc / wsum;
}`;

/**
 * Gaussian blur of `src` with radius ≈ 3σ = `radiusPx` render pixels. Large radii are
 * computed on a downsampled copy. Returns a private RT (render size) holding the result.
 */
export function blur(ctx: PassContext, src: THREE.Texture, radiusPx: number, slot = 'a'): THREE.WebGLRenderTarget {
  const { kit, width, height } = ctx;
  const out = rt(`blur-out-${slot}`, width, height);
  const sigma = Math.max(0, radiusPx / 3);
  if (sigma < 0.3) {
    kit.copy(src, out);
    return out;
  }
  // Choose a downsample level so the kernel stays ≤ ~8σ taps.
  let level = 0;
  while (sigma / 2 ** level > 6 && level < 5) level++;
  const f = 2 ** level;
  const w = Math.max(1, Math.ceil(width / f));
  const h = Math.max(1, Math.ceil(height / f));
  const a = rt(`blur-a-${slot}`, w, h);
  const b = rt(`blur-b-${slot}`, w, h);
  const m = mat(kit, 'blur', () =>
    kit.shader({
      uniforms: { tSrc: { value: null }, uDir: { value: new THREE.Vector2() }, uSigma: { value: 0 } },
      fragmentShader: blurFrag,
    }),
  );
  // Downsample progressively with bilinear copies to avoid aliasing.
  let cur: THREE.Texture = src;
  for (let l = 1; l <= level; l++) {
    const step = rt(`blur-down-${slot}-${l}`, Math.max(1, Math.ceil(width / 2 ** l)), Math.max(1, Math.ceil(height / 2 ** l)));
    kit.copy(cur, step);
    cur = step.texture;
  }
  const s = sigma / f;
  m.uniforms.uSigma.value = s;
  m.uniforms.tSrc.value = cur;
  m.uniforms.uDir.value.set(1 / w, 0);
  kit.run(m, a);
  m.uniforms.tSrc.value = a.texture;
  m.uniforms.uDir.value.set(0, 1 / h);
  kit.run(m, b);
  kit.copy(b.texture, out);
  return out;
}

// ---------- signed distance field (jump flooding) ----------
// Seeds are EDGE POINTS estimated from the anti-aliased alpha (pixel centre moved along the alpha
// gradient to where it crosses the threshold), not pixel centres, so distances are smooth along
// slanted/curved edges: outlines and bevels traced from the field don't staircase.

const seedFrag = /* glsl */ `
uniform sampler2D tSrc; uniform float uThreshold; uniform vec2 uRes; out vec4 o;
float A(vec2 q) { return texture(tSrc, clamp(q, vec2(0.5), uRes - 0.5) / uRes).a; }
void main() {
  vec2 p = gl_FragCoord.xy;
  float a = A(p);
  // Edge pixels: a 4-neighbour lies on the other side of the threshold. Faint alpha far from
  // the shape (glow halos, sparkles) seeds nothing and keeps its true distance.
  bool inside = a >= uThreshold;
  bool edge = (A(p + vec2(1.0, 0.0)) >= uThreshold) != inside || (A(p - vec2(1.0, 0.0)) >= uThreshold) != inside
           || (A(p + vec2(0.0, 1.0)) >= uThreshold) != inside || (A(p - vec2(0.0, 1.0)) >= uThreshold) != inside;
  if (!edge) { o = vec4(-1.0); return; }
  // Sobel gradient of alpha → normal pointing inside.
  float tl = A(p + vec2(-1.0, 1.0)), t = A(p + vec2(0.0, 1.0)), tr = A(p + vec2(1.0, 1.0));
  float l = A(p + vec2(-1.0, 0.0)), r = A(p + vec2(1.0, 0.0));
  float bl = A(p + vec2(-1.0, -1.0)), b = A(p + vec2(0.0, -1.0)), br = A(p + vec2(1.0, -1.0));
  vec2 g = vec2(tr + 2.0 * r + br - tl - 2.0 * l - bl, tl + 2.0 * t + tr - bl - 2.0 * b - br);
  if (dot(g, g) < 1e-8) { o = vec4(p, 1.0, 0.0); return; }
  vec2 n = normalize(g);
  // Alpha slope per px along n, the steeper one-sided difference: layers arrive with ramps from
  // ~1 px (crisp coverage) to ~2 px (resampled) wide, and a hard step reads as 1 (edge 0.5 px out).
  float slope = max(max(A(p + n) - a, a - A(p - n)), 1e-3);
  o = vec4(p - n * clamp((a - uThreshold) / slope, -1.0, 1.0), 1.0, 0.0);
}`;

const jfaFrag = /* glsl */ `
uniform sampler2D tSrc; uniform float uStep; uniform vec2 uRes; in vec2 vUv; out vec4 o;
void main() {
  vec2 p = gl_FragCoord.xy;
  vec4 best = vec4(-1.0); float dBest = 1e20;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 q = p + vec2(x, y) * uStep;
    if (q.x < 0.0 || q.y < 0.0 || q.x >= uRes.x || q.y >= uRes.y) continue;
    vec4 s = texture(tSrc, q / uRes);
    if (s.z > 0.5) { float d = dot(s.xy - p, s.xy - p); if (d < dBest) { dBest = d; best = s; } }
  }
  o = best;
}`;

const sdfFrag = /* glsl */ `
uniform sampler2D tSeeds; uniform sampler2D tSrc; uniform float uThreshold; in vec2 vUv; out vec4 o;
void main() {
  vec2 p = gl_FragCoord.xy;
  vec4 s = texture(tSeeds, vUv);
  float a = texture(tSrc, vUv).a;
  // Positive outside the shape, negative inside, in render pixels.
  float d = s.z > 0.5 ? length(s.xy - p) : 1e4;
  o = vec4(a >= uThreshold ? -d : d, a, 0.0, 1.0);
}`;

/**
 * Signed distance to the alpha edge of `src` (alpha ≥ threshold = inside), measured to sub-pixel
 * edge points. Returns a private float RT: R = signed distance in render pixels (+outside,
 * −inside), G = source alpha. Sample with texture(tSdf, uv).r.
 */
export function sdf(ctx: PassContext, src: THREE.Texture, threshold = 0.5): THREE.WebGLRenderTarget {
  const { kit, width, height } = ctx;
  const ping = rt('jfa-ping', width, height, THREE.FloatType);
  const pong = rt('jfa-pong', width, height, THREE.FloatType);
  const out = rt('sdf-out', width, height, THREE.FloatType);
  const seed = mat(kit, 'seed', () =>
    kit.shader({
      uniforms: { tSrc: { value: null }, uThreshold: { value: 0.5 }, uRes: { value: new THREE.Vector2() } },
      fragmentShader: seedFrag,
    }),
  );
  const jfa = mat(kit, 'jfa', () =>
    kit.shader({
      uniforms: { tSrc: { value: null }, uStep: { value: 1 }, uRes: { value: new THREE.Vector2() } },
      fragmentShader: jfaFrag,
    }),
  );
  const fin = mat(kit, 'sdf', () =>
    kit.shader({
      uniforms: { tSeeds: { value: null }, tSrc: { value: null }, uThreshold: { value: 0.5 } },
      fragmentShader: sdfFrag,
    }),
  );
  seed.uniforms.tSrc.value = src;
  seed.uniforms.uThreshold.value = threshold;
  seed.uniforms.uRes.value.set(width, height);
  kit.run(seed, ping);
  jfa.uniforms.uRes.value.set(width, height);
  let a = ping;
  let b = pong;
  let step = 2 ** Math.ceil(Math.log2(Math.max(width, height))) / 2;
  const steps: number[] = [];
  while (step >= 1) {
    steps.push(step);
    step /= 2;
  }
  steps.push(1); // JFA+1 cleans up residual errors
  for (const s of steps) {
    jfa.uniforms.tSrc.value = a.texture;
    jfa.uniforms.uStep.value = s;
    kit.run(jfa, b);
    [a, b] = [b, a];
  }
  fin.uniforms.tSeeds.value = a.texture;
  fin.uniforms.tSrc.value = src;
  fin.uniforms.uThreshold.value = threshold;
  kit.run(fin, out);
  return out;
}

// ---------- content bounding box (GPU reduction, no readback) ----------

const boundsFrag = /* glsl */ `
uniform sampler2D tSrc; uniform bool uFirst; out vec4 o;
void main() {
  ivec2 sz = textureSize(tSrc, 0);
  ivec2 base = ivec2(gl_FragCoord.xy) * 4;
  vec4 m = vec4(-1e6);
  for (int y = 0; y < 4; y++) for (int x = 0; x < 4; x++) {
    ivec2 q = base + ivec2(x, y);
    if (q.x >= sz.x || q.y >= sz.y) continue;
    vec4 s = texelFetch(tSrc, q, 0);
    if (uFirst) {
      if (s.a > 0.004) { vec2 uv = (vec2(q) + 0.5) / vec2(sz); m = max(m, vec4(-uv, uv)); }
    } else m = max(m, s);
  }
  o = m;
}`;

/**
 * Bounding box of the non-transparent pixels of `src`, computed on the GPU.
 * Returns a private 1×1 float RT; read it in shaders with BOUNDS_GLSL's `layerBox()`
 * (bind the returned texture to a `tBounds` uniform). Valid until the next bounds() call.
 */
export function bounds(ctx: PassContext, src: THREE.Texture): THREE.WebGLRenderTarget {
  const { kit } = ctx;
  const m = mat(kit, 'bounds', () =>
    kit.shader({ uniforms: { tSrc: { value: null }, uFirst: { value: true } }, fragmentShader: boundsFrag }),
  );
  let w = ctx.width;
  let h = ctx.height;
  let cur = src;
  let level = 0;
  let out: THREE.WebGLRenderTarget;
  do {
    w = Math.max(1, Math.ceil(w / 4));
    h = Math.max(1, Math.ceil(h / 4));
    out = rt(`bounds-${level}`, w, h, THREE.FloatType);
    m.uniforms.tSrc.value = cur;
    m.uniforms.uFirst.value = level === 0;
    kit.run(m, out);
    cur = out.texture;
    level++;
  } while (w > 1 || h > 1);
  return out;
}

/**
 * Comp-px box (origin comp centre, +y up) of the non-transparent pixels of `src` (bounds()'s
 * threshold), or null when there are none: bounds() and a 1×1 readback (one GPU sync).
 */
export function inkBounds(ctx: PassContext, src: THREE.Texture): Bounds | null {
  const { width: w, height: h, pxScale: scale } = ctx;
  const cx = centreX(ctx.frame);
  const cy = centreY(ctx.frame);
  const px = new Float32Array(4);
  ctx.renderer.readRenderTargetPixels(bounds(ctx, src), 0, 0, 1, 1, px);
  const u0 = -px[0];
  const v0 = -px[1];
  if (px[2] < u0 || px[3] < v0) return null;
  // texel-centre uv → the texels' outer edges, target px → comp px about the comp centre
  return {
    x0: (u0 * w - 0.5 - cx) / scale,
    y0: (v0 * h - 0.5 - cy) / scale,
    x1: (px[2] * w + 0.5 - cx) / scale,
    y1: (px[3] * h + 0.5 - cy) / scale,
  };
}

/**
 * GLSL for reading a bounds() result: declares `uniform sampler2D tBounds;` and
 * `vec4 layerBox()` = (minU, minV, maxU, maxV) in target uv; the whole target if the layer is empty.
 */
export const BOUNDS_GLSL = /* glsl */ `
uniform sampler2D tBounds;
vec4 layerBox() {
  vec4 b = texelFetch(tBounds, ivec2(0), 0);
  vec4 r = vec4(-b.xy, b.zw);
  return (r.z < r.x || r.w < r.y) ? vec4(0.0, 0.0, 1.0, 1.0) : r;
}
`;

/** After BOUNDS_GLSL (needs uRes / vUv): `boxPos(dir)` = position 0..1 along the unit vector `dir` across the layer's bounding box. */
export const BOX_POS_GLSL = /* glsl */ `
float boxPos(vec2 dir) {
  vec4 b = layerBox();
  vec2 lo = b.xy * uRes, hi = b.zw * uRes;
  vec2 c = 0.5 * (lo + hi), hs = 0.5 * (hi - lo);
  float ext = max(abs(dir.x) * hs.x + abs(dir.y) * hs.y, 1.0);
  return 0.5 + dot(vUv * uRes - c, dir) / (2.0 * ext);
}`;

export function disposeEffectLib() {
  for (const t of cache.values()) t.dispose();
  cache.clear();
}

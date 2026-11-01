import * as THREE from 'three';
import type { EffectContext, EffectParams, ParamDef } from '../../engine/contracts';
import type { PassKit } from '../../engine/passkit';
import type { Gradient } from '../../model/types';

// Shared plumbing for group A effects.
//
// Angle convention for every direction param in this group: screen space, clockwise,
// 0° = right, 90° = down ('cwFromRight' in EffectDef metadata).

export const DEG = Math.PI / 180;

/** Direction vector for a screen-clockwise angle, expressed in y-up uv/pixel space. */
export const dirVec = (deg: number): [number, number] => [Math.cos(deg * DEG), -Math.sin(deg * DEG)];

// ---------- GLSL ----------

/** Prepended to every group-A fragment shader. */
export const COMMON_GLSL = /* glsl */ `
uniform vec2 uRes;   // render size in px
uniform float uPx;   // render px per comp px
in vec2 vUv; out vec4 o;
const float PI = 3.14159265359;
vec3 unpremul(vec4 c) { return c.a > 1e-5 ? c.rgb / c.a : vec3(0.0); }
vec4 over(vec4 top, vec4 bottom) { return top + bottom * (1.0 - top.a); }
vec3 toSRGB(vec3 c) { c = max(c, 0.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
vec3 toLinear(vec3 c) { c = max(c, 0.0); return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}
vec3 hsv2rgb(vec3 c) {
  vec3 p = abs(fract(c.xxx + vec3(1.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
  return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
}
vec3 hsl2rgb(vec3 hsl) {
  vec3 rgb = clamp(abs(mod(hsl.x * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
  return hsl.z + hsl.y * (rgb - 0.5) * (1.0 - abs(2.0 * hsl.z - 1.0));
}
// Photoshop's luminosity and SetLum() (PDF blend-mode spec): c's hue and saturation at luminosity l.
float lumPS(vec3 c) { return dot(c, vec3(0.3, 0.59, 0.11)); }
vec3 setLum(vec3 c, float l) {
  c += l - lumPS(c);
  float L = lumPS(c), n = min(c.r, min(c.g, c.b)), x = max(c.r, max(c.g, c.b));
  if (n < 0.0) c = L + (c - L) * L / max(L - n, 1e-6);
  if (x > 1.0) c = L + (c - L) * (1.0 - L) / max(x - L, 1e-6);
  return c;
}
// Blend modes on sRGB-encoded straight colours: 0 normal, 1 multiply, 2 screen, 3 overlay, 4 add, 5 soft light, 6 color.
vec3 blendMode(int m, vec3 b, vec3 s) {
  if (m == 1) return b * s;
  if (m == 2) return b + s - b * s;
  if (m == 3) return mix(2.0 * b * s, 1.0 - 2.0 * (1.0 - b) * (1.0 - s), step(0.5, b));
  if (m == 4) return b + s;
  if (m == 5) return mix(b - (1.0 - 2.0 * s) * b * (1.0 - b), b + (2.0 * s - 1.0) * (sqrt(max(b, 0.0)) - b), step(0.5, s));
  if (m == 6) return setLum(s, lumPS(b));
  return s;
}
float hash1(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
`;

// ---------- passes ----------

type UValue = number | boolean | THREE.Texture | THREE.Color | number[] | null;

const mats = new WeakMap<PassKit, Map<string, THREE.ShaderMaterial>>();

/**
 * Run a cached fullscreen pass. `frag` is appended to COMMON_GLSL (which declares vUv, o,
 * uRes, uPx). Uniform names come from `u` keys and must be stable per `name`.
 * vec2/vec3/vec4 uniforms may be plain number arrays; colours may be THREE.Color.
 */
export function pass(
  ctx: EffectContext,
  name: string,
  frag: string,
  u: Record<string, UValue>,
  target: THREE.WebGLRenderTarget,
) {
  const { kit } = ctx;
  let byName = mats.get(kit);
  if (!byName) mats.set(kit, (byName = new Map()));
  let mat = byName.get(name);
  if (!mat) {
    const uniforms: Record<string, THREE.IUniform> = { uRes: { value: [1, 1] }, uPx: { value: 1 } };
    for (const k in u) uniforms[k] = { value: null };
    mat = kit.shader({ uniforms, fragmentShader: COMMON_GLSL + frag });
    byName.set(name, mat);
  }
  mat.uniforms.uRes.value = [ctx.width, ctx.height];
  mat.uniforms.uPx.value = ctx.pxScale;
  for (const k in u) mat.uniforms[k].value = u[k];
  kit.run(mat, target);
}

// ---------- resolved param readers ----------

export const num = (p: EffectParams, k: string): number => {
  const v = p[k];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
};
export const flag = (p: EffectParams, k: string): boolean => p[k] === true;
export const col = (p: EffectParams, k: string): THREE.Color =>
  new THREE.Color(typeof p[k] === 'string' ? (p[k] as string) : '#ffffff');
export const grad = (p: EffectParams, k: string): Gradient => {
  const v = p[k];
  return typeof v === 'object' && v !== null && 'stops' in v && v.stops.length > 0
    ? v
    : { stops: [{ pos: 0, color: '#ffffff' }] };
};
/** Index of the selected option value (0 if unknown). */
export const pick = (p: EffectParams, k: string, values: readonly string[]): number =>
  Math.max(0, values.indexOf(String(p[k])));

// ---------- ParamDef builders ----------

export const pNum = (
  key: string,
  label: string,
  def: number,
  min: number,
  max: number,
  step = 0.01,
  unit?: 'px' | 'deg' | '%' | 'x',
): ParamDef => ({ key, label, kind: 'number', default: def, min, max, step, unit });
export const pPx = (key: string, label: string, def: number, min: number, max: number, step = 1): ParamDef =>
  pNum(key, label, def, min, max, step, 'px');
export const pDeg = (key: string, label: string, def: number, min = -180, max = 360): ParamDef =>
  pNum(key, label, def, min, max, 1, 'deg');
export const pColor = (key: string, label: string, def: string): ParamDef => ({ key, label, kind: 'color', default: def });
export const pBool = (key: string, label: string, def: boolean): ParamDef => ({ key, label, kind: 'bool', default: def });
export const pGrad = (key: string, label: string, def: Gradient): ParamDef => ({ key, label, kind: 'gradient', default: def });
export const pSelect = (key: string, label: string, def: string, options: [string, string][]): ParamDef => ({
  key,
  label,
  kind: 'select',
  default: def,
  options: options.map(([value, l]) => ({ value, label: l })),
});

/**
 * 'Follow' select for effects that trace the outline: 'layer' (default) traces the layer's own
 * silhouette (ctx.content) wherever they sit, 'stack' everything the stack drew before them (a
 * Stroke's outer edge, but also a glow's halo). Instances saved before the param existed traced
 * the stack: migrateEffects (io/project.ts) fills 'stack' for them. Read the traced texture
 * through `followed`.
 */
export const pFollow = (): ParamDef =>
  pSelect('follow', 'Follow', 'layer', [
    ['layer', 'Layer'],
    ['stack', 'Stack below'],
  ]);
/** The texture an effect with `pFollow` traces. */
export const followed = (ctx: EffectContext, input: THREE.Texture, p: EffectParams): THREE.Texture =>
  p.follow === 'layer' ? ctx.content : input;

export const BLEND_OPTIONS: [string, string][] = [
  ['normal', 'Normal'],
  ['multiply', 'Multiply'],
  ['screen', 'Screen'],
  ['overlay', 'Overlay'],
  ['add', 'Add'],
  ['softLight', 'Soft Light'],
  ['color', 'Color'],
];
export const BLEND_VALUES = BLEND_OPTIONS.map(([v]) => v);

import * as THREE from 'three';
import type { EffectParams, ParamDef, PassContext } from '../../engine/contracts';
import type { PassKit } from '../../engine/passkit';
import type { Gradient } from '../../model/types';

// Shared plumbing for the group-B effects (material, energy, light & sparkle).
//
// Angle convention for direction/light params in this group: y-up, counter-clockwise,
// 0° = right, 90° = up ('ccwFromRight' in EffectDef metadata; Photoshop light angle).

// ---------- param helpers ----------

export const num = (
  key: string,
  label: string,
  def: number,
  min: number,
  max: number,
  unit?: 'px' | 'deg' | '%' | 'x',
  step?: number,
): ParamDef => ({ key, label, kind: 'number', default: def, min, max, unit, step });
export const col = (key: string, label: string, def: string): ParamDef => ({ key, label, kind: 'color', default: def });
export const bool = (key: string, label: string, def: boolean): ParamDef => ({ key, label, kind: 'bool', default: def });
export const sel = (key: string, label: string, def: string, options: [string, string][]): ParamDef => ({
  key,
  label,
  kind: 'select',
  default: def,
  options: options.map(([value, l]) => ({ value, label: l })),
});
export const grad = (key: string, label: string, def: Gradient): ParamDef => ({
  key,
  label,
  kind: 'gradient',
  default: def,
});

export const N = (p: EffectParams, k: string) => Number(p[k]) || 0;
export const S = (p: EffectParams, k: string) => String(p[k]);
export const B = (p: EffectParams, k: string) => p[k] === true;
export const C = (p: EffectParams, k: string) => new THREE.Color(String(p[k])); // hex sRGB → linear
export const G = (p: EffectParams, k: string): Gradient => {
  const v = p[k];
  return typeof v === 'object' && v !== null && 'stops' in v ? v : { stops: [{ pos: 0, color: '#ffffff' }] };
};

export const DEG = Math.PI / 180;

/** Light direction from Photoshop-style angle (0 = from right, 90 = from top) and elevation. */
export function lightDir(angleDeg: number, elevDeg: number, out = new THREE.Vector3()) {
  const a = angleDeg * DEG;
  const e = Math.min(89.5, Math.max(1, elevDeg)) * DEG;
  return out.set(Math.cos(a) * Math.cos(e), Math.sin(a) * Math.cos(e), Math.sin(e));
}

// ---------- material + RT caches ----------

const mats = new WeakMap<PassKit, Map<string, THREE.ShaderMaterial>>();

/** One cached ShaderMaterial per (kit, name). */
export function material(
  kit: PassKit,
  name: string,
  opts: Parameters<PassKit['shader']>[0],
): THREE.ShaderMaterial {
  let m = mats.get(kit);
  if (!m) mats.set(kit, (m = new Map()));
  let s = m.get(name);
  if (!s) {
    s = kit.shader({ ...opts, uniforms: { ...COMMON_UNIFORMS(), ...opts.uniforms } });
    m.set(name, s);
  }
  return s;
}

const COMMON_UNIFORMS = () => ({
  uRes: { value: new THREE.Vector2(1, 1) },
  uPx: { value: 1 },
});

/** Set the common uniforms (render size, px scale) on a material made by `material()`. */
export function common(m: THREE.ShaderMaterial, ctx: PassContext) {
  m.uniforms.uRes.value.set(ctx.width, ctx.height);
  m.uniforms.uPx.value = ctx.pxScale;
  return m;
}

const rts = new Map<string, THREE.WebGLRenderTarget>();

/** Private float RT of arbitrary size (nearest filtering). */
export function floatRT(key: string, w: number, h: number) {
  let t = rts.get(key);
  if (!t) {
    t = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.FloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: false,
    });
    rts.set(key, t);
  } else if (t.width !== w || t.height !== h) t.setSize(w, h);
  return t;
}

// ---------- GLSL chunks ----------

/** Common uniforms + helpers. `compPos()` = comp px, origin centre, +y up. */
export const HEAD = /* glsl */ `
uniform vec2 uRes; uniform float uPx;
in vec2 vUv; out vec4 o;
vec2 compPos() { return (gl_FragCoord.xy - 0.5 * uRes) / uPx; }
vec3 unpre(vec4 c) { return c.a > 1e-5 ? c.rgb / c.a : vec3(0.0); }
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
// Additive light encoded into premultiplied alpha so it survives export on transparent bg.
vec4 addLight(vec4 dst, vec3 light) {
  light = max(light, 0.0);
  float la = clamp(max(max(light.r, light.g), light.b), 0.0, 1.0);
  return vec4(dst.rgb + light, dst.a + (1.0 - dst.a) * la);
}
// Premultiplied "src over dst".
vec4 over(vec4 src, vec4 dst) { return src + dst * (1.0 - src.a); }
// Light-like colour → premultiplied rgba with alpha = brightest channel.
vec4 lightPremul(vec3 light) {
  light = max(light, 0.0);
  float la = clamp(max(max(light.r, light.g), light.b), 0.0, 1.0);
  return vec4(light, la);
}
`;

// ---------- CPU readback grids ----------

const gridFrag = /* glsl */ `
uniform sampler2D tSrc; uniform float uCell; uniform int uTaps; uniform vec2 uOrigin;
// R = mean alpha, G = mean luminance (premultiplied) over the cell. Taps sit on a regular
// lattice inside the cell; with an integer cell size (and origin) they land on texel centres,
// so the result is an exact box mean at any render scale. Taps past the canvas count as empty.
void main() {
  vec2 base = uOrigin + floor(gl_FragCoord.xy) * uCell;
  float pitch = uCell / float(uTaps);
  float sumA = 0.0, sumL = 0.0;
  for (int y = 0; y < 16; y++) {
    if (y >= uTaps) break;
    for (int x = 0; x < 16; x++) {
      if (x >= uTaps) break;
      vec2 q = base + (vec2(x, y) + 0.5) * pitch;
      if (any(lessThan(q, vec2(0.0))) || any(greaterThan(q, uRes))) continue;
      vec4 c = texture(tSrc, q / uRes);
      sumA += c.a; sumL += luma(c.rgb);
    }
  }
  float n = float(uTaps * uTaps);
  o = vec4(sumA / n, max(sumL / n, 0.0), 0.0, 1.0);
}`;

/** Cells a readGrid lattice extends each way from the canvas centre come in multiples of this (see readGrid). */
const GRID_ALIGN = 16;

export interface Grid {
  w: number;
  h: number;
  /** Cell size in render px (= cellComp × pxScale). */
  cell: number;
  /** Cell size in comp px. */
  cellComp: number;
  /** Lower-left corner of cell (0, 0), comp px about the canvas (comp) centre, y-up: a multiple of GRID_ALIGN cells. */
  x0: number;
  y0: number;
  /** The same corner in render px from the canvas's lower-left corner (≤ 0). */
  px0: number;
  py0: number;
  /** Mean alpha per cell (row 0 = bottom). */
  alpha: Float32Array;
  /** Mean premultiplied luminance per cell. */
  lum: Float32Array;
}

/** Last grid read per layer and call site, reused by draft frames (see readGrid). */
const lastGrids = new Map<string, Grid>();

/**
 * Box-average `src` into a grid of `cellCompPx` comp-px cells and read it back to the CPU.
 * Cells are fixed in comp space and hold means, so the grid is (up to resampling) the same at
 * every render scale: placements derived from it don't move between preview and 2× export.
 * The lattice is laid out from the canvas centre (the comp centre) in whole blocks of
 * GRID_ALIGN cells, so a larger canvas (an export's margins, an enlarged interactive frame)
 * only adds cells around the same ones. Used for placing sprites/bolts; stalls the GPU once,
 * keep grids small.
 *
 * `site` names the call site (one per effect use). Draft frames (ctx.draft, during drags and
 * scrubs) skip the readback, the GPU sync that dominates an interactive frame, and reuse the
 * grid this site last read for the layer: sprites hold still until the full render on release.
 */
export function readGrid(ctx: PassContext, src: THREE.Texture, cellCompPx: number, site: string): Grid {
  const { kit } = ctx;
  const cell = cellCompPx * ctx.pxScale;
  const nx = Math.max(1, Math.ceil(ctx.width / 2 / cell / GRID_ALIGN - 1e-6)) * GRID_ALIGN;
  const ny = Math.max(1, Math.ceil(ctx.height / 2 / cell / GRID_ALIGN - 1e-6)) * GRID_ALIGN;
  const w = 2 * nx;
  const h = 2 * ny;
  const px0 = ctx.width / 2 - nx * cell;
  const py0 = ctx.height / 2 - ny * cell;
  const key = `${ctx.layerId}|${site}|${cellCompPx}`;
  const last = lastGrids.get(key);
  // Same comp-space grid (draft 3D frames render at a lower pxScale): only the render-px cell differs.
  if (ctx.draft && last && last.w === w && last.h === h) return { ...last, cell, px0, py0 };
  const m = material(kit, 'b-grid', {
    uniforms: { tSrc: { value: null }, uCell: { value: 1 }, uTaps: { value: 1 }, uOrigin: { value: new THREE.Vector2() } },
    fragmentShader: HEAD + gridFrag,
  });
  common(m, ctx);
  const rt = floatRT('grid', w, h);
  m.uniforms.tSrc.value = src;
  m.uniforms.uCell.value = cell;
  m.uniforms.uTaps.value = Math.min(16, Math.max(1, Math.round(cell)));
  m.uniforms.uOrigin.value.set(px0, py0);
  kit.run(m, rt);
  const buf = new Float32Array(w * h * 4);
  ctx.renderer.readRenderTargetPixels(rt, 0, 0, w, h, buf);
  const alpha = new Float32Array(w * h);
  const lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    alpha[i] = buf[i * 4];
    lum[i] = buf[i * 4 + 1];
  }
  const grid = { w, h, cell, cellComp: cellCompPx, x0: -nx * cellCompPx, y0: -ny * cellCompPx, px0, py0, alpha, lum };
  lastGrids.set(key, grid);
  return grid;
}

/** Chamfer distance (in cells) from every cell to the nearest cell with alpha ≥ 0.5. */
export function gridDistance(g: Pick<Grid, 'w' | 'h' | 'alpha'>): Float32Array {
  const { w, h } = g;
  const d = new Float32Array(w * h);
  const INF = 1e9;
  for (let i = 0; i < w * h; i++) d[i] = g.alpha[i] >= 0.5 ? 0 : INF;
  const D = Math.SQRT2;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let v = d[i];
      if (x > 0) v = Math.min(v, d[i - 1] + 1);
      if (y > 0) {
        v = Math.min(v, d[i - w] + 1);
        if (x > 0) v = Math.min(v, d[i - w - 1] + D);
        if (x < w - 1) v = Math.min(v, d[i - w + 1] + D);
      }
      d[i] = v;
    }
  for (let y = h - 1; y >= 0; y--)
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      let v = d[i];
      if (x < w - 1) v = Math.min(v, d[i + 1] + 1);
      if (y < h - 1) {
        v = Math.min(v, d[i + w] + 1);
        if (x < w - 1) v = Math.min(v, d[i + w + 1] + D);
        if (x > 0) v = Math.min(v, d[i + w - 1] + D);
      }
      d[i] = v;
    }
  return d;
}

// ---------- deterministic randomness ----------

/** Integer hash → [0,1). */
export function hash(...n: number[]): number {
  let h = 0x811c9dc5;
  for (const v of n) {
    h ^= Math.floor(v * 1000003) | 0;
    h = Math.imul(h, 0x01000193);
    h ^= h >>> 15;
    h = Math.imul(h, 0x2c1b3c6d);
    h ^= h >>> 12;
  }
  return (h >>> 0) / 4294967296;
}

/** Seeded PRNG (mulberry32). */
export function rng(seed: number) {
  let a = (Math.floor(seed * 7919) ^ 0x9e3779b9) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- a scene renderer for geometry-based effects (sprites, bolts) ----------

const scenes = new WeakMap<PassKit, { scene: THREE.Scene; camera: THREE.OrthographicCamera }>();

/** Render `obj` (whose vertex shader writes clip space directly) into `target`, cleared first. */
export function drawObject(ctx: PassContext, obj: THREE.Object3D, target: THREE.WebGLRenderTarget) {
  let s = scenes.get(ctx.kit);
  if (!s) {
    s = { scene: new THREE.Scene(), camera: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1) };
    scenes.set(ctx.kit, s);
  }
  const r = ctx.renderer;
  s.scene.add(obj);
  const prev = r.autoClear;
  r.autoClear = false;
  r.setRenderTarget(target);
  r.setClearColor(0x000000, 0);
  r.clear(true, true, false);
  r.render(s.scene, s.camera);
  r.autoClear = prev;
  s.scene.remove(obj);
}

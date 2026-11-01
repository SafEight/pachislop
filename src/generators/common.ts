import * as THREE from 'three';
import type { EffectParams, GeneratorContext, ParamDef, PassContext } from '../engine/contracts';
import type { EffectInstance, ParamValue } from '../model/types';
import type { PassKit } from '../engine/passkit';
import { blur } from '../effects/lib';

// Shared GPU helpers for generators. Output follows the pass contract (passkit.ts): premultiplied
// linear RGBA, render pixels with the origin at the target's bottom-left.

/** What the drawing helpers need of a GeneratorContext or an EffectContext. */
export type GpuContext = Pick<GeneratorContext, 'renderer' | 'kit' | 'width' | 'height' | 'pxScale'>;

/**
 * Seeded PRNG (mulberry32): a function returning numbers in [0, 1). Any seed works (fractional and
 * negative too); the same seed always gives the same sequence.
 */
export function rng(seed: number): () => number {
  // hash the seed first so neighbouring seeds (1, 2, 3…) start uncorrelated streams
  let s = Math.imul(Math.floor(seed * 4096) ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Vertex shader chunk: `vec4 layerToClip(vec2 p)` maps a layer-space position (comp px) through
 * `uLayerToRender` to clip space; `float layerPxScale()` = render px per layer-space px. Set the
 * uniforms with `layerUniforms()` / `setLayerUniforms()`.
 */
export const LAYER_VERT = /* glsl */ `
uniform mat3 uLayerToRender; uniform vec2 uRenderSize;
vec4 layerToClip(vec2 p) { vec2 r = (uLayerToRender * vec3(p, 1.0)).xy; return vec4(r / uRenderSize * 2.0 - 1.0, 0.0, 1.0); }
float layerPxScale() { return length(uLayerToRender[0].xy); }
`;

/**
 * Fragment shader chunk for full-frame fills: `vec2 layerPos()` = this fragment's position in
 * layer space (comp px, +y up), through `uRenderToLayer`; `float layerPxScale()` as LAYER_VERT's.
 */
export const LAYER_FRAG = /* glsl */ `
uniform mat3 uRenderToLayer;
vec2 layerPos() { return (uRenderToLayer * vec3(gl_FragCoord.xy, 1.0)).xy; }
float layerPxScale() { return 1.0 / length(uRenderToLayer[0].xy); }
`;

export interface LayerUniforms {
  uLayerToRender: THREE.IUniform<THREE.Matrix3>;
  uRenderSize: THREE.IUniform<THREE.Vector2>;
  uRenderToLayer: THREE.IUniform<THREE.Matrix3>;
}

/** Fresh uniforms for LAYER_VERT / LAYER_FRAG (spread them into a material's uniforms). */
export function layerUniforms(): LayerUniforms {
  return {
    uLayerToRender: { value: new THREE.Matrix3() },
    uRenderSize: { value: new THREE.Vector2(1, 1) },
    uRenderToLayer: { value: new THREE.Matrix3() },
  };
}

/** Point `u` at this render: `toRender` maps the drawing space to render px (`ctx.layerToRender`, or `compToRender`). */
export function setLayerUniforms(u: LayerUniforms, ctx: GpuContext, toRender: THREE.Matrix3) {
  u.uLayerToRender.value.copy(toRender);
  u.uRenderSize.value.set(ctx.width, ctx.height);
  u.uRenderToLayer.value.copy(toRender).invert();
}

/**
 * Comp space (comp px, origin at the canvas centre, +y up) → render px of `ctx`, written into
 * `out`: the `toRender` of effects, which have no layer transform.
 */
export function compToRender(ctx: GpuContext, out = new THREE.Matrix3()): THREE.Matrix3 {
  return out.set(ctx.pxScale, 0, ctx.width / 2, 0, ctx.pxScale, ctx.height / 2, 0, 0, 1);
}

/** Clear `target` to transparent. */
export function clearTarget(ctx: Pick<GpuContext, 'kit'>, target: THREE.WebGLRenderTarget) {
  ctx.kit.clear(target);
}

// ---------- following a layer (GeneratorDef.follow) ----------

/** The `follow` param of follow-capable generators: the layer to follow ('' = free). First in their `params`. */
export const followParam = (label = 'Follow layer'): ParamDef => ({ key: 'follow', label, kind: 'layer', default: '' });

/** The layer id resolved params `p` follow ('' = free). */
export const followed = (p: EffectParams): string => (typeof p.follow === 'string' ? p.follow : '');

const scratchMat = new THREE.Matrix3();
const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/**
 * Render px → render px offset of a follow generator's own transform on top of the followed layer
 * (layerToRender · compToRender⁻¹), written into `out`; null at the identity transform, where the
 * generator draws exactly where the followed layer is.
 */
export function followOffset(ctx: GeneratorContext, out = new THREE.Matrix3()): THREE.Matrix3 | null {
  out.copy(ctx.layerToRender).multiply(compToRender(ctx, scratchMat).invert());
  return out.elements.every((v, i) => Math.abs(v - IDENTITY[i]) < 1e-9) ? null : out;
}

const offsetMats = new WeakMap<PassKit, THREE.ShaderMaterial>();
const offsetMat = new THREE.Matrix3();

/**
 * Draw a follow generator whose `draw` renders in comp space (where the followed layer is, as the
 * effect it replaced did) and place it by its own transform: at the identity transform `draw`
 * writes straight into `target`, else into a scratch target resampled through `followOffset`.
 */
export function drawFollowed(ctx: GeneratorContext, target: THREE.WebGLRenderTarget, draw: (out: THREE.WebGLRenderTarget) => void) {
  const off = followOffset(ctx, offsetMat);
  if (!off) {
    draw(target);
    return;
  }
  const { kit } = ctx;
  const tmp = kit.acquire();
  draw(tmp);
  let m = offsetMats.get(kit);
  if (!m) {
    m = kit.shader({
      uniforms: { tSrc: { value: null }, uInv: { value: new THREE.Matrix3() }, uSize: { value: new THREE.Vector2() } },
      fragmentShader: /* glsl */ `
        uniform sampler2D tSrc; uniform mat3 uInv; uniform vec2 uSize; in vec2 vUv; out vec4 o;
        void main() {
          vec2 su = (uInv * vec3(gl_FragCoord.xy, 1.0)).xy / uSize;
          o = all(greaterThanEqual(su, vec2(0.0))) && all(lessThanEqual(su, vec2(1.0))) ? texture(tSrc, su) : vec4(0.0);
        }`,
    });
    offsetMats.set(kit, m);
  }
  m.uniforms.tSrc.value = tmp.texture;
  m.uniforms.uInv.value.copy(off).invert();
  m.uniforms.uSize.value.set(ctx.width, ctx.height);
  kit.run(m, target);
  kit.release(tmp);
}

/**
 * Anamorphic lens streak along x (lens flare, the Glints hero streak): a hot thin line plus a
 * softer sheath, white at the centre and `col` outward. `lv` = offset in the streak's frame,
 * `size` = core size (sets the thickness), `len` = falloff length along x (render px).
 */
export const ANAMORPHIC_GLSL = /* glsl */ `
vec3 anamorphicStreak(vec2 lv, float size, float len, vec3 col) {
  float sy = abs(lv.y) / size;
  float sx = abs(lv.x) / max(len, 1.0);
  float streak = exp(-sy * 28.0) * exp(-sx * 2.2) * 1.4 + exp(-sy * 7.0) * exp(-sx * 4.0) * 0.35;
  return mix(col, vec3(1.0), exp(-sx * 6.0) * exp(-sy * 40.0)) * streak;
}`;

// ---------- instanced quads ----------

/**
 * How quads combine with what `target` holds (premultiplied): 'normal' = over, 'add' = colour
 * sum with alpha union (the compositor's Add), 'screen' = s + d − s·d with alpha union.
 */
export type QuadBlend = 'normal' | 'add' | 'screen';

export interface InstancedQuads {
  /** Number of quads; the per-instance arrays hold at least this many entries. */
  count: number;
  /** Per instance x, y: quad centre in the space `toRender` maps from (comp px). */
  center: Float32Array;
  /** Per instance w, h: full quad width and height along its own axes, comp px. */
  size: Float32Array;
  /** Per instance angle of the quad's +x axis, radians counter-clockwise (+y up). Omitted = 0. */
  rotation?: Float32Array;
  /** Per instance r, g, b, a: PREMULTIPLIED linear colour. */
  color: Float32Array;
  /** Per instance free vec4 for the fragment shader (seed, phase, shape…). Omitted = 0. */
  extra?: Float32Array;
  /** Drawing space → render px: `ctx.layerToRender` for generators, `compToRender(ctx)` for effects. */
  toRender: THREE.Matrix3;
  /**
   * Fragment shader BODY (the header below is prepended): declare your own uniforms and write
   * `o` (premultiplied). Inputs: `vQuad` (−1..1 across the quad along its own axes), `vColor`
   * (the instance colour, premultiplied, already faded for sub-`minPx` quads), `vExtra`, `vSizePx`
   * (drawn quad size in render px, for anti-aliasing). Materials are cached by this string: pass a
   * module constant, not a string built per call.
   */
  fragmentShader: string;
  /** Uniforms the fragment shader declares (values copied every call). */
  uniforms?: Record<string, THREE.IUniform>;
  blend: QuadBlend;
  /**
   * Smallest drawn side in render px (default 1.5): smaller quads are drawn at this size with
   * colour scaled by the area ratio, so tiny particles keep their energy and don't shimmer, and
   * the look holds across export scales.
   */
  minPx?: number;
}

const QUAD_VERT = /* glsl */ `
in vec2 iCenter; in vec2 iSize; in float iRot; in vec4 iColor; in vec4 iExtra;
uniform float uMinPx;
out vec2 vQuad; out vec4 vColor; out vec4 vExtra; out vec2 vSizePx;
${LAYER_VERT}
void main() {
  float k = layerPxScale();
  vec2 px = abs(iSize) * k;
  if (k <= 0.0 || px.x * px.y <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec2 grown = max(px, vec2(uMinPx));
  vec2 hs = 0.5 * grown / k;
  vec2 l = position.xy * hs;
  float c = cos(iRot), s = sin(iRot);
  gl_Position = layerToClip(iCenter + vec2(c * l.x - s * l.y, s * l.x + c * l.y));
  vQuad = position.xy;
  vColor = iColor * (px.x * px.y / (grown.x * grown.y));
  vExtra = iExtra;
  vSizePx = grown;
}`;

const QUAD_FRAG_HEAD = /* glsl */ `
in vec2 vQuad; in vec4 vColor; in vec4 vExtra; in vec2 vSizePx; out vec4 o;
`;

const ATTRS = [
  ['iCenter', 2],
  ['iSize', 2],
  ['iRot', 1],
  ['iColor', 4],
  ['iExtra', 4],
] as const;

interface QuadState {
  scene: THREE.Scene;
  camera: THREE.OrthographicCamera;
  mesh: THREE.Mesh;
  geo: THREE.InstancedBufferGeometry;
  cap: number;
  /** Per fragment shader and blend. */
  mats: Map<string, THREE.ShaderMaterial>;
}

const quadState = new WeakMap<PassKit, QuadState>();

function quadGeometry(cap: number): THREE.InstancedBufferGeometry {
  const quad = new THREE.PlaneGeometry(2, 2);
  const geo = new THREE.InstancedBufferGeometry();
  geo.setIndex(quad.getIndex());
  geo.setAttribute('position', quad.getAttribute('position'));
  for (const [k, n] of ATTRS) geo.setAttribute(k, new THREE.InstancedBufferAttribute(new Float32Array(cap * n), n).setUsage(THREE.DynamicDrawUsage));
  return geo;
}

function quadsFor(kit: PassKit, n: number): QuadState {
  let st = quadState.get(kit);
  if (!st) {
    const cap = Math.max(256, 2 ** Math.ceil(Math.log2(Math.max(1, n))));
    const geo = quadGeometry(cap);
    const mesh = new THREE.Mesh(geo);
    mesh.frustumCulled = false;
    const scene = new THREE.Scene();
    scene.add(mesh);
    st = { scene, camera: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1), mesh, geo, cap, mats: new Map() };
    quadState.set(kit, st);
  } else if (st.cap < n) {
    st.geo.dispose();
    st.cap = 2 ** Math.ceil(Math.log2(n));
    st.geo = quadGeometry(st.cap);
    st.mesh.geometry = st.geo;
  }
  return st;
}

const BLEND_FACTORS: Record<QuadBlend, THREE.BlendingDstFactor> = {
  normal: THREE.OneMinusSrcAlphaFactor,
  add: THREE.OneFactor,
  screen: THREE.OneMinusSrcColorFactor,
};

function quadMaterial(st: QuadState, opts: InstancedQuads): THREE.ShaderMaterial {
  const key = `${opts.blend}\n${opts.fragmentShader}`;
  let m = st.mats.get(key);
  if (!m) {
    const uniforms: Record<string, THREE.IUniform> = { ...layerUniforms(), uMinPx: { value: 1.5 } };
    for (const [k, u] of Object.entries(opts.uniforms ?? {})) uniforms[k] = { value: u.value };
    m = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: QUAD_VERT,
      fragmentShader: QUAD_FRAG_HEAD + opts.fragmentShader,
      uniforms,
      // A flipped layer's layerToRender mirrors the quads, turning their winding: draw both faces.
      side: THREE.DoubleSide,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: BLEND_FACTORS[opts.blend],
      // alpha is the union in every mode, as the compositor's blends
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });
    st.mats.set(key, m);
  }
  return m;
}

/**
 * Draw `opts.count` oriented quads over `target`'s current content (no clear), each with its own
 * centre / size / rotation / colour / extra, shaded by `opts.fragmentShader` and blended by
 * `opts.blend`. Up to tens of thousands of quads in one draw call.
 */
export function drawInstancedQuads(ctx: GpuContext, target: THREE.WebGLRenderTarget, opts: InstancedQuads) {
  const n = opts.count;
  if (n <= 0) return;
  const st = quadsFor(ctx.kit, n);
  const fill = (name: string, src: Float32Array | undefined, size: number) => {
    const a = st.geo.getAttribute(name) as THREE.InstancedBufferAttribute;
    const arr = a.array as Float32Array;
    if (src) arr.set(src.subarray(0, n * size));
    else arr.fill(0, 0, n * size);
    a.clearUpdateRanges();
    a.addUpdateRange(0, n * size);
    a.needsUpdate = true;
  };
  fill('iCenter', opts.center, 2);
  fill('iSize', opts.size, 2);
  fill('iRot', opts.rotation, 1);
  fill('iColor', opts.color, 4);
  fill('iExtra', opts.extra, 4);
  st.geo.instanceCount = n;

  const m = quadMaterial(st, opts);
  setLayerUniforms(m.uniforms as unknown as LayerUniforms, ctx, opts.toRender);
  m.uniforms.uMinPx.value = opts.minPx ?? 1.5;
  for (const [k, u] of Object.entries(opts.uniforms ?? {})) m.uniforms[k].value = u.value;
  st.mesh.material = m;

  const r = ctx.renderer;
  const prevAutoClear = r.autoClear;
  r.autoClear = false;
  r.setRenderTarget(target);
  r.render(st.scene, st.camera);
  r.autoClear = prevAutoClear;
}

// ---------- glow ----------

const glowMats = new WeakMap<PassKit, THREE.ShaderMaterial>();

/**
 * Add a Gaussian glow of `src` (radius ≈ 3σ = `radiusCompPx` comp px, so it scales with the
 * export) times `amount` onto `target`'s current content: colour adds, alpha takes the union.
 * `src` may be `target`'s own texture (it is blurred into private targets first). Accepts a
 * GeneratorContext or an EffectContext.
 */
export function glowInto(ctx: PassContext, src: THREE.Texture, target: THREE.WebGLRenderTarget, radiusCompPx: number, amount: number) {
  if (!(amount > 0) || !(radiusCompPx > 0)) return;
  const { kit } = ctx;
  const blurred = blur(ctx, src, radiusCompPx * ctx.pxScale, 'gen-glow');
  let m = glowMats.get(kit);
  if (!m) {
    m = kit.shader({
      uniforms: { tSrc: { value: null }, uAmount: { value: 1 } },
      fragmentShader: /* glsl */ `
        uniform sampler2D tSrc; uniform float uAmount; in vec2 vUv; out vec4 o;
        void main() { vec4 c = texture(tSrc, vUv) * uAmount; o = vec4(c.rgb, min(c.a, 1.0)); }`,
      blending: THREE.CustomBlending,
    });
    m.blendEquation = THREE.AddEquation;
    m.blendSrc = THREE.OneFactor;
    m.blendDst = THREE.OneFactor;
    m.blendSrcAlpha = THREE.OneFactor;
    m.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
    glowMats.set(kit, m);
  }
  m.uniforms.tSrc.value = blurred.texture;
  m.uniforms.uAmount.value = amount;
  kit.run(m, target, false);
}

// ---------- preset looks (GeneratorPreset.effects) ----------

/** An effect of a preset's look: `params` over the effect's defaults (copies onto a layer get their own ids). */
export const presetEffect = (type: string, params: Record<string, ParamValue>): EffectInstance => ({ id: type, type, enabled: true, params, fromPreset: true });

/**
 * Light glow of a generator layer: an Outer Glow of the layer's own colours, a Gaussian of radius
 * `size` comp px added × `intensity` over everything (alpha union), the glow generators used to draw themselves.
 */
export const lightGlow = (size: number, intensity = 1): EffectInstance =>
  presetEffect('outerGlow', { fill: 'layer', technique: 'softer', size, intensity, spread: 0, opacity: 1, mode: 'add', onFace: 1 });

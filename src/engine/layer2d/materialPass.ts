import * as THREE from 'three';
import { bakeGradient, hexToRgb } from '../../model/gradient';
import type { BevelProfile2D, Comp, Curve, Fill, FillKind, GlossContour, Gradient, Material2D, Satin2D, Texture2D, Transform } from '../../model/types';
import type { PassKit } from '../passkit';
import { patternUniforms, setPatternUniforms } from '../patterns';
import { bakeCurve } from './contours';
import { decodeImage, getBitmap, imageTexture } from './images';
import { reflectionTexture } from './reflectionMaps';
import { BLUR_R_FRAG, COVER_INIT_FRAG, COVER_JFA_FRAG, COVER_RADIUS_FRAG, ELEMENT_FRAG, HEIGHT_FRAG, JFA_FRAG, REDUCE_MAX_FRAG, SDF_FRAG, SEED_FRAG } from './shaders';

// One Material2D shaded over one coverage mask: the shared core of the 2D title renderer's faces
// and rims (Title2DRenderer) and of the Material effect (effects/b/material.ts), so every knob of
// a material shades the same wherever it is used.
//
// A "frame" is the pixel grid every texture of one shading shares (gl_FragCoord in frame px,
// y-up): the title's layer-local frame, or the effect's render target. Per mask, cached by key in
// a MaterialSlot: signed distance field (jump flooding over sub-pixel edge points) → bevel height
// field (profile, Fit cover, soften) → shape-burst depth and satin blur; then ELEMENT_FRAG shades
// fill → refraction / glass → bevel light → finish → pattern → satin → texture → sheen → inner
// glow → gloss cap into a premultiplied linear stack.

const PROFILE_IDS: Record<BevelProfile2D, number> = { smooth: 0, button: 1, mesa: 2, chamfer: 3, ridge: 4, cove: 5, stepped: 6, custom: 7 };
const GLOSS_IDS: Record<GlossContour, number> = { linear: 0, ring: 1, doubleRing: 2, cove: 3, roundedSteps: 4, sawtooth: 5, custom: 6 };
const FILL_KIND_IDS: Record<FillKind, number> = { solid: 0, linear: 1, radial: 2, angle: 3, reflected: 4, diamond: 5, shapeBurst: 6, image: 7 };
const SATIN_BLEND_IDS: Record<Satin2D['blend'], number> = { normal: 0, multiply: 1, screen: 2, overlay: 3 };
const TEX_IDS: Record<Texture2D['kind'], number> = {
  none: 0,
  noise: 1,
  sparkle: 2,
  brushed: 3,
  ripple: 4,
  grunge: 5,
  clouds: 6,
  hammered: 7,
  crumple: 8,
  liquid: 9,
  hairline: 10,
  spun: 11,
  flakes: 12,
};
const TEX_BLEND_IDS: Record<Texture2D['blend'], number> = { overlay: 0, softLight: 1, screen: 2, multiply: 3 };
const DEG = Math.PI / 180;

/** The placement whose rotZ / flip screen-fixed lights undo (a title's transform; identity for effects). */
export type Placement = Pick<Transform, 'rotZ' | 'flipX' | 'flipY'>;

export const NO_PLACEMENT: Placement = { rotZ: 0, flipX: false, flipY: false };

/**
 * Layer-space angle (degrees, counter-clockwise, y-up) of the screen direction `deg` under `t`:
 * undoes rotZ, then the flip, so lights stay fixed on screen however the layer is placed.
 */
function layerAngle(deg: number, t: Placement): number {
  const a = deg + t.rotZ;
  if (t.flipX) return t.flipY ? a + 180 : 180 - a;
  return t.flipY ? -a : a;
}

/** Inverse of layerAngle: the screen direction (degrees, counter-clockwise, y-up) of layer-space angle `deg`. */
function screenAngle(deg: number, t: Placement): number {
  if (t.flipX) return t.flipY ? deg - t.rotZ - 180 : 180 - deg - t.rotZ;
  return t.flipY ? -deg - t.rotZ : deg - t.rotZ;
}

// ---------- gradient lookup textures (sRGB-encoded, straight alpha, sampled raw) ----------

const rampCache = new Map<string, THREE.DataTexture>();

function rampTexture(g: Gradient): THREE.DataTexture {
  const key = JSON.stringify(g);
  let tex = rampCache.get(key);
  if (tex) return tex;
  tex = new THREE.DataTexture(bakeGradient(g), 256, 1, THREE.RGBAFormat);
  tex.colorSpace = THREE.NoColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  if (rampCache.size > 256) {
    for (const t of rampCache.values()) t.dispose();
    rampCache.clear();
  }
  rampCache.set(key, tex);
  return tex;
}

const curveCache = new Map<string, THREE.DataTexture>();

/** 256 × 1 R32F LUT of a curve (sampled with texelFetch + lerp in LUT_GLSL). */
function curveTexture(c: Curve): THREE.DataTexture {
  const key = JSON.stringify(c.points);
  let tex = curveCache.get(key);
  if (tex) return tex;
  tex = new THREE.DataTexture(bakeCurve(c), 256, 1, THREE.RedFormat, THREE.FloatType);
  tex.colorSpace = THREE.NoColorSpace;
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  if (curveCache.size > 256) {
    for (const t of curveCache.values()) t.dispose();
    curveCache.clear();
  }
  curveCache.set(key, tex);
  return tex;
}

export function fillUniforms(): Record<string, THREE.IUniform> {
  return {
    uFillKind: { value: 0 },
    uFillColor: { value: new THREE.Vector3() },
    tFillGrad: { value: null },
    uFillDir: { value: new THREE.Vector2(0, -1) },
    uFillScale: { value: 1 },
    uFillOffset: { value: 0 },
    uFillPx: { value: 1 },
    uImgOn: { value: false },
    tFillImg: { value: null },
    uImgAspect: { value: 1 },
    uImgScale: { value: 1 },
    uImgOff: { value: new THREE.Vector2() },
    uImgRot: { value: new THREE.Vector2(1, 0) },
    uImgTile: { value: false },
  };
}

/** The decoded image of an image fill (decoding starts on first use), or undefined. */
export function fillBitmap(fill: Fill): ImageBitmap | undefined {
  const id = fill.kind === 'image' ? fill.image?.assetId : undefined;
  if (!id) return undefined;
  const bmp = getBitmap(id);
  if (!bmp) void decodeImage(id);
  return bmp;
}

/** `pxStep`: fill-space units (the shader's p) per output pixel, for image filtering. */
export function setFill(u: Record<string, THREE.IUniform>, fill: Fill, pxStep: number) {
  u.uFillKind.value = FILL_KIND_IDS[fill.kind] ?? 0;
  (u.uFillColor.value as THREE.Vector3).fromArray(hexToRgb(fill.color));
  u.tFillGrad.value = rampTexture(fill.gradient);
  // angle: 0 = left→right, 90 = top→bottom (clockwise on screen) → y-up vector.
  (u.uFillDir.value as THREE.Vector2).set(Math.cos(fill.angle * DEG), -Math.sin(fill.angle * DEG));
  u.uFillScale.value = fill.scale;
  u.uFillOffset.value = fill.offset;
  u.uFillPx.value = pxStep;
  const img = fill.image;
  const bmp = fillBitmap(fill);
  u.uImgOn.value = !!bmp;
  u.tFillImg.value = bmp && img ? imageTexture(img.assetId) : null;
  if (bmp && img) {
    u.uImgAspect.value = bmp.width / Math.max(1, bmp.height);
    u.uImgScale.value = img.scale;
    (u.uImgOff.value as THREE.Vector2).set(img.offsetX, img.offsetY);
    (u.uImgRot.value as THREE.Vector2).set(Math.cos(img.rotate * DEG), Math.sin(img.rotate * DEG));
    u.uImgTile.value = img.tile;
  }
}

// ---------- GPU helpers ----------

function makeRT(w: number, h: number, format: THREE.PixelFormat, type: THREE.TextureDataType, linear = false) {
  const rt = new THREE.WebGLRenderTarget(w, h, {
    format,
    type,
    minFilter: linear ? THREE.LinearFilter : THREE.NearestFilter,
    magFilter: linear ? THREE.LinearFilter : THREE.NearestFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
  });
  rt.texture.colorSpace = THREE.NoColorSpace;
  rt.texture.generateMipmaps = false;
  return rt;
}

/** Reuse `rt` if it already has the size, else replace it. */
export function sized(
  rt: THREE.WebGLRenderTarget | null,
  w: number,
  h: number,
  format: THREE.PixelFormat,
  type: THREE.TextureDataType,
  linear = false,
) {
  if (rt && rt.width === w && rt.height === h) return rt;
  rt?.dispose();
  return makeRT(w, h, format, type, linear);
}

/** Premultiplied "over" (normal drawing) or knockout (dst × (1 − src alpha)) into the stack. */
function setStackBlend(m: THREE.ShaderMaterial, knockout: boolean) {
  const src = knockout ? THREE.ZeroFactor : THREE.OneFactor;
  m.blendEquation = THREE.AddEquation;
  m.blendSrc = src;
  m.blendDst = THREE.OneMinusSrcAlphaFactor;
  m.blendEquationAlpha = THREE.AddEquation;
  m.blendSrcAlpha = src;
  m.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
}

interface Programs {
  seed: THREE.ShaderMaterial;
  jfa: THREE.ShaderMaterial;
  sdf: THREE.ShaderMaterial;
  height: THREE.ShaderMaterial;
  coverInit: THREE.ShaderMaterial;
  coverJfa: THREE.ShaderMaterial;
  coverRadius: THREE.ShaderMaterial;
  blur: THREE.ShaderMaterial;
  reduce: THREE.ShaderMaterial;
  element: THREE.ShaderMaterial;
}

function makePrograms(kit: PassKit): Programs {
  const element = kit.shader({
    uniforms: {
      ...fillUniforms(),
      ...patternUniforms(),
      tMask: { value: null },
      uPicture: { value: false },
      uPictureLinear: { value: false },
      tPicture: { value: null },
      tSdf: { value: null },
      tHeight: { value: null },
      uHasSdf: { value: false },
      uBmin: { value: new THREE.Vector2() },
      uBmax: { value: new THREE.Vector2() },
      uBoxTex: { value: false },
      tBox: { value: null },
      uLight: { value: new THREE.Vector3(0, 0, 1) },
      uSpan: { value: 0 },
      tSpanIdx: { value: null },
      tGlyphs: { value: null },
      uFrameMin: { value: new THREE.Vector2() },
      uM: { value: 1 },
      uElemOff: { value: new THREE.Vector2() },
      uSpanGrow: { value: 0 },
      uBurstPx: { value: 0 },
      tBurstMax: { value: null },
      uBevel: { value: false },
      uBevelK: { value: 1 },
      uGloss: { value: 0 },
      tGlossLut: { value: null },
      uHiColor: { value: new THREE.Vector3(1, 1, 1) },
      uShColor: { value: new THREE.Vector3() },
      uHiOp: { value: 0 },
      uShOp: { value: 0 },
      uRefrPx: { value: 0 },
      uGlass: { value: false },
      uGlassColor: { value: new THREE.Vector3() },
      uGlassTint: { value: 1 },
      uGlassOp: { value: 1 },
      uGlassEdge: { value: 0 },
      uGlassCaustic: { value: 0 },
      uGlassCw: { value: 1 },
      uRefl: { value: false },
      tRefl: { value: null },
      uReflAmt: { value: 1 },
      uReflRot: { value: 0 },
      uReflTint: { value: 0 },
      uReflM: { value: new Float32Array([1, 0, 0, 1]) },
      uSatin: { value: false },
      tSatin: { value: null },
      uSatinOff: { value: new THREE.Vector2() },
      uSatinColor: { value: new THREE.Vector3() },
      uSatinOp: { value: 0 },
      uSatinBlend: { value: 0 },
      uSatinInvert: { value: false },
      tSatinLut: { value: null },
      uFinish: { value: false },
      tRamp: { value: null },
      uFinishAmt: { value: 0 },
      uTex: { value: 0 },
      uTexAmt: { value: 0 },
      uTexPx: { value: 8 },
      uTexBlend: { value: 0 },
      uTexSeed: { value: new THREE.Vector2() },
      uTexRot: { value: new THREE.Vector2(1, 0) },
      uSheen: { value: false },
      uSheenColor: { value: new THREE.Vector3(1, 1, 1) },
      uSheenAmt: { value: 0 },
      uSheenPos: { value: 0 },
      uSheenWidth: { value: 0.35 },
      uGlow: { value: false },
      uGlowColor: { value: new THREE.Vector3() },
      uGlowPx: { value: 1 },
      uGlowOp: { value: 0 },
      uGlowNoise: { value: 0 },
      uCap: { value: false },
      uCapOp: { value: 0 },
      uCapPos: { value: 0.5 },
      uCapSoft: { value: 0.1 },
      uCapCurve: { value: 0 },
      uCapDir: { value: new THREE.Vector2(0, -1) },
      uTexSurface: { value: false },
      uOpacity: { value: 1 },
      uPunch: { value: false },
    },
    fragmentShader: ELEMENT_FRAG,
    blending: THREE.CustomBlending,
  });
  setStackBlend(element, false);
  return {
    seed: kit.shader({ uniforms: { tSrc: { value: null } }, fragmentShader: SEED_FRAG }),
    jfa: kit.shader({ uniforms: { tSrc: { value: null }, uStep: { value: 1 } }, fragmentShader: JFA_FRAG }),
    sdf: kit.shader({ uniforms: { tSeeds: { value: null }, tSrc: { value: null } }, fragmentShader: SDF_FRAG }),
    height: kit.shader({
      uniforms: {
        tSdf: { value: null },
        uSize: { value: 1 },
        uProfile: { value: 0 },
        tProfileLut: { value: null },
        uFit: { value: false },
        tCover: { value: null },
        uFitK: { value: 0.7 },
        uBand: { value: 0 },
      },
      fragmentShader: HEIGHT_FRAG,
    }),
    coverInit: kit.shader({ uniforms: { tSdf: { value: null } }, fragmentShader: COVER_INIT_FRAG }),
    coverJfa: kit.shader({ uniforms: { tSrc: { value: null }, uStep: { value: 1 } }, fragmentShader: COVER_JFA_FRAG }),
    coverRadius: kit.shader({ uniforms: { tSrc: { value: null } }, fragmentShader: COVER_RADIUS_FRAG }),
    blur: kit.shader({
      uniforms: { tSrc: { value: null }, uDir: { value: new THREE.Vector2() }, uSigma: { value: 1 } },
      fragmentShader: BLUR_R_FRAG,
    }),
    reduce: kit.shader({ uniforms: { tSrc: { value: null }, uFirst: { value: true } }, fragmentShader: REDUCE_MAX_FRAG }),
    element,
  };
}

// JFA ping-pong buffers are transient: one pair per WebGL renderer, shared by its material passes
// and freed when the last of them is disposed.
interface JfaBuffers {
  a: THREE.WebGLRenderTarget | null;
  b: THREE.WebGLRenderTarget | null;
  users: Set<object>;
}
const jfaBuffers = new WeakMap<THREE.WebGLRenderer, JfaBuffers>();

// ---------- slots ----------

/** Pixel size of a frame. */
export interface FrameSize {
  w: number;
  h: number;
}

/** What a material derives from one coverage mask, each cached by a key. */
export interface MaterialSlot {
  /**
   * The coverage this shading reads (R = 0..1, frame-sized; SDF, height, burst and satin derive
   * from it) and its key. An alias, never disposed through this field.
   */
  shapeKey: string;
  shape: THREE.WebGLRenderTarget | null;
  sdfKey: string;
  sdf: THREE.WebGLRenderTarget | null;
  heightKey: string;
  height: THREE.WebGLRenderTarget | null;
  /** Fit bevel: local half-thickness (px), rebuilt with the height field. */
  cover: THREE.WebGLRenderTarget | null;
  /** 1×1 max inside distance (px) of the mask, for face shape-burst fills; keyed by sdfKey. */
  burstKey: string;
  burst: THREE.WebGLRenderTarget | null;
  /** Blurred coverage for satin (linear filtered); keyed by shapeKey + blur. */
  satinKey: string;
  satin: THREE.WebGLRenderTarget | null;
}

export const emptyMaterialSlot = (): MaterialSlot => ({
  shapeKey: '',
  shape: null,
  sdfKey: '',
  sdf: null,
  heightKey: '',
  height: null,
  cover: null,
  burstKey: '',
  burst: null,
  satinKey: '',
  satin: null,
});

export function disposeMaterialSlot(s: MaterialSlot) {
  s.sdf?.dispose();
  s.height?.dispose();
  s.cover?.dispose();
  s.burst?.dispose();
  s.satin?.dispose();
}

/** Glyph spans of a text fill (Fill.span 'char' / 'line'): see Title2DRenderer.updateSpanMap. */
export interface SpanInput {
  /** 1 = nearest glyph's ink box, 2 = its line box. */
  mode: 1 | 2;
  idx: THREE.Texture;
  glyphs: THREE.Texture;
  /** Frame origin (layer units) and frame px per layer unit. */
  frameMin: { x: number; y: number };
  m: number;
  /** Element shift (frame px) and growth (frame px). */
  offset: { x: number; y: number };
  grow: number;
}

/** One shading of `mat` over `slot.shape` into a stack. */
export interface ShadeInput {
  mat: Material2D;
  slot: MaterialSlot;
  /** Frame px per 1 % of the size the material's dimensions refer to. */
  unit: number;
  /** That size (layer units) and the frame px per layer unit, for the pattern's motif size. */
  size: number;
  m: number;
  /** Layer-space point (layer units) at frame px (0, 0), anchoring the pattern / the texture. */
  patternOrigin: { x: number; y: number };
  textureOrigin: { x: number; y: number };
  /** Element box: frame px (y-up), or an effects/lib bounds() texture (uv box of the mask). */
  box: { x0: number; y0: number; x1: number; y1: number } | THREE.Texture;
  /** Rim band width (frame px): shape-burst fills run across it; 0 for faces and effects. */
  bandPx: number;
  span: SpanInput | null;
  /**
   * Colour from this texture instead of the fill, texel for texel with the mask: a title image's
   * own picture (straight sRGB) or, `pictureLinear`, an effect's input (premultiplied linear).
   */
  picture: THREE.Texture | null;
  pictureLinear: boolean;
  place: Placement;
  comp: Comp;
}

/** The ELEMENT_FRAG pipeline and its mask-derived fields, for one PassKit. */
export class MaterialPass {
  private readonly kit: PassKit;
  private readonly progs: Programs;
  private jfaRenderer: THREE.WebGLRenderer | null = null;
  /** Intermediate levels of the shape-burst max reduction. */
  private readonly reduceRTs: (THREE.WebGLRenderTarget | null)[] = [];

  constructor(kit: PassKit) {
    this.kit = kit;
    this.progs = makePrograms(kit);
  }

  /** The shared float ping-pong pair, sized to the frame. */
  jfaPair(frame: FrameSize): { a: THREE.WebGLRenderTarget; b: THREE.WebGLRenderTarget } {
    const renderer = this.kit.renderer;
    let buf = jfaBuffers.get(renderer);
    if (!buf) jfaBuffers.set(renderer, (buf = { a: null, b: null, users: new Set() }));
    buf.users.add(this);
    this.jfaRenderer = renderer;
    buf.a = sized(buf.a, frame.w, frame.h, THREE.RGBAFormat, THREE.FloatType);
    buf.b = sized(buf.b, frame.w, frame.h, THREE.RGBAFormat, THREE.FloatType);
    return { a: buf.a, b: buf.b };
  }

  /** SDF of `src` into `slot.sdf`, cached under `key`. */
  updateSdf(slot: MaterialSlot, src: THREE.WebGLRenderTarget, key: string, frame: FrameSize) {
    if (slot.sdfKey === key && slot.sdf) return;
    const kit = this.kit;
    const progs = this.progs;
    const buf = this.jfaPair(frame);
    progs.seed.uniforms.tSrc.value = src.texture;
    kit.run(progs.seed, buf.a);
    let a = buf.a;
    let b = buf.b;
    const steps: number[] = [];
    for (let s = 2 ** Math.ceil(Math.log2(Math.max(frame.w, frame.h))) / 2; s >= 1; s /= 2) steps.push(s);
    steps.push(1);
    for (const s of steps) {
      progs.jfa.uniforms.tSrc.value = a.texture;
      progs.jfa.uniforms.uStep.value = s;
      kit.run(progs.jfa, b);
      [a, b] = [b, a];
    }
    slot.sdf = sized(slot.sdf, frame.w, frame.h, THREE.RedFormat, THREE.HalfFloatType);
    progs.sdf.uniforms.tSeeds.value = a.texture;
    progs.sdf.uniforms.tSrc.value = src.texture;
    kit.run(progs.sdf, slot.sdf);
    slot.sdfKey = key;
    slot.heightKey = '';
  }

  /**
   * Every field `mat` needs from `slot.shape` (SDF, bevel height, shape-burst depth, satin
   * blur), each redone only when its key changed. `bandPx`: rim band width (frame px), 0 else.
   */
  prepare(slot: MaterialSlot, mat: Material2D, unit: number, frame: FrameSize, bandPx: number) {
    const burst = mat.fill.kind === 'shapeBurst';
    const needSdf = mat.bevel.enabled || mat.innerGlow.enabled || burst;
    if (needSdf) this.updateSdf(slot, slot.shape!, slot.shapeKey, frame);
    if (mat.bevel.enabled) this.updateHeight(slot, mat, unit, frame, bandPx);
    if (burst && bandPx === 0) this.updateBurstMax(slot);
    if (mat.satin.enabled) this.updateSatin(slot, mat, unit, frame);
  }

  /**
   * Fit bevel: local half-thickness (px) per pixel — the radius of the largest inscribed circle
   * covering it, by jump flooding circles from the SDF — smoothed so region seams don't crease.
   */
  private updateCover(slot: MaterialSlot, frame: FrameSize, unit: number) {
    const kit = this.kit;
    const progs = this.progs;
    const buf = this.jfaPair(frame);
    progs.coverInit.uniforms.tSdf.value = slot.sdf!.texture;
    kit.run(progs.coverInit, buf.a);
    let a = buf.a;
    let b = buf.b;
    for (let s = 2 ** Math.ceil(Math.log2(Math.max(frame.w, frame.h))) / 2; s >= 1; s /= 2) {
      progs.coverJfa.uniforms.tSrc.value = a.texture;
      progs.coverJfa.uniforms.uStep.value = s;
      kit.run(progs.coverJfa, b);
      [a, b] = [b, a];
    }
    slot.cover = sized(slot.cover, frame.w, frame.h, THREE.RedFormat, THREE.FloatType);
    progs.coverRadius.uniforms.tSrc.value = a.texture;
    kit.run(progs.coverRadius, slot.cover);
    const bu = progs.blur.uniforms;
    bu.uSigma.value = Math.min(32, Math.max(1.5, unit * 0.8));
    bu.tSrc.value = slot.cover.texture;
    (bu.uDir.value as THREE.Vector2).set(1, 0);
    kit.run(progs.blur, b);
    bu.tSrc.value = b.texture;
    (bu.uDir.value as THREE.Vector2).set(0, 1);
    kit.run(progs.blur, slot.cover);
  }

  private updateHeight(slot: MaterialSlot, mat: Material2D, unit: number, frame: FrameSize, bandPx: number) {
    const bv = mat.bevel;
    const fit = bv.sizeMode === 'fit';
    const sizePx = Math.max(0.5, bv.size * unit);
    const softPx = Math.max(0, bv.soften * unit);
    const curveKey = bv.profile === 'custom' ? JSON.stringify(bv.profileCurve.points) : '';
    const fitKey = fit ? `|fit${bv.fit}|${bandPx}` : '';
    const key = `${slot.sdfKey}|${bv.profile}|${curveKey}|${sizePx}|${softPx}${fitKey}`;
    if (slot.heightKey === key && slot.height) return;
    const kit = this.kit;
    const progs = this.progs;
    const tmp = this.jfaPair(frame).a;
    if (fit && bandPx <= 0) this.updateCover(slot, frame, unit);
    slot.height = sized(slot.height, frame.w, frame.h, THREE.RedFormat, THREE.FloatType);
    const hu = progs.height.uniforms;
    hu.tSdf.value = slot.sdf!.texture;
    hu.uSize.value = sizePx;
    hu.uProfile.value = PROFILE_IDS[bv.profile] ?? 0;
    hu.tProfileLut.value = bv.profile === 'custom' ? curveTexture(bv.profileCurve) : null;
    hu.uFit.value = fit;
    hu.uFitK.value = Math.max(0.01, bv.fit / 100);
    hu.uBand.value = bandPx;
    hu.tCover.value = fit && bandPx <= 0 ? slot.cover!.texture : null;
    kit.run(progs.height, slot.height);
    // Soften = blur radius; a minimum blur smooths residual distance-field noise.
    const bu = progs.blur.uniforms;
    bu.uSigma.value = Math.min(32, Math.max(1, softPx / 2));
    bu.tSrc.value = slot.height.texture;
    (bu.uDir.value as THREE.Vector2).set(1, 0);
    kit.run(progs.blur, tmp);
    bu.tSrc.value = tmp.texture;
    (bu.uDir.value as THREE.Vector2).set(0, 1);
    kit.run(progs.blur, slot.height);
    slot.heightKey = key;
  }

  /** Max inside distance of the mask (−SDF), reduced on the GPU to a 1×1 texture. */
  private updateBurstMax(slot: MaterialSlot) {
    if (slot.burstKey === slot.sdfKey && slot.burst) return;
    const kit = this.kit;
    const red = this.progs.reduce;
    let src = slot.sdf!.texture;
    let w = slot.sdf!.width;
    let h = slot.sdf!.height;
    let first = true;
    for (let level = 0; first || w > 1 || h > 1; level++) {
      w = Math.ceil(w / 8);
      h = Math.ceil(h / 8);
      let dst: THREE.WebGLRenderTarget;
      if (w === 1 && h === 1) dst = slot.burst = sized(slot.burst, 1, 1, THREE.RedFormat, THREE.FloatType);
      else dst = this.reduceRTs[level] = sized(this.reduceRTs[level] ?? null, w, h, THREE.RedFormat, THREE.FloatType);
      red.uniforms.tSrc.value = src;
      red.uniforms.uFirst.value = first;
      kit.run(red, dst);
      src = dst.texture;
      first = false;
    }
    slot.burstKey = slot.sdfKey;
  }

  /** Mask blurred by the satin size (Photoshop's size = blur radius ≈ 2σ). */
  private updateSatin(slot: MaterialSlot, mat: Material2D, unit: number, frame: FrameSize) {
    const sigma = Math.min(32, Math.max(0.5, (mat.satin.size * unit) / 2));
    const key = `${slot.shapeKey}|${sigma}`;
    if (slot.satinKey === key && slot.satin) return;
    const kit = this.kit;
    const bu = this.progs.blur.uniforms;
    const tmp = this.jfaPair(frame).a;
    slot.satin = sized(slot.satin, frame.w, frame.h, THREE.RedFormat, THREE.HalfFloatType, true);
    bu.uSigma.value = sigma;
    bu.tSrc.value = slot.shape!.texture;
    (bu.uDir.value as THREE.Vector2).set(1, 0);
    kit.run(this.progs.blur, tmp);
    bu.tSrc.value = tmp.texture;
    (bu.uDir.value as THREE.Vector2).set(0, 1);
    kit.run(this.progs.blur, slot.satin);
    slot.satinKey = key;
  }

  /** Knockout: erase `stack` under the slot's coverage. */
  punch(slot: MaterialSlot, stack: THREE.WebGLRenderTarget) {
    const prog = this.progs.element;
    const u = prog.uniforms;
    u.tMask.value = slot.shape!.texture;
    u.uPunch.value = true;
    setStackBlend(prog, true);
    this.kit.run(prog, stack, false);
    setStackBlend(prog, false);
    u.uPunch.value = false;
  }

  /** Shade `input.mat` over its slot's coverage onto `stack` (premultiplied over), after prepare(). */
  shade(input: ShadeInput, stack: THREE.WebGLRenderTarget) {
    const { mat, slot, unit, m, place, comp } = input;
    const prog = this.progs.element;
    const u = prog.uniforms;

    const box = input.box;
    const boxTex = box instanceof THREE.Texture;
    u.uBoxTex.value = boxTex;
    u.tBox.value = boxTex ? box : null;
    if (!boxTex) {
      (u.uBmin.value as THREE.Vector2).set(box.x0, box.y0);
      (u.uBmax.value as THREE.Vector2).set(box.x1, box.y1);
    }

    setFill(u, mat.fill, 1);
    const span = input.span;
    u.uSpan.value = span ? span.mode : 0;
    u.tSpanIdx.value = span ? span.idx : null;
    u.tGlyphs.value = span ? span.glyphs : null;
    if (span) {
      (u.uFrameMin.value as THREE.Vector2).set(span.frameMin.x, span.frameMin.y);
      u.uM.value = span.m;
      (u.uElemOff.value as THREE.Vector2).set(span.offset.x, span.offset.y);
      u.uSpanGrow.value = span.grow;
    }

    u.tMask.value = slot.shape!.texture;
    u.uPicture.value = !!input.picture;
    u.uPictureLinear.value = input.pictureLinear;
    u.tPicture.value = input.picture;
    u.uOpacity.value = Math.min(1, Math.max(0, mat.opacity));
    const hasSdf = !!slot.sdf && slot.sdfKey === slot.shapeKey;
    u.uHasSdf.value = hasSdf;
    u.tSdf.value = hasSdf ? slot.sdf!.texture : slot.shape!.texture;
    u.uBurstPx.value = input.bandPx;
    u.tBurstMax.value = input.bandPx === 0 && slot.burst && slot.burstKey === slot.sdfKey ? slot.burst.texture : null;

    // Photoshop "Use Global Light": the comp's angle / altitude replace the bevel's own.
    const bv = mat.bevel;
    const light = bv.useGlobalLight ? comp.globalLight : { angle: bv.lightAngle, altitude: bv.lightAltitude };
    const A = layerAngle(light.angle, place) * DEG;
    const E = Math.min(90, Math.max(0, light.altitude)) * DEG;
    (u.uLight.value as THREE.Vector3).set(Math.cos(E) * Math.cos(A), Math.cos(E) * Math.sin(A), Math.sin(E));
    const bevelOn = bv.enabled && !!slot.height && slot.heightKey.startsWith(slot.sdfKey);
    u.uBevel.value = bevelOn;
    u.tHeight.value = bevelOn ? slot.height!.texture : slot.shape!.texture;
    const bevelPx = Math.max(0.5, bv.size * unit);
    u.uBevelK.value = bevelPx * bv.depth * 0.35;
    u.uGloss.value = GLOSS_IDS[bv.gloss] ?? 0;
    u.tGlossLut.value = bv.gloss === 'custom' ? curveTexture(bv.glossCurve) : null;
    (u.uHiColor.value as THREE.Vector3).fromArray(hexToRgb(bv.highlightColor));
    (u.uShColor.value as THREE.Vector3).fromArray(hexToRgb(bv.shadowColor));
    u.uHiOp.value = bv.highlightOpacity;
    u.uShOp.value = bv.shadowOpacity;

    u.uRefrPx.value = mat.refraction * unit;
    const gs = mat.glass;
    u.uGlass.value = gs.enabled;
    (u.uGlassColor.value as THREE.Vector3).fromArray(hexToRgb(gs.color));
    u.uGlassTint.value = gs.tint;
    u.uGlassOp.value = gs.opacity;
    u.uGlassEdge.value = gs.edge;
    u.uGlassCaustic.value = gs.caustic;
    // Light focuses across 1.6 bevel widths.
    u.uGlassCw.value = bevelPx * 1.6;

    const rf = mat.reflection;
    const reflTex = rf.enabled ? reflectionTexture(rf.map, rf.blur) : null;
    u.uRefl.value = reflTex !== null;
    u.tRefl.value = reflTex;
    u.uReflAmt.value = rf.amount;
    u.uReflRot.value = rf.rotation / 360;
    u.uReflTint.value = rf.colorize;
    // Columns: the screen directions of the layer's x and y axes (layerAngle inverted).
    const ax = screenAngle(0, place) * DEG,
      ay = screenAngle(90, place) * DEG;
    (u.uReflM.value as Float32Array).set([Math.cos(ax), Math.sin(ax), Math.cos(ay), Math.sin(ay)]);

    u.uFinish.value = mat.finish.enabled;
    u.tRamp.value = rampTexture(mat.finish.gradient);
    u.uFinishAmt.value = mat.finish.amount;

    // Pattern in element space: anchored to the layer origin (moving with a rim's offset).
    setPatternUniforms(u, mat.pattern, input.size, { linear: false, pxPerUnit: m, origin: input.patternOrigin });

    const sa = mat.satin;
    u.uSatin.value = sa.enabled && !!slot.satin && slot.satinKey.startsWith(`${slot.shapeKey}|`);
    u.tSatin.value = slot.satin?.texture ?? null;
    // The global light keeps the satin direction fixed on screen like the bevel light.
    const SA = (sa.useGlobalLight ? layerAngle(comp.globalLight.angle, place) : sa.angle) * DEG;
    const dist = sa.distance * unit;
    (u.uSatinOff.value as THREE.Vector2).set(Math.cos(SA) * dist, Math.sin(SA) * dist);
    (u.uSatinColor.value as THREE.Vector3).fromArray(hexToRgb(sa.color));
    u.uSatinOp.value = sa.opacity;
    u.uSatinBlend.value = SATIN_BLEND_IDS[sa.blend] ?? 0;
    u.uSatinInvert.value = sa.invert;
    u.tSatinLut.value = sa.enabled ? curveTexture(sa.contour) : null;

    const tx = mat.texture;
    const texPx = Math.max(0.5, tx.scale * unit);
    u.uTex.value = TEX_IDS[tx.kind] ?? 0;
    u.uTexAmt.value = tx.amount;
    u.uTexPx.value = texPx;
    u.uTexBlend.value = TEX_BLEND_IDS[tx.blend] ?? 0;
    u.uTexSurface.value = tx.target === 'surface';
    // Seed → offset in feature space; features are anchored to the layer, not the frame.
    const sx = ((tx.seed * 127.1) % 1000) + (input.textureOrigin.x * m) / texPx;
    const sy = ((tx.seed * 311.7) % 1000) + (input.textureOrigin.y * m) / texPx;
    (u.uTexSeed.value as THREE.Vector2).set(sx, sy);
    (u.uTexRot.value as THREE.Vector2).set(Math.cos(tx.angle * DEG), Math.sin(tx.angle * DEG));

    const sh = mat.sheen;
    u.uSheen.value = sh.enabled && sh.amount > 0;
    (u.uSheenColor.value as THREE.Vector3).fromArray(hexToRgb(sh.color));
    u.uSheenAmt.value = sh.amount;
    u.uSheenPos.value = sh.position;
    u.uSheenWidth.value = Math.max(0.05, sh.width);

    const ig = mat.innerGlow;
    u.uGlow.value = ig.enabled;
    (u.uGlowColor.value as THREE.Vector3).fromArray(hexToRgb(ig.color));
    u.uGlowPx.value = Math.max(0.5, ig.size * unit);
    u.uGlowOp.value = ig.opacity;
    u.uGlowNoise.value = ig.noise;

    const gl = mat.gloss;
    u.uCap.value = gl.enabled;
    u.uCapOp.value = gl.opacity;
    u.uCapPos.value = gl.position;
    u.uCapSoft.value = gl.softness;
    u.uCapCurve.value = gl.curve;
    // Band tilt: "down" across the band, turned clockwise on screen by the angle (y-up vector).
    (u.uCapDir.value as THREE.Vector2).set(-Math.sin(gl.angle * DEG), -Math.cos(gl.angle * DEG));

    this.kit.run(prog, stack, false);
  }

  dispose() {
    for (const p of Object.values(this.progs)) p.dispose();
    for (const rt of this.reduceRTs) rt?.dispose();
    this.reduceRTs.length = 0;
    const buf = this.jfaRenderer && jfaBuffers.get(this.jfaRenderer);
    if (buf) {
      buf.users.delete(this);
      if (buf.users.size === 0) {
        buf.a?.dispose();
        buf.b?.dispose();
        jfaBuffers.delete(this.jfaRenderer!);
      }
    }
    this.jfaRenderer = null;
  }
}

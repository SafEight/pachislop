import * as THREE from 'three';
import type { Layer, LayerMask, ShapeSource } from '../model/types';
import { blur } from '../effects/lib';
import { shapeCmds } from '../text/shapes';
import { version } from './layerSource';
import type { PassKit } from './passkit';
import type { Surface } from './surface';

// Layer masks (LayerBase.masks) on the GPU. Each enabled mask is rasterised at the render size
// of the surface (shape: Canvas2D fill of shapeCmds; gradient: analytic; layer: the source layer
// drawn alone through the surface's FrameSource), feathered (Gaussian, radius = feather comp px ×
// pxScale like every blur 'size' of the app), then inverted and weakened by density, and the
// masks multiply in list order. The combined mask lives in the red channel of a half-float
// target of this module, cached per layer and pool across frames by a key naming everything it
// depends on (see `combined`); `sweep` frees the ones a render did not use.

const DEG = Math.PI / 180;

/** 2D affine map p ↦ (a·x + c·y + e, b·x + d·y + f), in Canvas2D setTransform order. */
interface Affine {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

const IDENTITY: Affine = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

/** m ∘ n */
function mul(m: Affine, n: Affine): Affine {
  return {
    a: m.a * n.a + m.c * n.b,
    b: m.b * n.a + m.d * n.b,
    c: m.a * n.c + m.c * n.d,
    d: m.b * n.c + m.d * n.d,
    e: m.a * n.e + m.c * n.f + m.e,
    f: m.b * n.e + m.d * n.f + m.f,
  };
}

/** The inverse of `m`; all zeros when it is degenerate (a layer at scale 0: its masks are constant, it draws nothing anyway). */
function inverse(m: Affine): Affine {
  const det = m.a * m.d - m.b * m.c;
  if (!(Math.abs(det) > 1e-12)) return { a: 0, b: 0, c: 0, d: 0, e: 0, f: 0 };
  const a = m.d / det;
  const b = -m.b / det;
  const c = -m.c / det;
  const d = m.a / det;
  return { a, b, c, d, e: -(a * m.e + c * m.f), f: -(b * m.e + d * m.f) };
}

/** Mirror by `fx` / `fy` and scale by `s`, turn by `deg` clockwise on screen (y-up), then move to (x, y). */
function placeAt(x: number, y: number, deg: number, s = 1, fx = 1, fy = 1): Affine {
  const r = -deg * DEG;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return { a: cos * s * fx, b: sin * s * fx, c: -sin * s * fy, d: cos * s * fy, e: x, f: y };
}

/**
 * Mask space → comp px (centre origin, y-up). Linked masks ride the layer: its flip (before
 * rotZ, about the position), scale, rotZ and position, x / y / rotZ / scale only for 3D layers;
 * unlinked and layer masks are in comp space.
 */
function maskToComp(layer: Layer, m: LayerMask): Affine {
  if (!m.linked || m.kind === 'layer') return IDENTITY;
  const t = layer.transform;
  return placeAt(t.x, t.y, t.rotZ, t.scale, t.flipX ? -1 : 1, t.flipY ? -1 : 1);
}

/** Render uv (0..1, origin bottom-left) → comp px of surface `s`. */
const uvToComp = (s: Surface): Affine => ({ a: s.width / s.scale, b: 0, c: 0, d: s.height / s.scale, e: -s.width / 2 / s.scale, f: -s.height / 2 / s.scale });

/** Comp px → Canvas2D px of a render-sized canvas of `s` (top row first). */
const compToCanvas = (s: Surface): Affine => ({ a: s.scale, b: 0, c: 0, d: -s.scale, e: s.width / 2, f: s.height / 2 });

const paths = new WeakMap<ShapeSource, Path2D>();

/** The outline of `src` (shapeCmds, layer space) as a Path2D, memoized per source object. */
function shapePath(src: ShapeSource): Path2D {
  let p = paths.get(src);
  if (p) return p;
  p = new Path2D();
  for (const c of shapeCmds(src)) {
    if (c.type === 'M') p.moveTo(c.x, c.y);
    else if (c.type === 'L') p.lineTo(c.x, c.y);
    else if (c.type === 'Q') p.quadraticCurveTo(c.x1, c.y1, c.x, c.y);
    else if (c.type === 'C') p.bezierCurveTo(c.x1, c.y1, c.x2, c.y2, c.x, c.y);
    else p.closePath();
  }
  paths.set(src, p);
  return p;
}

/** Which value of a mask source texture a pass reads (see the `value` GLSL of maskCombine). */
const CHANNEL = { value: 0, alpha: 1, luminance: 2 } as const;

/** A mask's raster before feather / invert / density: a texture and the channel holding its value. */
interface MaskSource {
  tex: THREE.Texture;
  channel: number;
  /** Pool RT of the surface's kit to release once read, if any. */
  own: THREE.WebGLRenderTarget | null;
}

/** A combined mask kept for reuse (see Masks.combined). */
interface Entry {
  key: string;
  rt: THREE.WebGLRenderTarget;
  /** Read since the last sweep of its pool. */
  used: boolean;
}

/** Opaque white `w`×`h` pixels: no mask. */
function whiteImage(w: number, h: number): ImageData {
  const img = new ImageData(w, h);
  img.data.fill(255);
  return img;
}

export class Masks {
  private readonly gradientMat: THREE.ShaderMaterial;
  private readonly combineMat: THREE.ShaderMaterial;
  private readonly applyMat: THREE.ShaderMaterial;
  private readonly greyMat: THREE.ShaderMaterial;
  private readonly toLocal = new THREE.Matrix3();
  /** Combined masks per pool (one per render size in use) and layer id. */
  private readonly entries = new Map<PassKit, Map<string, Entry>>();
  /** Pools that rendered masks since the last sweep. */
  private readonly touched = new Set<PassKit>();
  /** Render-sized canvas the shape masks are filled on, and its texture. */
  private canvas: OffscreenCanvas | null = null;
  private canvasTex: THREE.CanvasTexture | null = null;

  /** `kit`: the pool whose renderer compiles the shaders (they run on any pool of that renderer). */
  constructor(kit: PassKit) {
    this.gradientMat = kit.shader({
      uniforms: {
        uToLocal: { value: this.toLocal },
        uStart: { value: new THREE.Vector2() },
        uDir: { value: new THREE.Vector2() },
        uLen: { value: 1 },
        uInner: { value: 0 },
        uGamma: { value: 1 },
        uRadial: { value: false },
      },
      // opaque (1) at the start / inside length × inner, transparent at length, half at `mid` (t^γ = ½)
      fragmentShader: /* glsl */ `
        uniform mat3 uToLocal; uniform vec2 uStart, uDir; uniform float uLen, uInner, uGamma; uniform bool uRadial;
        in vec2 vUv; out vec4 o;
        void main() {
          vec2 p = (uToLocal * vec3(vUv, 1.0)).xy - uStart;
          float t = uRadial ? (length(p) - uInner * uLen) / max(uLen * (1.0 - uInner), 1e-4) : dot(p, uDir) / max(uLen, 1e-4);
          o = vec4(1.0 - pow(clamp(t, 0.0, 1.0), uGamma));
        }`,
    });
    this.combineMat = kit.shader({
      uniforms: {
        tSrc: { value: null },
        tAcc: { value: null },
        uChannel: { value: 0 },
        uFirst: { value: true },
        uInvert: { value: false },
        uDensity: { value: 1 },
      },
      // value: the red channel, the alpha, or the luminance of sRGB-encoded straight colour × alpha
      // (white = shown, as a designer reads a matte); then invert, density, × the masks so far
      fragmentShader: /* glsl */ `
        uniform sampler2D tSrc, tAcc; uniform int uChannel; uniform bool uFirst, uInvert; uniform float uDensity;
        in vec2 vUv; out vec4 o;
        vec3 toSRGB(vec3 c) { c = clamp(c, 0.0, 1.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
        void main() {
          vec4 c = texture(tSrc, vUv);
          float a = clamp(c.a, 0.0, 1.0);
          float v = uChannel == 0 ? clamp(c.r, 0.0, 1.0)
            : uChannel == 1 ? a
            : a > 0.0 ? dot(toSRGB(c.rgb / a), vec3(0.2126, 0.7152, 0.0722)) * a : 0.0;
          if (uInvert) v = 1.0 - v;
          v = 1.0 - uDensity * (1.0 - v);
          o = vec4(uFirst ? v : texture(tAcc, vUv).r * v);
        }`,
    });
    this.applyMat = kit.shader({
      uniforms: { tSrc: { value: null }, tMask: { value: null } },
      fragmentShader: /* glsl */ `
        uniform sampler2D tSrc, tMask; in vec2 vUv; out vec4 o;
        void main() { o = texture(tSrc, vUv) * texture(tMask, vUv).r; }`,
    });
    this.greyMat = kit.shader({
      uniforms: { tSrc: { value: null } },
      fragmentShader: /* glsl */ `
        uniform sampler2D tSrc; in vec2 vUv; out vec4 o;
        void main() { o = vec4(vec3(clamp(texture(tSrc, vUv).r, 0.0, 1.0)), 1.0); }`,
    });
  }

  /**
   * `px` (a pool RT of `s.kit`: a node's final pixels) × the combined enabled masks of `layer`;
   * returns the new pool RT and releases `px`. Without an enabled mask `px` itself, no GPU work.
   */
  apply(layer: Layer, px: THREE.WebGLRenderTarget, s: Surface): THREE.WebGLRenderTarget {
    const mask = this.combined(layer, s);
    if (!mask) return px;
    const out = s.kit.acquire();
    this.applyMat.uniforms.tSrc.value = px.texture;
    this.applyMat.uniforms.tMask.value = mask;
    s.kit.run(this.applyMat, out);
    s.kit.release(px);
    return out;
  }

  /**
   * The combined enabled masks of `layer` at the render size of `s` (value in red, 1 = shown),
   * or null when it has none that draw (no enabled mask, or only layer masks whose source gives
   * no alpha: missing, an adjustment, or a cycle; such a mask counts as fully shown). Owned
   * here: valid until the next `sweep`. Re-rendered only when its key changes: the render size,
   * each mask object, the layer's placement for linked masks, each layer source's alphaKey.
   */
  combined(layer: Layer, s: Surface): THREE.Texture | null {
    if (!layer.masks.some((m) => m.enabled)) return null;
    return s.source.drawing(layer.id, () => {
      const t = layer.transform;
      const place = `${t.x},${t.y},${t.rotZ},${t.scale},${t.flipX ? 1 : 0}${t.flipY ? 1 : 0}`;
      const list: LayerMask[] = [];
      let key = `${s.width}x${s.height}@${s.scale}`;
      for (const m of layer.masks) {
        if (!m.enabled) continue;
        let part = `|${version(m)}`;
        if (m.kind === 'layer') {
          const k = s.source.alphaKey(m.layerId);
          if (k === null) continue;
          part += `:${k}`;
        } else if (m.linked) part += `:${place}`;
        list.push(m);
        key += part;
      }
      if (list.length === 0) return null;
      this.touched.add(s.kit);
      let pool = this.entries.get(s.kit);
      if (!pool) this.entries.set(s.kit, (pool = new Map()));
      let e = pool.get(layer.id);
      if (e && e.key === key) {
        e.used = true;
        return e.rt.texture;
      }
      if (!e) {
        const rt = new THREE.WebGLRenderTarget(s.width, s.height, {
          type: THREE.HalfFloatType,
          format: THREE.RedFormat,
          minFilter: THREE.LinearFilter,
          magFilter: THREE.LinearFilter,
          wrapS: THREE.ClampToEdgeWrapping,
          wrapT: THREE.ClampToEdgeWrapping,
          depthBuffer: false,
        });
        rt.texture.colorSpace = THREE.LinearSRGBColorSpace;
        pool.set(layer.id, (e = { key, rt, used: true }));
      } else if (e.rt.width !== s.width || e.rt.height !== s.height) e.rt.setSize(s.width, s.height);
      e.key = key;
      e.used = true;
      this.draw(list, layer, s, e.rt);
      return e.rt.texture;
    });
  }

  /**
   * Mask `mask` of `layer` alone (enabled or not) with its feather, invert and density, at the
   * render size of `s`: a pool RT of `s.kit` (caller releases), null for a layer mask whose
   * source gives no alpha.
   */
  single(layer: Layer, mask: LayerMask, s: Surface): THREE.WebGLRenderTarget | null {
    return s.source.drawing(layer.id, () => {
      if (mask.kind === 'layer' && s.source.alphaKey(mask.layerId) === null) return null;
      const rt = s.kit.acquire();
      this.draw([mask], layer, s, rt);
      return rt;
    });
  }

  /** Mask texture `tex` (value in red; null = no mask) as opaque greyscale pixels of `s`'s size, top row first. */
  readGrey(tex: THREE.Texture | null, s: Surface): ImageData {
    const { width: w, height: h, kit } = s;
    if (!tex) return whiteImage(w, h);
    const rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.UnsignedByteType, format: THREE.RGBAFormat, depthBuffer: false });
    try {
      this.greyMat.uniforms.tSrc.value = tex;
      kit.run(this.greyMat, rt);
      const buf = new Uint8Array(w * h * 4);
      kit.renderer.readRenderTargetPixels(rt, 0, 0, w, h, buf);
      const img = new ImageData(w, h);
      const row = w * 4;
      for (let y = 0; y < h; y++) img.data.set(buf.subarray((h - 1 - y) * row, (h - y) * row), y * row);
      return img;
    } finally {
      rt.dispose();
    }
  }

  /** End of a render: free the combined masks of the pools it used that it did not read. */
  sweep() {
    for (const kit of this.touched) {
      const pool = this.entries.get(kit);
      if (!pool) continue;
      for (const [id, e] of pool) {
        if (e.used) e.used = false;
        else {
          e.rt.dispose();
          pool.delete(id);
        }
      }
      if (pool.size === 0) this.entries.delete(kit);
    }
    this.touched.clear();
  }

  dispose() {
    for (const pool of this.entries.values()) for (const e of pool.values()) e.rt.dispose();
    this.entries.clear();
    this.touched.clear();
    this.canvasTex?.dispose();
    this.canvasTex = null;
    this.canvas = null;
    for (const m of [this.gradientMat, this.combineMat, this.applyMat, this.greyMat]) m.dispose();
  }

  /** The masks of `list` combined into `target` (layer masks only with a source that gives alpha). */
  private draw(list: readonly LayerMask[], layer: Layer, s: Surface, target: THREE.WebGLRenderTarget) {
    const { kit } = s;
    const u = this.combineMat.uniforms;
    let acc: THREE.WebGLRenderTarget | null = null;
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      let src = this.source(m, layer, s);
      const radius = Math.max(0, m.feather) * s.scale;
      if (radius > 0) {
        // the value first (luminance does not commute with the blur), then the Gaussian
        const val = kit.acquire();
        u.tSrc.value = src.tex;
        u.uChannel.value = src.channel;
        // tAcc unbound: a pool RT released earlier may be `val` now (feedback loop)
        u.tAcc.value = null;
        u.uFirst.value = true;
        u.uInvert.value = false;
        u.uDensity.value = 1;
        kit.run(this.combineMat, val);
        if (src.own) kit.release(src.own);
        const ctx = { renderer: s.ctx.renderer, kit, width: s.width, height: s.height, pxScale: s.scale, layerId: layer.id, comp: s.ctx.project.comp, draft: s.ctx.draft };
        const blurred = blur(ctx, val.texture, radius, 'mask');
        kit.release(val);
        src = { tex: blurred.texture, channel: CHANNEL.value, own: null };
      }
      const out = i === list.length - 1 ? target : kit.acquire();
      u.tSrc.value = src.tex;
      u.tAcc.value = acc?.texture ?? null;
      u.uChannel.value = src.channel;
      u.uFirst.value = acc === null;
      u.uInvert.value = m.invert;
      u.uDensity.value = Math.min(1, Math.max(0, m.density));
      kit.run(this.combineMat, out);
      if (src.own) kit.release(src.own);
      if (acc) kit.release(acc);
      acc = out === target ? null : out;
    }
  }

  /** Mask `m`'s raster before feather / invert / density. */
  private source(m: LayerMask, layer: Layer, s: Surface): MaskSource {
    switch (m.kind) {
      case 'layer':
        // the caller checked its alphaKey: it draws (FrameSource renders it once per frame)
        return { tex: s.source.alpha(m.layerId)!, channel: m.channel === 'alpha' ? CHANNEL.alpha : CHANNEL.luminance, own: null };
      case 'gradient': {
        const local = mul(inverse(maskToComp(layer, m)), uvToComp(s));
        this.toLocal.set(local.a, local.c, local.e, local.b, local.d, local.f, 0, 0, 1);
        const u = this.gradientMat.uniforms;
        u.uStart.value.set(m.x, m.y);
        u.uDir.value.set(Math.cos(m.angle * DEG), Math.sin(m.angle * DEG));
        u.uLen.value = Math.max(0, m.length);
        u.uInner.value = Math.min(1, Math.max(0, m.inner));
        u.uGamma.value = Math.log(0.5) / Math.log(Math.min(0.99, Math.max(0.01, m.mid)));
        u.uRadial.value = m.shape === 'radial';
        const rt = s.kit.acquire();
        s.kit.run(this.gradientMat, rt);
        return { tex: rt.texture, channel: CHANNEL.value, own: rt };
      }
      case 'shape': {
        const g = this.scratch(s.width, s.height);
        const t = mul(mul(compToCanvas(s), maskToComp(layer, m)), placeAt(m.x, m.y, m.rotation));
        g.setTransform(t.a, t.b, t.c, t.d, t.e, t.f);
        g.fillStyle = '#fff';
        g.fill(shapePath(m.source), 'nonzero');
        const tex = this.canvasTex!;
        tex.needsUpdate = true;
        return { tex, channel: CHANNEL.alpha, own: null };
      }
    }
  }

  /** The cleared render-sized shape canvas (identity transform). */
  private scratch(w: number, h: number): OffscreenCanvasRenderingContext2D {
    if (!this.canvas || this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas = new OffscreenCanvas(w, h);
      this.canvasTex?.dispose();
      this.canvasTex = new THREE.CanvasTexture(this.canvas as unknown as HTMLCanvasElement);
      this.canvasTex.flipY = true;
      this.canvasTex.premultiplyAlpha = false;
      this.canvasTex.generateMipmaps = false;
      this.canvasTex.minFilter = THREE.NearestFilter;
      this.canvasTex.magFilter = THREE.NearestFilter;
    }
    const g = this.canvas.getContext('2d')!;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, w, h);
    return g;
  }
}

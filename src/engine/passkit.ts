import * as THREE from 'three';
import { bakeGradient } from '../model/gradient';
import type { Gradient } from '../model/types';

// Shared GPU plumbing for the compositor, layer renderers and effects.
//
// Pixel contract (applies to every layer output, effect input and effect output):
//   * HalfFloat RGBA render targets at the current render size (comp size * pxScale)
//   * linear-light colour, PREMULTIPLIED alpha
//   * texture uv (0,0) = bottom-left of the comp

export const FULLSCREEN_VERT = /* glsl */ `
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export class PassKit {
  readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly quad: THREE.Mesh;
  private readonly free: THREE.WebGLRenderTarget[] = [];
  private readonly all = new Set<THREE.WebGLRenderTarget>();
  private readonly copyMat: THREE.ShaderMaterial;
  private readonly gradientCache = new Map<string, THREE.DataTexture>();
  width = 1;
  height = 1;
  /** Bumped whenever setSize changes the size: every pooled target's pixels are gone then. */
  generation = 0;

  constructor(renderer: THREE.WebGLRenderer) {
    this.renderer = renderer;
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
    this.copyMat = this.shader({
      uniforms: { tSrc: { value: null }, uOpacity: { value: 1 } },
      fragmentShader: /* glsl */ `
        uniform sampler2D tSrc; uniform float uOpacity; in vec2 vUv; out vec4 o;
        void main() { o = texture(tSrc, vUv) * uOpacity; }`,
    });
  }

  /** Create a GLSL3 fullscreen shader material. Fragment shader declares `in vec2 vUv; out vec4 o;`. */
  shader(opts: {
    uniforms: Record<string, THREE.IUniform>;
    fragmentShader: string;
    blending?: THREE.Blending;
    defines?: Record<string, string | number>;
  }): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: opts.fragmentShader,
      uniforms: opts.uniforms,
      defines: opts.defines ?? {},
      depthTest: false,
      depthWrite: false,
      transparent: opts.blending !== undefined && opts.blending !== THREE.NoBlending,
      blending: opts.blending ?? THREE.NoBlending,
      premultipliedAlpha: true,
    });
  }

  /** Resize the pool. Called by the engine whenever the render size changes. */
  setSize(width: number, height: number) {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.generation++;
    for (const rt of this.all) rt.setSize(width, height);
  }

  /** Get a scratch RT at the current size. Contents are undefined; release when done. */
  acquire(): THREE.WebGLRenderTarget {
    const rt = this.free.pop();
    if (rt) return rt;
    const fresh = new THREE.WebGLRenderTarget(this.width, this.height, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      depthBuffer: true,
      samples: 0,
    });
    fresh.texture.colorSpace = THREE.LinearSRGBColorSpace;
    this.all.add(fresh);
    return fresh;
  }

  release(rt: THREE.WebGLRenderTarget) {
    if (this.all.has(rt) && !this.free.includes(rt)) this.free.push(rt);
  }

  /** Draw `material` over the whole of `target` (null = canvas). Clears first unless clear=false. */
  run(material: THREE.Material, target: THREE.WebGLRenderTarget | null, clear = true) {
    this.quad.material = material;
    const r = this.renderer;
    const prevAutoClear = r.autoClear;
    r.autoClear = false;
    r.setRenderTarget(target);
    if (clear) {
      r.setClearColor(0x000000, 0);
      r.clear(true, true, false);
    }
    r.render(this.scene, this.camera);
    r.autoClear = prevAutoClear;
  }

  copy(src: THREE.Texture, target: THREE.WebGLRenderTarget | null, opacity = 1) {
    this.copyMat.uniforms.tSrc.value = src;
    this.copyMat.uniforms.uOpacity.value = opacity;
    this.run(this.copyMat, target);
  }

  clear(target: THREE.WebGLRenderTarget) {
    const r = this.renderer;
    r.setRenderTarget(target);
    r.setClearColor(0x000000, 0);
    r.clear(true, true, false);
  }

  /**
   * 256x1 gradient lookup texture: linear-light RGB, straight stop alpha in A. Cached by the
   * whole gradient (stops with alpha / midpoints, and the interpolation space).
   */
  gradientTexture(g: Gradient): THREE.DataTexture {
    const key = JSON.stringify(g);
    let tex = this.gradientCache.get(key);
    if (tex) return tex;
    tex = new THREE.DataTexture(bakeGradient(g, 256), 256, 1, THREE.RGBAFormat);
    tex.colorSpace = THREE.SRGBColorSpace; // sampled → linear
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    if (this.gradientCache.size > 200) {
      for (const t of this.gradientCache.values()) t.dispose();
      this.gradientCache.clear();
    }
    this.gradientCache.set(key, tex);
    return tex;
  }

  dispose() {
    for (const rt of this.all) rt.dispose();
    for (const t of this.gradientCache.values()) t.dispose();
    this.copyMat.dispose();
    this.quad.geometry.dispose();
  }
}

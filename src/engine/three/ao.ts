import * as THREE from 'three';
import type { RenderFrame } from '../contracts';
import type { PassKit } from '../passkit';

// Screen-space ambient occlusion for 3D layers (Element 3D SSAO), Scalable-AO style
// (McGuire et al. 2012): darkens the crevices between bevel bands, letters and backplates.
//
//   scene ─ normal / depth prepass (view-space normal + linear depth, AO grid)
//         ─ AO: a spiral of taps over a disc of the world-space radius projected at the
//           pixel's depth; each tap's view position occludes by its height over the
//           tangent plane, with a smooth falloff at the radius
//         ─ bilateral blur (depth-aware separable gaussian) to remove the per-pixel jitter
//         ─ multiplied into the layer's HDR render (premultiplied colour, alpha kept)
//
// The AO grid is the layer's output resolution (comp px × export scale), not the supersampled
// one: occlusion is soft, so it upsamples bilinearly for free. The radius comes in world units
// (layer px × layer scale), so it covers the same part of the title at every export scale.

export interface AOParams {
  /** Sample radius in world units (comp px on the z = 0 plane). */
  radius: number;
  /** 0..2 strength. */
  intensity: number;
}

/** Taps per pixel and spiral turns (co-prime, so the taps don't line up). */
const TAPS = 16;
const TURNS = 7;
/** Blur radius in AO-grid px. */
const BLUR_RADIUS = 4;

const ND_VERT = /* glsl */ `
out vec3 vNormal;
out float vDepth;
#include <common>
void main() {
  vNormal = normalize( normalMatrix * normal );
  vec4 mv = modelViewMatrix * vec4( position, 1.0 );
  vDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

const ND_FRAG = /* glsl */ `
in vec3 vNormal;
in float vDepth;
out vec4 o;
void main() {
  vec3 n = normalize( vNormal ) * ( gl_FrontFacing ? 1.0 : -1.0 );
  o = vec4( n, vDepth );
}
`;

const VIEW_POS = /* glsl */ `
uniform mat4 uProjInv;
// view-space position of the pixel at uv with linear depth z (any perspective projection,
// view offsets included)
vec3 viewPos( vec2 uv, float z ) {
  vec4 p = uProjInv * vec4( uv * 2.0 - 1.0, -1.0, 1.0 );
  vec3 d = p.xyz / p.w;
  return d * ( z / -d.z );
}
`;

const AO_FRAG = /* glsl */ `
uniform sampler2D tND;
uniform float uRadius; // view units
uniform float uProjScale; // AO-grid px per view unit at depth 1
uniform float uIntensity;
uniform vec2 uFrameOrigin; // the AO grid's bottom-left px in the whole render (RenderFrame x, y)
in vec2 vUv;
out vec4 o;
${VIEW_POS}
void main() {
  ivec2 size = textureSize( tND, 0 );
  vec4 nd = texelFetch( tND, ivec2( gl_FragCoord.xy ), 0 );
  o = vec4( 1.0 );
  if ( nd.a <= 0.0 ) return;
  vec3 P = viewPos( vUv, nd.a );
  vec3 N = normalize( nd.xyz );
  float rPx = uRadius * uProjScale / nd.a;
  if ( rPx < 1.0 ) return;
  // interleaved gradient noise: per-pixel spiral rotation, removed by the blur; keyed on the
  // whole render's px, so a preview window jitters as the whole render does there
  vec2 px = gl_FragCoord.xy + uFrameOrigin;
  float rnd = 6.2831853 * fract( 52.9829189 * fract( dot( px, vec2( 0.06711056, 0.00583715 ) ) ) );
  float r2 = uRadius * uRadius;
  float bias = 0.02 * uRadius;
  float sum = 0.0;
  for ( int i = 0; i < ${TAPS}; i ++ ) {
    float a = ( float( i ) + 0.5 ) / ${TAPS}.0;
    float ang = a * ${TURNS}.0 * 6.2831853 + rnd;
    vec2 off = vec2( cos( ang ), sin( ang ) ) * a * rPx;
    ivec2 q = ivec2( gl_FragCoord.xy + off );
    if ( any( lessThan( q, ivec2( 0 ) ) ) || any( greaterThanEqual( q, size ) ) ) continue;
    float qz = texelFetch( tND, q, 0 ).a;
    if ( qz <= 0.0 ) continue;
    vec3 v = viewPos( ( vec2( q ) + 0.5 ) / vec2( size ), qz ) - P;
    float vv = dot( v, v );
    float vn = dot( v, N );
    // falloff by the distance ALONG the surface, not in 3D: the face of a letter standing far
    // above the plate (behind which its wall is hidden from the camera) still shades the
    // plate at its foot, out to one radius; only very tall occluders (8 radii) fade out
    float t = max( vv - vn * vn, 0.0 ) / r2;
    float f = max( 1.0 - t, 0.0 ) * clamp( 1.0 - vn / ( 8.0 * uRadius ), 0.0, 1.0 );
    sum += f * f * max( ( vn - bias ) / ( sqrt( vv ) + 0.01 * uRadius ), 0.0 );
  }
  // the render is HDR (lit faces often 2–4× white before tone mapping), so occlusion must reach
  // deep to read after the tone curve: (1 − 2·mean)^(2·intensity)
  o = vec4( vec3( pow( max( 0.0, 1.0 - 2.0 * sum / ${TAPS}.0 ), 2.0 * uIntensity ) ), 1.0 );
}
`;

const BLUR_FRAG = /* glsl */ `
uniform sampler2D tAO;
uniform sampler2D tND;
uniform ivec2 uAxis;
in vec2 vUv;
out vec4 o;
void main() {
  ivec2 p = ivec2( gl_FragCoord.xy );
  ivec2 last = textureSize( tAO, 0 ) - 1;
  float z = texelFetch( tND, p, 0 ).a;
  if ( z <= 0.0 ) { o = vec4( 1.0 ); return; }
  float s = 0.0;
  float ws = 0.0;
  for ( int i = -${BLUR_RADIUS}; i <= ${BLUR_RADIUS}; i ++ ) {
    ivec2 q = clamp( p + uAxis * i, ivec2( 0 ), last );
    float qz = texelFetch( tND, q, 0 ).a;
    if ( qz <= 0.0 ) continue;
    float x = float( i ) / ${BLUR_RADIUS / 2}.0;
    // depth-aware: taps across a depth jump (letter over plate) don't bleed
    float w = exp( -0.5 * x * x ) * exp( -abs( qz - z ) / ( 0.02 * z ) );
    s += texelFetch( tAO, q, 0 ).r * w;
    ws += w;
  }
  o = vec4( vec3( ws > 0.0 ? s / ws : 1.0 ), 1.0 );
}
`;

const APPLY_FRAG = /* glsl */ `
uniform sampler2D tAO;
in vec2 vUv;
out vec4 o;
void main() { o = vec4( texture( tAO, vUv ).rrr, 1.0 ); }
`;

export class AOPass {
  private readonly kit: PassKit;
  private readonly nd = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: ND_VERT, fragmentShader: ND_FRAG });
  private readonly ao: THREE.ShaderMaterial;
  private readonly blur: THREE.ShaderMaterial;
  private readonly apply: THREE.ShaderMaterial;
  private readonly ndRT: THREE.WebGLRenderTarget;
  private readonly aoRT: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget];
  /** Scratch copy of the camera without its view offset (frameProjection). */
  private readonly whole = new THREE.PerspectiveCamera();

  constructor(kit: PassKit) {
    this.kit = kit;
    this.ao = kit.shader({
      uniforms: {
        tND: { value: null },
        uProjInv: { value: new THREE.Matrix4() },
        uRadius: { value: 1 },
        uProjScale: { value: 1 },
        uIntensity: { value: 1 },
        uFrameOrigin: { value: new THREE.Vector2() },
      },
      fragmentShader: AO_FRAG,
    });
    this.blur = kit.shader({
      uniforms: { tAO: { value: null }, tND: { value: null }, uAxis: { value: new THREE.Vector2(1, 0) } },
      fragmentShader: BLUR_FRAG,
    });
    // dst = dst × ao on colour, alpha untouched (premultiplied colour stays consistent)
    this.apply = kit.shader({ uniforms: { tAO: { value: null } }, fragmentShader: APPLY_FRAG, blending: THREE.CustomBlending });
    this.apply.blendSrc = THREE.ZeroFactor;
    this.apply.blendDst = THREE.SrcColorFactor;
    this.apply.blendSrcAlpha = THREE.ZeroFactor;
    this.apply.blendDstAlpha = THREE.OneFactor;
    const rt = (depth: boolean) => {
      const t = new THREE.WebGLRenderTarget(1, 1, {
        type: depth ? THREE.FloatType : THREE.HalfFloatType, // linear depth needs float precision
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: depth,
      });
      t.texture.colorSpace = THREE.LinearSRGBColorSpace;
      return t;
    };
    this.ndRT = rt(true);
    this.aoRT = [rt(false), rt(false)];
    this.ndRT.texture.minFilter = THREE.NearestFilter;
    this.ndRT.texture.magFilter = THREE.NearestFilter;
  }

  /**
   * The projection of the whole render `camera` shows a window of (its view offset cleared):
   * the camera's own when it has none.
   */
  private frameProjection(camera: THREE.PerspectiveCamera): THREE.Matrix4 {
    if (!camera.view?.enabled) return camera.projectionMatrix;
    this.whole.copy(camera, false);
    this.whole.clearViewOffset();
    return this.whole.projectionMatrix;
  }

  /**
   * Darken `target` (the layer's HDR render of `scene` through `camera`) by AO computed on a
   * `width`×`height` grid: the render px of `frame` (the camera's view offset, if any, is that
   * window). `hide` objects (e.g. the shadow catcher) stay out of the prepass.
   */
  render(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    target: THREE.WebGLRenderTarget,
    width: number,
    height: number,
    frame: RenderFrame,
    hide: THREE.Object3D[],
    p: AOParams,
  ) {
    for (const t of [this.ndRT, ...this.aoRT]) if (t.width !== width || t.height !== height) t.setSize(width, height);

    // normal / depth prepass (no shadow-map refresh, no catcher)
    const prevOverride = scene.overrideMaterial;
    const prevShadow = renderer.shadowMap.enabled;
    const visible = hide.map((o) => o.visible);
    for (const o of hide) o.visible = false;
    scene.overrideMaterial = this.nd;
    renderer.shadowMap.enabled = false;
    renderer.setRenderTarget(this.ndRT);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, true);
    renderer.render(scene, camera);
    scene.overrideMaterial = prevOverride;
    renderer.shadowMap.enabled = prevShadow;
    hide.forEach((o, i) => (o.visible = visible[i]));

    const u = this.ao.uniforms;
    u.tND.value = this.ndRT.texture;
    u.uProjInv.value.copy(camera.projectionMatrixInverse);
    u.uRadius.value = Math.max(1e-3, p.radius);
    // projectionMatrix[1][1] = 2·near / (top − bottom): NDC per view unit at depth 1, over the
    // whole frame's height (a window's view offset narrows top − bottom to the window)
    u.uProjScale.value = (frame.height / 2) * this.frameProjection(camera).elements[5];
    u.uFrameOrigin.value.set(frame.x, frame.y);
    u.uIntensity.value = Math.max(0, p.intensity);
    this.kit.run(this.ao, this.aoRT[0]);

    const b = this.blur.uniforms;
    b.tND.value = this.ndRT.texture;
    b.tAO.value = this.aoRT[0].texture;
    b.uAxis.value.set(1, 0);
    this.kit.run(this.blur, this.aoRT[1]);
    b.tAO.value = this.aoRT[1].texture;
    b.uAxis.value.set(0, 1);
    this.kit.run(this.blur, this.aoRT[0]);

    this.apply.uniforms.tAO.value = this.aoRT[0].texture;
    this.kit.run(this.apply, target, false);
  }

  /** Multiply the AO of the last `render` into `target`, another render of the same view (a part render's parts after its whole). */
  applyAgain(target: THREE.WebGLRenderTarget) {
    this.kit.run(this.apply, target, false);
  }

  dispose() {
    for (const m of [this.nd, this.ao, this.blur, this.apply]) m.dispose();
    for (const t of [this.ndRT, ...this.aoRT]) t.dispose();
  }
}

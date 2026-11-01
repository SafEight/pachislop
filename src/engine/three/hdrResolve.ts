import * as THREE from 'three';
import type { PassKit } from '../passkit';

// Tone-map-aware MSAA resolve for 3D layers rendered without supersampling. The hardware
// resolve averages a pixel's samples in HDR, and the tone map runs after it: on an edge
// between a highlight at 20 and a face at 0.5 the averages 15, 10 and 5 all tone map to near
// white, so bright edges step as if there were no antialiasing.
//
// Every material drawing into a compressed target writes each sample through an invertible
// shoulder (Karis, "Tone mapping", 2013, starting at the knee of the tone curves): the
// straight colour is scaled so its brightest channel x, after exposure, maps to
// knee + h·(x − knee) / (h + x − knee) above the knee and stays as is below it. The resolve
// then averages about what the tone map would show, and `HdrExpand` inverts the shoulder on
// the resolved pixel. Pixels whose samples all sit below the knee are untouched (bit for
// bit); coverage edges against transparency are exact either way, since alpha carries the
// coverage. Headroom h = 0.75 was measured against 4×-supersampled, box-filtered renders of
// templates 3, 4 and 19: the plain resolve's bright bias on hot edges (+3..+9 of 255) drops
// to about a third with either sign, where Neutral's own shoulder (h = 0.24) overshoots dark
// and costs half-float precision. Hot pixels keep a few % precision (±4 % at 20× white),
// invisible after the tone map and in the glint. Blended (transparent) surfaces mix
// compressed values, a close approximation of mixing the light.
//
// Only targets passed to `compressInto` are compressed: three draws the same materials into
// its transmission buffer (gems sample it as linear light), and the per-draw flag follows the
// current render target.

const KNEE = 0.76; // Neutral / punch: where the shoulder starts (tonemap.ts)
const HEADROOM = 0.75;
const SHOULDER_GLSL = /* glsl */ `
const float HDR_KNEE = ${KNEE};
const float HDR_H = ${HEADROOM};
`;

const compressed = new WeakSet<THREE.WebGLRenderTarget>();
/** Shared by every patched material; uHdrCompress is set per draw from the current render target. */
const shared = {
  uHdrCompress: { value: false } as THREE.IUniform<boolean>,
  uHdrExposure: { value: 1 } as THREE.IUniform<number>,
};
const patched = new WeakSet<THREE.Material>();

/** Materials drawing into `rt` compress their output (see header). */
export function compressInto(rt: THREE.WebGLRenderTarget) {
  compressed.add(rt);
}

/** Exposure of the tone map the compressed renders feed (the knee is in exposed units). */
export function setCompressionExposure(exposure: number) {
  shared.uHdrExposure.value = Math.max(0, exposure);
}

const KEY = '|hdr-compress-v1';

/**
 * Patch `m` (any built-in or onBeforeCompile-patched three material) to compress its output
 * while drawing into a `compressInto` target. Idempotent; keeps the material's own
 * onBeforeCompile / onBeforeRender / program cache key.
 */
export function compressHdrOutput<M extends THREE.Material>(m: M): M {
  if (patched.has(m)) return m;
  patched.add(m);
  const compile = m.onBeforeCompile;
  const before = m.onBeforeRender;
  // three's default key is the onBeforeCompile source: take it before wrapping
  const key = m.customProgramCacheKey() + KEY;
  m.onBeforeCompile = function (shader, renderer) {
    compile.call(this, shader, renderer);
    Object.assign(shader.uniforms, shared);
    // premultipliedAlpha is a program parameter, so either variant gets its own program
    const straightMax = this.premultipliedAlpha ? 'hdrM / max( gl_FragColor.a, 1e-6 )' : 'hdrM';
    shader.fragmentShader =
      `uniform bool uHdrCompress;\nuniform float uHdrExposure;\n${SHOULDER_GLSL}` +
      shader.fragmentShader.replace(
        /\}\s*$/,
        /* glsl */ `
  if ( uHdrCompress ) {
    float hdrM = max( max( gl_FragColor.r, gl_FragColor.g ), gl_FragColor.b );
    float hdrX = ( ${straightMax} ) * uHdrExposure;
    if ( hdrX > HDR_KNEE ) gl_FragColor.rgb *= ( HDR_KNEE + HDR_H * ( hdrX - HDR_KNEE ) / ( HDR_H + hdrX - HDR_KNEE ) ) / hdrX;
  }
}
`,
      );
  };
  m.customProgramCacheKey = () => key;
  m.onBeforeRender = function (renderer, scene, camera, geometry, object, group) {
    shared.uHdrCompress.value = compressed.has(renderer.getRenderTarget() as THREE.WebGLRenderTarget);
    before.call(this, renderer, scene, camera, geometry, object, group);
  };
  m.needsUpdate = true;
  return m;
}

const EXPAND_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform float uExposure;
in vec2 vUv;
out vec4 o;
${SHOULDER_GLSL}
void main() {
  vec4 c = texelFetch( tSrc, ivec2( gl_FragCoord.xy ), 0 );
  float a = clamp( c.a, 0.0, 1.0 );
  if ( a <= 0.0 || uExposure <= 0.0 ) { o = c; return; }
  // brightest straight channel after exposure, then the shoulder's inverse above the knee
  float y = max( max( c.r, c.g ), c.b ) / a * uExposure;
  if ( y > HDR_KNEE ) {
    float t = min( ( y - HDR_KNEE ) / HDR_H, 1.0 - 1.0 / 4096.0 );
    float x = HDR_KNEE + HDR_H * t / ( 1.0 - t );
    c.rgb *= x / y;
  }
  o = c;
}
`;

/** Resolved compressed render → premultiplied linear HDR (same size). */
export class HdrExpand {
  private readonly kit: PassKit;
  private readonly mat: THREE.ShaderMaterial;

  constructor(kit: PassKit) {
    this.kit = kit;
    this.mat = kit.shader({ uniforms: { tSrc: { value: null }, uExposure: shared.uHdrExposure }, fragmentShader: EXPAND_FRAG });
  }

  run(src: THREE.Texture, target: THREE.WebGLRenderTarget) {
    this.mat.uniforms.tSrc.value = src;
    this.kit.run(this.mat, target);
  }

  dispose() {
    this.mat.dispose();
  }
}

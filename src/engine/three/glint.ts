import * as THREE from 'three';
import type { PassKit } from '../passkit';

// Glint for 3D layers (Element 3D "Glow from Luminance", Blender Glare Bloom + Streaks):
// runs on the layer's HDR render BEFORE tone mapping, so only real specular highlights
// (straight-colour luminance above `threshold`) glint, not every bright-coloured face.
//
//   full-res HDR ─ bright pass (box-averaged onto the glint grid, then thresholded) → level B
//                ─ box mips → levels B+1..n
//                ─ bloom: a narrow and a wide separable gaussian, each on the mip where its
//                  sigma is a few texels
//                ─ streaks: Kawase streak filter (4 taps × passes of growing stride, with
//                  exponential falloff) per ray direction, fed by a POINT detector: the bright
//                  pass minus the larger of its horizontal and vertical 1D blurs, all on the
//                  one mip where the detail size is a few texels. Isolated hot spots and
//                  corners throw rays; broad faces, their straight edges and long bevel lines
//                  (bright along one axis) don't, so the rays read as star glints instead of
//                  curtains.
//                ─ sum × tint × intensity → level-B glint texture
//
// Scale invariance: the threshold is non-linear and the point detector depends on how well
// a feature is resolved, so both would grow with the export scale if they ran on render
// pixels (finer highlights pass the knee more fully, and thin bevel lines survive a detector
// whose 1D blurs are box-filtered across the line). Everything therefore runs on a grid
// locked to comp pixels: level B = round(log2(pxScale)) texels are about one comp pixel, and
// every mip choice is made in level-B texels, so a 4× export computes exactly what a 1×
// export does, at 4×4 render px per texel.
// A supersampled source (k× per axis) only widens the bright pass's box to k·2^B texels,
// so supersampling never changes the glint either.
//
// The result is pure added light (RGB, premultiplied by construction); the tone-map pass
// adds it and raises alpha by its brightness, so glints survive on transparent exports
// without dark fringes. All sizes come in as render pixels (size-relative % already
// converted, export scale included).

export interface GlintParams {
  threshold: number;
  intensity: number;
  /** Bloom radius, render px. */
  radiusPx: number;
  /** Ray count (0 = bloom only). */
  streaks: number;
  /** Streak length, render px. */
  lengthPx: number;
  /** Feature size that still counts as a "point" for streaks (high-pass sigma), render px. */
  detailPx: number;
  /** Render px per comp px (preview < 1, export ≥ 1): sets the glint grid. */
  pxScale: number;
  /**
   * Source texels per render px per axis (3D supersampling): the bright pass box-averages
   * them away, so the glint grid and everything after it match a non-supersampled render.
   */
  supersample: number;
  /** Streak rotation, radians counter-clockwise (uv space, y-up). */
  angle: number;
  /** Linear tint. */
  tint: THREE.Color;
}

/** Brightest straight luminance a texel may contribute (keeps tiny HDR sparkles from exploding). */
const LUMA_CLAMP = 64;
/**
 * Knee of the bright pass: a texel contributes e² / (e + KNEE) of luminance, e = excess over
 * the threshold. Faces just above white (HDR 1.5–2.5 under a bright studio) barely glow while
 * true specular hot spots (10+) pass almost fully — glint stays on the highlights.
 */
const KNEE = 4;
/**
 * Ray brightness at its start for a source spot one detail-size wide. A ray sums the source
 * along its line, so the gain is divided by the detail size in texels. Tuned on 1× exports.
 */
const STREAK_PEAK = 1.2;
/** Fraction of a ray's start intensity left at its nominal length. */
const STREAK_TAIL = 0.02;
/** Target gaussian sigma in texels: the mip level is picked to keep sigma near this. */
const MIP_SIGMA = 5;
/** Smallest point-detector sigma in texels: below ~3 the detector is pixel-limited. */
const DETAIL_SIGMA = 3;
/** Deepest mip below the glint grid. */
const MAX_LEVEL = 6;

const BRIGHT = /* glsl */ `
uniform sampler2D tSrc;
uniform float uThreshold;
uniform int uFactor; // source texels per glint texel, per axis
uniform ivec2 uOrigin; // source texel of the glint domain's lower-left corner (≤ 0)
in vec2 vUv;
out vec4 o;
void main() {
  // box average first (premultiplied), threshold after: the knee sees the same footprint at
  // every export scale; texels past the source are empty
  ivec2 p = uOrigin + ivec2( gl_FragCoord.xy ) * uFactor;
  ivec2 size = textureSize( tSrc, 0 );
  vec4 c = vec4( 0.0 );
  for ( int y = 0; y < uFactor; y ++ )
    for ( int x = 0; x < uFactor; x ++ ) {
      ivec2 q = p + ivec2( x, y );
      if ( all( greaterThanEqual( q, ivec2( 0 ) ) ) && all( lessThan( q, size ) ) ) c += texelFetch( tSrc, q, 0 );
    }
  c /= float( uFactor * uFactor );
  o = vec4( 0.0, 0.0, 0.0, 1.0 );
  if ( c.a <= 1e-4 ) return;
  float l = dot( c.rgb, vec3( 0.2126, 0.7152, 0.0722 ) ) / c.a;
  float e = min( l, ${LUMA_CLAMP.toFixed(1)} ) - uThreshold;
  if ( e <= 0.0 ) return;
  // c.rgb / l = premultiplied colour at unit luminance
  o.rgb = c.rgb * ( e * e / ( e + ${KNEE.toFixed(1)} ) ) / max( l, 1e-4 );
}
`;

const DOWN = /* glsl */ `
uniform sampler2D tSrc;
in vec2 vUv;
out vec4 o;
void main() { o = texture( tSrc, vUv ); }
`;

const BLUR = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uStep; // uv per texel along the blur axis
uniform float uSigma; // texels
uniform int uRadius;
in vec2 vUv;
out vec4 o;
void main() {
  vec3 s = vec3( 0.0 );
  float ws = 0.0;
  for ( int i = -uRadius; i <= uRadius; i ++ ) {
    float x = float( i );
    float w = exp( -0.5 * x * x / ( uSigma * uSigma ) );
    s += texture( tSrc, vUv + uStep * x ).rgb * w;
    ws += w;
  }
  o = vec4( s / ws, 1.0 );
}
`;

const STREAK = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uStep; // uv offset between taps of this pass
uniform float uFall; // weight ratio between consecutive taps
in vec2 vUv;
out vec4 o;
void main() {
  vec3 s = vec3( 0.0 );
  float ws = 0.0;
  float w = 1.0;
  for ( int i = 0; i < 4; i ++ ) {
    vec2 uv = vUv - uStep * float( i );
    // outside the frame there is no light (clamp-to-edge would smear the border)
    float inside = step( 0.0, uv.x ) * step( uv.x, 1.0 ) * step( 0.0, uv.y ) * step( uv.y, 1.0 );
    s += texture( tSrc, uv ).rgb * w * inside;
    ws += w;
    w *= uFall;
  }
  o = vec4( s / ws, 1.0 );
}
`;

const ADD = /* glsl */ `
uniform sampler2D tSrc;
uniform vec3 uGain;
uniform vec2 uScale, uOffset; // output uv → glint domain uv
in vec2 vUv;
out vec4 o;
void main() { o = vec4( texture( tSrc, vUv * uScale + uOffset ).rgb * uGain, 0.0 ); }
`;

const HIGHPASS = /* glsl */ `
uniform sampler2D tSrc;
uniform sampler2D tBlurX;
uniform sampler2D tBlurY;
in vec2 vUv;
out vec4 o;
void main() {
  vec3 b = texture( tSrc, vUv ).rgb;
  o = vec4( max( b - max( texture( tBlurX, vUv ).rgb, texture( tBlurY, vUv ).rgb ), vec3( 0.0 ) ), 1.0 );
}
`;

export class GlintPass {
  private readonly bright: THREE.ShaderMaterial;
  private readonly down: THREE.ShaderMaterial;
  private readonly blur: THREE.ShaderMaterial;
  private readonly highpass: THREE.ShaderMaterial;
  private readonly streak: THREE.ShaderMaterial;
  private readonly add: THREE.ShaderMaterial;
  /** Scratch targets keyed `${level}:${slot}`. */
  private readonly rts = new Map<string, THREE.WebGLRenderTarget>();
  private readonly gain = new THREE.Vector3();

  private readonly kit: PassKit;

  constructor(kit: PassKit) {
    this.kit = kit;
    this.bright = kit.shader({
      uniforms: { tSrc: { value: null }, uThreshold: { value: 1 }, uFactor: { value: 1 }, uOrigin: { value: new THREE.Vector2() } },
      fragmentShader: BRIGHT,
    });
    this.down = kit.shader({ uniforms: { tSrc: { value: null } }, fragmentShader: DOWN });
    this.blur = kit.shader({
      uniforms: { tSrc: { value: null }, uStep: { value: new THREE.Vector2() }, uSigma: { value: 1 }, uRadius: { value: 1 } },
      fragmentShader: BLUR,
    });
    this.highpass = kit.shader({ uniforms: { tSrc: { value: null }, tBlurX: { value: null }, tBlurY: { value: null } }, fragmentShader: HIGHPASS });
    this.streak = kit.shader({
      uniforms: { tSrc: { value: null }, uStep: { value: new THREE.Vector2() }, uFall: { value: 0.5 } },
      fragmentShader: STREAK,
    });
    this.add = kit.shader({
      uniforms: { tSrc: { value: null }, uGain: { value: this.gain }, uScale: { value: new THREE.Vector2() }, uOffset: { value: new THREE.Vector2() } },
      fragmentShader: ADD,
      blending: THREE.AdditiveBlending,
    });
  }

  private target(level: number, slot: number, width: number, height: number): THREE.WebGLRenderTarget {
    const w = Math.max(1, Math.ceil(width / 2 ** level));
    const h = Math.max(1, Math.ceil(height / 2 ** level));
    const key = `${level}:${slot}`;
    let rt = this.rts.get(key);
    if (!rt) {
      rt = new THREE.WebGLRenderTarget(w, h, {
        type: THREE.HalfFloatType,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: false,
      });
      rt.texture.colorSpace = THREE.LinearSRGBColorSpace;
      this.rts.set(key, rt);
    } else if (rt.width !== w || rt.height !== h) rt.setSize(w, h);
    return rt;
  }

  /** 1D gaussian of `src` (at `level`) along x (`axis` 0) or y (1) into slot `out`. */
  private blur1D(src: THREE.WebGLRenderTarget, level: number, out: number, sigma: number, axis: 0 | 1, W: number, H: number) {
    const dst = this.target(level, out, W, H);
    const u = this.blur.uniforms;
    u.uSigma.value = Math.max(0.5, sigma);
    u.uRadius.value = Math.ceil(3 * Math.max(0.5, sigma));
    u.tSrc.value = src.texture;
    u.uStep.value.set(axis === 0 ? 1 / src.width : 0, axis === 1 ? 1 / src.height : 0);
    this.kit.run(this.blur, dst);
    return dst;
  }

  /** Separable gaussian of `src` (at `level`) into slot `out`; returns it. */
  private gaussian(src: THREE.WebGLRenderTarget, level: number, out: number, sigma: number, W: number, H: number) {
    const tmp = this.target(level, 9, W, H);
    const dst = this.target(level, out, W, H);
    const u = this.blur.uniforms;
    u.uSigma.value = Math.max(0.5, sigma);
    u.uRadius.value = Math.ceil(3 * Math.max(0.5, sigma));
    u.tSrc.value = src.texture;
    u.uStep.value.set(1 / src.width, 0);
    this.kit.run(this.blur, tmp);
    u.tSrc.value = tmp.texture;
    u.uStep.value.set(0, 1 / src.height);
    this.kit.run(this.blur, dst);
    return dst;
  }

  /**
   * Glint light of the HDR render `src` (premultiplied linear, `width`×`height` render px at
   * `p.supersample` texels per render px), on the comp-locked glint grid (see the header).
   * The grid and its mips cover a domain laid out from the canvas centre (the comp centre) in
   * whole texels of the deepest mip, so every level's texels sit at the same comp px on any
   * canvas (export margins, an enlarged interactive frame) and halve exactly from level to
   * level. Returned at the canvas's own uv. Valid until the next call.
   */
  render(src: THREE.Texture, width: number, height: number, p: GlintParams): THREE.Texture {
    const { kit } = this;
    // glint grid: level B texels are about one comp px (render px below 1× preview)
    const base = Math.max(0, Math.round(Math.log2(Math.max(1, p.pxScale))));
    const grid = 2 ** base; // render px per grid texel

    // mip for a gaussian of `sigma` grid texels: the deepest level that still spans `min` of
    // its texels (at most MAX_LEVEL below the grid)
    const levelFor = (sigma: number, min: number) => base + Math.min(MAX_LEVEL, Math.max(0, Math.floor(Math.log2(sigma / min))));
    const radius = Math.max(0, p.radiusPx) / grid;
    const detail = Math.max(1, p.detailPx / grid);
    const rays = Math.round(p.streaks);
    const sl = levelFor(detail, DETAIL_SIGMA); // point detector + rays
    const len = p.lengthPx / 2 ** sl; // sl texels
    const streaking = rays > 0 && len > 1;
    // bloom: narrow core + wide halo, each kept between MIP_SIGMA / 2 and MIP_SIGMA texels
    const bloom = (radius > 0 ? ([[radius * 0.3, 0.4, 2], [radius, 0.3, 3]] as const) : []).map(([sigma, gain, slot]) => ({
      sigma,
      gain,
      slot,
      level: levelFor(sigma, MIP_SIGMA / 2),
    }));
    const deepest = Math.max(base, ...bloom.map((b) => b.level), streaking ? sl : base);
    // the domain: whole deepest-level texels each way from the canvas centre, render px
    const cell = 2 ** deepest;
    const W = 2 * Math.ceil(width / 2 / cell) * cell;
    const H = 2 * Math.ceil(height / 2 / cell) * cell;
    const ox = width / 2 - W / 2;
    const oy = height / 2 - H / 2;

    const out = this.target(base, 0, width, height);
    const brightRT = this.target(base, 1, W, H);
    const ss = Math.max(1, Math.round(p.supersample));
    this.bright.uniforms.tSrc.value = src;
    this.bright.uniforms.uThreshold.value = Math.max(0, p.threshold);
    this.bright.uniforms.uFactor.value = grid * ss;
    this.bright.uniforms.uOrigin.value.set(Math.round(ox * ss), Math.round(oy * ss));
    kit.run(this.bright, brightRT);

    const mips: THREE.WebGLRenderTarget[] = [];
    mips[base] = brightRT;
    for (let l = base + 1; l <= deepest; l++) {
      const rt = this.target(l, 1, W, H);
      this.down.uniforms.tSrc.value = mips[l - 1].texture;
      kit.run(this.down, rt);
      mips[l] = rt;
    }

    kit.clear(out);
    const k = Math.max(0, p.intensity);
    // output uv (the canvas's) → domain uv
    this.add.uniforms.uScale.value.set(width / W, height / H);
    this.add.uniforms.uOffset.value.set(-ox / W, -oy / H);
    const addInto = (tex: THREE.Texture, gain: number) => {
      this.gain.set(p.tint.r, p.tint.g, p.tint.b).multiplyScalar(k * gain);
      this.add.uniforms.tSrc.value = tex;
      kit.run(this.add, out, false);
    };

    for (const { sigma, gain, slot, level } of bloom) addInto(this.gaussian(mips[level], level, slot, sigma / 2 ** (level - base), W, H).texture, gain);

    // streaks: one ray per direction, Kawase passes of stride 1, 4, 16… on level sl; the point
    // detector compares the bright pass with its 1D blurs on that same level, so a line is
    // cancelled exactly instead of against a copy box-filtered across it
    if (streaking) {
      const sigma = detail / 2 ** (sl - base);
      const blurX = this.blur1D(mips[sl], sl, 6, sigma, 0, W, H);
      const blurY = this.blur1D(mips[sl], sl, 8, sigma, 1, W, H);
      const peaks = this.target(sl, 7, W, H);
      this.highpass.uniforms.tSrc.value = mips[sl].texture;
      this.highpass.uniforms.tBlurX.value = blurX.texture;
      this.highpass.uniforms.tBlurY.value = blurY.texture;
      kit.run(this.highpass, peaks);
      const fall = STREAK_TAIL ** (1 / len); // per texel
      const passes = Math.max(1, Math.ceil(Math.log(len + 1) / Math.log(4)));
      // each pass normalises its 4 taps; undo that so the kernel's first tap weighs 1
      let kernelSum = 1;
      for (let i = 0; i < passes; i++) {
        const f = fall ** 4 ** i;
        kernelSum *= 1 + f + f * f + f * f * f;
      }
      const ping = [this.target(sl, 4, W, H), this.target(sl, 5, W, H)];
      for (let r = 0; r < rays; r++) {
        const a = p.angle + (r * 2 * Math.PI) / rays;
        const dx = Math.cos(a) / peaks.width;
        const dy = Math.sin(a) / peaks.height;
        let srcTex = peaks.texture;
        for (let i = 0; i < passes; i++) {
          const stride = 4 ** i;
          this.streak.uniforms.tSrc.value = srcTex;
          this.streak.uniforms.uStep.value.set(dx * stride, dy * stride);
          this.streak.uniforms.uFall.value = fall ** stride;
          kit.run(this.streak, ping[i % 2]);
          srcTex = ping[i % 2].texture;
        }
        addInto(srcTex, (STREAK_PEAK * kernelSum) / Math.max(1, sigma));
      }
    }
    return out.texture;
  }

  dispose() {
    for (const rt of this.rts.values()) rt.dispose();
    this.rts.clear();
    for (const m of [this.bright, this.down, this.blur, this.highpass, this.streak, this.add]) m.dispose();
  }
}

import * as THREE from 'three';
import type { RenderFrame } from '../contracts';
import { centreX, centreY } from '../frame';
import type { PassKit } from '../passkit';

// Glint for 3D layers (Element 3D "Glow from Luminance", Blender Glare Bloom + Streaks):
// runs on the layer's HDR render BEFORE tone mapping, so only real specular highlights
// (straight-colour luminance above `threshold`) glint, not every bright-coloured face.
//
//   full-res HDR ─ bright pass (box-averaged onto the glint grid, then thresholded) → level B
//                ─ box mips → levels B+1..n
//                ─ tame: each level a consumer reads × K / (K + hot coverage), the bright pass
//                  averaged over a few letter strokes, so a whole face turned into the light
//                  (any pose can bring large areas over the threshold at once) adds a bounded
//                  glow, while a lone hot point, whose coverage is tiny, keeps its strength
//                ─ bloom: a narrow and a wide separable gaussian, each on the mip where its
//                  sigma is a few texels
//                ─ streaks: Kawase streak filter (4 taps × passes of growing stride, with
//                  exponential falloff) per ray direction, fed by a POINT detector: the bright
//                  pass minus the larger of its horizontal and vertical 1D blurs, all on the
//                  one mip where the detail size is a few texels. Isolated hot spots and
//                  corners throw rays; broad faces, their straight edges and long bevel lines
//                  (bright along one axis) don't, so the rays read as star glints instead of
//                  curtains. The detected points are then pinched to their centres and kept
//                  only where they stand well above the coverage (PINCH): curved edges and
//                  face texture (flakes, noise), which pass the detector as lines or fields of
//                  weak points, throw no rays. Each ray is a long thin streak on that mip plus
//                  a short, hot, twice-as-wide one on the next, so it starts thick and bright
//                  at the source and tapers into a faint hairline; a round bloom of the kept
//                  points sits under the rays as the glint's hot core.
//                ─ sum × tint × intensity → glint texture on the whole render's level-B
//                  lattice (a preview window gets the texels of that lattice covering it)
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

/** Glint light (GlintPass.render): sample `texture` at uv = target uv × `uv.xy` + `uv.zw`. */
export interface GlintLight {
  texture: THREE.Texture;
  uv: THREE.Vector4;
}

/**
 * One axis of the glint output: the whole render's level-B lattice, `n` texels of `F / n`
 * render px across the frame (`F` px; a whole render's level-B target), and the run of them
 * `j0` .. `j0 + count` covering a target `w` px long whose first px is the frame's px `fx`;
 * `lo` .. `hi` = the run's extent in target px. A whole frame (`fx` = 0, `w` = `F`) gets
 * exactly its level-B target: j0 = 0, count = n, lo = 0, hi = F.
 */
function outLattice(F: number, fx: number, w: number, grid: number) {
  const n = Math.max(1, Math.ceil(F / grid));
  const j0 = Math.floor((fx * n) / F);
  const count = Math.max(1, Math.ceil(((fx + w) * n) / F) - j0);
  return { n, j0, count, lo: (j0 * F) / n - fx, hi: ((j0 + count) * F) / n - fx };
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
 * Ray brightness at its start for a source spot one detail-size wide: the long thin streak. A
 * ray sums the source along its line, so the gain is divided by the detail size in texels.
 * Tuned on 1× exports.
 */
const STREAK_PEAK = 1.5;
/** Fraction of a ray's start intensity left at its nominal length. */
const STREAK_TAIL = 0.02;
/** Start brightness of a ray's short, wide, hot part (one mip coarser), same units as STREAK_PEAK. */
const STREAK_CORE = 2.5;
/** Length of a ray's short hot part, fraction of the ray length: the taper from thick to thin. */
const STREAK_CORE_LEN = 0.22;
/** Gain of the round bloom on the detected points under the rays (the glint's hot core). */
const POINT_BLOOM = 8;
/** Sigma of that bloom, × the detail size; also the neighbourhood a point is judged against (PINCH). */
const POINT_BLOOM_SIGMA = 1.2;
/**
 * How far a point must stand above its blur to keep its centre (see PINCH): a small point does;
 * wider spots and stretches of curved edges, which stand far less, fade.
 */
const PINCH_K = 8;
/**
 * How far a point's gathered light must stand above the hot coverage around it to glint (see
 * PINCH): a lone highlight does many times over; a speck in a field of flake or noise texture,
 * which shares the coverage with its neighbours, doesn't.
 */
const ISOLATION_K = 3;
/** Sigma of the hot-coverage average that tames the bright pass (see TAME), × the detail size. */
const COVER_SIGMA = 6;
/** Coverage (bright-pass excess) at which TAME halves the bright pass. */
const COVER_K = 0.5;
/** Reach of the star budget (see DENSITY): sigma × the detail size, about a letter's width. */
const BUDGET_SIGMA = 16;
/**
 * Star budget (see DENSITY): how far a glint's light must stand above its average over the
 * budget reach. A lone glint stands about (BUDGET_SIGMA / POINT_BLOOM_SIGMA)² ≈ 180× above it,
 * so a few glints share a letter at full strength; denser fields fade to their brightest.
 */
const DENSITY_K = 40;
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

// The point detector: the bright pass minus the larger of its 1D blurs, tamed by the hot
// coverage (`tCover`, see TAME).
const HIGHPASS = /* glsl */ `
uniform sampler2D tSrc;
uniform sampler2D tBlurX;
uniform sampler2D tBlurY;
uniform sampler2D tCover;
uniform float uK;
in vec2 vUv;
out vec4 o;
void main() {
  vec3 b = texture( tSrc, vUv ).rgb;
  vec3 c = texture( tCover, vUv ).rgb;
  float tame = uK / ( uK + max( c.r, max( c.g, c.b ) ) );
  o = vec4( max( b - max( texture( tBlurX, vUv ).rgb, texture( tBlurY, vUv ).rgb ), vec3( 0.0 ) ) * tame, 1.0 );
}
`;

// The bright pass tamed by its hot coverage (`tCover`: it averaged over a few letter strokes):
// × uK / (uK + coverage). A lone hot point or a thin hot line barely raises the coverage and
// keeps its strength; a broad face over the threshold is brought down to about uK, whatever its
// HDR level, so its glow stays bounded and its texture throws no star field.
const TAME = /* glsl */ `
uniform sampler2D tSrc;
uniform sampler2D tCover;
uniform float uK;
in vec2 vUv;
out vec4 o;
void main() {
  vec3 c = texture( tCover, vUv ).rgb;
  float cov = max( c.r, max( c.g, c.b ) );
  o = vec4( texture( tSrc, vUv ).rgb * ( uK / ( uK + cov ) ), 1.0 );
}
`;

// Keeps the detected points that are real glints. `tBlur` = the points' blur (a few detail
// sizes): a point's light gathered over its neighbourhood; `tCover` = the hot coverage (TAME).
// A point is brighter than its blur at its centre and dimmer on its flanks, and a small point
// stands out of its blur far more than a stretch of a curved edge or a broad spot does:
// point × (point / (blur × uK))², at most 1×, thins a wide hot spot to a hairline and a curved
// edge (which the H/V detector passes) to a faint sheet. A lone highlight also gathers many
// times the light of the coverage around it, while a speck of face texture (metal flakes,
// noise), whose neighbours share that coverage, doesn't: × (blur / (coverage × uKc))², at most
// 1×, so a flaky face turned into the light throws no star field.
const PINCH = /* glsl */ `
uniform sampler2D tSrc;
uniform sampler2D tBlur;
uniform sampler2D tCover;
uniform float uK;
uniform float uKc;
in vec2 vUv;
out vec4 o;
void main() {
  vec3 p = texture( tSrc, vUv ).rgb;
  vec3 b = texture( tBlur, vUv ).rgb;
  vec3 c = texture( tCover, vUv ).rgb;
  float lp = max( p.r, max( p.g, p.b ) );
  float lb = max( b.r, max( b.g, b.b ) );
  float lc = max( c.r, max( c.g, c.b ) );
  float k = clamp( lp / max( lb * uK, 1e-6 ), 0.0, 1.0 );
  float iso = clamp( lb / max( lc * uKc, 1e-6 ), 0.0, 1.0 );
  o = vec4( p * ( k * k ) * ( iso * iso ), 1.0 );
}
`;

// The star budget: `tSrc` × (near / (wide × uK))², at most 1×, with `tNear` = the kept points'
// light gathered over a few detail sizes and `tWide` = that light averaged over the coverage
// reach. A lone glint's light stands about (coverage reach / detail reach)² above its wide
// average; when many glints share a region they each stand far less, so a field of them (gem
// facets, glitter) keeps only its brightest few instead of covering the letters in stars.
const DENSITY = /* glsl */ `
uniform sampler2D tSrc;
uniform sampler2D tNear;
uniform sampler2D tWide;
uniform float uK;
in vec2 vUv;
out vec4 o;
void main() {
  vec3 n = texture( tNear, vUv ).rgb;
  vec3 w = texture( tWide, vUv ).rgb;
  float g = clamp( max( n.r, max( n.g, n.b ) ) / max( max( w.r, max( w.g, w.b ) ) * uK, 1e-6 ), 0.0, 1.0 );
  g *= g;
  o = vec4( texture( tSrc, vUv ).rgb * g * g, 1.0 );
}
`;

export class GlintPass {
  private readonly bright: THREE.ShaderMaterial;
  private readonly down: THREE.ShaderMaterial;
  private readonly blur: THREE.ShaderMaterial;
  private readonly highpass: THREE.ShaderMaterial;
  private readonly pinch: THREE.ShaderMaterial;
  private readonly tame: THREE.ShaderMaterial;
  private readonly density: THREE.ShaderMaterial;
  private readonly streak: THREE.ShaderMaterial;
  private readonly add: THREE.ShaderMaterial;
  /** Scratch targets keyed `${level}:${slot}`. */
  private readonly rts = new Map<string, THREE.WebGLRenderTarget>();
  private readonly gain = new THREE.Vector3();
  /** GlintLight.uv of the last render. */
  private readonly uv = new THREE.Vector4(1, 1, 0, 0);

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
    this.highpass = kit.shader({
      uniforms: { tSrc: { value: null }, tBlurX: { value: null }, tBlurY: { value: null }, tCover: { value: null }, uK: { value: COVER_K } },
      fragmentShader: HIGHPASS,
    });
    this.tame = kit.shader({ uniforms: { tSrc: { value: null }, tCover: { value: null }, uK: { value: COVER_K } }, fragmentShader: TAME });
    this.density = kit.shader({ uniforms: { tSrc: { value: null }, tNear: { value: null }, tWide: { value: null }, uK: { value: DENSITY_K } }, fragmentShader: DENSITY });
    this.pinch = kit.shader({
      uniforms: { tSrc: { value: null }, tBlur: { value: null }, tCover: { value: null }, uK: { value: PINCH_K }, uKc: { value: ISOLATION_K } },
      fragmentShader: PINCH,
    });
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
    return this.sized(`${level}:${slot}`, Math.max(1, Math.ceil(width / 2 ** level)), Math.max(1, Math.ceil(height / 2 ** level)));
  }

  /** Scratch target `key` (`${level}:${slot}`) of `w`×`h` texels. */
  private sized(key: string, w: number, h: number): THREE.WebGLRenderTarget {
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
   * Glint light of the HDR render `src` (premultiplied linear: the `width`×`height` render px
   * of `frame` at `p.supersample` texels per render px), on the comp-locked glint grid (see
   * the header). The grid and its mips cover a domain laid out from the comp centre in whole
   * texels of the deepest mip, so every level's texels sit at the same comp px on any canvas
   * (export margins, an enlarged interactive frame, a preview window) and halve exactly from
   * level to level. The light comes out on the whole render's level-B lattice (the texels of
   * it covering the target), so a window samples it where the whole render does. Valid until
   * the next call.
   */
  render(src: THREE.Texture, width: number, height: number, frame: RenderFrame, p: GlintParams): GlintLight {
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
    // the rays' short hot part runs one mip below them (sl + 1)
    const cover = { sigma: COVER_SIGMA * detail, level: levelFor(COVER_SIGMA * detail, MIP_SIGMA / 2) };
    const budget = { sigma: BUDGET_SIGMA * detail, level: levelFor(BUDGET_SIGMA * detail, MIP_SIGMA / 2) };
    const deepest = Math.max(base, cover.level, ...bloom.map((b) => b.level), streaking ? Math.max(sl + 1, budget.level) : base);
    // output texels (whole render's level-B lattice)
    const lx = outLattice(frame.width, frame.x, width, grid);
    const ly = outLattice(frame.height, frame.y, height, grid);
    // the domain: whole deepest-level texels each way from the comp centre (cx, cy) past the
    // output texels, render px; origin (ox, oy), size W×H
    const cell = 2 ** deepest;
    const cx = centreX(frame);
    const cy = centreY(frame);
    const left = Math.ceil((cx - lx.lo) / cell);
    const below = Math.ceil((cy - ly.lo) / cell);
    const W = (left + Math.ceil((lx.hi - cx) / cell)) * cell;
    const H = (below + Math.ceil((ly.hi - cy) / cell)) * cell;
    const ox = cx - left * cell;
    const oy = cy - below * cell;

    const out = this.sized(`${base}:0`, lx.count, ly.count);
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

    // hot coverage around each texel: the bright pass averaged over a few letter strokes. Every
    // consumer reads the bright pass tamed by it (TAME), so a whole face turning into the light
    // (rotation brings large areas over the threshold at once) adds a bounded glow and no
    // star field, while a lone hot point, whose coverage is tiny, keeps its full strength.
    const coverage = this.gaussian(mips[cover.level], cover.level, 17, cover.sigma / 2 ** (cover.level - base), W, H);
    const tamed: THREE.WebGLRenderTarget[] = [];
    const tame = (level: number) => {
      if (!tamed[level]) {
        const rt = this.target(level, 18, W, H);
        this.tame.uniforms.tSrc.value = mips[level].texture;
        this.tame.uniforms.tCover.value = coverage.texture;
        kit.run(this.tame, rt);
        tamed[level] = rt;
      }
      return tamed[level];
    };

    kit.clear(out);
    const k = Math.max(0, p.intensity);
    // output uv → target px → domain uv
    this.add.uniforms.uScale.value.set((lx.count * frame.width) / lx.n / W, (ly.count * frame.height) / ly.n / H);
    this.add.uniforms.uOffset.value.set((lx.lo - ox) / W, (ly.lo - oy) / H);
    const addInto = (tex: THREE.Texture, gain: number) => {
      this.gain.set(p.tint.r, p.tint.g, p.tint.b).multiplyScalar(k * gain);
      this.add.uniforms.tSrc.value = tex;
      kit.run(this.add, out, false);
    };

    for (const { sigma, gain, slot, level } of bloom) addInto(this.gaussian(tame(level), level, slot, sigma / 2 ** (level - base), W, H).texture, gain);

    // streaks: one ray per direction, Kawase passes of stride 1, 4, 16… on level sl; the point
    // detector compares the bright pass with its 1D blurs on that same level, so a line is
    // cancelled exactly instead of against a copy box-filtered across it
    if (streaking) {
      const sigma = detail / 2 ** (sl - base);
      // the detector reads the raw level and tames its result: the tame factor is smooth over
      // many detail sizes, so this equals detecting on the tamed level, one full-res pass less
      const blurX = this.blur1D(mips[sl], sl, 6, sigma, 0, W, H);
      const blurY = this.blur1D(mips[sl], sl, 8, sigma, 1, W, H);
      const peaks = this.target(sl, 7, W, H);
      this.highpass.uniforms.tSrc.value = mips[sl].texture;
      this.highpass.uniforms.tBlurX.value = blurX.texture;
      this.highpass.uniforms.tBlurY.value = blurY.texture;
      this.highpass.uniforms.tCover.value = coverage.texture;
      kit.run(this.highpass, peaks);
      // light gathered over a few detail sizes, on sl + 1 (smooth, so a quarter of the texels):
      // `tSrc` box-reduced one mip into slot `mid` and blurred there into slot `out`
      const gather = (src: THREE.WebGLRenderTarget, mid: number, out: number) => {
        const half = this.target(sl + 1, mid, W, H);
        this.down.uniforms.tSrc.value = src.texture;
        kit.run(this.down, half);
        return this.gaussian(half, sl + 1, out, (sigma * POINT_BLOOM_SIGMA) / 2, W, H);
      };
      // real glints only: the detected points pinched to their centres and stripped of texture
      // specks (see PINCH), so a curved edge, which passes the detector as a line of weak
      // points, or a flaky face neither blooms nor throws rays
      const ref = gather(peaks, 10, 11);
      const pinched = this.target(sl, 11, W, H);
      this.pinch.uniforms.tSrc.value = peaks.texture;
      this.pinch.uniforms.tBlur.value = ref.texture;
      this.pinch.uniforms.tCover.value = coverage.texture;
      kit.run(this.pinch, pinched);
      // star budget: the kept points' light gathered over a few detail sizes against the same
      // light averaged over about a letter (DENSITY): a lone glint or a few keep it all, a
      // field of them (glitter flakes or gem facets turned into the light) thins to its brightest
      const pointLight = gather(pinched, 12, 21);
      let wideSrc = pointLight;
      for (let l = sl + 2; l <= budget.level; l++) {
        const rt = this.target(l, 19, W, H);
        this.down.uniforms.tSrc.value = wideSrc.texture;
        kit.run(this.down, rt);
        wideSrc = rt;
      }
      const wideLevel = Math.max(sl + 1, budget.level);
      const pointWide = this.gaussian(wideSrc, wideLevel, 20, budget.sigma / 2 ** (wideLevel - base), W, H);
      const gated = (src: THREE.WebGLRenderTarget, level: number, slot: number) => {
        const rt = this.target(level, slot, W, H);
        this.density.uniforms.tSrc.value = src.texture;
        this.density.uniforms.tNear.value = pointLight.texture;
        this.density.uniforms.tWide.value = pointWide.texture;
        kit.run(this.density, rt);
        return rt;
      };
      const stars = gated(pinched, sl, 22);
      // hot core: a round bloom of those points under the rays
      addInto(gated(pointLight, sl + 1, 22).texture, POINT_BLOOM);
      // one ray per direction of `src` (on `level`), `n` texels long, starting at `gain`
      const streakRays = (src: THREE.WebGLRenderTarget, level: number, n: number, gain: number) => {
        const fall = STREAK_TAIL ** (1 / n); // per texel
        const passes = Math.max(1, Math.ceil(Math.log(n + 1) / Math.log(4)));
        // each pass normalises its 4 taps; undo that so the kernel's first tap weighs 1
        let kernelSum = 1;
        for (let i = 0; i < passes; i++) {
          const f = fall ** 4 ** i;
          kernelSum *= 1 + f + f * f + f * f * f;
        }
        const ping = [this.target(level, 4, W, H), this.target(level, 5, W, H)];
        for (let r = 0; r < rays; r++) {
          const a = p.angle + (r * 2 * Math.PI) / rays;
          const dx = Math.cos(a) / src.width;
          const dy = Math.sin(a) / src.height;
          let srcTex = src.texture;
          for (let i = 0; i < passes; i++) {
            const stride = 4 ** i;
            this.streak.uniforms.tSrc.value = srcTex;
            this.streak.uniforms.uStep.value.set(dx * stride, dy * stride);
            this.streak.uniforms.uFall.value = fall ** stride;
            kit.run(this.streak, ping[i % 2]);
            srcTex = ping[i % 2].texture;
          }
          addInto(srcTex, gain * kernelSum);
        }
      };
      // the long thin rays on sl, then their short, twice-as-wide hot starts on sl + 1: thick
      // and bright at the source, tapering into a faint hairline
      streakRays(stars, sl, len, STREAK_PEAK / Math.max(1, sigma));
      const coarse = this.target(sl + 1, 7, W, H);
      this.down.uniforms.tSrc.value = stars.texture;
      kit.run(this.down, coarse);
      streakRays(coarse, sl + 1, Math.max(1, (len * STREAK_CORE_LEN) / 2), STREAK_CORE / Math.max(1, sigma / 2));
    }
    // target uv → output uv
    this.uv.set(
      (width * lx.n) / (frame.width * lx.count),
      (height * ly.n) / (frame.height * ly.count),
      ((frame.x * lx.n) / frame.width - lx.j0) / lx.count,
      ((frame.y * ly.n) / frame.height - ly.j0) / ly.count,
    );
    return { texture: out.texture, uv: this.uv };
  }

  dispose() {
    for (const rt of this.rts.values()) rt.dispose();
    this.rts.clear();
    for (const m of [this.bright, this.down, this.blur, this.highpass, this.pinch, this.tame, this.density, this.streak, this.add]) m.dispose();
  }
}

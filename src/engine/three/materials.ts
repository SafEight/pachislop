import * as THREE from 'three';
import type { GradientSpan, Material3D, Surface3D } from '../../model/types';
import type { PassKit } from '../passkit';
import { PATTERN_GLSL, PATTERN_UNIFORMS_GLSL, patternActive, patternUniforms, setPatternUniforms } from '../patterns';
import { compressHdrOutput } from './hdrResolve';

// Material3D → MeshPhysicalMaterial with shader patches (onBeforeCompile):
//
// 1. Exaggeration (Element 3D multipliers): image-based specular (env reflections, incl.
//    clearcoat) is scaled by `reflectivity` (Environment Multiplier), direct-light specular
//    by `specBoost` (Specular Multiplier); diffuse is untouched.
// 2. Layer-space gradient: when the material has a gradient, the base colour is the
//    gradient (linear / radial / reflected, Fill.scale / offset semantics) over a span box in
//    layer space: 'layer' = the PART's bounds (so a face gradient spans the face, a band
//    gradient spans that band); 'line' / 'char' = the per-vertex glyph boxes Geo3D records
//    in the aSpanLine / aSpanChar attributes (geometry without them falls back to 'layer').
//    gradientAxis 'depth' runs the ramp front → back instead, from the per-vertex part z
//    range Geo3D records in aZRange (side walls fading red → black); geometry without it
//    (models) keeps the layer-plane ramp.
//    The emissive radiance is tinted by the same gradient colour, so a white emissive lifts
//    the gradient's own hues (self-lit rainbow) instead of washing them out.
// 2b. Image projection (USE_FACEIMAGE; Title3DProps.faceImage on an image source's face slots,
//    edgeImage on its band and side slots): the picture projected straight on along z in the
//    mesh's own (unsheared) layer space, over the box the outline was traced in
//    (src/text/trace.ts), so it registers with the extruded silhouette and wraps an inflated
//    front the same way. Its colour replaces the base colour by the amount (after the gradient,
//    before the pattern), so the slot's metalness, roughness and clearcoat light it. Face: the
//    texture is premultiplied (filtering never pulls in the colour of transparent pixels) and
//    un-premultiplied per sample; samples fainter than the traced edge alpha fade back to the
//    face material (despeckled holes, filtered rims). Bands and sides (FACEIMAGE_EDGE): every
//    texel holds the colour of the nearest pixel inside the traced edge, opaque, so a side wall
//    shows the colour of its outline point along the whole depth and bands grown outside the
//    outline keep the colour of the edge they grow from (Element 3D extruded logos).
// 3. Pattern (柄): the shared 2D/3D pattern GLSL (engine/patterns.ts) projected front-on in
//    layer space recolours the base colour; `shade` keeps that much of the lighting on the
//    marks (0 = flat print), `relief` bumps the normal along the pattern height.
// 4. Surface (Material3D.surface): large-scale normal perturbation projected front-on in
//    layer space like the pattern — crumpled foil facets, hammered dents, or domain-warped
//    liquid ripples — so the reflections warp across the face. It bends the clearcoat too.
// 5. Flakes: metallic glitter — hash-based cells in layer space (cell = flakeScale % of the
//    source size), each tilting the base normal randomly. The clearcoat stays smooth over
//    them, like car paint.
// 6. Environment lock (Title3DProps.envLock): the image-based lookups use the normal the
//    surface would have with the layer unrotated (layer axes = world axes), so a tilted title
//    reflects exactly what it reflects head-on. Rotating the environment instead would only
//    halve the shift (a mirror turns its reflection by twice the tilt). Fresnel, direct lights
//    and shadows keep the real normal.
// 7. Output stage, PREMULTIPLIED: opaque parts write alpha 1. Transparent parts (opacity < 1)
//    and gems (transmission) scale the diffuse body by its coverage but add specular,
//    clearcoat and emission at full strength, raising alpha where they are bright — a
//    see-through body with solid highlights and correct alpha for compositing. Drawing into
//    the layer's unsupersampled MSAA target the output is compressed for the resolve
//    (hdrResolve.ts).
// 8. Gems: three's transmission samples what the title itself has behind the gem (its
//    opaque parts). The transmission buffer is cleared to (1, 1, 1, 0.5) by three when the
//    clear alpha is < 1 (WebGLRenderer.renderTransmissionPass), so each sample is unmixed
//    into premultiplied colour + coverage. Where nothing is behind (transparent export) the
//    body shows the environment refracted through the gem and bounced back off its back
//    (dispersed per channel) — E3D-style refraction that reads as a gem on any background —
//    and the uncovered rest stays see-through via alpha.

const FLAKE_TILT = 0.55; // max normal tilt of a flake at flakes = 1 (radians-ish)
const RELIEF_TILT = 0.06; // normal tilt per unit pattern-height change per motif, at relief = 1
const DISPERSION_SCALE = 6; // Material3D.dispersion 0..1 → three's dispersion
const GEM_THICKNESS = 0.3; // refraction thickness, fraction of the source size
/** Normal tilt per unit surface slope (height change per feature) at amount = 1, per Surface3D kind. */
const SURFACE_TILT: Record<Exclude<Surface3D['kind'], 'none'>, number> = { crumple: 0.45, hammered: 0.4, liquid: 0.22 };
const SURFACE_KINDS: Record<Exclude<Surface3D['kind'], 'none'>, string> = { crumple: '1', hammered: '2', liquid: '3' };
/** log2 of the PMREM cube size the material presets were tuned on (512). */
const PMREM_REF_MIP = 9;

// Size-invariant reflection blur. three's PMREM prefilters cube level i (face 2^(MAX_MIP - i),
// mips below 4 continuing as extra blur levels) for roughness i / (MAX_MIP + 2), but its
// shader picks the level from the material roughness alone, so the same material blurs more
// on a bigger map (a 1024 preview vs a 2048 export would differ). Sample the level whose
// prefilter roughness the reference map would give instead: the same blur at every map size,
// the bigger maps' extra top levels only sharpening near-mirror finishes.
const CUBEUV_MIP_FROM = 'float mip = clamp( roughnessToMip( roughness ), cubeUV_m0, CUBEUV_MAX_MIP );';
const CUBEUV_MIP_TO = /* glsl */ `
float mipRef = clamp( roughnessToMip( max( roughness, uEnvBlur ) ), cubeUV_m0, ${PMREM_REF_MIP.toFixed(1)} );
float mip = CUBEUV_MAX_MIP - ( ${PMREM_REF_MIP.toFixed(1)} - mipRef ) * ( CUBEUV_MAX_MIP + 2.0 ) / ${(PMREM_REF_MIP + 2).toFixed(1)};
`;

// Environment blur and repeat (Comp['environment'].blur / .repeatX / .repeatY), applied in
// three's cube-UV lookup, so every environment lookup (reflections, clearcoat, the gem body,
// irradiance) sees them:
// - blur: the lookup samples at least this roughness's prefiltered level, as if the map itself
//   were blurred. Irradiance already samples roughness 1, so diffuse light is unchanged, and
//   direct-light highlights keep the material's own roughness.
// - repeat (Element 3D's environment tiling): the direction's azimuth, measured from the forward
//   axis (+z, what a face looking at the camera reflects), is multiplied by repeatX and its
//   elevation, measured from the horizon, is tiled repeatY times, so the view straight ahead
//   stays put while the sliders run. A fractional horizontal repeat has its seam behind the
//   object, where front faces never look; vertical tiles meet at hard edges, as tiled maps do.
const ENV_LOOKUP_DECL = /* glsl */ `
uniform float uEnvBlur;
uniform vec2 uEnvRepeat;
vec3 envRepeatDir( vec3 d ) {
  if ( uEnvRepeat.x == 1.0 && uEnvRepeat.y == 1.0 ) return d;
  d = normalize( d );
  float a = atan( d.x, d.z ) * uEnvRepeat.x;
  float e = asin( clamp( d.y, -1.0, 1.0 ) );
  if ( uEnvRepeat.y != 1.0 ) e = ( fract( e / PI * uEnvRepeat.y + 0.5 ) - 0.5 ) * PI;
  float c = cos( e );
  return vec3( sin( a ) * c, sin( e ), cos( a ) * c );
}
`;
const CUBEUV_FN = 'vec4 textureCubeUV( sampler2D envMap, vec3 sampleDir, float roughness ) {';
/** three's cube-UV lookup with the environment blur and repeat; `sizeInvariant` also applies the part materials' level remap above. */
const cubeUvChunk = (sizeInvariant: boolean) =>
  ENV_LOOKUP_DECL +
  THREE.ShaderChunk.cube_uv_reflection_fragment
    .replace(CUBEUV_FN, `${CUBEUV_FN}\n\t\tsampleDir = envRepeatDir( sampleDir );`)
    .replace(
      CUBEUV_MIP_FROM,
      sizeInvariant ? CUBEUV_MIP_TO : CUBEUV_MIP_FROM.replace('roughnessToMip( roughness )', 'roughnessToMip( max( roughness, uEnvBlur ) )'),
    );

interface EnvLookupUniforms {
  uEnvBlur: THREE.IUniform<number>;
  uEnvRepeat: THREE.IUniform<THREE.Vector2>;
}
const envLookupPatched = new WeakMap<THREE.Material, EnvLookupUniforms>();

/** One environment repeat as the shader takes it: 0.25..8. */
const envRepeat = (n: number) => Math.min(8, Math.max(0.25, Number.isFinite(n) ? n : 1));
const setRepeat = (u: THREE.IUniform<THREE.Vector2>, env: Pick<EnvState, 'repeatX' | 'repeatY'>) => u.value.set(envRepeat(env.repeatX), envRepeat(env.repeatY));

/**
 * Give a plain three material (a GLB model's own) the environment blur and repeat and set them.
 * Patches once, keeping its onBeforeCompile and program key (call after `compressHdrOutput`).
 */
export function setEnvLookup(m: THREE.Material, env: Pick<EnvState, 'blur' | 'repeatX' | 'repeatY'>) {
  let u = envLookupPatched.get(m);
  if (!u) {
    const uniforms: EnvLookupUniforms = { uEnvBlur: { value: 0 }, uEnvRepeat: { value: new THREE.Vector2(1, 1) } };
    u = uniforms;
    envLookupPatched.set(m, u);
    const compile = m.onBeforeCompile;
    const key = m.customProgramCacheKey();
    m.onBeforeCompile = function (shader, renderer) {
      compile.call(this, shader, renderer);
      Object.assign(shader.uniforms, uniforms);
      shader.fragmentShader = shader.fragmentShader.replace('#include <cube_uv_reflection_fragment>', cubeUvChunk(false));
    };
    m.customProgramCacheKey = () => `${key}|envlookup`;
    m.needsUpdate = true;
  }
  u.uEnvBlur.value = clamp01(env.blur);
  setRepeat(u.uEnvRepeat, env);
}

const VERT_DECL = /* glsl */ `
uniform mat4 uLayerInv;
varying vec3 vLayerPos;
// LAYERGRAD_SPAN (1 = line, 2 = char) is only defined alongside USE_LAYERGRAD
#ifdef LAYERGRAD_SPAN
  #if LAYERGRAD_SPAN == 1
    attribute vec4 aSpanLine; // (x0, y0, x1, y1) layer px: the glyph's line box
  #else
    attribute vec4 aSpanChar; // (x0, y0, x1, y1) layer px: the glyph's ink box
  #endif
  varying vec4 vGradBox;
#endif
#ifdef LAYERGRAD_DEPTH
  attribute vec2 aZRange; // (front z, back z) of the vertex's part, in position.z's (object) space
  varying float vDepthT;
#endif
#ifdef USE_FACEIMAGE
  varying vec2 vFacePos;
#endif
`;

const VERT_BODY = /* glsl */ `
vLayerPos = ( uLayerInv * modelMatrix * vec4( transformed, 1.0 ) ).xyz;
#ifdef LAYERGRAD_SPAN
  #if LAYERGRAD_SPAN == 1
    vGradBox = aSpanLine;
  #else
    vGradBox = aSpanChar;
  #endif
#endif
#ifdef LAYERGRAD_DEPTH
  // 0 at the part's front, 1 at its back; -1 = no z range (models, zero-depth parts): xy ramp.
  // position.z, not the world position: shear and glyph rigs never move it.
  float zSpan = aZRange.x - aZRange.y;
  vDepthT = zSpan > 1e-4 ? ( aZRange.x - position.z ) / zSpan : -1.0;
#endif
#ifdef USE_FACEIMAGE
  // object space: the solid's layer space before the oblique shear (front at z = 0)
  vFacePos = transformed.xy;
#endif
#include <project_vertex>
`;

const FRAG_DECL = /* glsl */ `
uniform float uReflectivity;
uniform float uSpecBoost;
uniform mat3 uLayerRot; // layer axes → world (rotation times the flipX / flipY mirror; orthonormal)
varying vec3 vLayerPos;

// layer-space direction → view space (both maps are orthonormal, so lengths are kept)
vec3 layerDirToView( vec3 d ) {
  return mat3( viewMatrix ) * ( uLayerRot * d );
}

#ifdef ENV_LOCK
  // view-space normal → the view-space normal it has with the layer unrotated and unflipped
  // (view → world, world → layer axes read as world axes, world → view): a flipped title's
  // reflections mirror with it
  vec3 envLockNormal( vec3 n ) {
    return mat3( viewMatrix ) * ( ( n * mat3( viewMatrix ) ) * uLayerRot );
  }
  #define ENVLOCK_N( n ) envLockNormal( n )
#else
  #define ENVLOCK_N( n ) ( n )
#endif

#ifdef USE_LAYERGRAD
  uniform sampler2D uGradTex;
  uniform int uGradKind; // 0 linear, 1 radial, 2 reflected
  uniform vec2 uGradDir; // y-up unit axis (linear / reflected)
  uniform vec4 uGradBox; // part bounds (x0, y0, x1, y1), layer px: the 'layer' span
  uniform vec2 uGradFit; // (scale: ramp length / span box, offset: -1..1 of the span)
  #ifdef LAYERGRAD_SPAN
    varying vec4 vGradBox;
  #endif
  #ifdef LAYERGRAD_DEPTH
    varying float vDepthT;
  #endif
  // Ramp position like the 2D Fill: linear spans the box's extent along the axis, radial the
  // half-diagonal, reflected mirrors the linear ramp around the centre (centre = stop 0).
  // Depth: stop 0 at the part's front, the ramp length scaled from the front.
  float layerGradT( vec2 p ) {
    #ifdef LAYERGRAD_DEPTH
      if ( vDepthT >= -0.5 ) return vDepthT / max( uGradFit.x, 1e-3 ) - uGradFit.y;
    #endif
    vec4 b = uGradBox;
    #ifdef LAYERGRAD_SPAN
      // geometry without the span attributes reads a degenerate generic value: keep the part bounds
      if ( vGradBox.z > vGradBox.x && vGradBox.w > vGradBox.y ) b = vGradBox;
    #endif
    vec2 c = 0.5 * ( b.xy + b.zw );
    vec2 hs = 0.5 * ( b.zw - b.xy );
    float s = max( uGradFit.x, 1e-3 );
    if ( uGradKind == 1 ) return length( p - c ) / ( max( length( hs ), 1e-3 ) * s ) - uGradFit.y;
    float ext = abs( uGradDir.x ) * hs.x + abs( uGradDir.y ) * hs.y;
    float d = dot( p - c, uGradDir ) / ( max( ext, 1e-3 ) * s );
    return ( uGradKind == 2 ? abs( d ) : 0.5 * d + 0.5 ) - uGradFit.y;
  }
#endif
#ifdef USE_FLAKES
  uniform vec2 uFlakes; // (tilt, cell size px)
  uvec3 flakeHash( uvec3 v ) {
    v = v * 1664525u + 1013904223u;
    v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
    v ^= v >> 16u;
    v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
    return v;
  }
  vec3 flakeRandom( vec3 cell ) {
    return vec3( flakeHash( uvec3( ivec3( cell ) + 32768 ) ) ) * ( 1.0 / 4294967295.0 );
  }
#endif

#ifdef USE_PATTERN
  uniform float uPatCell; // motif size, layer px
  ${PATTERN_GLSL}
  ${PATTERN_UNIFORMS_GLSL}
#endif

#ifdef USE_TRANSMISSION
  float gemBehind = 1.0; // coverage of the title's own opaque parts behind the gem
#endif

#ifdef USE_GLASS
  uniform vec2 uGlass; // (glassDepth 0..1, gradientBend -1..1)
#endif

#ifdef USE_FACEIMAGE
  uniform sampler2D uFaceTex; // premultiplied, raw sRGB values, rows top → bottom
  uniform vec4 uFaceBox; // (x0, y0, x1, y1) layer px, y-up: where the picture lies
  uniform vec2 uFaceMix; // (amount 0..1, traced edge alpha 0..1)
  varying vec2 vFacePos;
  vec3 faceSrgbToLinear( vec3 c ) {
    return mix( c / 12.92, pow( ( c + 0.055 ) / 1.055, vec3( 2.4 ) ), step( vec3( 0.04045 ), c ) );
  }
#endif
`;

/** Un-mix three's (1, 1, 1, 0.5) transmission clear: premultiplied colour + coverage. */
const TRANSMISSION_SAMPLE_FROM = 'return textureBicubic( transmissionSamplerMap, fragCoord.xy, lod );';
const TRANSMISSION_SAMPLE_TO = /* glsl */ `
vec4 gemS = textureBicubic( transmissionSamplerMap, fragCoord.xy, lod );
float gemK = clamp( 2.0 * gemS.a - 1.0, 0.0, 1.0 );
gemBehind = gemK;
return vec4( max( gemS.rgb - ( 1.0 - gemK ), vec3( 0.0 ) ), gemK );
`;

/**
 * Rough gems blur what is behind them by sampling the transmission buffer's mip at
 * log2(buffer width) × roughness: the buffer is the render target, so a preview window
 * (narrower than the whole render, contracts.ts RenderFrame) scales its width up to the whole
 * frame's (`uFrameSpan` = frame width / target width, 1 for a whole render).
 */
const TRANSMISSION_SIZE_FROM = 'uniform vec2 transmissionSamplerSize;';
const TRANSMISSION_SIZE_TO = 'uniform vec2 transmissionSamplerSize;\n\tuniform float uFrameSpan;';
const TRANSMISSION_LOD_FROM = 'float lod = log2( transmissionSamplerSize.x ) *';
const TRANSMISSION_LOD_TO = 'float lod = log2( transmissionSamplerSize.x * uFrameSpan ) *';

// after <normal_pars_fragment> (needs vNormal)
const SURFACE_DECL = /* glsl */ `
#include <normal_pars_fragment>
#if defined( USE_PATTERN ) || defined( USE_FLAKES ) || defined( SURFACE_KIND )
  uniform mat4 uLayerInv;
  uniform vec2 uViewport; // render target size, px
  // camera projection terms (P00, P11, P20, P21): our own uniform, because three only declares
  // projectionMatrix in transmission_pars_fragment, which comes after this chunk
  uniform vec4 uProjK;
  // Layer-space position for screen-derivative work (pattern AA, flake edges). Glyph caps are
  // earcut fans full of sliver triangles whose interpolated varyings have unstable screen
  // derivatives (bright seams along triangle edges), so on planar caps (layer normal ±z, an
  // exact constant across such triangles) the position is rebuilt from gl_FragCoord by
  // intersecting the pixel's view ray with the plane z = vLayerPos.z (also exact there).
  vec3 layerSurfacePos() {
    vec3 nL = ( normalize( vNormal ) * mat3( viewMatrix ) ) * uLayerRot;
    if ( abs( nL.z ) < 0.999 ) return vLayerPos;
    vec2 ndc = gl_FragCoord.xy / uViewport * 2.0 - 1.0;
    vec3 dirView = vec3( ( ndc + uProjK.zw ) / uProjK.xy, -1.0 );
    vec3 o = ( uLayerInv * vec4( cameraPosition, 1.0 ) ).xyz;
    vec3 d = mat3( uLayerInv ) * ( dirView * mat3( viewMatrix ) );
    return o + d * ( ( vLayerPos.z - o.z ) / d.z );
  }
#endif
#ifdef SURFACE_KIND
  uniform vec4 uSurface; // (tilt per unit slope, feature size layer px, seed offset x, y in features)
  vec2 srfHash2( vec2 p ) {
    vec3 p3 = fract( vec3( p.xyx ) * vec3( 0.1031, 0.1030, 0.0973 ) );
    p3 += dot( p3, p3.yzx + 33.33 );
    return fract( ( p3.xx + p3.yz ) * p3.zy );
  }
  #if SURFACE_KIND == 3
    // gradient noise (Quilez), roughly -1..1
    float srfNoise( vec2 p ) {
      vec2 i = floor( p ), f = fract( p );
      vec2 u = f * f * f * ( f * ( f * 6.0 - 15.0 ) + 10.0 );
      float a = dot( srfHash2( i ) * 2.0 - 1.0, f );
      float b = dot( srfHash2( i + vec2( 1.0, 0.0 ) ) * 2.0 - 1.0, f - vec2( 1.0, 0.0 ) );
      float c = dot( srfHash2( i + vec2( 0.0, 1.0 ) ) * 2.0 - 1.0, f - vec2( 0.0, 1.0 ) );
      float d = dot( srfHash2( i + vec2( 1.0 ) ) * 2.0 - 1.0, f - vec2( 1.0 ) );
      return 2.0 * ( a + u.x * ( b - a ) + u.y * ( c - a ) + u.x * u.y * ( a - b - c + d ) );
    }
    // liquid metal: a domain-warped 2-octave height field, smooth and broad, so reflections
    // pour across the face in big warped bands
    float srfLiquidH( vec2 p ) {
      vec2 w = vec2( srfNoise( p * 0.5 ), srfNoise( p * 0.5 + vec2( 5.2, 1.3 ) ) );
      vec2 q = p + 0.9 * w;
      return srfNoise( q ) + 0.3 * srfNoise( q * 2.03 + vec2( 1.7, 9.2 ) );
    }
  #else
    // Cellular facets: the nearest two jittered feature points; each cell has its own slope
    // (crumple: a flat tilted facet; hammered: a round dent tilting away from its centre),
    // blended across the cell border over aa features so creases antialias.
    vec2 srfCellSlope( vec2 v, vec2 cell ) {
      vec2 r = srfHash2( cell + vec2( 17.3, 41.9 ) );
      #if SURFACE_KIND == 1
        return r * 2.0 - 1.0;
      #else
        return v * ( 1.0 + 0.5 * r.x ); // h = k |v|² → slope 2k v, deeper or shallower dents
      #endif
    }
    vec2 srfCells( vec2 p, float aa ) {
      vec2 c = floor( p );
      float d1 = 1e9, d2 = 1e9;
      vec2 v1 = vec2( 0.0 ), v2 = vec2( 0.0 ), g1 = c, g2 = c;
      // 5×5: the second-nearest point (border blend) can sit two cells away
      for ( int j = -2; j <= 2; j ++ ) {
        for ( int i = -2; i <= 2; i ++ ) {
          vec2 g = c + vec2( float( i ), float( j ) );
          vec2 v = p - g - srfHash2( g ) * 0.9;
          float d = dot( v, v );
          if ( d < d1 ) { d2 = d1; v2 = v1; g2 = g1; d1 = d; v1 = v; g1 = g; }
          else if ( d < d2 ) { d2 = d; v2 = v; g2 = g; }
        }
      }
      // distance to the bisector between the two points (exact for Voronoi borders)
      float edge = ( d2 - d1 ) / max( 2.0 * length( v2 - v1 ), 1e-4 );
      float w = 0.5 + 0.5 * smoothstep( 0.0, aa, edge );
      return mix( srfCellSlope( v2, g2 ), srfCellSlope( v1, g1 ), w );
    }
  #endif
  // slope of the surface height (height per feature size, layer x / y) at layer point pos;
  // aa = one pixel in features
  vec2 surfaceSlope( vec2 pos, float aa ) {
    vec2 p = pos / uSurface.y + uSurface.zw;
    #if SURFACE_KIND == 3
      const float e = 0.02;
      float h = srfLiquidH( p );
      return vec2( srfLiquidH( p + vec2( e, 0.0 ) ) - h, srfLiquidH( p + vec2( 0.0, e ) ) - h ) / e;
    #elif SURFACE_KIND == 1
      // two octaves of facets: big folds and small crinkles
      return srfCells( p, aa ) + 0.5 * srfCells( mat2( 0.8, -0.6, 0.6, 0.8 ) * p * 2.3 + 7.1, aa * 2.3 );
    #else
      return srfCells( p, aa );
    #endif
  }
#endif
`;

const FRAG_MAP = /* glsl */ `
#include <map_fragment>
#ifdef USE_GLASS
  // layer-space geometric normal (before surface bumps); edge = sine of its tilt away from the viewer
  vec3 glassN = normalize( ( normalize( vNormal ) * mat3( viewMatrix ) ) * uLayerRot );
  float glassEdge = clamp( length( glassN.xy ), 0.0, 1.0 );
#endif
#ifdef USE_LAYERGRAD
  float layerT = layerGradT( vLayerPos.xy );
  #if defined( USE_GLASS ) && !defined( LAYERGRAD_DEPTH )
    // refraction-like bend: slopes facing along the ramp see further along, turned-away edges back toward its start
    layerT += uGlass.y * 0.25 * ( dot( glassN.xy, uGradDir ) - glassEdge );
  #endif
  vec3 layerGradCol = texture2D( uGradTex, vec2( clamp( layerT, 0.0, 1.0 ), 0.5 ) ).rgb;
  diffuseColor.rgb *= layerGradCol;
#endif
#ifdef USE_FACEIMAGE
  vec2 faceUv = vec2( ( vFacePos.x - uFaceBox.x ) / ( uFaceBox.z - uFaceBox.x ), ( uFaceBox.w - vFacePos.y ) / ( uFaceBox.w - uFaceBox.y ) );
  vec4 faceTexel = texture2D( uFaceTex, faceUv );
  #ifdef FACEIMAGE_EDGE
    diffuseColor.rgb = mix( diffuseColor.rgb, faceSrgbToLinear( faceTexel.rgb ), uFaceMix.x );
  #else
    vec3 faceCol = faceSrgbToLinear( min( faceTexel.rgb / max( faceTexel.a, 1e-4 ), vec3( 1.0 ) ) );
    diffuseColor.rgb = mix( diffuseColor.rgb, faceCol, uFaceMix.x * clamp( faceTexel.a / max( uFaceMix.y, 1e-3 ), 0.0, 1.0 ) );
  #endif
#endif
#if defined( USE_PATTERN ) || defined( USE_FLAKES ) || defined( SURFACE_KIND )
  vec3 surfL = layerSurfacePos();
#endif
#ifdef USE_PATTERN
  // composited like 2D: marks over the base, color2 over the marks; folded into one
  // mark colour + weight so the output stage can flatten the marks by (1 - shade)
  vec4 patS = patternAt( surfL.xy );
  float patWx = clamp( patS.x, 0.0, 1.0 ) * uPatOpacity;
  float patWy = clamp( patS.y, 0.0, 1.0 ) * uPatOpacity;
  float patW = 1.0 - ( 1.0 - patWx ) * ( 1.0 - patWy );
  vec3 patCol = ( uPatColor * patWx * ( 1.0 - patWy ) + uPatColor2 * patWy ) / max( patW, 1e-5 );
  diffuseColor.rgb = mix( diffuseColor.rgb, patCol, patW );
#endif
#ifdef USE_GLASS
  // absorption: a longer path through the glass where the surface turns away deepens,
  // saturates and darkens the colour; the facing core clears a little
  diffuseColor.rgb = pow( max( diffuseColor.rgb, vec3( 1e-4 ) ), vec3( 1.0 + uGlass.x * ( 3.0 * glassEdge - 0.4 ) ) ) * ( 1.0 - 0.45 * uGlass.x * glassEdge );
#endif
`;

const FRAG_EMISSIVE = /* glsl */ `
#include <emissivemap_fragment>
#ifdef USE_LAYERGRAD
  totalEmissiveRadiance *= layerGradCol;
#endif
`;

const FRAG_NORMAL = /* glsl */ `
#include <normal_fragment_maps>
#ifdef SURFACE_KIND
  // one pixel in features, taken at top level (derivatives of the rebuilt cap position are stable)
  float srfAA = max( length( fwidth( surfL.xy ) ) / uSurface.y, 1e-4 );
  vec3 srfTilt = layerDirToView( vec3( surfaceSlope( surfL.xy, srfAA ), 0.0 ) ) * uSurface.x;
  normal = normalize( normal - ( srfTilt - dot( srfTilt, normal ) * normal ) );
#endif
#ifdef USE_PATTERN
  // finite-difference height gradient in layer space, steps of 2% of a motif, expressed as
  // height change per motif so the bump does not depend on the pattern scale
  const float patE = 0.02;
  vec2 patGL = vec2(
    patternAt( surfL.xy + vec2( patE * uPatCell, 0.0 ) ).z - patS.z,
    patternAt( surfL.xy + vec2( 0.0, patE * uPatCell ) ).z - patS.z
  ) / patE;
  vec3 reliefTilt = layerDirToView( vec3( patGL, 0.0 ) ) * ( uPatRelief * ${RELIEF_TILT} );
  normal = normalize( normal - ( reliefTilt - dot( reliefTilt, normal ) * normal ) );
#endif
#ifdef USE_FLAKES
  // one round flake per cell (jittered centre, random radius and tilt), smooth base between;
  // the distance is measured in the surface plane so flakes are discs on caps and walls alike
  // (cells shifted half a cell in z so the face plane z = 0 never sits on a cell boundary)
  vec3 flakeP = surfL / uFlakes.y + vec3( 0.0, 0.0, 0.5 );
  vec3 flakeCell = floor( flakeP );
  vec3 flakeA = flakeRandom( flakeCell );
  vec3 flakeB = flakeRandom( flakeCell + vec3( 4099.0, 1543.0, 7919.0 ) );
  float flakeR = 0.22 + 0.13 * flakeB.z;
  vec3 flakeV = flakeP - flakeCell - 0.5 - ( flakeB - 0.5 ) * 0.3;
  vec3 flakeN = ( nonPerturbedNormal * mat3( viewMatrix ) ) * uLayerRot; // view → layer space
  float flakeD = length( flakeV - dot( flakeV, flakeN ) * flakeN );
  float flakeAA = max( fwidth( flakeD ), 1e-3 );
  float flakeIn = 1.0 - smoothstep( flakeR - flakeAA, flakeR + flakeAA, flakeD );
  vec3 flakeT = layerDirToView( flakeA * 2.0 - 1.0 );
  flakeT -= dot( flakeT, normal ) * normal;
  normal = normalize( normal + flakeT * ( uFlakes.x * flakeIn ) );
#endif
`;

const FRAG_CLEARCOAT_NORMAL = /* glsl */ `
#include <clearcoat_normal_fragment_begin>
#if defined( USE_CLEARCOAT ) && defined( SURFACE_KIND )
  clearcoatNormal = normalize( clearcoatNormal - ( srfTilt - dot( srfTilt, clearcoatNormal ) * clearcoatNormal ) );
#endif
#if defined( USE_CLEARCOAT ) && defined( USE_PATTERN )
  clearcoatNormal = normalize( clearcoatNormal - ( reliefTilt - dot( reliefTilt, clearcoatNormal ) * clearcoatNormal ) );
#endif
`;

/** Replace `from` in a three shader chunk, failing loudly if a three upgrade renamed it. */
function patchChunk(src: string, from: string, to: string): string {
  if (!src.includes(from)) throw new Error(`materials.ts: three chunk lost "${from}"`);
  return src.replaceAll(from, to);
}

// three's IBL lookups with the env-locked normal (identity without ENV_LOCK)
let lightsMapsLocked = THREE.ShaderChunk.lights_fragment_maps;
lightsMapsLocked = patchChunk(lightsMapsLocked, 'getIBLIrradiance( geometryNormal )', 'getIBLIrradiance( ENVLOCK_N( geometryNormal ) )');
lightsMapsLocked = patchChunk(lightsMapsLocked, 'geometryViewDir, geometryNormal,', 'geometryViewDir, ENVLOCK_N( geometryNormal ),');
lightsMapsLocked = patchChunk(lightsMapsLocked, 'geometryViewDir, geometryClearcoatNormal,', 'geometryViewDir, ENVLOCK_N( geometryClearcoatNormal ),');

const FRAG_REFLECT = /* glsl */ `
reflectedLight.directSpecular *= uSpecBoost;
#ifdef USE_CLEARCOAT
  clearcoatSpecularDirect *= uSpecBoost;
#endif
${lightsMapsLocked}
#if defined( USE_ENVMAP ) && defined( RE_IndirectSpecular )
  radiance *= uReflectivity;
  #ifdef USE_CLEARCOAT
    clearcoatRadiance *= uReflectivity;
  #endif
#endif
`;

const FRAG_TRANSMISSION = /* glsl */ `
#include <transmission_fragment>
#ifdef USE_TRANSMISSION
  vec3 gemLight = vec3( 0.0 );
  #if defined( USE_ENVMAP ) && defined( ENVMAP_TYPE_CUBE_UV )
    // environment refracted into the gem and bounced back toward the viewer off its back
    vec3 gemIors = vec3( material.ior );
    #ifdef USE_DISPERSION
      float gemSpread = ( material.ior - 1.0 ) * 0.025 * material.dispersion;
      gemIors += vec3( -gemSpread, 0.0, gemSpread );
    #endif
    vec3 gemV = geometryViewDir;
    for ( int i = 0; i < 3; i ++ ) {
      vec3 rIn = refract( -gemV, ENVLOCK_N( normal ), 1.0 / gemIors[ i ] );
      vec3 rOut = reflect( rIn, gemV );
      rOut = transformDirectionByInverseViewMatrix( rOut, viewMatrix );
      gemLight[ i ] = textureCubeUV( envMap, envMapRotation * rOut, material.roughness )[ i ];
    }
    vec3 gemF = EnvironmentBRDF( normal, gemV, material.specularColorBlended, material.specularF90, material.roughness );
    gemLight *= envMapIntensity * uReflectivity * ( 1.0 - gemF ) * material.diffuseContribution
      * material.transmission * ( 1.0 - gemBehind );
  #endif
#endif
`;

const OUTPUT_PATCH = /* glsl */ `
#ifdef USE_PATTERN
  // flat (unlit) share of the marks
  float patFlat = patW * ( 1.0 - uPatShade );
  totalDiffuse = mix( totalDiffuse, patCol, patFlat );
  outgoingLight = mix( outgoingLight, patCol, patFlat );
#endif
#if defined( OPAQUE ) && !defined( USE_TRANSMISSION )
  gl_FragColor = vec4( outgoingLight, 1.0 );
#else
  #ifdef OPAQUE
    float bodyA = 1.0;
  #else
    float bodyA = clamp( diffuseColor.a, 0.0, 1.0 );
  #endif
  vec3 bodyCol = totalDiffuse * bodyA;
  vec3 addLight = max( outgoingLight - totalDiffuse, vec3( 0.0 ) );
  #ifdef USE_TRANSMISSION
    // totalDiffuse is already premultiplied (opaque body mixed with the coverage-weighted
    // refracted sample); its coverage is transmissionAlpha
    bodyA *= material.transmissionAlpha;
    addLight += gemLight;
  #endif
  float addA = clamp( max( addLight.r, max( addLight.g, addLight.b ) ), 0.0, 1.0 );
  gl_FragColor = vec4( bodyCol + addLight, bodyA + ( 1.0 - bodyA ) * addA );
#endif
`;

interface PartUniforms {
  uReflectivity: THREE.IUniform<number>;
  uSpecBoost: THREE.IUniform<number>;
  uLayerInv: THREE.IUniform<THREE.Matrix4>;
  uLayerRot: THREE.IUniform<THREE.Matrix3>;
  uGradTex: THREE.IUniform<THREE.Texture | null>;
  uGradKind: THREE.IUniform<number>;
  uGradDir: THREE.IUniform<THREE.Vector2>;
  uGradBox: THREE.IUniform<THREE.Vector4>;
  uGradFit: THREE.IUniform<THREE.Vector2>;
  uFlakes: THREE.IUniform<THREE.Vector2>;
  uPatCell: THREE.IUniform<number>;
  uSurface: THREE.IUniform<THREE.Vector4>;
  uViewport: THREE.IUniform<THREE.Vector2>;
  uProjK: THREE.IUniform<THREE.Vector4>;
  uFrameSpan: THREE.IUniform<number>;
  uFaceTex: THREE.IUniform<THREE.Texture | null>;
  uFaceBox: THREE.IUniform<THREE.Vector4>;
  uFaceMix: THREE.IUniform<THREE.Vector2>;
  uGlass: THREE.IUniform<THREE.Vector2>;
  uEnvBlur: THREE.IUniform<number>;
  uEnvRepeat: THREE.IUniform<THREE.Vector2>;
}

export type PartMaterial = THREE.MeshPhysicalMaterial & {
  userData: { u: PartUniforms; pat: Record<string, THREE.IUniform> };
};

export function createPartMaterial(): PartMaterial {
  const m = new THREE.MeshPhysicalMaterial({ premultipliedAlpha: true }) as PartMaterial;
  const u: PartUniforms = {
    uReflectivity: { value: 1 },
    uSpecBoost: { value: 1 },
    uLayerInv: { value: new THREE.Matrix4() },
    uLayerRot: { value: new THREE.Matrix3() },
    uGradTex: { value: null },
    uGradKind: { value: 0 },
    uGradDir: { value: new THREE.Vector2(0, -1) },
    uGradBox: { value: new THREE.Vector4(0, 0, 1, 1) },
    uGradFit: { value: new THREE.Vector2(1, 0) },
    uFlakes: { value: new THREE.Vector2(0, 1) },
    uPatCell: { value: 1 },
    uSurface: { value: new THREE.Vector4(0, 1, 0, 0) },
    uViewport: { value: new THREE.Vector2(1, 1) },
    uProjK: { value: new THREE.Vector4(1, 1, 0, 0) },
    uFrameSpan: { value: 1 },
    uFaceTex: { value: null },
    uFaceBox: { value: new THREE.Vector4(-1, -1, 1, 1) },
    uFaceMix: { value: new THREE.Vector2(0, 0.5) },
    uGlass: { value: new THREE.Vector2(0, 0) },
    uEnvBlur: { value: 0 },
    uEnvRepeat: { value: new THREE.Vector2(1, 1) },
  };
  const pat = patternUniforms();
  m.userData.u = u;
  m.userData.pat = pat;
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u, pat);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERT_DECL}`)
      .replace('#include <project_vertex>', VERT_BODY);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAG_DECL}`)
      .replace('#include <cube_uv_reflection_fragment>', cubeUvChunk(true))
      .replace(
        '#include <transmission_pars_fragment>',
        THREE.ShaderChunk.transmission_pars_fragment
          .replace(TRANSMISSION_SAMPLE_FROM, TRANSMISSION_SAMPLE_TO)
          .replace(TRANSMISSION_SIZE_FROM, TRANSMISSION_SIZE_TO)
          .replace(TRANSMISSION_LOD_FROM, TRANSMISSION_LOD_TO),
      )
      .replace('#include <normal_pars_fragment>', SURFACE_DECL)
      .replace('#include <map_fragment>', FRAG_MAP)
      .replace('#include <emissivemap_fragment>', FRAG_EMISSIVE)
      .replace('#include <normal_fragment_maps>', FRAG_NORMAL)
      .replace('#include <clearcoat_normal_fragment_begin>', FRAG_CLEARCOAT_NORMAL)
      .replace('#include <lights_fragment_maps>', FRAG_REFLECT)
      .replace('#include <transmission_fragment>', FRAG_TRANSMISSION)
      .replace('#include <opaque_fragment>', OUTPUT_PATCH)
      .replace('#include <premultiplied_alpha_fragment>', '');
  };
  // the camera is only known per draw: feed the projection terms layerSurfacePos needs
  m.onBeforeRender = (_renderer, _scene, camera) => {
    const e = camera.projectionMatrix.elements; // column-major: P[col][row] = e[col * 4 + row]
    u.uProjK.value.set(e[0], e[5], e[8], e[9]);
  };
  // three keys programs by their defines too (USE_FACEIMAGE, FACEIMAGE_EDGE, ...); compressHdrOutput
  // snapshots this key, so it names the patch source version only
  m.customProgramCacheKey = () => 'pachi-part-v12';
  m.iridescenceIOR = 1.6;
  m.iridescenceThicknessRange = [180, 520];
  return compressHdrOutput(m);
}

export interface EnvState {
  map: THREE.Texture | null;
  rotation: number; // radians around Y
  intensity: number;
  /** Comp['environment'].blur: a floor on the roughness every environment lookup uses. */
  blur: number;
  /** Comp['environment'].repeatX / repeatY: how many times the environment tiles around / up the turn. */
  repeatX: number;
  repeatY: number;
  /** Title3DProps.envLock: reflect as if the layer were unrotated and unflipped (needs PartSpace.layerRot). */
  lock: boolean;
}

/** Where a part lives: layer-space frame and the size that size-relative units refer to. */
export interface PartSpace {
  /** The part's layer-space 2D bounds (gradient span); undefined = no gradient. */
  bounds: THREE.Box2 | undefined;
  /** World → layer space (inverse of the layer root matrix). */
  layerInverse: THREE.Matrix4;
  /** Layer axes → world: the rotation times the flipX / flipY mirror (orthonormal, no scale). */
  layerRot: THREE.Matrix3;
  /** source.size in layer px (reference for pattern / flake sizes). */
  size: number;
  /** Render target size, px. */
  viewport: THREE.Vector2;
  /** Whole render width / render target width: 1 unless the target is a preview window (contracts.ts RenderFrame). */
  frameSpan: number;
}

/** A picture projected straight on (Title3DProps.faceImage / edgeImage, header 2b). */
export interface ImageProjection {
  /** faceImageTexture (face slots) or edgeImageTexture (band and side slots) of the source bitmap. */
  texture: THREE.Texture;
  /** Layer-space box the picture fills, y-up: the fitted image box the outline was traced in. */
  box: { x0: number; y0: number; x1: number; y1: number };
  /** How much of the picture replaces the base colour, 0..1. */
  amount: number;
  /** Face: alpha 0..1 of the traced edge (ImageSource.trace.threshold / 255). Bands and sides: null (the edge texture is opaque). */
  edge: number | null;
}

/** Longest side of a face image texture, px (larger images are downscaled once). */
const FACE_TEX_MAX = 4096;
/** Longest side of an edge image texture, px (its nearest-colour fill runs on the CPU: ≈ 40 ms at this size). */
const EDGE_TEX_MAX = 1024;
const faceTextures = new WeakMap<ImageBitmap, THREE.Texture>();
/** One edge texture per bitmap, for the last traced-edge alpha it was built for. */
const edgeTextures = new WeakMap<ImageBitmap, { threshold: number; tex: THREE.Texture }>();

function setImageSampling(tex: THREE.Texture) {
  tex.colorSpace = THREE.NoColorSpace;
  tex.flipY = false;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
}

/** `bmp` drawn into a canvas whose longest side is at most `max` px. */
function downscaled(bmp: ImageBitmap, max: number): OffscreenCanvas {
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height, 1));
  const canvas = new OffscreenCanvas(Math.max(1, Math.round(bmp.width * k)), Math.max(1, Math.round(bmp.height * k)));
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/**
 * Premultiplied, mipmapped GPU texture of an image source's bitmap for the face image: raw
 * sRGB values, rows top → bottom (flipY off). Uploaded from a canvas copy because WebGL
 * ignores UNPACK_PREMULTIPLY_ALPHA for ImageBitmaps (the shared one is straight alpha) and a
 * canvas uploads its own premultiplied pixels exactly. One per bitmap, shared by every renderer.
 */
export function faceImageTexture(bmp: ImageBitmap): THREE.Texture {
  let tex = faceTextures.get(bmp);
  if (tex) return tex;
  tex = new THREE.Texture(downscaled(bmp, FACE_TEX_MAX));
  tex.premultiplyAlpha = true;
  setImageSampling(tex);
  faceTextures.set(bmp, tex);
  return tex;
}

/**
 * Opaque, mipmapped GPU texture of an image source's bitmap for the bands and sides (header
 * 2b): every texel takes the straight colour of the nearest pixel whose alpha reaches
 * `threshold` (0..255, the traced edge), raw sRGB, rows top → bottom. Shared by every renderer;
 * rebuilt (the old one disposed) when the threshold changes.
 */
export function edgeImageTexture(bmp: ImageBitmap, threshold: number): THREE.Texture {
  const hit = edgeTextures.get(bmp);
  if (hit?.threshold === threshold) return hit.tex;
  hit?.tex.dispose();
  const canvas = downscaled(bmp, EDGE_TEX_MAX);
  const { width: w, height: h } = canvas;
  const px = canvas.getContext('2d')!.getImageData(0, 0, w, h).data;
  const tex = new THREE.DataTexture(nearestInsideColours(px, w, h, threshold), w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  setImageSampling(tex);
  edgeTextures.set(bmp, { threshold, tex });
  return tex;
}

/**
 * RGBA (alpha 255) where every pixel has the colour of the nearest pixel of `px` (straight
 * RGBA, w×h) with alpha ≥ `threshold`: exact Euclidean nearest site by the separable lower
 * envelope (Felzenszwalb & Huttenlocher), columns then rows. All black when no pixel qualifies.
 */
function nearestInsideColours(px: Uint8ClampedArray, w: number, h: number, threshold: number): Uint8Array {
  const out = new Uint8Array(w * h * 4);
  // per column: the row of the nearest site in that column (-1 = none)
  const near = new Int32Array(w * h);
  for (let x = 0; x < w; x++) {
    let last = -1;
    for (let y = 0; y < h; y++) {
      if (px[(y * w + x) * 4 + 3] >= threshold) last = y;
      near[y * w + x] = last;
    }
    last = -1;
    for (let y = h - 1; y >= 0; y--) {
      const i = y * w + x;
      if (px[i * 4 + 3] >= threshold) last = y;
      if (last >= 0 && (near[i] < 0 || last - y < y - near[i])) near[i] = last;
    }
  }
  // per row: lower envelope of the parabolas (x - q)² + dy(q)² over the columns q with a site
  const f = new Float64Array(w);
  const v = new Int32Array(w);
  const z = new Float64Array(w + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let k = -1;
    for (let q = 0; q < w; q++) {
      const ny = near[row + q];
      if (ny < 0) continue;
      f[q] = (y - ny) * (y - ny) + q * q;
      let s = -Infinity;
      while (k >= 0) {
        const p = v[k];
        s = (f[q] - f[p]) / (2 * (q - p));
        if (s > z[k]) break;
        k--;
      }
      k++;
      v[k] = q;
      z[k] = k === 0 ? -Infinity : s;
      z[k + 1] = Infinity;
    }
    if (k < 0) {
      // no site in any column: the image has nothing inside the edge
      for (let x = 0; x < w; x++) out[(row + x) * 4 + 3] = 255;
      continue;
    }
    for (let x = 0, j = 0; x < w; x++) {
      while (z[j + 1] < x) j++;
      const q = v[j];
      const src = (near[row + q] * w + q) * 4;
      const dst = (row + x) * 4;
      out[dst] = px[src];
      out[dst + 1] = px[src + 1];
      out[dst + 2] = px[src + 2];
      out[dst + 3] = 255;
    }
  }
  return out;
}

/** Project `img` on `m`, or with null nothing (backplates, other sources, amount 0). */
export function applyImageProjection(m: PartMaterial, img: ImageProjection | null) {
  const on = img !== null && img.amount > 0;
  setDefine(m, 'USE_FACEIMAGE', on);
  setDefine(m, 'FACEIMAGE_EDGE', on && img.edge === null);
  const u = m.userData.u;
  u.uFaceTex.value = on ? img.texture : null;
  if (!on) return;
  u.uFaceBox.value.set(img.box.x0, img.box.y0, img.box.x1, img.box.y1);
  u.uFaceMix.value.set(clamp01(img.amount), img.edge === null ? 1 : clamp01(img.edge));
}

const DEG = Math.PI / 180;

const GRAD_KINDS: Record<Material3D['gradientKind'], number> = { linear: 0, radial: 1, reflected: 2 };
const GRAD_SPANS: Record<GradientSpan, string | undefined> = { layer: undefined, line: '1', char: '2' };

function setDefine(m: THREE.Material, name: string, on: boolean) {
  setDefineValue(m, name, on ? '' : undefined);
}

/** Set (or with `undefined`, remove) a shader define; recompiles only on change. */
function setDefineValue(m: THREE.Material, name: string, value: string | undefined) {
  const defines = ((m as THREE.MeshPhysicalMaterial).defines ??= {});
  if (defines[name] === value && (value !== undefined || !(name in defines))) return;
  if (value === undefined) delete defines[name];
  else defines[name] = value;
  m.needsUpdate = true;
}

/** Update `m` from a Material3D. */
export function applyMaterial3D(m: PartMaterial, mat: Material3D, env: EnvState, kit: PassKit, space: PartSpace) {
  const grad = mat.gradient && mat.gradient.stops.length > 0 ? mat.gradient : null;
  m.color.set(grad ? '#ffffff' : mat.color);
  m.metalness = clamp01(mat.metalness);
  m.roughness = clamp01(mat.roughness);
  m.emissive.set(mat.emissive);
  m.emissiveIntensity = Math.max(0, mat.emissiveIntensity);
  m.iridescence = clamp01(mat.iridescence);
  m.clearcoat = clamp01(mat.clearcoat);
  m.clearcoatRoughness = 0.04;
  m.envMap = env.map;
  m.envMapRotation.set(0, env.rotation, 0);
  m.envMapIntensity = env.intensity;
  setDefine(m, 'ENV_LOCK', env.lock);

  // gem body; thickness drives the refraction offset of what is behind
  m.transmission = clamp01(mat.transmission);
  m.ior = Math.min(2.333, Math.max(1, mat.ior));
  m.dispersion = clamp01(mat.dispersion) * DISPERSION_SCALE;
  m.thickness = GEM_THICKNESS * space.size;

  const u = m.userData.u;
  u.uReflectivity.value = Math.min(4, Math.max(0, mat.reflectivity));
  u.uSpecBoost.value = Math.min(4, Math.max(0, mat.specBoost));
  u.uLayerInv.value.copy(space.layerInverse);
  u.uLayerRot.value.copy(space.layerRot);
  u.uViewport.value.copy(space.viewport);
  u.uFrameSpan.value = space.frameSpan;
  u.uEnvBlur.value = clamp01(env.blur);
  setRepeat(u.uEnvRepeat, env);

  const opacity = clamp01(mat.opacity);
  const transparent = opacity < 0.999;
  if (m.transparent !== transparent) {
    m.transparent = transparent;
    m.side = transparent ? THREE.DoubleSide : THREE.FrontSide;
    m.needsUpdate = true;
  }
  m.opacity = opacity;

  // flakes
  const flakes = clamp01(mat.flakes);
  setDefine(m, 'USE_FLAKES', flakes > 0);
  u.uFlakes.value.set(flakes * FLAKE_TILT, Math.max(0.05, (mat.flakeScale / 100) * space.size));

  // surface; the seed shifts the feature lattice by whole features (integer: the cells stay put)
  const srf = mat.surface;
  const srfOn = srf.kind !== 'none' && srf.amount > 0;
  setDefineValue(m, 'SURFACE_KIND', srfOn ? SURFACE_KINDS[srf.kind as Exclude<Surface3D['kind'], 'none'>] : undefined);
  if (srfOn) {
    const seed = Math.round(srf.seed);
    u.uSurface.value.set(
      clamp01(srf.amount) * SURFACE_TILT[srf.kind as Exclude<Surface3D['kind'], 'none'>],
      Math.max(0.5, (srf.scale / 100) * space.size),
      ((seed * 7919) % 389) - 194,
      ((seed * 104729) % 397) - 198,
    );
  }
  // pattern: the shared uniforms in layer units (relief-only patterns are active too)
  const pat = mat.pattern;
  const usePattern = patternActive(pat);
  setDefine(m, 'USE_PATTERN', usePattern);
  if (usePattern) {
    setPatternUniforms(m.userData.pat, pat, space.size, { linear: true });
    u.uPatCell.value = Math.max(1e-3, (pat.scale / 100) * space.size);
  }

  // gradient
  const bounds = space.bounds;
  const useGrad = grad !== null && bounds !== undefined && !bounds.isEmpty();
  const depth = useGrad && mat.gradientAxis === 'depth';
  setDefine(m, 'USE_LAYERGRAD', useGrad);
  setDefine(m, 'LAYERGRAD_DEPTH', depth);
  setDefineValue(m, 'LAYERGRAD_SPAN', useGrad && !depth ? GRAD_SPANS[mat.gradientSpan] : undefined);
  if (useGrad) {
    u.uGradTex.value = kit.gradientTexture(grad);
    u.uGradKind.value = GRAD_KINDS[mat.gradientKind];
    const a = mat.gradientAngle * DEG;
    u.uGradDir.value.set(Math.cos(a), -Math.sin(a)); // 90° = top → bottom on screen (y-up space)
    u.uGradBox.value.set(bounds.min.x, bounds.min.y, bounds.max.x, bounds.max.y);
    u.uGradFit.value.set(mat.gradientScale, mat.gradientOffset);
  } else {
    u.uGradTex.value = null;
  }

  // coloured-glass depth and the gradient's refraction bend
  const glassDepth = clamp01(mat.glassDepth);
  const bend = useGrad && !depth ? Math.min(1, Math.max(-1, mat.gradientBend)) : 0;
  setDefine(m, 'USE_GLASS', glassDepth > 0 || bend !== 0);
  u.uGlass.value.set(glassDepth, bend);
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

import { NOISE_GLSL } from '../../effects/lib';
import { PATTERN_GLSL, PATTERN_UNIFORMS_GLSL } from '../patterns';

// GLSL for the 2D title renderer. Conventions: every element texture covers the same
// "frame" (layer-space box) at mask resolution; gl_FragCoord is in frame pixels, y-up.
// Masks are R8 coverage in .r. Shading happens in sRGB (Photoshop's working space, so
// screen/multiply/gradient-map behave like the PS recipes) and converts to linear,
// premultiplied output at the end.

export const COLOR_GLSL = /* glsl */ `
vec3 toLinear(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}
vec3 toSrgb(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
`;

/** 256-entry curve LUT (R32F, texelFetch + manual lerp: float textures need not filter). */
export const LUT_GLSL = /* glsl */ `
float lutAt(sampler2D lut, float x) {
  float f = clamp(x, 0.0, 1.0) * 255.0;
  int i = int(floor(f));
  int j = min(i + 1, 255);
  return mix(texelFetch(lut, ivec2(i, 0), 0).r, texelFetch(lut, ivec2(j, 0), 0).r, f - float(i));
}
`;

/**
 * fillColor(): every FillKind over a span box (bmin..bmax, same units as p) → sRGB colour +
 * straight alpha (gradient stop opacity, image alpha). `burst` is the caller's shape-burst
 * coordinate (0 at the element edge → 1 at the deepest point / across the rim band), used by
 * kind 6 only. Kind 7 places an image cover-fitted over the span box (Fill.image); the
 * per-pixel step of p (uFillPx) gives textureGrad its exact footprint so tiles have no seams.
 */
export const FILL_GLSL = /* glsl */ `
uniform int uFillKind; // 0 solid, 1 linear, 2 radial, 3 angle, 4 reflected, 5 diamond, 6 shapeBurst, 7 image
uniform vec3 uFillColor;
uniform sampler2D tFillGrad; // RGBA: sRGB colour, straight alpha
uniform vec2 uFillDir; // y-up unit vector of the gradient axis
uniform float uFillScale;
uniform float uFillOffset;
uniform float uFillPx;      // p units per output pixel
uniform bool uImgOn;        // image decoded (else the fill shows uFillColor)
uniform sampler2D tFillImg; // rows top → bottom, straight alpha
uniform float uImgAspect;   // image width / height
uniform float uImgScale;
uniform vec2 uImgOff;       // fractions of the span box, y-up
uniform vec2 uImgRot;       // cos, sin of the clockwise-on-screen rotation
uniform bool uImgTile;
vec3 rampAt(sampler2D ramp, float t) {
  return texture(ramp, vec2(clamp(t, 0.0, 1.0) * (255.0 / 256.0) + 0.5 / 256.0, 0.5)).rgb;
}
vec4 rampAt4(sampler2D ramp, float t) {
  return texture(ramp, vec2(clamp(t, 0.0, 1.0) * (255.0 / 256.0) + 0.5 / 256.0, 0.5));
}
vec4 imageFill(vec2 p, vec2 bmin, vec2 bmax) {
  if (!uImgOn) return vec4(uFillColor, 1.0);
  vec2 bs = max(bmax - bmin, vec2(1e-3));
  vec2 v = p - 0.5 * (bmin + bmax) - uImgOff * bs;
  // Undo the clockwise-on-screen rotation (a counter-clockwise turn in y-up space).
  vec2 r = vec2(uImgRot.x * v.x - uImgRot.y * v.y, uImgRot.y * v.x + uImgRot.x * v.y);
  // Cover fit: the image's smaller relative side spans the box at scale 1.
  float w = max(bs.x, bs.y * uImgAspect) * max(uImgScale, 1e-3);
  vec2 size = vec2(w, w / uImgAspect);
  vec2 uv = r / size + 0.5;
  vec2 st = uImgTile ? fract(uv) : clamp(uv, 0.0, 1.0);
  vec2 dx = uImgRot * uFillPx / size;
  vec2 dy = vec2(-uImgRot.y, uImgRot.x) * uFillPx / size;
  // Texture rows run top → bottom: flip v.
  return textureGrad(tFillImg, vec2(st.x, 1.0 - st.y), vec2(dx.x, -dx.y), vec2(dy.x, -dy.y));
}
vec4 fillColor(vec2 p, vec2 bmin, vec2 bmax, float burst) {
  if (uFillKind == 0) return vec4(uFillColor, 1.0);
  if (uFillKind == 7) return imageFill(p, bmin, bmax);
  vec2 c = 0.5 * (bmin + bmax);
  vec2 hs = 0.5 * (bmax - bmin);
  vec2 v = p - c;
  float s = max(uFillScale, 1e-3);
  float ext = max(abs(uFillDir.x) * hs.x + abs(uFillDir.y) * hs.y, 1e-3);
  float t;
  if (uFillKind == 1) {
    t = dot(v, uFillDir) / (2.0 * ext * s) + 0.5;
  } else if (uFillKind == 2) {
    t = length(v) / (max(length(hs), 1e-3) * s);
  } else if (uFillKind == 3) {
    // Clockwise on screen (y-up: negative cross) from the gradient direction, 0..1 per turn.
    float a = atan(-(uFillDir.x * v.y - uFillDir.y * v.x), dot(uFillDir, v));
    t = (a < 0.0 ? a + 6.2831853 : a) / (6.2831853 * s);
  } else if (uFillKind == 4) {
    t = abs(dot(v, uFillDir)) / (ext * s);
  } else if (uFillKind == 5) {
    t = (abs(v.x) + abs(v.y)) / (max(hs.x + hs.y, 1e-3) * s);
  } else {
    t = burst / s;
  }
  return rampAt4(tFillGrad, t - uFillOffset);
}
`;

export const BACKGROUND_FRAG = /* glsl */ `
${COLOR_GLSL}
${FILL_GLSL}
uniform vec2 uSize;
in vec2 vUv; out vec4 o;
void main() {
  vec2 p = vUv * uSize;
  // Shape burst of the comp rectangle: distance to the nearest edge over the half short side.
  vec2 e = min(p, uSize - p);
  float burst = min(e.x, e.y) / max(0.5 * min(uSize.x, uSize.y), 1e-3);
  vec4 f = fillColor(p, vec2(0.0), uSize, burst);
  o = vec4(toLinear(f.rgb) * f.a, f.a);
}`;

// ---------- gradient span (text) ----------

/**
 * R = index of the glyph nearest to each frame pixel: smallest distance to its ink box (0
 * inside), ties (overlapping boxes) broken by the distance to the box centre. Computed once
 * per geometry and frame; elements then read their span box per pixel from tGlyphs.
 */
export const NEAREST_GLYPH_FRAG = /* glsl */ `
uniform sampler2D tGlyphs; // RGBA32F, N × 2: row 0 = ink boxes, row 1 = line boxes (layer units)
uniform int uCount;
uniform vec2 uFrameMin;    // layer units
uniform float uM;          // frame px per layer unit
out vec4 o;
void main() {
  vec2 p = uFrameMin + gl_FragCoord.xy / uM;
  float best = 1e30, bestC = 1e30;
  int bi = 0;
  for (int i = 0; i < uCount; i++) {
    vec4 b = texelFetch(tGlyphs, ivec2(i, 0), 0);
    vec2 c = 0.5 * (b.xy + b.zw);
    vec2 q = abs(p - c) - 0.5 * (b.zw - b.xy);
    float d = length(max(q, 0.0));
    float dc = dot(p - c, p - c);
    if (d < best - 1e-4 || (d <= best + 1e-4 && dc < bestC)) { best = d; bestC = dc; bi = i; }
  }
  o = vec4(float(bi));
}`;

/** Max inside distance (−SDF) over 8×8 blocks; repeated down to 1×1 for shape-burst fills. */
export const REDUCE_MAX_FRAG = /* glsl */ `
uniform sampler2D tSrc; uniform bool uFirst; out vec4 o;
void main() {
  ivec2 base = ivec2(gl_FragCoord.xy) * 8;
  ivec2 mx = textureSize(tSrc, 0) - 1;
  float m = 0.0;
  for (int y = 0; y < 8; y++) for (int x = 0; x < 8; x++) {
    ivec2 q = base + ivec2(x, y);
    if (q.x > mx.x || q.y > mx.y) continue;
    float v = texelFetch(tSrc, q, 0).r;
    m = max(m, uFirst ? -v : v);
  }
  o = vec4(m);
}`;

/** Canvas (RGBA8, coverage in alpha) → R8 mask. */
export const MASK_COPY_FRAG = /* glsl */ `
uniform sampler2D tSrc; out vec4 o;
void main() { o = vec4(texelFetch(tSrc, ivec2(gl_FragCoord.xy), 0).a); }`;

/** Canvas2D drawing → RGBA (straight alpha): an image face's own picture, texel for texel with its mask. */
export const PICTURE_COPY_FRAG = /* glsl */ `
uniform sampler2D tSrc; out vec4 o;
void main() { o = texelFetch(tSrc, ivec2(gl_FragCoord.xy), 0); }`;

/** R8 mask → .r everywhere; drawn with MAX blending to union every element's mask. */
export const MASK_UNION_FRAG = /* glsl */ `
uniform sampler2D tSrc; out vec4 o;
void main() { o = vec4(texelFetch(tSrc, ivec2(gl_FragCoord.xy), 0).r); }`;

/** かすれ: an element's mask × the shared keep-mask (ERODE_FRAG), the coverage it is shaded from. */
export const MASK_KEEP_FRAG = /* glsl */ `
uniform sampler2D tSrc; uniform sampler2D tKeep; out vec4 o;
void main() { ivec2 p = ivec2(gl_FragCoord.xy); o = vec4(texelFetch(tSrc, p, 0).r * texelFetch(tKeep, p, 0).r); }`;

/**
 * かすれ (dry-brush) keep-mask, 1 = ink kept, from the union of every element (the OUTER
 * silhouette) and its SDF. The brush is dragged along uDir: thin bristle lanes run along it and
 * the dry ones lose ink over a random length measured ALONG the drag from the silhouette (the
 * trailing edge where the brush lifts, a third as much at the leading edge where it lands), so
 * gaps are long streaks entering from stroke ends, not holes. Dry lanes also split off the
 * silhouette along side edges (stray bristles). The SDF caps everything to a band of uEdgePx.
 * Every cut is anti-aliased through its own gradient: the elements are shaded from this mask, so
 * their bevels would light each step of an aliased cut.
 */
export const ERODE_FRAG = /* glsl */ `
${NOISE_GLSL}
uniform sampler2D tUnion; // union coverage (R8, linear filtered)
uniform sampler2D tSdf;   // its signed distance, px (+outside)
uniform vec2 uDir;        // drag direction, y-up unit
uniform float uAmount, uEdgePx, uLenPx, uLanePx;
uniform vec2 uSeed;
uniform vec2 uOrigin;    // the frame corner, in frame px from the layer origin
out vec4 o;
float cov(vec2 q) { return texture(tUnion, q / vec2(textureSize(tUnion, 0))).r; }
// Distance from p along dir to the silhouette (coverage < 0.5), capped at maxD; marched then bisected.
float exitDist(vec2 p, vec2 dir, float maxD) {
  float stepL = max(maxD / 48.0, 0.75);
  float t = 0.0;
  for (int i = 0; i < 96; i++) {
    float tn = t + stepL;
    if (tn > maxD) return maxD;
    if (cov(p + dir * tn) < 0.5) {
      float lo = t, hi = tn;
      for (int k = 0; k < 6; k++) { float m = 0.5 * (lo + hi); if (cov(p + dir * m) < 0.5) hi = m; else lo = m; }
      return 0.5 * (lo + hi);
    }
    t = tn;
  }
  return maxD;
}
float sdAt(ivec2 q) { return texelFetch(tSdf, clamp(q, ivec2(0), textureSize(tSdf, 0) - 1), 0).r; }
// Central-difference SDF gradient at q (2 × the outward normal, ~unit length per px).
vec2 sdGrad(vec2 q) {
  ivec2 i = ivec2(q);
  return vec2(sdAt(i + ivec2(1, 0)) - sdAt(i - ivec2(1, 0)), sdAt(i + ivec2(0, 1)) - sdAt(i - ivec2(0, 1)));
}
// Gradient of exitDist(p, dir) per frame px: moving p by δ moves the exit at p + dir·d by
// −(δ·n)/(dir·n) along dir, n the silhouette normal there (steep for grazing exits).
vec2 exitGrad(vec2 p, vec2 dir, float d, float maxD) {
  if (d >= maxD) return vec2(0.0);
  vec2 n = sdGrad(p + dir * d);
  float len = length(n);
  if (len < 1e-4) return vec2(0.0);
  float c = dot(dir, n);
  return -n / ((c < 0.0 ? -1.0 : 1.0) * max(abs(c), 0.05 * len));
}
// Brush state at frame px p: x = lane dryness (0 = inked, 1 = driest), y = ink lost from the
// silhouette along the drag (px), z = skip noise (ink catching again).
vec3 brush(vec2 p) {
  vec2 perp = vec2(-uDir.y, uDir.x);
  vec2 pl = p + uOrigin;
  float lane = dot(pl, perp) / uLanePx + uSeed.x;
  float along = dot(pl, uDir) / uLenPx + uSeed.y;
  // Lane dryness: fine bristles clustered into dry bundles that wander slowly along the drag.
  float dry = 0.55 * vnoise(vec2(lane, along * 0.15)) + 0.3 * vnoise(vec2(lane * 0.21, 3.7 + along * 0.1)) + 0.15 * vnoise(vec2(lane * 2.7, along * 0.8));
  float x = clamp((uAmount - dry) / max(uAmount, 1e-3), 0.0, 1.0);
  float gap = uLenPx * x * (0.45 + 0.8 * vnoise(vec2(lane * 0.37 + 11.0, along * 1.7)));
  return vec3(x, gap, vnoise(vec2(lane * 0.9 + 5.0, along * 4.0)));
}
// Cut where e crosses 0, anti-aliased over ±0.7 px through e's gradient g (per px).
float cut(float e, vec2 g) { float w = 0.7 * max(length(g), 1.0); return smoothstep(-w, w, e); }
void main() {
  ivec2 ip = ivec2(gl_FragCoord.xy);
  vec2 p = gl_FragCoord.xy;
  float depth = -texelFetch(tSdf, ip, 0).r; // px inside the silhouette
  if (texelFetch(tUnion, ip, 0).r <= 0.0 || depth > uEdgePx) { o = vec4(1.0); return; }
  vec3 b = brush(p);
  float x = b.x;
  if (x <= 0.0) { o = vec4(1.0); return; }
  // Lanes change fast across the drag (tens of px of gap per px), so take every field's slope.
  vec3 bx = brush(p + vec2(1.0, 0.0)) - b, by = brush(p + vec2(0.0, 1.0)) - b;
  vec2 gX = vec2(bx.x, by.x), gGap = vec2(bx.y, by.y), gSkip = vec2(bx.z, by.z);
  float gap = b.y;
  float maxD = min(uLenPx * 1.3, uEdgePx * 3.0);
  float dF = exitDist(p, uDir, maxD);
  float dB = exitDist(p, -uDir, maxD);
  float eat = max(cut(gap - dF, gGap - exitGrad(p, uDir, dF, maxD)), cut(gap * 0.35 - dB, gGap * 0.35 - exitGrad(p, -uDir, dB, maxD)));
  // Stray bristles along side edges.
  eat = max(eat, cut(x * x * uEdgePx * 0.3 - depth, 2.0 * x * uEdgePx * 0.3 * gX + 0.5 * sdGrad(p)));
  // Dry lanes skip: ink catches again in dashes along the drag, so gaps are broken streaks.
  float sw = max(0.125, 0.7 * length(gSkip));
  eat *= mix(1.0, smoothstep(0.325 - sw, 0.325 + sw, b.z), 0.45 * (1.0 - x));
  eat *= 1.0 - smoothstep(uEdgePx * 0.55, uEdgePx, depth);
  o = vec4(1.0 - eat);
}`;

/** Grow a mask through its SDF (image sources: round joins), shifted by uOffset px. */
export const GROW_FRAG = /* glsl */ `
uniform sampler2D tSdf; uniform float uGrow; uniform vec2 uOffset; out vec4 o;
float sd(ivec2 q) {
  ivec2 mx = textureSize(tSdf, 0) - 1;
  return texelFetch(tSdf, clamp(q, ivec2(0), mx), 0).r;
}
void main() {
  vec2 p = gl_FragCoord.xy - 0.5 - uOffset;
  vec2 f = fract(p); ivec2 i = ivec2(floor(p));
  float d = mix(mix(sd(i), sd(i + ivec2(1, 0)), f.x), mix(sd(i + ivec2(0, 1)), sd(i + ivec2(1, 1)), f.x), f.y);
  o = vec4(clamp(uGrow - d + 0.5, 0.0, 1.0));
}`;

// ---------- jump flooding SDF over sub-pixel edge points ----------
// Seeds are EDGE POINTS estimated from the anti-aliased coverage (pixel centre moved along
// the coverage gradient by its offset from 0.5), not pixel centres, so distances are smooth
// along slanted/curved edges (no staircase in the bevel normals).

export const SEED_FRAG = /* glsl */ `
uniform sampler2D tSrc; out vec4 o;
float cov(ivec2 q) {
  ivec2 mx = textureSize(tSrc, 0) - 1;
  return texelFetch(tSrc, clamp(q, ivec2(0), mx), 0).r;
}
void main() {
  ivec2 ip = ivec2(gl_FragCoord.xy);
  vec2 p = gl_FragCoord.xy;
  float a = cov(ip);
  // Edge pixels: partial coverage, or a hard (non-anti-aliased) step to a 4-neighbour.
  bool edge = a > 0.003 && a < 0.997;
  if (!edge) {
    float o4 = 1.0 - a;
    edge = abs(cov(ip + ivec2(1, 0)) - o4) < 0.003 || abs(cov(ip - ivec2(1, 0)) - o4) < 0.003
        || abs(cov(ip + ivec2(0, 1)) - o4) < 0.003 || abs(cov(ip - ivec2(0, 1)) - o4) < 0.003;
  }
  if (!edge) { o = vec4(0.0); return; }
  // Sobel gradient of coverage → normal pointing inside.
  float tl = cov(ip + ivec2(-1, 1)), t = cov(ip + ivec2(0, 1)), tr = cov(ip + ivec2(1, 1));
  float l = cov(ip + ivec2(-1, 0)), r = cov(ip + ivec2(1, 0));
  float bl = cov(ip + ivec2(-1, -1)), b = cov(ip + ivec2(0, -1)), br = cov(ip + ivec2(1, -1));
  vec2 g = vec2(tr + 2.0 * r + br - tl - 2.0 * l - bl, tl + 2.0 * t + tr - bl - 2.0 * b - br);
  vec2 n = dot(g, g) > 1e-8 ? normalize(g) : vec2(0.0);
  o = vec4(p - n * (a - 0.5), 1.0, 0.0);
}`;

export const JFA_FRAG = /* glsl */ `
uniform sampler2D tSrc; uniform float uStep; out vec4 o;
void main() {
  vec2 p = gl_FragCoord.xy;
  ivec2 res = textureSize(tSrc, 0);
  vec4 best = vec4(0.0); float dBest = 1e20;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    ivec2 q = ivec2(p + vec2(x, y) * uStep);
    if (q.x < 0 || q.y < 0 || q.x >= res.x || q.y >= res.y) continue;
    vec4 s = texelFetch(tSrc, q, 0);
    if (s.z > 0.5) { float d = dot(s.xy - p, s.xy - p); if (d < dBest) { dBest = d; best = s; } }
  }
  o = best;
}`;

/** R = signed distance in mask px (+outside, −inside) to the nearest sub-pixel edge point. */
export const SDF_FRAG = /* glsl */ `
uniform sampler2D tSeeds; uniform sampler2D tSrc; out vec4 o;
void main() {
  vec2 p = gl_FragCoord.xy;
  vec4 s = texelFetch(tSeeds, ivec2(p), 0);
  float a = texelFetch(tSrc, ivec2(p), 0).r;
  float d = s.z > 0.5 ? length(s.xy - p) : 1e4;
  o = vec4(a >= 0.5 ? -d : d);
}`;

// ---------- bevel height field ----------

/**
 * Height 0..1 from the inside distance through the bevel profile (7 = custom curve LUT).
 * Fixed size: t = inside distance / uSize. Fit (Eye Candy 適合): t = inside distance / (uFitK ×
 * local half-thickness), the half-thickness being the radius of the largest inscribed circle
 * covering the pixel (tCover, smoothed), so thin and thick strokes alike dome to their centre
 * line. A rim band (uBand > 0 px) fits as a tube: distance to the nearer of its outer edge and
 * the inner edge `uBand` inside it, over half the band.
 */
export const HEIGHT_FRAG = /* glsl */ `
${LUT_GLSL}
uniform sampler2D tSdf; uniform float uSize; uniform int uProfile; uniform sampler2D tProfileLut; out vec4 o;
uniform bool uFit; uniform sampler2D tCover; uniform float uFitK, uBand;
float profile(float t) {
  if (uProfile == 7) return lutAt(tProfileLut, t);                                     // custom
  if (uProfile == 1) { float u = 1.0 - t; return 1.0 - u * u * u; }                 // button
  if (uProfile == 2) { float u = 1.0 - min(t / 0.45, 1.0); return 1.0 - u * u; }      // mesa
  if (uProfile == 3) return t;                                                         // chamfer
  if (uProfile == 4) return 1.0 - abs(2.0 * t - 1.0);                                  // ridge
  if (uProfile == 5) return t * t;                                                     // cove
  if (uProfile == 6) { float f = min(t, 0.9999) * 3.0; return (floor(f) + smoothstep(0.55, 1.0, fract(f))) / 3.0; } // stepped
  return sin(t * 1.5707963);                                                           // smooth
}
void main() {
  ivec2 ip = ivec2(gl_FragCoord.xy);
  float d = texelFetch(tSdf, ip, 0).r;
  if (!uFit) { o = vec4(profile(clamp(-d / uSize, 0.0, 1.0))); return; }
  float inside = -d, size;
  if (uBand > 0.0) {
    inside = min(inside, uBand - inside);
    size = uFitK * 0.5 * uBand;
  } else size = uFitK * texelFetch(tCover, ip, 0).r;
  o = vec4(profile(clamp(inside / max(size, 0.5), 0.0, 1.0)));
}`;

/** Fit bevel, step 1: every inside pixel seeds its own inscribed circle (centre, radius = −SDF). */
export const COVER_INIT_FRAG = /* glsl */ `
uniform sampler2D tSdf; out vec4 o;
void main() {
  float d = texelFetch(tSdf, ivec2(gl_FragCoord.xy), 0).r;
  o = d < 0.0 ? vec4(gl_FragCoord.xy, -d, 1.0) : vec4(0.0);
}`;

/**
 * Fit bevel, step 2 (jump flooding): keep the largest neighbouring circle that covers this pixel,
 * so each pixel ends with (about) the largest inscribed circle containing it.
 */
export const COVER_JFA_FRAG = /* glsl */ `
uniform sampler2D tSrc; uniform float uStep; out vec4 o;
void main() {
  vec2 p = gl_FragCoord.xy;
  ivec2 res = textureSize(tSrc, 0);
  vec4 best = texelFetch(tSrc, ivec2(p), 0);
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    ivec2 q = ivec2(p + vec2(x, y) * uStep);
    if (q.x < 0 || q.y < 0 || q.x >= res.x || q.y >= res.y) continue;
    vec4 s = texelFetch(tSrc, q, 0);
    if (s.w > 0.5 && s.z > best.z && length(s.xy - p) <= s.z + 1.0) best = s;
  }
  o = best;
}`;

/** Fit bevel, step 3: the covering circle's radius (local half-thickness, px) into R. */
export const COVER_RADIUS_FRAG = /* glsl */ `
uniform sampler2D tSrc; out vec4 o;
void main() { o = vec4(texelFetch(tSrc, ivec2(gl_FragCoord.xy), 0).z); }`;

/** Separable gaussian on a float R texture (texelFetch, clamp to edge). */
export const BLUR_R_FRAG = /* glsl */ `
uniform sampler2D tSrc; uniform ivec2 uDir; uniform float uSigma; out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 mx = textureSize(tSrc, 0) - 1;
  int r = int(ceil(uSigma * 3.0));
  float acc = 0.0, wsum = 0.0;
  for (int i = -96; i <= 96; i++) {
    if (i < -r || i > r) continue;
    float w = exp(-0.5 * float(i * i) / (uSigma * uSigma));
    acc += texelFetch(tSrc, clamp(p + uDir * i, ivec2(0), mx), 0).r * w;
    wsum += w;
  }
  o = vec4(acc / wsum);
}`;

// ---------- element shading ----------

export const ELEMENT_FRAG = /* glsl */ `
${COLOR_GLSL}
${NOISE_GLSL}
${FILL_GLSL}
${LUT_GLSL}
uniform sampler2D tMask;    // coverage (with かすれ: already eroded, like tSdf / tHeight / tSatin)
uniform sampler2D tSdf;
uniform sampler2D tHeight;
uniform bool uHasSdf;
uniform vec2 uBmin, uBmax;  // element bounds, frame px
// Effects: the element box from an effects/lib bounds() texture (uv box of the mask) instead.
uniform bool uBoxTex;
uniform sampler2D tBox;
// Colour from tPicture instead of the fill, texel for texel with tMask: an image face's own
// picture (Title2DRenderer ownPicture: straight sRGB, coverage = its alpha) or, uPictureLinear,
// a Material effect's input (premultiplied linear, the layer's own pixels).
uniform bool uPicture;
uniform bool uPictureLinear;
uniform sampler2D tPicture;
uniform vec3 uLight;        // light direction (towards the light), layer space, y-up

// Material2D.refraction: frame px the fill is read away from p per unit of surface tilt.
uniform float uRefrPx;
// Material2D.glass (Glass2D); uGlassCw: caustic reach, frame px.
uniform bool uGlass;
uniform vec3 uGlassColor;
uniform float uGlassTint, uGlassOp, uGlassEdge, uGlassCaustic, uGlassCw;

// Gradient span: 0 = element bounds, 1 = nearest glyph's ink box, 2 = its line box.
uniform int uSpan;
uniform sampler2D tSpanIdx; // R = nearest glyph index per frame px (unshifted geometry)
uniform sampler2D tGlyphs;  // RGBA32F N × 2 boxes, layer units (NEAREST_GLYPH_FRAG)
uniform vec2 uFrameMin;     // layer units
uniform float uM;           // frame px per layer unit
uniform vec2 uElemOff;      // element shift (rim offset), frame px
uniform float uSpanGrow;    // element growth (rim), frame px

// Shape burst: depth that maps to stop 1. uBurstPx > 0: rim band width; else tBurstMax (1×1,
// the element's max inside distance).
uniform float uBurstPx;
uniform sampler2D tBurstMax;

uniform bool uBevel;
uniform float uBevelK;      // slope multiplier: height units → px
uniform int uGloss;         // 6 = custom (tGlossLut)
uniform sampler2D tGlossLut;
uniform vec3 uHiColor, uShColor;
uniform float uHiOp, uShOp;

// Reflection map (Material2D.reflection): equirectangular panorama, row 0 = zenith, centre = +z.
uniform bool uRefl;
uniform sampler2D tRefl;
uniform float uReflAmt, uReflRot, uReflTint;
uniform mat2 uReflM;        // layer-space (y-up) → screen-space (y-up) directions

uniform bool uSatin;
uniform sampler2D tSatin;   // blurred mask (linear filtered)
uniform vec2 uSatinOff;     // frame px
uniform vec3 uSatinColor;
uniform float uSatinOp;
uniform int uSatinBlend;    // 0 normal 1 multiply 2 screen 3 overlay
uniform bool uSatinInvert;
uniform sampler2D tSatinLut;

// Pattern (patterns.ts): patternCoord() maps frame px → motif units.
${PATTERN_GLSL}
${PATTERN_UNIFORMS_GLSL}

uniform bool uFinish;
uniform sampler2D tRamp;
uniform float uFinishAmt;

// 0 none 1 noise 2 sparkle 3 brushed 4 ripple 5 grunge 6 clouds 7 hammered 8 crumple 9 liquid
// 10 hairline 11 spun 12 flakes
uniform int uTex;
uniform float uTexAmt, uTexPx;
uniform int uTexBlend;      // 0 overlay 1 softLight 2 screen 3 multiply
uniform vec2 uTexSeed;
uniform vec2 uTexRot;       // cos, sin of Texture2D.angle (grain direction, counter-clockwise)
uniform bool uTexSurface;   // Texture2D.target = 'surface': bends the lit normal instead of blending colour

// Material2D.sheen (Sheen2D), shaped by the texture kind.
uniform bool uSheen;
uniform vec3 uSheenColor;
uniform float uSheenAmt, uSheenPos, uSheenWidth;

uniform bool uGlow;
uniform vec3 uGlowColor;
uniform float uGlowPx, uGlowOp, uGlowNoise;

uniform bool uCap;
uniform float uCapOp, uCapPos, uCapSoft, uCapCurve;
uniform vec2 uCapDir;       // y-up unit vector pointing down across the gloss band (Gloss2D.angle)

uniform float uOpacity;     // Material2D.opacity (fill opacity)
uniform bool uPunch;        // knockout pass: output coverage only (blended as dst × (1 − a))

out vec4 o;

// Gloss contours: remap highlight/shadow strength (0..1 → 0..1, contour(0) = 0 so flat
// areas stay neutral). Ring-type contours re-brighten/darken mid slopes → metallic bands.
float contour(float x) {
  x = clamp(x, 0.0, 1.0);
  if (uGloss == 6) return lutAt(tGlossLut, x);                                                 // custom
  if (uGloss == 1) { float s = sin(x * 2.6); return s * s; }                                  // ring
  if (uGloss == 2) { float s = sin(x * 5.5); return s * s; }                                  // doubleRing
  if (uGloss == 3) return 1.0 - sqrt(max(1.0 - x * x, 0.0));                                  // cove
  if (uGloss == 4) { float f = min(x, 0.9999) * 4.0; return (floor(f) + smoothstep(0.3, 0.7, fract(f))) / 4.0; } // roundedSteps
  if (uGloss == 5) return fract(min(x, 0.9999) * 3.0) * (0.6 + 0.4 * x);                      // sawtooth
  return x;                                                                                     // linear
}

float hFetch(ivec2 q) {
  ivec2 mx = textureSize(tHeight, 0) - 1;
  return texelFetch(tHeight, clamp(q, ivec2(0), mx), 0).r;
}

// Procedural textures: 0..1 with 0.5 = neutral.
float sparkle(vec2 q) {
  vec2 cell = floor(q);
  float best = 0.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 c = cell + vec2(x, y);
    vec2 h = hash22(c);
    if (hash12(c + 7.3) > 0.45) continue;
    vec2 d = q - (c + h);
    float size = 0.25 + 0.75 * hash12(c + 3.1);
    float core = exp(-dot(d, d) / (0.012 * size));
    float arms = (exp(-abs(d.y) * 60.0) * max(0.0, 1.0 - abs(d.x) / (0.9 * size))
               + exp(-abs(d.x) * 60.0) * max(0.0, 1.0 - abs(d.y) / (0.9 * size)));
    best = max(best, (core + arms * 0.8) * size);
  }
  return 0.5 + 0.5 * min(best, 1.0);
}

// Hammered: concave dimples; the slope of the nearest dimple (height per feature unit).
vec2 hammeredSlope(vec2 q) {
  vec2 cell = floor(q);
  float dmin = 1e9; vec2 vmin = vec2(0.0);
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 c = cell + vec2(x, y);
    vec2 v = c + 0.15 + 0.7 * hash22(c) - q;
    float d = dot(v, v);
    if (d < dmin) { dmin = d; vmin = v; }
  }
  // The surface falls toward the dimple centre, so the normal tilts toward it.
  return -vmin * 1.4;
}

// Crumpled foil: two octaves of large Voronoi facets, each a tilted plane with a random slope;
// creases (cell borders) are softened over a narrow band so they stay anti-aliased.
vec2 crumpleSlope(vec2 q) {
  vec2 s = vec2(0.0);
  float amp = 1.0;
  for (int o = 0; o < 2; o++) {
    vec2 cell = floor(q);
    float d1 = 1e9, d2 = 1e9;
    vec2 c1 = cell, c2 = cell;
    for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
      vec2 c = cell + vec2(x, y);
      vec2 v = c + 0.1 + 0.8 * hash22(c + float(o) * 17.0) - q;
      float d = dot(v, v);
      if (d < d1) { d2 = d1; c2 = c1; d1 = d; c1 = c; }
      else if (d < d2) { d2 = d; c2 = c; }
    }
    vec2 s1 = hash22(c1 + 31.7) * 2.0 - 1.0, s2 = hash22(c2 + 31.7) * 2.0 - 1.0;
    float w = smoothstep(0.0, 0.05, sqrt(d2) - sqrt(d1));
    s += amp * mix(0.5 * (s1 + s2), s1, w);
    q = q * 2.17 + 5.3;
    amp *= 0.45;
  }
  return s * 0.9;
}

// Liquid metal: smooth domain-warped flow (quintic gradient noise, so the derivative is smooth
// and gloss-contour bands bend into continuous molten swirls).
float liquidH(vec2 q) {
  q *= 0.32;
  vec2 w = vec2(pat_gnoise(q + vec2(1.7, 9.2)), pat_gnoise(q + vec2(8.3, 2.8)));
  vec2 w2 = vec2(pat_gnoise(q * 1.7 + 1.8 * w + vec2(4.1, 7.3)), pat_gnoise(q * 1.7 + 1.8 * w + vec2(1.2, 5.5)));
  return 0.7 * pat_gnoise(q + 1.5 * w2) + 0.3 * pat_gnoise(q * 2.3 + w2 + 6.1);
}

// Element box centre / half size, frame px (set first thing in main).
vec2 gBoxC, gBoxH;

// Texture2D.angle: frame px into the texture's own axes (grain along +x) and slopes back.
vec2 texRotate(vec2 v) { return vec2(uTexRot.x * v.x + uTexRot.y * v.y, -uTexRot.y * v.x + uTexRot.x * v.y); }
vec2 texUnrotate(vec2 v) { return vec2(uTexRot.x * v.x - uTexRot.y * v.y, uTexRot.y * v.x + uTexRot.x * v.y); }

// Metal grain (hairline / spun / flakes): smooth 1D value noise.
float metalN1(float x, float seed) {
  float i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(hash12(vec2(i, seed)), hash12(vec2(i + 1.0, seed)), f);
}
// Flakes: the nearest Voronoi cell of q and the squared distance to its point.
void flakeCell(vec2 q, out vec2 cell, out float best) {
  vec2 g0 = floor(q), f0 = fract(q);
  best = 9.0;
  cell = g0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 c = g0 + vec2(x, y);
    vec2 dv = vec2(x, y) + hash22(c) - f0;
    float dd = dot(dv, dv);
    if (dd < best) { best = dd; cell = c; }
  }
}
// How squarely a flake (a tilted mirror) reflects the sheen light, from Sheen2D.position and the angle, at the viewer.
float flakeFacing(vec2 cell) {
  float la = uSheenPos * 3.1415927 + atan(uTexRot.y, uTexRot.x);
  vec3 L = normalize(vec3(cos(la), sin(la), 1.2));
  vec3 fn = normalize(vec3((hash22(cell + 7.0) - 0.5) * 1.4, 1.0));
  return max(dot(reflect(-L, fn), vec3(0.0, 0.0, 1.0)), 0.0);
}

// Height-like value 0..1 of the noise-type textures (1–6, 10–12), 0.5 = neutral. px: frame px in
// the texture's axes; q: feature units.
float textureHeight(vec2 px, vec2 q) {
  if (uTex == 1) return clamp(0.5 + (vnoise(q * 2.0) - 0.5) * 1.3 + (hash12(px + uTexSeed) - 0.5) * 0.35, 0.0, 1.0);
  if (uTex == 2) return sparkle(q * 0.5);
  if (uTex == 3) return clamp(0.5 + (fbm(vec2(q.x * 0.06, q.y * 2.5)) - 0.5) * 1.6, 0.0, 1.0);
  if (uTex == 4) return 0.5 + 0.45 * sin(6.2831853 * 2.5 * fbm(q * 0.35));
  if (uTex == 5) {
    float blot = smoothstep(0.5, 0.72, fbm(q * 0.45));
    float speck = step(0.93, hash12(floor(q * 3.0)));
    float scratch = smoothstep(0.985, 1.0, 1.0 - abs(vnoise(vec2(q.x * 0.12 + q.y * 0.5, q.y * 0.04)) - 0.5) * 2.0);
    return clamp(0.5 - blot * 0.45 - speck * 0.25 + scratch * 0.4, 0.0, 1.0);
  }
  if (uTex == 6) return clamp(0.5 + (fbm(q * 0.25) - 0.5) * 1.6, 0.0, 1.0);
  if (uTex == 10) {
    // Hairline: fine lines across the grain, long slow variation along it.
    float lines = 0.55 * metalN1(q.y, 1.0) + 0.3 * metalN1(q.y * 2.7, 2.0) + 0.15 * hash12(vec2(floor(q.y * 4.0), 3.0));
    float along = vnoise(vec2(q.x / 90.0, q.y * 0.21));
    return mix(lines, lines * along * 1.6, 0.35);
  }
  if (uTex == 11) {
    // Spun: rings around the element centre.
    vec2 dv = (px - texRotate(gBoxC)) / max(uTexPx, 0.5);
    float ring = length(dv);
    float lines = 0.6 * metalN1(ring, 4.0) + 0.4 * metalN1(ring * 3.1, 5.0);
    return lines * (0.75 + 0.5 * vnoise(dv / max(ring, 1e-3) * 3.0 + floor(ring) * 0.13));
  }
  if (uTex == 12) {
    // Flakes / gold leaf: facets lit by how squarely they catch the light.
    vec2 cell;
    float best;
    flakeCell(q, cell, best);
    return 0.3 + 0.7 * flakeFacing(cell) * (0.6 + 0.4 * hash12(cell));
  }
  return 0.5;
}

// Surface slope of the texture at frame px (height px per px, scaled by amount): the texture's
// height is amount × its feature size, so bumps keep their steepness at any scale.
vec2 textureSlope(vec2 p) {
  vec2 px = texRotate(p);
  float S = max(uTexPx, 0.5);
  vec2 q = px / S + uTexSeed;
  vec2 s;
  if (uTex == 7) s = hammeredSlope(q * 0.5) * 0.5;
  else if (uTex == 8) s = crumpleSlope(q * 0.35) * 0.35 * 2.2;
  else if (uTex == 9) {
    const float e = 0.02;
    s = vec2(liquidH(q + vec2(e, 0.0)) - liquidH(q - vec2(e, 0.0)), liquidH(q + vec2(0.0, e)) - liquidH(q - vec2(0.0, e))) / (2.0 * e) * 2.4;
  } else {
    // Finite differences over one frame pixel.
    vec2 ex = vec2(1.0, 0.0), ey = vec2(0.0, 1.0);
    s = vec2(textureHeight(px + ex, q + ex / S) - textureHeight(px - ex, q - ex / S),
             textureHeight(px + ey, q + ey / S) - textureHeight(px - ey, q - ey / S)) * 0.5 * S;
  }
  return texUnrotate(s) * uTexAmt;
}

// Colour-target texture value 0..1 (0.5 neutral). Relief kinds are shaded by the bevel light
// (hammered keeps its v4 dimple depth: twice its surface slope).
float textureValue(vec2 p) {
  vec2 px = texRotate(p);
  if (uTex >= 7 && uTex <= 9) {
    vec2 g = uTex == 7 ? texUnrotate(hammeredSlope(px / max(uTexPx, 0.5) * 0.5 + uTexSeed * 0.5)) : textureSlope(p) / max(uTexAmt, 1e-3);
    vec3 n = normalize(vec3(-g, 1.0));
    return clamp(0.5 + (dot(n, uLight) - uLight.z) * 1.4, 0.0, 1.0);
  }
  return textureHeight(px, px / max(uTexPx, 0.5) + uTexSeed);
}

// Sheen2D strength at frame px p: a band across the grain (spun: radial lobes; flakes: the facets
// that catch the light), modulated by the metal grain.
float sheenShape(vec2 p) {
  vec2 px = texRotate(p);
  vec2 q = px / max(uTexPx, 0.5) + uTexSeed;
  float grain = uTex >= 10 ? textureHeight(px, q) : 0.5;
  if (uTex == 11) {
    vec2 dv = p - gBoxC;
    float th = atan(dv.y, dv.x) - uSheenPos * 3.1415927 - atan(uTexRot.y, uTexRot.x);
    return pow(abs(cos(th)), 6.0 / max(uSheenWidth * uSheenWidth, 0.01)) * (0.5 + grain);
  }
  if (uTex == 12) {
    vec2 cell;
    float best;
    flakeCell(q, cell, best);
    float g = pow(flakeFacing(cell), 18.0 / max(uSheenWidth, 0.05));
    // A bright facet, and a sparkle point at its centre.
    return g * step(0.4, hash12(cell + 19.0)) * (1.2 + 3.0 * exp(-best * 30.0));
  }
  float u = dot((p - gBoxC) / gBoxH, uTexRot);
  return exp(-pow((u - uSheenPos * 1.2) / uSheenWidth, 2.0)) * (0.5 + grain);
}

vec3 blendTex(vec3 b, float v) {
  if (uTexBlend == 1) return (1.0 - 2.0 * v) * b * b + 2.0 * v * b;                      // soft light
  if (uTexBlend == 2) { float s = 2.0 * max(v - 0.5, 0.0); return 1.0 - (1.0 - b) * (1.0 - s); } // screen (above-mid only)
  if (uTexBlend == 3) { float m = 1.0 - 2.0 * max(0.5 - v, 0.0); return b * m; }           // multiply (below-mid only)
  vec3 lo = 2.0 * b * v, hi = 1.0 - 2.0 * (1.0 - b) * (1.0 - v);                          // overlay
  return mix(lo, hi, step(0.5, b));
}

vec3 screen(vec3 b, vec3 s) { return 1.0 - (1.0 - b) * (1.0 - s); }

// The bevel's highlight screen + shadow multiply on any colour (base or pattern marks).
vec3 light(vec3 c, float hi, float sh) {
  c = screen(c, uHiColor * hi * uHiOp);
  return c * mix(vec3(1.0), uShColor, clamp(sh * uShOp, 0.0, 1.0));
}

int spanIdx(ivec2 q) { return int(texelFetch(tSpanIdx, q, 0).r + 0.5); }
// Span box of glyph g (uSpan's row of tGlyphs), frame px.
void spanBox(int g, out vec2 bmin, out vec2 bmax) {
  vec4 b = texelFetch(tGlyphs, ivec2(g, uSpan - 1), 0);
  bmin = (b.xy - uFrameMin) * uM + uElemOff - uSpanGrow;
  bmax = (b.zw - uFrameMin) * uM + uElemOff + uSpanGrow;
}
// Frame px from p to the seam where glyph gn takes over from gi as the nearest one (the
// NEAREST_GLYPH_FRAG rule: ink-box distance, ties by centre distance); > 0 on gi's side.
float seamPx(int gi, int gn, vec2 p) {
  vec2 lp = uFrameMin + (p - uElemOff) / uM;
  vec4 bi = texelFetch(tGlyphs, ivec2(gi, 0), 0), bn = texelFetch(tGlyphs, ivec2(gn, 0), 0);
  vec2 ci = 0.5 * (bi.xy + bi.zw), cn = 0.5 * (bn.xy + bn.zw);
  vec2 oi = max(abs(lp - ci) - 0.5 * (bi.zw - bi.xy), 0.0), on = max(abs(lp - cn) - 0.5 * (bn.zw - bn.xy), 0.0);
  float di = length(oi), dn = length(on);
  if (max(di, dn) < 1e-4) {
    // Inside both boxes: the perpendicular bisector of the centres.
    vec2 ax = cn - ci;
    float L = length(ax);
    return L > 1e-6 ? dot(0.5 * (ci + cn) - lp, ax) / L * uM : 1e4;
  }
  vec2 gi2 = di > 0.0 ? oi / di * sign(lp - ci) : vec2(0.0);
  vec2 gn2 = dn > 0.0 ? on / dn * sign(lp - cn) : vec2(0.0);
  return (dn - di) / max(length(gn2 - gi2), 1e-3) * uM;
}

void main() {
  ivec2 ip = ivec2(gl_FragCoord.xy);
  float a = texelFetch(tMask, ip, 0).r;
  if (a <= 0.0) { o = vec4(0.0); return; }
  if (uPunch) { o = vec4(a); return; }
  vec2 p = gl_FragCoord.xy;
  float d = uHasSdf ? texelFetch(tSdf, ip, 0).r : 0.0;

  // Pattern: the frame is axis-aligned, so the motif steps per pixel are exact constants.
  vec4 pat = vec4(0.0);
  vec2 pg = vec2(0.0); // relief: pattern height gradient, height px per frame px
  bool relief = false;
  if (uPatKind > 0) {
    vec2 pm = patternCoord(p);
    vec2 ex = vec2(uPatXform.x, uPatXform.z), ey = vec2(uPatXform.y, uPatXform.w);
    pat = patternSampleD(pm, ex, ey, uPatKind, uPatSeed);
    if (uPatRelief > 0.0) {
      relief = true;
      // Raised marks stand 6 % of a motif tall at relief 1, whatever the pattern scale.
      float hpx = uPatRelief * 0.06 / max(length(ex), 1e-6);
      pg = vec2(patternSampleD(pm + ex, ex, ey, uPatKind, uPatSeed).z - patternSampleD(pm - ex, ex, ey, uPatKind, uPatSeed).z,
                patternSampleD(pm + ey, ex, ey, uPatKind, uPatSeed).z - patternSampleD(pm - ey, ex, ey, uPatKind, uPatSeed).z) * 0.5 * hpx;
    }
  }

  // Element box: frame px, or (effects) the mask's bounds() uv box, texel centres → outer edges.
  vec2 emin = uBmin, emax = uBmax;
  if (uBoxTex) {
    vec4 b = texelFetch(tBox, ivec2(0), 0);
    vec2 sz = vec2(textureSize(tMask, 0));
    if (b.z >= -b.x && b.w >= -b.y) { emin = -b.xy * sz - 0.5; emax = b.zw * sz + 0.5; }
  }
  gBoxC = 0.5 * (emin + emax);
  gBoxH = max(0.5 * (emax - emin), vec2(0.5));

  // Surface texture joins the bevel height field: lighting, gloss contour and finish all bend.
  bool surface = uTexSurface && uTex > 0 && uTexAmt > 0.0;
  bool lit = uBevel || relief || surface;
  vec3 n = vec3(0.0, 0.0, 1.0);
  if (lit) {
    vec2 g = pg;
    if (uBevel) g += vec2(hFetch(ip + ivec2(1, 0)) - hFetch(ip - ivec2(1, 0)), hFetch(ip + ivec2(0, 1)) - hFetch(ip - ivec2(0, 1))) * 0.5 * uBevelK;
    if (surface) g += textureSlope(p);
    n = normalize(vec3(-g, 1.0));
  }
  // Refraction: the fill is read where the tilted surface bends the view (< 0: mirrors, like chrome).
  bool refr = uRefrPx != 0.0;
  vec2 pf = refr ? p - n.xy * uRefrPx : p;

  vec2 bmin = emin, bmax = emax;
  int gi = 0, gn = 0;
  if (uSpan > 0) {
    ivec2 mx = textureSize(tSpanIdx, 0) - 1;
    ivec2 q = clamp(ivec2(p - uElemOff), ivec2(0), mx);
    gi = spanIdx(q);
    gn = gi;
    // A 4-neighbour owned by another glyph: this pixel may straddle the seam between the two.
    for (int k = 0; k < 4; k++) {
      ivec2 o4 = k == 0 ? ivec2(1, 0) : k == 1 ? ivec2(-1, 0) : k == 2 ? ivec2(0, 1) : ivec2(0, -1);
      int g = spanIdx(clamp(q + o4, ivec2(0), mx));
      if (g != gi) gn = g;
    }
    spanBox(gi, bmin, bmax);
  }
  float burst = 0.0;
  if (uFillKind == 6 && uHasSdf) {
    float depth = uBurstPx > 0.0 ? uBurstPx : texelFetch(tBurstMax, ivec2(0), 0).r;
    burst = clamp(-d / max(depth, 1e-3), 0.0, 1.0);
  }
  vec4 fill;
  if (uPicture) {
    vec4 s = refr ? texture(tPicture, pf / vec2(textureSize(tPicture, 0))) : texelFetch(tPicture, ip, 0);
    if (uPictureLinear) {
      // Premultiplied linear: refracted reads off the shape keep the colour here.
      if (s.a < 1e-4) s = texelFetch(tPicture, ip, 0);
      fill = vec4(toSrgb(s.rgb / max(s.a, 1e-4)), 1.0);
    } else fill = vec4(s.rgb, 1.0);
  } else fill = fillColor(pf, bmin, bmax, burst);
  if (gn != gi) {
    // Antialias the span seam: blend in the neighbour's fill by its share of this pixel.
    vec2 nmin, nmax;
    spanBox(gn, nmin, nmax);
    if (nmin != bmin || nmax != bmax) fill = mix(fill, fillColor(pf, nmin, nmax, burst), clamp(0.5 - seamPx(gi, gn, p), 0.0, 1.0));
  }
  vec3 c = fill.rgb;

  // Glass body, in linear light: what is seen through takes the glass colour and deepens like
  // thick glass; steep slopes darken (Fresnel rim); light entering on the lit side focuses into a
  // caustic band inside the far edge. Rims and caustics are more opaque than the body.
  float glassA = 1.0;
  if (uGlass) {
    vec3 base = mix(toLinear(c), toLinear(uGlassColor), uGlassTint);
    vec3 gc = base * base * 0.3 + base * 0.14;
    float slope = clamp(1.0 - n.z, 0.0, 1.0);
    float fres = smoothstep(0.0, 0.7, slope);
    gc *= 1.0 - fres * uGlassEdge * 0.85;
    float caus = 0.0;
    if (uBevel) {
      vec2 l2 = normalize(uLight.xy + 1e-6);
      float hHere = hFetch(ip);
      float hBack = hFetch(ivec2(p - l2 * uGlassCw));
      caus = clamp(1.0 - hBack, 0.0, 1.0) * smoothstep(0.05, 0.6, hHere) * (1.0 - fres * 0.6);
      gc += mix(base, vec3(1.0), 0.3) * caus * caus * uGlassCaustic * 1.8;
      gc += base * 0.15 * smoothstep(0.5, 1.0, hHere) * uGlassCaustic;
    }
    // The sky on upward-facing slopes.
    gc += vec3(0.55) * smoothstep(0.1, 0.8, n.y) * slope;
    glassA = clamp(uGlassOp + (1.0 - uGlassOp) * (fres * uGlassEdge * 0.8 + caus * uGlassCaustic * 0.6), 0.0, 1.0);
    c = toSrgb(gc);
  }

  // Mirror the view ray (straight into the screen) off the surface into the panorama; screen
  // space, so the sky stays up when the layer turns. The fill keeps its hue under colorize.
  if (uRefl) {
    vec3 ns = vec3(uReflM * n.xy, n.z);
    vec3 R = vec3(2.0 * ns.z * ns.xy, 2.0 * ns.z * ns.z - 1.0);
    vec2 uv = vec2(atan(R.x, R.z) / 6.2831853 + 0.5 + uReflRot, 0.5 - asin(clamp(R.y, -1.0, 1.0)) / 3.1415927);
    vec3 rc = texture(tRefl, uv).rgb;
    float l = dot(rc, vec3(0.299, 0.587, 0.114));
    // Coloured glass: dark reflections deepen the fill, mid tones keep its full hue and only the
    // brightest ones run to white (a squared ramp), so saturated colours never wash to pastel.
    float w = max(2.0 * l - 1.0, 0.0);
    vec3 tinted = l < 0.5 ? 2.0 * c * l : mix(c, vec3(1.0), w * w);
    c = mix(c, mix(rc, tinted, uReflTint), uReflAmt);
  }

  float hi = 0.0, sh = 0.0;
  if (lit) {
    float s = dot(n, uLight) - uLight.z;
    hi = contour(s > 0.0 ? s / max(1.0 - uLight.z, 0.05) : 0.0);
    sh = contour(s < 0.0 ? -s / max(uLight.z, 0.05) : 0.0);
    c = light(c, hi, sh);
  }

  if (uFinish) {
    float lum = dot(c, vec3(0.299, 0.587, 0.114));
    c = mix(c, rampAt(tRamp, lum), uFinishAmt);
  }

  // Marks, then color2 over them; uPatShade keeps that much of the bevel lighting on both.
  if (uPatKind > 0) {
    vec3 m1 = uPatColor, m2 = uPatColor2;
    if (lit) {
      m1 = mix(m1, light(m1, hi, sh), uPatShade);
      m2 = mix(m2, light(m2, hi, sh), uPatShade);
    }
    c = mix(c, m1, pat.x * uPatOpacity);
    c = mix(c, m2, pat.y * uPatOpacity);
  }

  // Satin: |difference| of two blurred copies of the silhouette shifted ±distance, through the
  // contour (inverted like Photoshop's default), blended in its colour.
  if (uSatin) {
    vec2 ts = vec2(textureSize(tSatin, 0));
    float s1 = texture(tSatin, (p + uSatinOff) / ts).r;
    float s2 = texture(tSatin, (p - uSatinOff) / ts).r;
    float v = lutAt(tSatinLut, abs(s1 - s2));
    if (uSatinInvert) v = 1.0 - v;
    vec3 sc = uSatinColor;
    vec3 bl = uSatinBlend == 1 ? c * sc
            : uSatinBlend == 2 ? screen(c, sc)
            : uSatinBlend == 3 ? mix(2.0 * c * sc, 1.0 - 2.0 * (1.0 - c) * (1.0 - sc), step(0.5, c))
            : sc;
    c = mix(c, bl, clamp(v * uSatinOp, 0.0, 1.0));
  }

  if (uTex > 0 && uTexAmt > 0.0 && !uTexSurface) c = mix(c, clamp(blendTex(c, textureValue(p)), 0.0, 1.0), uTexAmt);

  if (uSheen) c += uSheenColor * sheenShape(p) * uSheenAmt * (0.4 + 0.6 * c);

  if (uGlow && uHasSdf) {
    float t = clamp(max(-d, 0.0) / max(uGlowPx, 0.5), 0.0, 1.0);
    float gi = (1.0 - t) * (1.0 - t);
    float n = hash12(p + 13.7);
    gi *= mix(1.0, n * 2.0, uGlowNoise);
    c = screen(c, uGlowColor * clamp(gi * uGlowOp, 0.0, 1.0));
  }

  if (uCap) {
    // Band coordinates along uCapDir (0 = the band's top edge of the element box, 1 = bottom)
    // and across it (-1..1), so the cap tilts with Gloss2D.angle.
    vec2 cc = gBoxC;
    vec2 hs = gBoxH;
    vec2 dn = uCapDir, ac = vec2(-dn.y, dn.x);
    float ed = abs(dn.x) * hs.x + abs(dn.y) * hs.y;
    float ea = abs(ac.x) * hs.x + abs(ac.y) * hs.y;
    float yf = (dot(p - cc, dn) + ed) / (2.0 * ed);
    float u = dot(p - cc, ac) / ea;
    float edge = uCapPos + uCapCurve * 0.25 * (1.0 - u * u);
    float sw = max(uCapSoft, 0.002) * 0.5;
    float cap = 1.0 - smoothstep(edge - sw, edge + sw, yf);
    cap *= mix(1.0, 0.55, clamp(yf / max(edge, 1e-3), 0.0, 1.0));
    c = mix(c, vec3(1.0), clamp(cap * uCapOp, 0.0, 1.0));
  }

  float alpha = a * fill.a * uOpacity;
  // Glass: the body's own opacity; the bevel highlight stays visible on clear glass.
  if (uGlass) alpha *= clamp(glassA + hi * uHiOp, 0.0, 1.0);
  o = vec4(toLinear(c) * alpha, alpha);
}`;

// ---------- placement into the comp ----------

export const PLACE_FRAG = /* glsl */ `
uniform sampler2D tStack;
uniform vec2 uTarget;     // render target px
uniform vec2 uComp;       // comp px
uniform vec2 uPos;        // layer position (comp px, y-up from centre)
uniform vec2 uRot;        // cos, sin of rotZ (clockwise-positive on screen)
uniform float uScale;
uniform vec2 uFlip;       // -1 on a mirrored axis (flipX / flipY, before rotZ), else 1
uniform vec2 uFrameMin, uFrameSize; // layer units
uniform int uTaps;
out vec4 o;
vec2 toUv(vec2 frag) {
  vec2 comp = frag / uTarget * uComp - 0.5 * uComp;
  vec2 q = (comp - uPos) / uScale;
  vec2 l = vec2(uRot.x * q.x - uRot.y * q.y, uRot.y * q.x + uRot.x * q.y);
  return (l * uFlip - uFrameMin) / uFrameSize;
}
void main() {
  vec4 acc = vec4(0.0);
  for (int j = 0; j < uTaps; j++) for (int i = 0; i < uTaps; i++) {
    vec2 frag = gl_FragCoord.xy + (vec2(i, j) + 0.5) / float(uTaps) - 0.5;
    vec2 uv = toUv(frag);
    if (uv.x >= 0.0 && uv.y >= 0.0 && uv.x <= 1.0 && uv.y <= 1.0) acc += texture(tStack, uv);
  }
  o = acc / float(uTaps * uTaps);
}`;

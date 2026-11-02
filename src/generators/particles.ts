import * as THREE from 'three';
import type { EffectParams, GeneratorContext, GeneratorDef, ParamDef } from '../engine/contracts';
import { sampleGradientRgba } from '../model/gradient';
import type { Gradient } from '../model/types';
import type { Bounds } from '../text/layout';
import { C, DEG, floatRT, G, gridDistance, grad, N, num, S, sel, col } from '../effects/b/common';
import { inkBounds } from '../effects/lib';
import { centreX, centreY } from '../engine/frame';
import { clearTarget, compToRender, drawInstancedQuads, followed, followParam, GLINT_MIN_THIN, GLINT_STAR_GLSL, type GpuContext, lightGlow, rng } from './common';

// Particle field (Trapcode Particular for stills): one CPU-built list of seeded particles drawn as
// instanced quads. Free, it emits from its own shapes around the layer position; following a layer,
// those shapes centre on that layer, or (Emitter = Followed layer) the particles burst from the
// layer's own pixels (its edge band or fill, before its effects), out along the edge normal, away
// from a point or at an angle, optionally only the half that goes in front of or behind it.
//
// Scale invariance: every particle is computed on the CPU in comp px (positions, sizes, streaks,
// blur) from params and seeded streams only, then mapped to render px by ctx.layerToRender.
// Nothing depends on the render size except anti-aliasing (fwidth in the shader) and
// drawInstancedQuads' minPx, which grows sub-pixel quads while scaling their colour by the area
// ratio so their energy stays the same. The followed layer is read back on a grid whose cells are
// fixed in comp px (cell size from comp-space areas, origin snapped to 64 comp px), so the
// candidate cells match at every scale.

// ---------- shapes ----------

type Shape = 'dot' | 'glint4' | 'glint6' | 'ember' | 'square' | 'confetti' | 'petal' | 'star' | 'heart' | 'bokeh' | 'rain';

/** Shader ids (PARTICLE_FRAG's constants). */
const SHAPE_ID: Record<Shape, number> = {
  dot: 0,
  glint4: 1,
  glint6: 2,
  ember: 3,
  square: 4,
  confetti: 5,
  petal: 6,
  star: 7,
  heart: 8,
  bokeh: 9,
  rain: 10,
};

/** Opaque shapes: drawn with normal blending, far to near. Every other shape is light (additive). */
const SOLID: Shape[] = ['confetti', 'petal', 'heart'];
/** Shapes that tumble in 3D: foreshortened along their width, back face shown when flipped. */
const TUMBLING: Shape[] = ['square', 'confetti', 'petal', 'star', 'heart'];
/** Shapes the Glint mix applies to (gold dust: dots with a few big 4-point glints). */
const GLINT_MIXABLE: Shape[] = ['dot', 'square'];

/** Mixed-in glints' radius, × the particle's own. */
const GLINT_MIX_SCALE = 3.5;
/** Length ÷ width of confetti strips and sakura petals. */
const CONFETTI_ASPECT = 2.4;
const PETAL_ASPECT = 1.25;
/**
 * Depth focus plane (0 far … 1 near). Direction Seeds fakes depth with sharp particles in front and
 * defocused ones behind; the nearest, largest ones defocus too (foreground bokeh), so the sharp band
 * sits just in front of the middle.
 */
const FOCUS = 0.6;
/** Glow amount (the radius is the Glow param of particleBurst; the generator's glow is an effect, `particleGlow`). */
const GLOW_AMOUNT = 0.8;
/** Hard cap on particles (instanced quads) per layer. */
const MAX_PARTICLES = 5000;

const SHAPES: [Shape, string][] = [
  ['dot', 'Soft dot'],
  ['glint4', '4-point glint'],
  ['glint6', '6-point glint'],
  ['ember', 'Ember (streak)'],
  ['square', 'Square'],
  ['confetti', 'Confetti strip'],
  ['petal', 'Sakura petal'],
  ['star', 'Star'],
  ['heart', 'Heart'],
  ['bokeh', 'Bokeh disc'],
  ['rain', 'Rain streak'],
];

const WHITE_GOLD: Gradient = {
  stops: [
    { pos: 0, color: '#fff2c2' },
    { pos: 0.35, color: '#ffc845' },
    { pos: 1, color: '#c77a12' },
  ],
};

// ---------- look params (shared with particleBurst) ----------

const STREAKED: Shape[] = ['ember', 'rain'];
const ROTATING: Shape[] = ['glint4', 'glint6', 'square', 'confetti', 'petal', 'star', 'heart'];

/**
 * The particle look: shape, size, depth, colour, opacity and seed; `defaults` overrides defaults by
 * key. Its glow is a layer effect (`particleGlow`).
 */
function lookParams(defaults: Partial<Record<string, number | string>> = {}): ParamDef[] {
  const d = <T extends number | string>(k: string, v: T): T => (defaults[k] as T | undefined) ?? v;
  return [
    sel('shape', 'Shape', d('shape', 'dot'), SHAPES),
    { ...num('glintMix', 'Glint mix', d('glintMix', 0), 0, 100, '%'), when: { key: 'shape', value: GLINT_MIXABLE } },
    num('count', 'Count', d('count', 400), 1, MAX_PARTICLES, undefined, 1),
    num('size', 'Size', d('size', 6), 0.5, 200, 'px', 0.5),
    num('sizeRandom', 'Size random', d('sizeRandom', 60), 0, 100, '%'),
    num('depth', 'Depth', d('depth', 50), 0, 100, '%'),
    { ...num('streak', 'Streak length', d('streak', 40), 0, 400, 'px'), when: { key: 'shape', value: STREAKED } },
    { ...num('ring', 'Bokeh ring', d('ring', 30), 0, 100, '%'), when: { key: 'shape', value: 'bokeh' } },
    { ...num('rotation', 'Rotation random', d('rotation', 20), 0, 180, 'deg'), when: { key: 'shape', value: ROTATING } },
    { ...num('tumble', 'Tumble', d('tumble', 0), 0, 100, '%'), when: { key: 'shape', value: TUMBLING } },
    { ...num('sheen', 'Foil sheen', d('sheen', 50), 0, 100, '%'), when: { key: 'shape', value: 'confetti' } },
    sel('colorMode', 'Colour', d('colorMode', 'radial'), [
      ['solid', 'Solid'],
      ['radial', 'Gradient by radius'],
      ['palette', 'Palette random'],
      ['sample', 'Sample layer'],
    ]),
    { ...col('color', 'Solid colour', d('color', '#ffd166')), when: { key: 'colorMode', value: 'solid' } },
    { ...grad('gradient', 'Gradient', WHITE_GOLD), when: { key: 'colorMode', value: ['radial', 'palette'] } },
    num('opacity', 'Opacity', d('opacity', 100), 0, 100, '%'),
    num('opacityRandom', 'Opacity random', d('opacityRandom', 40), 0, 100, '%'),
    num('seed', 'Seed', d('seed', 1), 0, 999, undefined, 1),
  ];
}

interface Look {
  shape: Shape;
  /** 0..1 share of dots / squares drawn as big 4-point glints. */
  glintMix: number;
  count: number;
  /** Diameter, comp px. */
  size: number;
  sizeRandom: number;
  depth: number;
  /** Streak length, comp px (ember / rain). */
  streak: number;
  ring: number;
  /** Rotation random, radians either way. */
  rotation: number;
  tumble: number;
  sheen: number;
  colorMode: string;
  color: THREE.Color;
  gradient: Gradient;
  opacity: number;
  opacityRandom: number;
  seed: number;
}

function readLook(p: EffectParams): Look {
  const shape = (SHAPE_ID[S(p, 'shape') as Shape] !== undefined ? S(p, 'shape') : 'dot') as Shape;
  return {
    shape,
    glintMix: GLINT_MIXABLE.includes(shape) ? N(p, 'glintMix') / 100 : 0,
    count: Math.min(MAX_PARTICLES, Math.max(0, Math.round(N(p, 'count')))),
    size: Math.max(0.1, N(p, 'size')),
    sizeRandom: N(p, 'sizeRandom') / 100,
    depth: N(p, 'depth') / 100,
    streak: Math.max(0, N(p, 'streak')),
    ring: N(p, 'ring') / 100,
    rotation: N(p, 'rotation') * DEG,
    tumble: N(p, 'tumble') / 100,
    sheen: N(p, 'sheen') / 100,
    colorMode: S(p, 'colorMode'),
    color: C(p, 'color'),
    gradient: G(p, 'gradient'),
    opacity: N(p, 'opacity') / 100,
    opacityRandom: N(p, 'opacityRandom') / 100,
    seed: Math.round(N(p, 'seed')),
  };
}

/**
 * How far (comp px, conservative) one particle can draw from its centre with params `p`: the
 * nearest depth size, glint / strip proportions, defocus and streak.
 */
function particleReach(p: EffectParams): number {
  const look = readLook(p);
  const d = look.depth;
  const shapeK = Math.max(
    look.shape === 'confetti' ? CONFETTI_ASPECT : look.shape === 'petal' ? PETAL_ASPECT : 1,
    look.glintMix > 0 ? GLINT_MIX_SCALE : 1,
  );
  const r = (look.size / 2) * (1 + 1.7 * d) * shapeK;
  const defocus = 1 + 2.4 * d * (look.shape === 'bokeh' ? 0.3 : 1);
  const streak = STREAKED.includes(look.shape) ? look.streak : 0;
  return r * defocus + streak;
}

// ---------- particles ----------

/** Where a particle ends up and how it got there (drawing space, comp px). */
interface Birth {
  x: number;
  y: number;
  /** Unit motion direction (streak orientation). */
  dx: number;
  dy: number;
  /** 0..1 distance measure: gradient position and depth bias (Direction Seeds: big ones outside). */
  t: number;
  /** 0..1 speed (streak length); default the particle's nearness. */
  speed?: number;
  /** Opacity factor (thinning out along the travel), default 1. */
  fade?: number;
  /** Linear colour sampled from a layer (colour mode 'sample'). */
  rgb?: [number, number, number];
}

interface Particle {
  x: number;
  y: number;
  /** Full quad size, comp px (padded for defocus). */
  w: number;
  h: number;
  rot: number;
  /** Premultiplied linear colour. */
  color: [number, number, number, number];
  /** Defocus, in particle radii. */
  blur: number;
  aspect: number;
  /** Tumble angle (sheen phase). */
  phase: number;
  /** 0 far … 1 near: draw order of solid shapes. */
  z: number;
  /** Drawn as a mixed-in 4-point glint. */
  glint: boolean;
  /** Free uniform 0..1 of this particle: the half it belongs to (in front of / behind a followed layer). */
  side: number;
}

/**
 * Independent seeded stream per (seed, particle, purpose): a particle keeps its look when the
 * count changes or when its own placement needs more tries.
 */
function stream(seed: number, i: number, salt: number): () => number {
  const k = (Math.imul(seed + 0x632be5ab, 0x9e3779b1) ^ Math.imul(i + 1, 0x85ebca6b) ^ Math.imul(salt + 1, 0xc2b2ae35)) >>> 0;
  // common's rng floors seed × 4096 before hashing it: this hands it the 32-bit key exactly.
  return rng(k / 4096);
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

type Rgba = [number, number, number, number];

function linearRgba(g: Gradient, pos: number): Rgba {
  const [r, gg, b, a] = sampleGradientRgba(g, pos);
  const c = new THREE.Color().setRGB(r, gg, b, THREE.SRGBColorSpace);
  return [c.r, c.g, c.b, a];
}

const LUT_N = 64;

/**
 * The particles of `look`: `birth(i, r)` places particle i from its own placement stream `r`
 * (null = none, e.g. an empty emitter); everything else comes from a second stream per particle.
 */
function buildParticles(look: Look, birth: (i: number, r: () => number) => Birth | null): Particle[] {
  const out: Particle[] = [];
  const d = look.depth;
  const lut: Rgba[] = look.colorMode === 'radial' ? Array.from({ length: LUT_N }, (_, k) => linearRgba(look.gradient, k / (LUT_N - 1))) : [];
  const palette: Rgba[] = look.gradient.stops.map((s) => {
    const c = new THREE.Color(s.color);
    return [c.r, c.g, c.b, s.alpha ?? 1];
  });
  const solid: Rgba = [look.color.r, look.color.g, look.color.b, 1];
  for (let i = 0; i < look.count; i++) {
    const b = birth(i, stream(look.seed, i, 0));
    if (!b) continue;
    const a = stream(look.seed, i, 1);
    // Drawn in a fixed order whether used or not, so each attribute keeps its value across shapes and modes.
    const z0 = a();
    const su = a();
    const ru = a();
    const phi = a() * 2 * Math.PI;
    const ou = a();
    const pu = a();
    const gu = a();
    const side = a();

    // Most particles far and small, a few near and big; with Depth they also sit further out.
    const z = clamp01(lerp(z0 ** 1.7, b.t, 0.5 * d));
    const near = 1 + d * (2.4 * z - 0.7);
    const bright = 1 + d * (0.8 * z - 0.35);
    const glint = look.glintMix > 0 && gu < look.glintMix;
    const shape: Shape = glint ? 'glint4' : look.shape;
    let blur = d * (z < FOCUS ? (0.8 * (FOCUS - z)) / FOCUS : (2.4 * (z - FOCUS)) / (1 - FOCUS));
    if (shape === 'glint4' || shape === 'glint6') blur = Math.min(blur, 0.5); // glints stay crisp
    else if (shape === 'bokeh') blur *= 0.3; // already a defocused disc
    const r = (look.size / 2) * (1 - look.sizeRandom * su) * near * (glint ? GLINT_MIX_SCALE : 1);
    if (!(r > 0)) continue;
    const speed = b.speed ?? z;
    let aspect = 1;
    let rot = (2 * ru - 1) * look.rotation;
    if (shape === 'ember' || shape === 'rain') {
      const len = look.streak * (shape === 'ember' ? 0.35 + 0.65 * speed : 0.5 + 0.5 * speed);
      aspect = 1 + len / (2 * r);
      rot = Math.atan2(b.dy, b.dx);
    } else if (shape === 'confetti') aspect = CONFETTI_ASPECT;
    else if (shape === 'petal') aspect = PETAL_ASPECT;
    const tumbles = TUMBLING.includes(shape) && look.tumble > 0;
    const fs = tumbles ? lerp(1, Math.max(0.12, Math.abs(Math.cos(phi))), look.tumble) : 1;

    let c: Rgba;
    if (look.colorMode === 'sample' && b.rgb) c = [...b.rgb, 1];
    else if (look.colorMode === 'radial') c = lut[Math.round(clamp01(b.t) * (LUT_N - 1))];
    else if (look.colorMode === 'palette' && palette.length > 0) c = palette[Math.min(palette.length - 1, Math.floor(pu * palette.length))];
    else c = solid;
    let shade = 1;
    if (tumbles && Math.cos(phi) < 0) shade = shape === 'confetti' ? 0.45 : 0.85; // back face: two-tone
    if (shape === 'confetti') shade *= 0.65 + 0.35 * Math.abs(Math.cos(phi)); // foil turning from the light
    const alpha = look.opacity * (1 - look.opacityRandom * ou) * (b.fade ?? 1) * c[3];
    if (!(alpha > 0)) continue;
    const k = alpha * shade * (SOLID.includes(shape) ? 1 : bright);
    out.push({
      x: b.x,
      y: b.y,
      w: 2 * r * (aspect + blur),
      h: 2 * r * (1 + blur) * fs,
      rot,
      color: [c[0] * k, c[1] * k, c[2] * k, alpha],
      blur,
      aspect,
      phase: phi,
      z,
      glint,
      side,
    });
  }
  return out;
}

// ---------- drawing ----------

const PARTICLE_FRAG = /* glsl */ `
uniform int uShape; uniform float uRing, uSheen; uniform bool uLight;
const int DOT = 0, GLINT4 = 1, GLINT6 = 2, EMBER = 3, SQUARE = 4, CONFETTI = 5, PETAL = 6, STAR = 7, HEART = 8, BOKEH = 9, RAIN = 10;
float max3(vec3 c) { return max(c.r, max(c.g, c.b)); }
float cover(float d, float e) { return 1.0 - smoothstep(-e, e, d); }
// The glint shapes are the Glints star look (src/generators/glints.ts).
${GLINT_STAR_GLSL}
// Signed distances (Inigo Quilez): a 5-point star pointing up, a heart with its tip at the origin.
float sdStar5(vec2 p, float r, float rf) {
  const vec2 k1 = vec2(0.809016994375, -0.587785252292);
  const vec2 k2 = vec2(-k1.x, k1.y);
  p.x = abs(p.x);
  p -= 2.0 * max(dot(k1, p), 0.0) * k1;
  p -= 2.0 * max(dot(k2, p), 0.0) * k2;
  p.x = abs(p.x);
  p.y -= r;
  vec2 ba = rf * vec2(-k1.y, k1.x) - vec2(0.0, 1.0);
  float h = clamp(dot(p, ba) / dot(ba, ba), 0.0, r);
  return length(p - ba * h) * sign(p.y * ba.x - p.x * ba.y);
}
float dot2(vec2 v) { return dot(v, v); }
float sdHeart(vec2 p) {
  p.x = abs(p.x);
  if (p.y + p.x > 1.0) return sqrt(dot2(p - vec2(0.25, 0.75))) - sqrt(2.0) / 4.0;
  return sqrt(min(dot2(p - vec2(0.0, 1.0)), dot2(p - 0.5 * max(p.x + p.y, 0.0)))) * sign(p.x - p.y);
}
void main() {
  float b = vExtra.x, A = vExtra.y, phase = vExtra.z;
  // Local position in particle radii: x along the length (−A…A), y across (−1…1), plus the defocus pad.
  vec2 l = vQuad * vec2(A + b, 1.0 + b);
  vec2 fw = fwidth(l);
  float e = max(0.7 * (fw.x + fw.y), 0.5 * b);
  float r = length(l);
  float s = 1.0 + b;
  float I = 0.0;   // light intensity, or coverage of solids
  float hot = 0.0; // white-hot core of light shapes
  vec3 glint = vec3(0.0); // glint shapes: their light, colour included
  vec3 tint = vec3(1.0);
  if (uShape == DOT) {
    I = exp(-2.6 * r * r / (s * s)) / s;
    hot = 0.5 * exp(-18.0 * r * r) / (1.0 + 4.0 * b);
  } else if (uShape == GLINT4 || uShape == GLINT6) {
    // The colour unpremultiplied (it saturates toward the ray tips), the light × opacity.
    vec2 v = l / s;
    float a = max(vColor.a, 1e-4);
    glint = glintStar(v, uShape == GLINT4 ? 4 : 6, 0.035 * (1.0 + 3.0 * b), vExtra.w, max(fw.x, fw.y) / s, vColor.rgb / a, false) * (vColor.a / s);
  } else if (uShape == EMBER) {
    // A dot dragged along its motion: dim tail at −x, hot head at +x.
    float hl = A - 1.0;
    vec2 q = vec2(l.x - clamp(l.x, -hl, hl), l.y);
    float h = clamp((l.x + A) / (2.0 * A), 0.0, 1.0);
    I = exp(-3.0 * dot(q, q) / (s * s)) * mix(0.15, 1.0, h * h) / s;
    vec2 hp = vec2(l.x - hl, l.y);
    hot = 0.7 * exp(-10.0 * dot(hp, hp) / (s * s)) / s;
  } else if (uShape == RAIN) {
    float h = clamp((l.x + A) / (2.0 * A), 0.0, 1.0);
    I = exp(-3.0 * l.y * l.y / (s * s)) * smoothstep(0.0, 0.3, h) * (1.0 - smoothstep(0.92, 1.0, h)) * mix(0.35, 1.0, h) / s;
  } else if (uShape == BOKEH) {
    // A defocused highlight: soft-edged disc, a little dimmer in the middle, with an optional bright rim (onion ring).
    float cov = cover(r - 0.94, max(e, 0.06 + 0.5 * b));
    I = cov * (mix(0.8, 0.4, uRing) * (1.0 - 0.2 * r * r) + 1.1 * uRing * smoothstep(0.6, 0.95, r));
  } else if (uShape == STAR) {
    I = cover(sdStar5(l, 1.0, 0.45), e) * (0.75 + 0.6 * exp(-6.0 * r * r));
    hot = 0.35 * exp(-20.0 * r * r);
  } else if (uShape == SQUARE) {
    I = cover(max(abs(l.x), abs(l.y)) - 1.0, e);
  } else if (uShape == CONFETTI) {
    I = cover(max(abs(l.x) - A, abs(l.y) - 1.0), e);
    // Foil sheen: a diagonal glare band that slides along the strip as it turns.
    float band = (l.x / A) * 0.8 + l.y * 0.35 - 1.6 * sin(phase);
    tint += uSheen * 1.6 * exp(-band * band / 0.05);
  } else if (uShape == PETAL) {
    // Base at −x, notched tip at +x, widest near the tip.
    float u = (l.x / A + 1.0) * 0.5;
    float uc = clamp(u, 0.0, 1.0);
    float w = 0.95 * pow(uc, 0.6) * sqrt(max(0.0, 1.0 - pow(uc, 6.0)));
    float d = max(abs(l.y) - w, abs(l.x) - A);
    d = max(d, (u - 0.86) * 2.4 * A - abs(l.y));
    I = cover(d, e);
    tint *= mix(1.12, 0.94, uc);
  } else {
    vec2 p = l * 0.55 + vec2(0.0, 0.5);
    I = cover(sdHeart(p) / 0.55, e);
    vec2 hl = l - vec2(-0.35, 0.35);
    tint *= 1.0 + 0.25 * exp(-8.0 * dot(hl, hl));
  }
  if (uLight) {
    vec3 c = vColor.rgb * I + vColor.a * hot + glint;
    o = vec4(c, min(1.0, max3(c)));
  } else {
    o = vec4(vColor.rgb * tint, vColor.a) * (I / (1.0 + 0.6 * b));
  }
}`;

const quadUniforms = {
  uShape: { value: 0 },
  uRing: { value: 0.3 },
  uSheen: { value: 0.5 },
  uLight: { value: true },
};

/** Per-instance buffers, grown on demand and reused across renders. */
const buf = {
  cap: 0,
  center: new Float32Array(0),
  size: new Float32Array(0),
  rotation: new Float32Array(0),
  color: new Float32Array(0),
  extra: new Float32Array(0),
};

function drawPass(ctx: GpuContext, target: THREE.WebGLRenderTarget, list: Particle[], shape: Shape, look: Look, toRender: THREE.Matrix3) {
  const n = list.length;
  if (n === 0) return;
  if (buf.cap < n) {
    buf.cap = 2 ** Math.ceil(Math.log2(n));
    buf.center = new Float32Array(buf.cap * 2);
    buf.size = new Float32Array(buf.cap * 2);
    buf.rotation = new Float32Array(buf.cap);
    buf.color = new Float32Array(buf.cap * 4);
    buf.extra = new Float32Array(buf.cap * 4);
  }
  for (let i = 0; i < n; i++) {
    const q = list[i];
    buf.center[i * 2] = q.x;
    buf.center[i * 2 + 1] = q.y;
    buf.size[i * 2] = q.w;
    buf.size[i * 2 + 1] = q.h;
    buf.rotation[i] = q.rot;
    buf.color.set(q.color, i * 4);
    buf.extra[i * 4] = q.blur;
    buf.extra[i * 4 + 1] = q.aspect;
    buf.extra[i * 4 + 2] = q.phase;
    buf.extra[i * 4 + 3] = (2 * GLINT_MIN_THIN) / q.h; // glints: GLINT_MIN_THIN in half quad heights
  }
  const light = !SOLID.includes(shape);
  quadUniforms.uShape.value = SHAPE_ID[shape];
  quadUniforms.uRing.value = look.ring;
  quadUniforms.uSheen.value = look.sheen;
  quadUniforms.uLight.value = light;
  drawInstancedQuads(ctx, target, {
    count: n,
    center: buf.center,
    size: buf.size,
    rotation: buf.rotation,
    color: buf.color,
    extra: buf.extra,
    toRender,
    fragmentShader: PARTICLE_FRAG,
    uniforms: quadUniforms,
    blend: light ? 'add' : 'normal',
  });
}

/**
 * Draw `list` over `target`'s current content (no clear) through `toRender` (drawing space → render
 * px). Solid shapes go far to near; mixed-in glints last.
 */
function drawParticles(ctx: GpuContext, target: THREE.WebGLRenderTarget, list: Particle[], look: Look, toRender: THREE.Matrix3) {
  const main = list.filter((q) => !q.glint);
  if (SOLID.includes(look.shape)) main.sort((a, b) => a.z - b.z);
  drawPass(ctx, target, main, look.shape, look, toRender);
  drawPass(
    ctx,
    target,
    list.filter((q) => q.glint),
    'glint4',
    look,
    toRender,
  );
}

// ---------- the followed layer as emitter ----------

/** Box means of a texture over comp-px cells (row 0 = bottom). */
interface AlphaGrid {
  /** Comp px of cell (0, 0)'s lower-left corner (origin comp centre, +y up). */
  x0: number;
  y0: number;
  /** Cell size, comp px. */
  cell: number;
  w: number;
  h: number;
  /** Mean premultiplied linear RGBA per cell. */
  rgba: Float32Array;
}

const gridFrag = /* glsl */ `
uniform sampler2D tSrc; uniform vec2 uSrcSize, uCentre, uOrigin; uniform float uCell, uPx; uniform int uTaps;
in vec2 vUv; out vec4 o;
void main() {
  vec2 c0 = uOrigin + floor(gl_FragCoord.xy) * uCell;
  float pitch = uCell / float(uTaps);
  vec4 acc = vec4(0.0);
  for (int y = 0; y < 8; y++) {
    if (y >= uTaps) break;
    for (int x = 0; x < 8; x++) {
      if (x >= uTaps) break;
      vec2 px = (c0 + (vec2(x, y) + 0.5) * pitch) * uPx + uCentre;
      acc += texture(tSrc, px / uSrcSize);
    }
  }
  o = acc / float(uTaps * uTaps);
}`;

const gridMats = new WeakMap<object, THREE.ShaderMaterial>();

/** Grid region snap, comp px: keeps the cell lattice identical when a measured box wobbles by a pixel between scales. */
const SNAP = 64;
/** Readback budget: cells per comp-space area (the cell grows for big areas, never per render scale). */
const GRID_CELLS = 50000;

/** Cell size (comp px) for a comp-space area; the same at every render scale. */
const gridCell = (areaCompPx: number) => Math.max(3, Math.ceil(Math.sqrt(Math.max(1, areaCompPx) / GRID_CELLS)));

/** `b` grown outward to SNAP multiples. */
function snapBox(b: Bounds): Bounds {
  return {
    x0: Math.floor(b.x0 / SNAP) * SNAP,
    y0: Math.floor(b.y0 / SNAP) * SNAP,
    x1: Math.ceil(b.x1 / SNAP) * SNAP,
    y1: Math.ceil(b.y1 / SNAP) * SNAP,
  };
}

/**
 * Read `src` (a target of `ctx`: render px, the comp centre at centreX/Y of its frame) back to the
 * CPU as box means over `cell`-px comp cells covering `region` (comp px, snapped by the caller). One
 * GPU sync: callers cache the result.
 */
function readAlphaGrid(ctx: GpuContext, src: THREE.Texture, region: Bounds, cell: number): AlphaGrid {
  const { kit } = ctx;
  const w = Math.max(1, Math.ceil((region.x1 - region.x0) / cell));
  const h = Math.max(1, Math.ceil((region.y1 - region.y0) / cell));
  let m = gridMats.get(kit);
  if (!m) {
    m = kit.shader({
      uniforms: {
        tSrc: { value: null },
        uSrcSize: { value: new THREE.Vector2() },
        uCentre: { value: new THREE.Vector2() },
        uOrigin: { value: new THREE.Vector2() },
        uCell: { value: 1 },
        uPx: { value: 1 },
        uTaps: { value: 1 },
      },
      fragmentShader: gridFrag,
    });
    gridMats.set(kit, m);
  }
  const u = m.uniforms;
  u.tSrc.value = src;
  u.uSrcSize.value.set(ctx.width, ctx.height);
  u.uCentre.value.set(centreX(ctx.frame), centreY(ctx.frame));
  u.uOrigin.value.set(region.x0, region.y0);
  u.uCell.value = cell;
  u.uPx.value = ctx.pxScale;
  u.uTaps.value = Math.min(8, Math.max(1, Math.ceil(cell * ctx.pxScale)));
  const rt = floatRT('particles-grid', w, h);
  kit.run(m, rt);
  const rgba = new Float32Array(w * h * 4);
  ctx.renderer.readRenderTargetPixels(rt, 0, 0, w, h, rgba);
  return { x0: region.x0, y0: region.y0, cell, w, h, rgba };
}

/** Where particles may be born on an alpha grid, with outward normals. */
interface EmitMap {
  grid: AlphaGrid;
  /** 1 = candidate cell. */
  mask: Uint8Array;
  /** Sampling box of the candidates, comp px, snapped. */
  box: Bounds;
  /** Unit outward normal per cell (comp space). */
  nx: Float32Array;
  ny: Float32Array;
  /** Centroid of the ink, comp px. */
  cx: number;
  cy: number;
  /** Half diagonal of the ink box, comp px. */
  radius: number;
}

/** Ink (alpha ≥ 0.5) of `grid`: its 'fill', or its 'edge' band `bandPx` deep; null when empty. */
function emitMap(grid: AlphaGrid, source: 'fill' | 'edge', bandPx: number): EmitMap | null {
  const { w, h, cell, rgba } = grid;
  const n = w * h;
  const alpha = new Float32Array(n);
  const outside = new Float32Array(n);
  let sx = 0;
  let sy = 0;
  let cnt = 0;
  let ix0 = w;
  let iy0 = h;
  let ix1 = -1;
  let iy1 = -1;
  for (let i = 0; i < n; i++) {
    const a = rgba[i * 4 + 3];
    alpha[i] = a;
    outside[i] = a >= 0.5 ? 0 : 1;
    if (a >= 0.5) {
      const x = i % w;
      const y = (i - x) / w;
      sx += x;
      sy += y;
      cnt++;
      ix0 = Math.min(ix0, x);
      iy0 = Math.min(iy0, y);
      ix1 = Math.max(ix1, x);
      iy1 = Math.max(iy1, y);
    }
  }
  if (cnt === 0) return null;
  const cx = grid.x0 + (sx / cnt + 0.5) * cell;
  const cy = grid.y0 + (sy / cnt + 0.5) * cell;
  const radius = 0.5 * Math.hypot(ix1 - ix0 + 1, iy1 - iy0 + 1) * cell;
  // Cells to the nearest non-ink cell (chamfer), for the edge band.
  const dOut = gridDistance({ w, h, alpha: outside });
  const band = Math.max(1, bandPx / cell);
  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) mask[i] = alpha[i] >= 0.5 && (source === 'fill' || dOut[i] <= band) ? 1 : 0;
  // Normals: −gradient of the 3×3-smoothed alpha; radial from the centroid where it is flat.
  const sm = new Float32Array(n);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let j = -1; j <= 1; j++)
        for (let k = -1; k <= 1; k++) s += alpha[Math.min(h - 1, Math.max(0, y + j)) * w + Math.min(w - 1, Math.max(0, x + k))];
      sm[y * w + x] = s / 9;
    }
  const nx = new Float32Array(n);
  const ny = new Float32Array(n);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const gx = sm[y * w + Math.min(w - 1, x + 1)] - sm[y * w + Math.max(0, x - 1)];
      const gy = sm[Math.min(h - 1, y + 1) * w + x] - sm[Math.max(0, y - 1) * w + x];
      let vx = -gx;
      let vy = -gy;
      let len = Math.hypot(vx, vy);
      if (len < 0.02) {
        vx = grid.x0 + (x + 0.5) * cell - cx;
        vy = grid.y0 + (y + 0.5) * cell - cy;
        len = Math.hypot(vx, vy);
      }
      nx[i] = len > 0 ? vx / len : 1;
      ny[i] = len > 0 ? vy / len : 0;
    }
  const box = snapBox({ x0: grid.x0 + ix0 * cell, y0: grid.y0 + iy0 * cell, x1: grid.x0 + (ix1 + 1) * cell, y1: grid.y0 + (iy1 + 1) * cell });
  return { grid, mask, box, nx, ny, cx, cy, radius };
}

/** Tries per particle before giving up on a sparse emitter (thin edges of small text). */
const MAX_TRIES = 400;

/** A point on the map's candidates from stream `r` (comp px) and its cell index, or null. */
function sampleMap(m: EmitMap, r: () => number): { x: number; y: number; cell: number } | null {
  const { grid, box } = m;
  // Uniform tries over the snapped box (not a list of cells): a borderline cell flipping between
  // render scales then moves only the particles that land on it.
  for (let k = 0; k < MAX_TRIES; k++) {
    const x = box.x0 + r() * (box.x1 - box.x0);
    const y = box.y0 + r() * (box.y1 - box.y0);
    const gx = Math.floor((x - grid.x0) / grid.cell);
    const gy = Math.floor((y - grid.y0) / grid.cell);
    if (gx < 0 || gy < 0 || gx >= grid.w || gy >= grid.h) continue;
    const i = gy * grid.w + gx;
    if (m.mask[i]) return { x, y, cell: i };
  }
  return null;
}

/** Cells stepped inward when picking a particle's colour from the ink. */
const INK_COLOR_STEPS = 8;

/**
 * Unpremultiplied linear colour for a particle born in cell `i`: the most vivid ink cell up to
 * INK_COLOR_STEPS cells inward along the normal. Titles are rimmed with dark keylines and
 * shadows and crossed by white highlight bands; the edge cell would give dull sparks and the
 * brightest cell white ones, while the sparks should carry the face colour.
 */
function inkColor(m: EmitMap, i: number): [number, number, number] {
  const { grid } = m;
  const { w, h, rgba } = grid;
  const x0 = i % w;
  const y0 = (i - x0) / w;
  let best = i;
  let bestScore = -1;
  for (let k = 0; k <= INK_COLOR_STEPS; k++) {
    const x = Math.round(x0 - m.nx[i] * k);
    const y = Math.round(y0 - m.ny[i] * k);
    if (x < 0 || y < 0 || x >= w || y >= h) break;
    const j = y * w + x;
    if (rgba[j * 4 + 3] < 0.5) continue;
    const mx = Math.max(rgba[j * 4], rgba[j * 4 + 1], rgba[j * 4 + 2]);
    const mn = Math.min(rgba[j * 4], rgba[j * 4 + 1], rgba[j * 4 + 2]);
    // Brightness × (some + saturation): a vivid face beats both a white highlight and a dark rim.
    const score = mx * (0.4 + (mx > 0 ? (mx - mn) / mx : 0));
    if (score > bestScore) {
      bestScore = score;
      best = j;
    }
  }
  const a = Math.max(1e-4, rgba[best * 4 + 3]);
  return [rgba[best * 4] / a, rgba[best * 4 + 1] / a, rgba[best * 4 + 2] / a];
}

// ---------- the generator ----------

type Emitter = 'point' | 'ellipse' | 'rect' | 'ring' | 'line' | 'full' | 'layer';

/**
 * Grids of the followed layer's pixels per generator layer: read back only when the source's
 * content key (GeneratorContext.layerContentKey) changes; draft frames reuse the last grid of the
 * same source. The ink box (± 8 comp px, snapped) in comp px, the cell size from its area: the same
 * lattice at every render scale and on any canvas (export margins, an enlarged interactive frame).
 */
const contentCache = new Map<string, { source: string; key: string; grid: AlphaGrid | null }>();

function contentGrid(ctx: GeneratorContext, source: string): AlphaGrid | null {
  const key = ctx.layerContentKey(source);
  if (key === null) return null;
  const hit = contentCache.get(ctx.layerId);
  if (hit && hit.source === source && (hit.key === key || ctx.draft)) return hit.grid;
  const tex = ctx.layerContent(source);
  if (!tex) return null;
  const b = inkBounds(ctx, tex);
  const region = b && snapBox({ x0: b.x0 - 8, y0: b.y0 - 8, x1: b.x1 + 8, y1: b.y1 + 8 });
  const grid = region && readAlphaGrid(ctx, tex, region, gridCell((region.x1 - region.x0) * (region.y1 - region.y0)));
  contentCache.set(ctx.layerId, { source, key, grid });
  return grid;
}

/** Signed −1…1 with density falling off toward ±1 (falloff 0 = uniform). */
const axis = (u: number, falloff: number) => {
  const v = 2 * u - 1;
  return Math.sign(v) * Math.abs(v) ** (1 + 2 * falloff);
};

/** A start point on the analytic emitters (layer space) with its outward direction and 0..1 radius. */
interface Start {
  x: number;
  y: number;
  dx: number;
  dy: number;
  t: number;
}

function unit(x: number, y: number, fx: number, fy: number): [number, number] {
  const l = Math.hypot(x, y);
  return l > 1e-6 ? [x / l, y / l] : [fx, fy];
}

const EMITTERS: [Emitter, string][] = [
  ['ellipse', 'Ellipse'],
  ['rect', 'Rectangle'],
  ['ring', 'Ring'],
  ['line', 'Straight line'],
  ['point', 'Point'],
  ['full', 'Full frame'],
  ['layer', 'Followed layer'],
];

const DISTRIBUTIONS: [string, string][] = [
  ['scatter', 'Scatter'],
  ['burst', 'Burst out'],
  ['stream', 'Stream'],
];

const SIZED: Emitter[] = ['ellipse', 'rect', 'ring', 'line'];
const SHAPED: Emitter[] = ['ellipse', 'rect', 'ring', 'line', 'point', 'full'];
const ON_LAYER = { key: 'emitter', value: 'layer' };

/** The light glow of the particle presets: Outer Glow from the layer's colours, × 0.8 (what the generator drew itself). */
export const particleGlow = (size: number) => lightGlow(size, GLOW_AMOUNT);

/**
 * Births of particles bursting from the followed layer's pixels (`map`, comp px): along the edge
 * normal, away from Point X / Y or at Angle, Distance × (1 − Distance random × √u) out, so most
 * stay close to the edge they burst from and thin out with distance.
 */
function burstBirth(map: EmitMap, p: EffectParams): (i: number, r: () => number) => Birth | null {
  const mode = S(p, 'direction');
  const px = N(p, 'x');
  const py = N(p, 'y');
  const ang = N(p, 'heading') * DEG;
  const distance = Math.max(0, N(p, 'travel'));
  const dr = N(p, 'distanceRandom') / 100;
  const cone = N(p, 'cone') * DEG;
  return (_i, r) => {
    const s = sampleMap(map, r);
    if (!s) return null;
    let a: number;
    if (mode === 'angle') a = ang;
    else if (mode === 'point' && Math.hypot(s.x - px, s.y - py) > 1e-3) a = Math.atan2(s.y - py, s.x - px);
    else a = Math.atan2(map.ny[s.cell], map.nx[s.cell]);
    a += (r() - 0.5) * cone;
    const tf = 1 - dr * Math.sqrt(r());
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    return {
      x: s.x + dx * distance * tf,
      y: s.y + dy * distance * tf,
      dx,
      dy,
      // Gradient by radius: 0 for the nearest particles, 1 for the farthest.
      t: dr > 0 ? (tf - 1 + dr) / dr : 1,
      speed: tf,
      fade: 1 - 0.5 * tf * tf,
      rgb: inkColor(map, s.cell),
    };
  };
}

/** Layer-space box of the shape emitters (not 'full' / 'layer') with their travel and particle reach. */
function shapeBounds(p: EffectParams): Bounds {
  const em = S(p, 'emitter') as Emitter;
  const scatter = S(p, 'distribution') === 'scatter';
  const travel = scatter && em !== 'point' ? 0 : N(p, 'travel');
  const pad = travel + particleReach(p);
  const rx = em === 'point' ? 0 : N(p, 'rx') * (em === 'ring' ? 1.25 : 1);
  const ry = em === 'point' || em === 'line' ? 0 : N(p, 'ry') * (em === 'ring' ? 1.25 : 1);
  return { x0: -rx - pad, y0: -ry - pad, x1: rx + pad, y1: ry + pad };
}

export const particles: GeneratorDef = {
  type: 'particles',
  label: 'Particles',
  category: 'Particles',
  description:
    'Particle field: 金粉 glitter, 火の粉 embers, light motes, confetti, sakura, star showers, bokeh, rain and fireworks. ' +
    'Emits from a point, ellipse, rectangle, ring, line or the whole frame (centred on the followed layer when following one); scattered, bursting out or streaming. ' +
    'Following a layer it can also burst from that layer’s edge or fill, coloured from it, in front of it, behind it or both (two layers). ' +
    'Depth makes near particles bigger, brighter and defocused.',
  follow: 'optional',
  params: [
    followParam('Layer'),
    sel('emitter', 'Emitter', 'ellipse', EMITTERS),
    {
      ...sel('source', 'Emit from', 'fill', [
        ['fill', 'Fill'],
        ['edge', 'Edge'],
      ]),
      when: ON_LAYER,
    },
    { ...num('edgeWidth', 'Edge width', 4, 1, 100, 'px'), when: { key: 'source', value: 'edge' } },
    {
      ...sel('direction', 'Direction', 'normal', [
        ['normal', 'Normal out'],
        ['point', 'From point'],
        ['angle', 'Angle'],
      ]),
      when: ON_LAYER,
    },
    { ...num('x', 'Point X', 0, -4000, 4000, 'px'), when: { key: 'direction', value: 'point' } },
    { ...num('y', 'Point Y', 0, -4000, 4000, 'px'), when: { key: 'direction', value: 'point' } },
    { ...num('heading', 'Angle', 90, -180, 180, 'deg'), when: { key: 'direction', value: 'angle' } },
    { ...num('rx', 'Radius X', 450, 0, 4000, 'px'), when: { key: 'emitter', value: SIZED } },
    { ...num('ry', 'Radius Y', 300, 0, 4000, 'px'), when: { key: 'emitter', value: ['ellipse', 'rect', 'ring'] } },
    { ...sel('distribution', 'Distribution', 'burst', DISTRIBUTIONS), when: { key: 'emitter', value: SHAPED } },
    { ...num('falloff', 'Density falloff', 60, 0, 100, '%'), when: { key: 'emitter', value: SHAPED } },
    num('travel', 'Distance', 200, 0, 4000, 'px'),
    { ...num('distanceRandom', 'Distance random', 100, 0, 100, '%'), when: ON_LAYER },
    { ...num('angle', 'Direction', -90, -180, 180, 'deg'), when: { key: 'distribution', value: ['scatter', 'stream'] } },
    num('cone', 'Spread angle', 20, 0, 360, 'deg'),
    {
      ...sel('split', 'Particles', 'all', [
        ['all', 'All'],
        ['front', 'Front half (above the layer)'],
        ['back', 'Back half (below the layer)'],
      ]),
      when: ON_LAYER,
    },
    ...lookParams(),
  ],
  // Tuned on a 1920×1080 comp against the research stills: 金粉 / 光の粒 around BONUS titles (#22, #48–#50),
  // 火の粉 (#5), 桜吹雪 (#33, #37), confetti finishing a BONUS screen, ボケ (#39), 雨 (#29, #34), 花火 (#19).
  presets: [
    {
      id: 'goldDust',
      label: 'Gold Dust',
      blend: 'add',
      params: {
        emitter: 'ellipse',
        rx: 450,
        ry: 300,
        distribution: 'burst',
        falloff: 65,
        travel: 260,
        cone: 20,
        shape: 'dot',
        glintMix: 4,
        count: 2600,
        size: 6,
        sizeRandom: 70,
        depth: 55,
        rotation: 12,
        colorMode: 'radial',
        gradient: WHITE_GOLD,
        opacity: 100,
        opacityRandom: 55,
      },
      effects: [particleGlow(24)],
    },
    {
      id: 'embers',
      label: 'Embers',
      blend: 'add',
      params: {
        emitter: 'rect',
        rx: 960,
        ry: 360,
        distribution: 'stream',
        falloff: 45,
        travel: 520,
        angle: 80,
        cone: 36,
        shape: 'ember',
        count: 600,
        size: 5,
        sizeRandom: 55,
        streak: 50,
        depth: 65,
        colorMode: 'radial',
        gradient: {
          stops: [
            { pos: 0, color: '#ffc45a' },
            { pos: 0.35, color: '#ff8a24' },
            { pos: 0.7, color: '#f04a10' },
            { pos: 1, color: '#a81c06' },
          ],
        },
        opacityRandom: 45,
      },
      effects: [particleGlow(16)],
    },
    {
      id: 'lightMotes',
      label: 'Light Motes',
      blend: 'add',
      params: {
        emitter: 'ellipse',
        rx: 760,
        ry: 440,
        distribution: 'scatter',
        falloff: 40,
        shape: 'dot',
        glintMix: 0,
        count: 420,
        size: 9,
        sizeRandom: 70,
        depth: 85,
        colorMode: 'palette',
        gradient: {
          stops: [
            { pos: 0, color: '#ffffff' },
            { pos: 0.5, color: '#bfefff' },
            { pos: 1, color: '#ffe9a8' },
          ],
        },
        opacityRandom: 55,
      },
      effects: [particleGlow(14)],
    },
    {
      id: 'confetti',
      label: 'Confetti',
      params: {
        emitter: 'full',
        distribution: 'scatter',
        falloff: 0,
        angle: -80,
        cone: 30,
        shape: 'confetti',
        count: 320,
        size: 16,
        sizeRandom: 45,
        depth: 70,
        rotation: 180,
        tumble: 85,
        sheen: 60,
        colorMode: 'palette',
        gradient: {
          stops: [
            { pos: 0, color: '#ffd34d' },
            { pos: 0.34, color: '#fff8e8' },
            { pos: 0.67, color: '#e8b04a' },
            { pos: 1, color: '#ff3b4e' },
          ],
        },
        opacity: 100,
        opacityRandom: 0,
      },
    },
    {
      id: 'sakura',
      label: 'Sakura',
      params: {
        emitter: 'full',
        distribution: 'scatter',
        falloff: 0,
        angle: -60,
        shape: 'petal',
        count: 380,
        size: 26,
        sizeRandom: 50,
        depth: 80,
        rotation: 180,
        tumble: 70,
        colorMode: 'palette',
        gradient: {
          stops: [
            { pos: 0, color: '#ffd1e0' },
            { pos: 0.5, color: '#ffb3cb' },
            { pos: 1, color: '#fff0f5' },
          ],
        },
        opacity: 100,
        opacityRandom: 10,
      },
    },
    {
      id: 'starShower',
      label: 'Star Shower',
      blend: 'add',
      params: {
        emitter: 'ellipse',
        rx: 400,
        ry: 260,
        distribution: 'burst',
        falloff: 50,
        travel: 360,
        shape: 'star',
        count: 260,
        size: 20,
        sizeRandom: 65,
        depth: 50,
        rotation: 180,
        tumble: 30,
        colorMode: 'palette',
        gradient: {
          stops: [
            { pos: 0, color: '#fff4b8' },
            { pos: 0.5, color: '#ffd23f' },
            { pos: 1, color: '#ffffff' },
          ],
        },
        opacityRandom: 30,
      },
      effects: [particleGlow(14)],
    },
    {
      id: 'bokeh',
      label: 'Bokeh',
      blend: 'add',
      params: {
        emitter: 'full',
        distribution: 'scatter',
        falloff: 30,
        shape: 'bokeh',
        count: 45,
        size: 150,
        sizeRandom: 70,
        depth: 30,
        ring: 40,
        colorMode: 'palette',
        gradient: {
          stops: [
            { pos: 0, color: '#ffcf5a' },
            { pos: 0.34, color: '#ffa63d' },
            { pos: 0.67, color: '#ff7a2e' },
            { pos: 1, color: '#ffe08a' },
          ],
        },
        opacity: 40,
        opacityRandom: 60,
      },
    },
    {
      id: 'rain',
      label: 'Rain',
      blend: 'add',
      params: {
        emitter: 'full',
        distribution: 'scatter',
        falloff: 0,
        angle: -100,
        cone: 4,
        shape: 'rain',
        count: 900,
        size: 1.5,
        sizeRandom: 40,
        streak: 120,
        depth: 60,
        colorMode: 'solid',
        color: '#cfe6ff',
        opacity: 45,
        opacityRandom: 60,
      },
    },
    {
      id: 'fireworks',
      label: 'Fireworks',
      blend: 'add',
      params: {
        emitter: 'point',
        distribution: 'burst',
        falloff: 0,
        travel: 380,
        cone: 6,
        shape: 'ember',
        count: 600,
        size: 3,
        sizeRandom: 40,
        streak: 40,
        depth: 30,
        colorMode: 'palette',
        gradient: {
          stops: [
            { pos: 0, color: '#ffffff' },
            { pos: 0.34, color: '#ffe27a' },
            { pos: 0.67, color: '#ff6ab0' },
            { pos: 1, color: '#7ad8ff' },
          ],
        },
        opacityRandom: 30,
      },
      effects: [particleGlow(14)],
    },
  ],
  sizes: [
    { rx: 'rx', ry: 'ry', label: 'Emitter', when: { key: 'emitter', value: 'ellipse' } },
    { rx: 'rx', ry: 'ry', shape: 'box', label: 'Emitter', when: { key: 'emitter', value: 'rect' } },
    { rx: 'rx', ry: 'ry', label: 'Emitter', when: { key: 'emitter', value: 'ring' } },
  ],
  directions: [
    { angle: 'angle', length: 'travel', label: 'Stream direction', convention: 'ccwFromRight', when: { key: 'distribution', value: 'stream' } },
    { angle: 'angle', label: 'Streak direction', convention: 'ccwFromRight', when: { key: 'distribution', value: 'scatter' } },
  ],
  bounds(p) {
    const em = S(p, 'emitter') as Emitter;
    if (em === 'full') return null;
    // The followed-layer emitter draws nothing free.
    if (em === 'layer') return { x0: 0, y0: 0, x1: 0, y1: 0 };
    return shapeBounds(p);
  },
  followReach(p) {
    const em = S(p, 'emitter') as Emitter;
    if (em === 'full') return null;
    if (em === 'layer') return Math.max(0, N(p, 'travel')) + particleReach(p);
    // A shape centred on the followed layer reaches at most its own extent past that layer's ink.
    const b = shapeBounds(p);
    return Math.max(-b.x0, -b.y0, b.x1, b.y1);
  },
  render(ctx, target, p) {
    clearTarget(ctx, target);
    const look = readLook(p);
    const em = S(p, 'emitter') as Emitter;
    const id = followed(p);
    if (em === 'layer') {
      const grid = id ? contentGrid(ctx, id) : null;
      const map = grid && emitMap(grid, S(p, 'source') === 'edge' ? 'edge' : 'fill', N(p, 'edgeWidth'));
      if (!map || look.count === 0) return;
      const split = S(p, 'split');
      const list = buildParticles(look, burstBirth(map, p)).filter((q) => split === 'all' || (split === 'front') === q.side < 0.5);
      // Comp px: the generator's own transform is an offset on top (identity = exactly on the layer).
      drawParticles(ctx, target, list, look, ctx.layerToRender);
      return;
    }
    const dist = S(p, 'distribution');
    const falloff = N(p, 'falloff') / 100;
    const travel = Math.max(0, N(p, 'travel'));
    const cone = N(p, 'cone') * DEG;
    const ang = N(p, 'angle') * DEG;
    const rx = Math.max(0, N(p, 'rx'));
    const ry = Math.max(0, N(p, 'ry'));
    // Comp space → layer space (pxScale and export margins cancel out).
    const toLayer = new THREE.Matrix3().copy(ctx.layerToRender).invert().multiply(compToRender(ctx));
    const e = toLayer.elements;
    const mapPt = (x: number, y: number): [number, number] => [e[0] * x + e[3] * y + e[6], e[1] * x + e[4] * y + e[7]];
    // Following a layer, the shapes centre on its ink (comp px), the layer transform an offset on top.
    const box = id && em !== 'full' ? ctx.layerBounds(id) : null;
    const toRender = box ? ctx.layerToRender.clone().multiply(new THREE.Matrix3().makeTranslation((box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2)) : ctx.layerToRender;

    let start: (r: () => number) => Start | null;
    let R: number; // emitter radius, comp px (gradient by radius spans R + travel)
    if (em === 'full') {
      const W = ctx.comp.width / 2;
      const H = ctx.comp.height / 2;
      const [ox, oy] = mapPt(0, 0);
      const [axx, axy] = mapPt(W, 0);
      const [ayx, ayy] = mapPt(0, H);
      R = Math.hypot(W, H);
      start = (r) => {
        const fx = axis(r(), falloff);
        const fy = axis(r(), falloff);
        const x = ox + fx * (axx - ox) + fy * (ayx - ox);
        const y = oy + fx * (axy - oy) + fy * (ayy - oy);
        const a = r() * 2 * Math.PI;
        const [dx, dy] = unit(x - ox, y - oy, Math.cos(a), Math.sin(a));
        return { x, y, dx, dy, t: Math.max(Math.abs(fx), Math.abs(fy)) };
      };
    } else {
      R = em === 'point' ? 0 : em === 'line' ? rx : Math.max(rx, ry);
      start = (r) => {
        const a = r() * 2 * Math.PI;
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        switch (em) {
          case 'point':
            return { x: 0, y: 0, dx: ca, dy: sa, t: 0 };
          case 'ellipse': {
            const rho = r() ** (0.5 + 1.5 * falloff);
            const [dx, dy] = unit(rx * ca, ry * sa, ca, sa);
            return { x: rx * rho * ca, y: ry * rho * sa, dx, dy, t: rho };
          }
          case 'rect': {
            const fx = axis(r(), falloff);
            const fy = axis(r(), falloff);
            const [dx, dy] = unit(rx * fx, ry * fy, ca, sa);
            return { x: rx * fx, y: ry * fy, dx, dy, t: Math.max(Math.abs(fx), Math.abs(fy)) };
          }
          case 'ring': {
            // Falloff tightens the band around the ring line.
            const rho = 1 + (r() + r() - 1) * 0.25 * (1 - 0.85 * falloff);
            return { x: rx * rho * ca, y: ry * rho * sa, dx: ca * ry, dy: sa * rx, t: Math.min(1, rho) };
          }
          default: {
            const fx = axis(r(), falloff);
            return { x: rx * fx, y: 0, dx: 0, dy: sa < 0 ? -1 : 1, t: Math.abs(fx) };
          }
        }
      };
    }

    const list = buildParticles(look, (_i, r) => {
      const s = start(r);
      if (!s) return null;
      const [ux, uy] = unit(s.dx, s.dy, 1, 0);
      const jitter = (r() - 0.5) * cone;
      if (dist === 'burst') {
        const tf = r() ** (0.6 + 1.6 * falloff);
        const a = Math.atan2(uy, ux) + jitter;
        const dx = Math.cos(a);
        const dy = Math.sin(a);
        const go = travel * tf;
        return { x: s.x + dx * go, y: s.y + dy * go, dx, dy, t: (s.t * R + go) / Math.max(1, R + travel), speed: tf, fade: 1 - 0.5 * tf * tf };
      }
      const a = ang + jitter;
      const dx = Math.cos(a);
      const dy = Math.sin(a);
      if (dist === 'stream') {
        const tf = r() ** (0.6 + 1.6 * falloff);
        return { x: s.x + dx * travel * tf, y: s.y + dy * travel * tf, dx, dy, t: tf, fade: 1 - 0.6 * tf * tf };
      }
      if (em === 'point') {
        // A point has no area to scatter over: Distance is the cloud's radius.
        const rho = r() ** (0.5 + 1.5 * falloff);
        return { x: ux * travel * rho, y: uy * travel * rho, dx, dy, t: rho };
      }
      return { x: s.x, y: s.y, dx, dy, t: s.t };
    });
    drawParticles(ctx, target, list, look, toRender);
  },
  dispose() {
    contentCache.clear();
  },
};

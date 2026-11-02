import type { EffectDef } from '../../engine/contracts';
import { centreX, centreY } from '../../engine/frame';
import { GRADIENTS } from '../../model/defaults';
import { lit } from '../globalLight';
import { blur, bounds, BOUNDS_GLSL, BOX_POS_GLSL } from '../lib';
import { glintOverlay, longShadowExtrude, rainbowOverlay } from './recipes';
import {
  BLEND_OPTIONS,
  BLEND_VALUES,
  col,
  dirVec,
  grad,
  num,
  pass,
  pColor,
  pDeg,
  pGrad,
  pick,
  pNum,
  pPx,
  pSelect,
} from './util';

// ---------- gradient overlay ----------

const gradientOverlayFrag = /* glsl */ `
${BOUNDS_GLSL}
uniform sampler2D tSrc, tGrad;
uniform vec2 uDir; uniform float uScale, uOffset, uAmount, uLen, uPos; uniform int uMode, uWrap, uStyle;
void main() {
  vec4 L = texture(tSrc, vUv);
  if (L.a < 1e-5) { o = vec4(0.0); return; }
  vec4 bb = layerBox();
  vec2 lo = bb.xy * uRes, hi = bb.zw * uRes;
  vec2 c = 0.5 * (lo + hi), hs = 0.5 * (hi - lo);
  vec2 p = vUv * uRes - c;
  float ext = max(abs(uDir.x) * hs.x + abs(uDir.y) * hs.y, 1.0);
  float x;
  if (uStyle == 1) {
    // radial: 0 at the box centre → 1 at its corners (elliptical, follows the box aspect)
    x = length(p / max(hs, vec2(1.0))) * 0.70710678 / max(uScale, 0.01) + uOffset;
  } else if (uStyle == 2) {
    // sweep: a uLen-px gradient centred at uPos (−1…1) of the way from just off one side of the box to the other
    x = 0.5 + (dot(p, uDir) - uPos * (ext + 0.5 * uLen)) / uLen;
  } else {
    x = dot(p, uDir) / (2.0 * ext) / max(uScale, 0.01) + 0.5 + uOffset;
  }
  if (uWrap == 1) x = fract(x);
  else if (uWrap == 2) x = 1.0 - abs(mod(x, 2.0) - 1.0);
  vec3 gl = texture(tGrad, vec2(clamp(x, 0.0, 1.0), 0.5)).rgb;
  vec3 r;
  if (uMode == ${BLEND_VALUES.length}) {
    // add light: linear-light addition, unclamped (emissive), like a light layer in Add
    r = unpremul(L) + gl * uAmount;
  } else if (uMode == ${BLEND_VALUES.length + 1}) {
    // shade: linear-light multiply (light through a filter)
    r = unpremul(L) * mix(vec3(1.0), gl, uAmount);
  } else {
    vec3 g = toSRGB(gl);
    vec3 b = toSRGB(unpremul(L));
    r = toLinear(mix(b, blendMode(uMode, b, g), uAmount));
  }
  o = vec4(r * L.a, L.a);
}`;

const OVERLAY_STYLES = ['linear', 'radial', 'sweep'];
// Light and Shade blend in linear light, the others on sRGB values like Photoshop's.
const OVERLAY_BLENDS: [string, string][] = [...BLEND_OPTIONS, ['light', 'Light (add)'], ['shade', 'Light (multiply)']];
const ALONG = { key: 'style', value: ['linear', 'sweep'] };
const FIT = { key: 'style', value: ['linear', 'radial'] };
const SWEEP = { key: 'style', value: 'sweep' };

const gradientOverlay: EffectDef = {
  type: 'gradientOverlay',
  label: 'Gradient Overlay',
  category: 'Color',
  description:
    'Recolours the layer with a gradient, keeping its alpha: Linear across its bounds (angle 90° = top→bottom), Radial from its centre, ' +
    'or Sweep, a gradient of fixed length moved across the layer by Position (a glint band; −100…100 % = just off one side to just off the other). ' +
    'Light (add) adds the gradient as light and Light (multiply) filters the layer through it, both in linear light like light does.',
  params: [
    pGrad('gradient', 'Gradient', GRADIENTS.goldBandsFill),
    pSelect('style', 'Style', 'linear', [
      ['linear', 'Linear'],
      ['radial', 'Radial'],
      ['sweep', 'Sweep (band)'],
    ]),
    { ...pDeg('angle', 'Angle', 90), when: ALONG },
    { ...pNum('scale', 'Scale', 1, 0.1, 10, 0.01, 'x'), when: FIT },
    { ...pNum('offset', 'Offset', 0, -2, 2), when: FIT },
    { ...pPx('length', 'Length', 200, 2, 4000), when: SWEEP },
    { ...pNum('position', 'Position', 0, -100, 100, 1, '%'), when: SWEEP },
    pSelect('wrap', 'Wrap', 'clamp', [
      ['clamp', 'Clamp'],
      ['repeat', 'Repeat'],
      ['mirror', 'Mirror'],
    ]),
    pNum('amount', 'Amount', 1, 0, 1),
    pSelect('mode', 'Blend', 'normal', OVERLAY_BLENDS),
  ],
  presets: [
    { id: 'rainbow', label: 'Rainbow', params: rainbowOverlay({ bands: 1, angle: 20, phase: 0, saturation: 0.9, amount: 1, mode: 'color' }) },
    {
      id: 'glint',
      label: 'Glint',
      params: glintOverlay({ angle: 30, position: -20, width: 70, softness: 85, double: true, color: '#ffffff', intensity: 90 }),
    },
  ],
  directions: [
    { angle: 'angle', label: 'Gradient direction', convention: 'cwFromRight', when: { key: 'style', value: 'linear' } },
    { angle: 'angle', label: 'Sweep direction', convention: 'cwFromRight', when: { key: 'style', value: 'sweep' } },
  ],
  apply(ctx, input, output, p) {
    const box = bounds(ctx, input);
    pass(
      ctx,
      'gradientOverlay',
      gradientOverlayFrag,
      {
        tSrc: input,
        tBounds: box.texture,
        tGrad: ctx.kit.gradientTexture(grad(p, 'gradient')),
        uStyle: pick(p, 'style', OVERLAY_STYLES),
        uDir: dirVec(num(p, 'angle')),
        uScale: num(p, 'scale'),
        uOffset: num(p, 'offset'),
        uLen: Math.max(1, num(p, 'length') * ctx.pxScale),
        uPos: num(p, 'position') / 100,
        uAmount: num(p, 'amount'),
        uMode: pick(p, 'mode', OVERLAY_BLENDS.map(([v]) => v)),
        uWrap: pick(p, 'wrap', ['clamp', 'repeat', 'mirror']),
      },
      output,
    );
  },
};

// ---------- extrude ----------

const extrudeFrag = /* glsl */ `
uniform sampler2D tSrc, tN, tGrad;
uniform vec2 uDir, uLight;
uniform float uLen, uStep, uShade, uEdge, uOpacity, uFade;
void main() {
  vec4 L = texture(tSrc, vUv);
  vec2 px = 1.0 / uRes;
  vec4 acc = vec4(0.0);
  float faded = 0.0;   // coverage-weighted fade (1 − uFade · depth) of the copies hit
  int n = int(ceil(uLen / uStep));
  for (int i = 1; i <= 1024; i++) {
    if (i > n || acc.a > 0.996) break;
    float s = min(float(i) * uStep, uLen);
    vec2 q = vUv - uDir * s * px;
    float a = texture(tSrc, q).a;
    if (a < 0.002) continue;
    vec2 gr = vec2(texture(tN, q + vec2(px.x, 0.0)).a - texture(tN, q - vec2(px.x, 0.0)).a,
                   texture(tN, q + vec2(0.0, px.y)).a - texture(tN, q - vec2(0.0, px.y)).a);
    float gl = length(gr);
    vec2 nrm = gl > 1e-4 ? -gr / gl : uDir;           // outward edge normal of the face
    float lit = 0.5 + 0.5 * dot(nrm, uLight);
    vec3 c = texture(tGrad, vec2(s / uLen, 0.5)).rgb;
    c *= mix(1.0, 0.4 + 0.95 * lit, uShade);
    // dark contact line where the side meets the face, and along the back edge
    c *= 1.0 - uEdge * (1.0 - smoothstep(0.0, 3.0 * uPx, s - uStep));
    c *= 1.0 - 0.6 * uEdge * smoothstep(uLen - 3.0 * uPx, uLen, s);
    vec4 add = (1.0 - acc.a) * vec4(c, 1.0) * a;
    acc += add;
    faded += add.a * (1.0 - uFade * s / uLen);
  }
  // Fade: the extrusion thins out toward its back end (a flat long shadow with Shading and Edge at 0).
  if (uFade > 0.0 && acc.a > 0.0) acc *= faded / acc.a;
  o = L + acc * uOpacity * (1.0 - L.a);
}`;

const extrude2d: EffectDef = {
  type: 'extrude2d',
  label: 'Extrude',
  category: 'Material',
  description:
    'Eye Candy-style 2D extrusion: stacks the shape toward a direction (90° = down) with shaded, gradient sides behind the layer. ' +
    'With Shading and Edge Darkening at 0, a one-colour gradient and some Fade it is a flat long shadow.',
  params: [
    pDeg('angle', 'Direction', 75),
    pPx('length', 'Depth', 22, 1, 3000),
    pGrad('gradient', 'Side Gradient (front→back)', {
      stops: [
        { pos: 0, color: '#d97a00' },
        { pos: 1, color: '#4a1600' },
      ],
    }),
    pDeg('light', 'Light From', -120),
    pNum('shading', 'Shading', 0.7, 0, 1),
    pNum('edge', 'Edge Darkening', 0.55, 0, 1),
    pNum('fade', 'Fade', 0, 0, 1),
    pNum('opacity', 'Opacity', 1, 0, 1),
  ],
  presets: [{ id: 'longShadow', label: 'Long shadow', params: longShadowExtrude({ angle: 45, length: 260, fade: 1, color: '#000000', opacity: 0.55 }) }],
  directions: [
    { angle: 'angle', length: 'length', label: 'Extrude', convention: 'cwFromRight' },
    { angle: 'light', label: 'Light from', convention: 'cwFromRight' },
  ],
  reach: (p) => num(p, 'length'),
  apply(ctx, input, output, p) {
    const len = Math.max(1, num(p, 'length') * ctx.pxScale);
    const normals = blur(ctx, input, Math.max(1.5, 3 * ctx.pxScale), 'a');
    pass(
      ctx,
      'extrude2d',
      extrudeFrag,
      {
        tSrc: input,
        tN: normals.texture,
        tGrad: ctx.kit.gradientTexture(grad(p, 'gradient')),
        uDir: dirVec(num(p, 'angle')),
        uLight: dirVec(num(p, 'light')),
        uLen: len,
        uStep: Math.max(0.75, len / 1024),
        uShade: num(p, 'shading'),
        uEdge: num(p, 'edge'),
        uOpacity: num(p, 'opacity'),
        uFade: num(p, 'fade'),
      },
      output,
    );
  },
};

// ---------- motion trail ----------

const trailFrag = /* glsl */ `
${BOUNDS_GLSL}
uniform sampler2D tSrc;
uniform vec2 uDir; uniform vec3 uTint;
uniform float uLen, uStep, uFade, uTaper, uOpacity, uTintAmt;
void main() {
  vec4 L = texture(tSrc, vUv);
  vec4 b = layerBox();
  vec2 c = 0.5 * (b.xy + b.zw) * uRes;
  vec2 p = vUv * uRes;
  vec4 best = vec4(0.0); float bestF = 0.0;
  int n = int(ceil(uLen / uStep));
  for (int i = 1; i <= 1024; i++) {
    if (i > n) break;
    float s = min(float(i) * uStep, uLen);
    float f = s / uLen;
    float k = max(1.0 - uTaper * f, 0.02);
    vec2 q = c + (p - uDir * s - c) / k;
    vec4 v = texture(tSrc, q / uRes) * pow(1.0 - f, uFade);
    if (v.a > best.a) { best = v; bestF = f; }
  }
  vec3 cs = unpremul(best);
  cs = mix(cs, uTint, uTintAmt * mix(0.35, 1.0, bestF));
  o = L + vec4(cs * best.a, best.a) * uOpacity * (1.0 - L.a);
}`;

// Echo (残像): discrete copies stepped along the direction, each scaled about the layer box
// centre, fading by `uDecay` per copy and tinted from uC0 (nearest) to uC1 (farthest). Per-copy
// blur grows linearly with the copy index; it is read from three pre-blurred levels
// (⅓, ⅔ and all of the farthest copy's radius) mixed linearly.
const echoFrag = /* glsl */ `
${BOUNDS_GLSL}
uniform sampler2D tSrc, tB1, tB2, tB3;
uniform vec2 uDir; uniform vec3 uC0, uC1;
uniform float uOff, uScale, uDecay, uOpacity, uTintAmt;
uniform int uN; uniform bool uBlur;
vec4 level(vec2 uv, float t) {
  vec4 a = texture(tSrc, uv), b = texture(tB1, uv), c = texture(tB2, uv), d = texture(tB3, uv);
  return t < 1.0 ? mix(a, b, t) : t < 2.0 ? mix(b, c, t - 1.0) : mix(c, d, t - 2.0);
}
void main() {
  vec4 L = texture(tSrc, vUv);
  vec4 b = layerBox();
  vec2 c = 0.5 * (b.xy + b.zw) * uRes;
  vec2 p = vUv * uRes;
  vec4 acc = vec4(0.0);
  // Farthest copy first; each nearer one goes over it.
  for (int i = 12; i >= 1; i--) {
    if (i > uN) continue;
    float fi = float(i);
    vec2 uv = (c + (p - uDir * uOff * fi - c) / pow(uScale, fi)) / uRes;
    vec4 v = uBlur ? level(uv, 3.0 * fi / float(uN)) : texture(tSrc, uv);
    if (any(lessThan(uv, uFrameUv.xy)) || any(greaterThan(uv, uFrameUv.zw))) v = vec4(0.0);
    float t = uN > 1 ? (fi - 1.0) / float(uN - 1) : 0.0;
    vec3 cs = mix(unpremul(v), mix(uC0, uC1, t), uTintAmt);
    float a = v.a * pow(1.0 - uDecay, fi - 1.0);
    acc = over(vec4(cs * a, a), acc);
  }
  o = L + acc * uOpacity * (1.0 - L.a);
}`;

const SMEAR = { key: 'mode', value: 'smear' };
const ECHO = { key: 'mode', value: 'echo' };

const motionTrail: EffectDef = {
  type: 'motionTrail',
  label: 'Motion Trail',
  category: 'Distort',
  description:
    'Eye Candy-style smeared trail of the shape behind the layer, fading and tapering toward its end (180° = trail to the left), or Echo (残像): separate fading copies stepped along the direction.',
  params: [
    pSelect('mode', 'Mode', 'smear', [
      ['smear', 'Smear'],
      ['echo', 'Echo (残像)'],
    ]),
    pDeg('angle', 'Direction', 180),
    { ...pPx('length', 'Length', 160, 1, 1500), when: SMEAR },
    { ...pNum('fade', 'Fade', 1.4, 0, 6), when: SMEAR },
    { ...pNum('taper', 'Taper', 0.25, 0, 0.95), when: SMEAR },
    { ...pNum('copies', 'Copies', 4, 1, 12, 1), when: ECHO },
    { ...pPx('offset', 'Copy offset', 70, 1, 600), when: ECHO },
    { ...pNum('scaleStep', 'Scale step', 0, -30, 30, 1, '%'), when: ECHO },
    { ...pNum('decay', 'Opacity decay', 0.4, 0, 0.95), when: ECHO },
    { ...pPx('echoBlur', 'Blur per copy', 0, 0, 40, 0.5), when: ECHO },
    pNum('opacity', 'Opacity', 0.8, 0, 1),
    { ...pColor('tint', 'Tint Color', '#ff7a00'), when: SMEAR },
    { ...pColor('tintStart', 'Start Color', '#ff7a00'), when: ECHO },
    { ...pColor('tintEnd', 'End Color', '#7a2cff'), when: ECHO },
    pNum('tintAmount', 'Tint Amount', 0.5, 0, 1),
  ],
  directions: [
    { angle: 'angle', length: 'length', label: 'Trail', convention: 'cwFromRight', when: SMEAR },
    { angle: 'angle', length: 'offset', label: 'Copy offset', convention: 'cwFromRight', when: ECHO },
  ],
  // Echo: the farthest copy's offset and blur; growth from a positive scale step depends on the
  // layer's size and is not counted.
  reach: (p) =>
    p.mode === 'echo' ? Math.round(num(p, 'copies')) * (num(p, 'offset') + num(p, 'echoBlur')) : num(p, 'length'),
  apply(ctx, input, output, p) {
    const box = bounds(ctx, input);
    if (p.mode === 'echo') {
      const n = Math.min(12, Math.max(1, Math.round(num(p, 'copies'))));
      // Radius of the farthest copy's blur, render px.
      const r = Math.max(0, num(p, 'echoBlur')) * n * ctx.pxScale;
      const blurred = r > 0.5;
      pass(
        ctx,
        'motionEcho',
        echoFrag,
        {
          tSrc: input,
          tBounds: box.texture,
          tB1: blurred ? blur(ctx, input, r / 3, 'echo1').texture : input,
          tB2: blurred ? blur(ctx, input, (2 * r) / 3, 'echo2').texture : input,
          tB3: blurred ? blur(ctx, input, r, 'echo3').texture : input,
          uBlur: blurred,
          uDir: dirVec(num(p, 'angle')),
          uC0: col(p, 'tintStart'),
          uC1: col(p, 'tintEnd'),
          uOff: Math.max(0, num(p, 'offset')) * ctx.pxScale,
          uScale: Math.max(0.05, 1 + num(p, 'scaleStep') / 100),
          uDecay: Math.min(1, Math.max(0, num(p, 'decay'))),
          uOpacity: num(p, 'opacity'),
          uTintAmt: num(p, 'tintAmount'),
          uN: n,
        },
        output,
      );
      return;
    }
    const len = Math.max(1, num(p, 'length') * ctx.pxScale);
    pass(
      ctx,
      'motionTrail',
      trailFrag,
      {
        tSrc: input,
        tBounds: box.texture,
        uDir: dirVec(num(p, 'angle')),
        uTint: col(p, 'tint'),
        uLen: len,
        uStep: Math.max(0.75, len / 1024),
        uFade: Math.max(0, num(p, 'fade')),
        uTaper: num(p, 'taper'),
        uOpacity: num(p, 'opacity'),
        uTintAmt: num(p, 'tintAmount'),
      },
      output,
    );
  },
};

// ---------- halftone ----------

const halftoneFrag = /* glsl */ `
${BOUNDS_GLSL}
${BOX_POS_GLSL}
uniform sampler2D tSrc, tSoft;
uniform float uSize, uAngle, uDotScale, uAmount; uniform vec3 uColor; uniform vec2 uRampDir;
uniform int uSource, uMode;
uniform vec2 uCentreUv;                             // the comp centre in target uv
// Anti-aliased disc of radius rad (cells) at distance d (cells), px render px per cell; tiny discs fade by their area.
float disc(float rad, float d, float px) { return clamp((rad - d) * px + 0.5, 0.0, 1.0) * min(1.0, 2.0 * rad * px); }
void main() {
  vec4 L = texture(tSrc, vUv);
  if (L.a < 1e-5) { o = vec4(0.0); return; }
  vec2 pc = (vUv - uCentreUv) * uRes / uPx;        // comp px from the comp centre
  float cs = cos(uAngle), sn = sin(uAngle);
  mat2 rot = mat2(cs, sn, -sn, cs);
  vec2 r = rot * pc / uSize;
  vec2 cell = floor(r);
  vec2 f = r - cell - 0.5;
  if (uSource == 3) {
    // Dissolve: an AM screen cut out of the layer, its density from the alpha softened over Fade:
    // no dots below 40 %, dots growing until they touch at 70 %, then the gaps closing up to 100 %.
    float dens = clamp(1.7 * texture(tSoft, vUv).a - 0.7, 0.0, 1.0);
    float px = uSize * uPx;
    float scr = dens <= 0.5 ? disc(sqrt(dens / 3.14159265), length(f), px)
                            : 1.0 - disc(sqrt((1.0 - dens) / 3.14159265), length(fract(r + 0.5) - 0.5), px);
    o = L * scr;
    return;
  }
  float v;
  if (uSource == 0) {
    v = clamp(boxPos(uRampDir), 0.0, 1.0);
  } else if (uSource == 1) {
    vec2 cc = (transpose(rot) * ((cell + 0.5) * uSize) * uPx) / uRes + uCentreUv;
    vec4 s = texture(tSrc, cc);
    if (s.a < 0.05) s = L;
    v = 1.0 - luma(toSRGB(unpremul(s)));
  } else v = 1.0;
  float radius = sqrt(clamp(v * uDotScale, 0.0, 2.0)) * 0.7071;
  float cov = clamp((radius - length(f)) * uSize * uPx + 0.5, 0.0, 1.0);
  vec3 b = toSRGB(unpremul(L));
  vec3 dc = toSRGB(uColor);
  vec3 res = toLinear(mix(b, blendMode(uMode, b, dc), cov * uAmount));
  o = vec4(res * L.a, L.a);
}`;

/** Halftone params that only apply when the dots recolour the layer (not in Dissolve). */
const RECOLOUR = { key: 'source', value: ['ramp', 'luminance', 'uniform'] };

const halftone: EffectDef = {
  type: 'halftone',
  label: 'Halftone',
  category: 'Color',
  description:
    'Comic dot screen inside the shape; dot size from a ramp across the layer, its luminance, or uniform. Dissolve instead breaks the layer itself into a dot screen toward its edges (or its soft, transparent parts), over Fade.',
  params: [
    pPx('size', 'Cell Size', 9, 2, 120, 0.5),
    pDeg('angle', 'Screen Angle', 45),
    { ...pNum('dotScale', 'Dot Scale', 0.8, 0, 2), when: RECOLOUR },
    { ...pColor('color', 'Dot Color', '#8a1c00'), when: RECOLOUR },
    { ...pNum('amount', 'Amount', 0.6, 0, 1), when: RECOLOUR },
    pSelect('source', 'Dot Size From', 'ramp', [
      ['ramp', 'Ramp'],
      ['luminance', 'Darkness'],
      ['uniform', 'Uniform'],
      ['alpha', 'Transparency (dissolve)'],
    ]),
    { ...pPx('fade', 'Fade', 28, 0, 400), when: { key: 'source', value: 'alpha' } },
    { ...pDeg('rampAngle', 'Ramp Angle', 90), when: { key: 'source', value: 'ramp' } },
    { ...pSelect('mode', 'Blend', 'multiply', BLEND_OPTIONS), when: RECOLOUR },
  ],
  apply(ctx, input, output, p) {
    const source = pick(p, 'source', ['ramp', 'luminance', 'uniform', 'alpha']);
    pass(
      ctx,
      'halftone',
      halftoneFrag,
      {
        tSrc: input,
        tBounds: source === 0 ? bounds(ctx, input).texture : null,
        // Dissolve: the alpha softened over Fade (radius ≈ 3σ) sets the screen density.
        tSoft: source === 3 ? blur(ctx, input, Math.max(0, num(p, 'fade')) * ctx.pxScale, 'halftone').texture : null,
        uSize: Math.max(1, num(p, 'size')),
        uAngle: (num(p, 'angle') * Math.PI) / 180,
        uDotScale: num(p, 'dotScale'),
        uAmount: num(p, 'amount'),
        uColor: col(p, 'color'),
        uRampDir: dirVec(num(p, 'rampAngle')),
        uSource: source,
        uCentreUv: [centreX(ctx.frame) / ctx.width, centreY(ctx.frame) / ctx.height],
        uMode: pick(p, 'mode', BLEND_VALUES),
      },
      output,
    );
  },
};

export const STYLIZE_EFFECTS: EffectDef[] = [
  gradientOverlay,
  // Only the shading light follows the comp light; the extrusion direction stays the user's.
  lit(extrude2d, { angle: 'light', convention: 'cwFromRight', relation: 'from' }),
  motionTrail,
  halftone,
];

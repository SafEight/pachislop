import * as THREE from 'three';
import type { EffectParams, GeneratorContext, GeneratorDef } from '../../engine/contracts';
import { B, C, col, DEG, G, grad, HEAD, material, N, num, S, sel, bool } from '../../effects/b/common';
import { NOISE_GLSL } from '../../effects/lib';
import type { EffectInstance } from '../../model/types';
import { compToRender, followed, followParam, LAYER_FRAG, type LayerUniforms, layerUniforms, presetEffect, setLayerUniforms } from '../common';
import { framePolygon, when } from './shared';

// 放射 / 集中線: rays from a centre over the whole frame, free or following a layer.
// - Sunburst (放射 background: Shine, CC Light Burst, sunburst 素材): alternating ray wedges merging
//   into a solid disc of the ray colour at the inner radius, with a centre glow. Opaque: it is the
//   background. Ray edges are anti-aliased by their true perpendicular distance in render px
//   (twisted rays too) and fade to the average where the rays get thinner than a few pixels, so
//   the centre never moirés. Darkened corners are a Gradient Overlay on the layer (`vignette`).
// - Wedges, Focus lines (集中線) and Speed rings: rays of varying width (and length) around a
//   cleared centre, in one or two colours, with a perceptual (sRGB, Photoshop-like) ray opacity.
// Following a layer, the centre is that layer's centre (or Centre X / Y), and the rays can stay on
// the layer's own pixels (mixed over them like a recolour) or go over it and around it.

const frag = /* glsl */ `
uniform vec2 uC; uniform float uRays, uTwist, uRot, uInner, uSoft, uGlow, uRc, uDuty;
uniform vec3 uA, uB; uniform bool uRadial, uClip; uniform sampler2D tGrad, tSrc;
${LAYER_FRAG}
const float TAU = 6.2831853;
void main() {
  vec2 d = layerPos() - uC;
  float r = length(d);
  float k = layerPxScale();
  float th = atan(d.y, d.x) - uRot + uTwist * r;
  float u = fract(th / TAU * uRays + 0.5) - 0.5;  // -0.5..0.5 across one ray period, ray = |u| < duty / 2
  // One period's arc in render px, shortened by the slant of twisted edges.
  float period = TAU * r * k / uRays / sqrt(1.0 + r * r * uTwist * uTwist);
  float edge = mix(1.0, 0.5 * period, uSoft);
  float cov = smoothstep(0.0, 1.0, clamp((0.5 * uDuty - abs(u)) * period / max(edge, 1e-3) + 0.5, 0.0, 1.0));
  cov = mix(0.5, cov, clamp(0.5 * period - 1.0, 0.0, 1.0));
  // Inside the inner radius the rays merge into a disc of the ray colour.
  float disc = clamp((uInner - r) * k / max(1.0, uSoft * uInner * k * 0.6) + 0.5, 0.0, 1.0);
  cov = max(cov, disc);
  vec3 ray = uA;
  if (uRadial) {
    vec4 g = texture(tGrad, vec2(clamp(r / uRc, 0.0, 1.0), 0.5));
    ray = mix(uB, g.rgb, g.a);
  }
  vec3 c = mix(uB, ray, cov);
  // Centre glow: a whitened ray colour, about twice the inner disc wide.
  float gr = max(uInner * 1.6, 0.15 * uRc);
  vec3 hot = mix(uRadial ? texture(tGrad, vec2(0.0, 0.5)).rgb : uA, vec3(1.0), 0.6);
  c += hot * uGlow * exp(-2.0 * r * r / (gr * gr));
  o = uClip ? vec4(c, 1.0) * texture(tSrc, vUv).a : vec4(c, 1.0);
}`;

const burstFrag = /* glsl */ `
uniform sampler2D tSrc; uniform bool uHasSrc; uniform vec2 uC; uniform int uStyle, uMode;
uniform float uN, uDuty, uVar, uInner, uSoft, uOpacity, uRot, uSeed, uLenVar;
uniform vec3 uCol1, uCol2; uniform bool uAlt;
${NOISE_GLSL}
${LAYER_FRAG}
const float TAU = 6.2831853;
float toLin1(float x) { return x <= 0.04045 ? x / 12.92 : pow((x + 0.055) / 1.055, 2.4); }
vec3 toLin(vec3 c) { c = max(c, 0.0); return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
vec3 toSrgb(vec3 c) { c = clamp(c, 0.0, 1.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
void main() {
  vec4 s = uHasSrc ? texture(tSrc, vUv) : vec4(0.0);
  vec2 d = layerPos() - uC;
  float r = length(d);
  float ang = atan(d.y, d.x) - uRot;
  float aa = 1.0 / layerPxScale();       // one render pixel in layer px
  float cov = 0.0;                       // ray coverage 0..1
  float k = 0.0;                         // 0/1 colour select for alternating colours
  if (uStyle < 2) {
    // Sector index around the centre; each sector holds one ray.
    float u = fract(ang / TAU) * uN;
    float i = floor(u);
    if (i >= uN) i = 0.0;
    float f = u - i;                     // 0..1 across the sector
    float h1 = hash12(vec2(i, uSeed)), h2 = hash12(vec2(i + 31.0, uSeed)), h3 = hash12(vec2(i + 77.0, uSeed));
    float sectorPx = TAU * r / uN;       // sector arc length at this radius (layer px)
    if (uStyle == 0) {
      // Wedges: angular width varies per ray, edges anti-aliased in pixels.
      float w = uDuty * (1.0 - uVar * h1);
      float c0 = 0.5 + (h2 - 0.5) * (1.0 - w) * uVar;
      cov = clamp((0.5 * w - abs(f - c0)) * sectorPx / aa + 0.5, 0.0, 1.0);
    } else {
      // Focus lines: needle-shaped rays starting at random radii beyond the inner radius.
      float start = uInner * (1.0 + uLenVar * 1.5 * h3);
      float grow = max(uInner * 0.6, 40.0);
      float w = uDuty * (1.0 - uVar * h1) * smoothstep(start, start + grow, r);
      float c0 = 0.5 + (h2 - 0.5) * 0.7;
      cov = clamp((0.5 * w - abs(f - c0)) * sectorPx / aa + 0.5, 0.0, 1.0) * step(start, r);
      k = step(0.5, h3);
    }
  } else {
    // Concentric speed rings: broken arcs at regular radii (count = rings per 1000 comp px, so the
    // pattern doesn't depend on the canvas size).
    float spacing = 1000.0 / uN;
    float j = floor(r / spacing);
    float fr = r / spacing - j;
    float h1 = hash12(vec2(j, uSeed)), h2 = hash12(vec2(j + 13.0, uSeed)), h3 = hash12(vec2(j + 57.0, uSeed));
    float w = uDuty * (1.0 - uVar * h1);
    float band = clamp((0.5 * w - abs(fr - 0.5)) * spacing / aa + 0.5, 0.0, 1.0);
    float segs = floor(3.0 + 9.0 * h2);
    float sa = fract(ang / TAU * segs + h3);
    float arcLen = mix(1.0, 0.35 + 0.5 * h1, uLenVar);
    float arcPx = TAU * r / segs;
    float arc = clamp((0.5 * arcLen - abs(sa - 0.5)) * arcPx / aa + 0.5, 0.0, 1.0);
    cov = band * arc;
    k = mod(j, 2.0);
  }
  // Clear the centre with a soft edge.
  float inner = smoothstep(uInner * (1.0 - uSoft) - aa, uInner, r);
  vec3 c;
  float a;
  if (uStyle == 0 && uAlt) {
    // Two-colour wedges: colour-1 wedges on a colour-2 ground.
    c = mix(uCol2, uCol1, cov);
    a = inner * uOpacity;
  } else {
    c = uAlt && k > 0.5 ? uCol2 : uCol1;
    a = cov * inner * uOpacity;
  }
  // Ray opacity is perceptual (Photoshop-like, sRGB-space coverage): over the followed layer's own
  // pixels the rays are blended in sRGB; HDR energy above 1 is kept.
  vec3 sb = unpre(s);
  vec3 mixed = toLin(mix(toSrgb(sb), toSrgb(c), a)) + max(sb - 1.0, 0.0) * (1.0 - a);
  // Elsewhere the engine composites later in linear light, so use the alpha that gives the same
  // brightness over black (dark rays keep the plain alpha).
  float ls = dot(toSrgb(c), vec3(0.2126, 0.7152, 0.0722));
  float aT = ls > 1e-4 ? clamp(toLin1(a * ls) / toLin1(ls), 0.0, 1.0) : a;
  vec4 rayT = vec4(c * aT, aT);
  // 0 = rays only, 1 = on the layer's pixels only, 2 = on them and around them.
  vec4 onLayer = vec4(mixed * s.a, s.a);
  o = uMode == 1 ? onLayer : uMode == 2 ? onLayer + rayT * (1.0 - s.a) : rayT;
}`;

const STYLE_ID: Record<string, number> = { wedges: 0, focus: 1, rings: 2 };
const MODE_ID: Record<string, number> = { all: 0, clip: 1, over: 2 };
const BURSTS = ['wedges', 'focus', 'rings'];

/** sRGB hex of the linear grey `v` (0..1). */
function greyHex(v: number): string {
  const s = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
  const h = Math.round(Math.min(1, Math.max(0, s)) * 255).toString(16).padStart(2, '0');
  return `#${h}${h}${h}`;
}

/**
 * Darkened corners (0..1): a radial Gradient Overlay shading the layer by 1 − `amount` ×
 * smoothstep(0.25, 1, r) in linear light, r = 0 at the layer box centre … 1 in its corners. On a
 * full-frame layer that is the frame's vignette (the one Sunburst used to draw itself).
 */
export function vignette(amount: number): EffectInstance {
  const at = (x: number) => ({ pos: x, color: greyHex(1 - amount * (x <= 0.25 ? 0 : (t => t * t * (3 - 2 * t))((x - 0.25) / 0.75))) });
  const stops = [at(0), ...Array.from({ length: 13 }, (_, i) => at(0.25 + (0.75 * i) / 12))];
  return presetEffect('gradientOverlay', { style: 'radial', gradient: { stops }, mode: 'shade', scale: 1, offset: 0, wrap: 'clamp', amount: 1 });
}

/**
 * Layer-space centre of the rays: Centre X / Y, plus (following a layer with Centre = Layer centre)
 * that layer's ink centre.
 */
function centre(ctx: GeneratorContext, p: EffectParams): [number, number] {
  const x = N(p, 'x');
  const y = N(p, 'y');
  const id = followed(p);
  const b = id && S(p, 'centre') === 'layer' ? ctx.layerBounds(id) : null;
  if (!b) return [x, y];
  // Comp space → layer space (pxScale and export margins cancel out).
  const v = new THREE.Vector2((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2).applyMatrix3(compToRender(ctx)).applyMatrix3(ctx.layerToRender.clone().invert());
  return [v.x + x, v.y + y];
}

export const sunburst: GeneratorDef = {
  type: 'sunburst',
  label: 'Sunburst',
  category: 'Lines',
  description:
    '放射 / 集中線: rays from a centre over the whole frame. Sunburst: two colours (or rays coloured by a gradient along the radius) merging into a solid disc ' +
    'at the inner radius, with a centre glow; Twist curls the rays (degrees per 1000 px of radius). Wedges, Focus lines and Speed rings: rays of varying width ' +
    'and length around a cleared centre, in one or two colours. Following a layer, the rays centre on it and can stay on its own pixels.',
  follow: 'optional',
  params: [
    followParam('Layer'),
    sel('style', 'Style', 'sunburst', [
      ['sunburst', 'Sunburst'],
      ['wedges', 'Wedges'],
      ['focus', 'Focus lines (集中線)'],
      ['rings', 'Speed rings'],
    ]),
    sel('centre', 'Centre', 'layer', [
      ['layer', 'Layer centre'],
      ['point', 'Centre X / Y'],
    ]),
    sel('onLayer', 'On the layer', 'all', [
      ['all', 'Rays everywhere'],
      ['clip', 'Only on its pixels'],
      ['over', 'On its pixels and around'],
    ]),
    num('x', 'Centre X', 0, -4000, 4000, 'px'),
    num('y', 'Centre Y', 0, -4000, 4000, 'px'),
    num('rays', 'Rays', 24, 2, 300, undefined, 1),
    num('rotation', 'Rotation', 0, -180, 180, 'deg'),
    num('width', 'Ray width', 50, 2, 100, '%'),
    when(num('widthVariation', 'Width variation', 40, 0, 100, '%'), 'style', BURSTS),
    when(num('lengthVariation', 'Length variation', 60, 0, 100, '%'), 'style', ['focus', 'rings']),
    when(num('twist', 'Twist', 0, -360, 360, 'deg'), 'style', 'sunburst'),
    num('inner', 'Inner radius', 140, 0, 4000, 'px'),
    when(num('softness', 'Softness', 10, 0, 100, '%'), 'style', 'sunburst'),
    when(num('innerSoftness', 'Inner softness', 60, 0, 100, '%'), 'style', BURSTS),
    when(
      sel('colorMode', 'Ray colour', 'ab', [
        ['ab', 'Colour A'],
        ['radial', 'Gradient along the radius'],
      ]),
      'style',
      'sunburst',
    ),
    when(col('colorA', 'Colour A', '#ffc93c'), 'colorMode', 'ab'),
    when(bool('alternate', 'Two colours', false), 'style', BURSTS),
    col('colorB', 'Colour B', '#c2121c'),
    when(
      grad('gradient', 'Gradient', {
        stops: [
          { pos: 0, color: '#fff3b0' },
          { pos: 0.45, color: '#e3a82a' },
          { pos: 1, color: '#7a4a0a' },
        ],
      }),
      'colorMode',
      'radial',
    ),
    when(num('glow', 'Centre glow', 70, 0, 300, '%'), 'style', 'sunburst'),
    when(num('opacity', 'Ray opacity', 70, 0, 100, '%'), 'style', BURSTS),
    when(num('seed', 'Seed', 1, 0, 999, undefined, 1), 'style', BURSTS),
  ],
  presets: [
    { id: 'redGold', label: 'Red & gold rays', params: {}, effects: [vignette(0.45)] },
    { id: 'blue', label: 'Blue rays', params: { rays: 32, softness: 30, colorA: '#4fc3ff', colorB: '#0a2a8a', glow: 60 }, effects: [vignette(0.5)] },
    {
      id: 'rainbowHalo',
      label: 'Rainbow halo',
      params: {
        rays: 48,
        inner: 90,
        softness: 60,
        colorMode: 'radial',
        colorB: '#120c24',
        gradient: {
          stops: [
            { pos: 0, color: '#ffffff' },
            { pos: 0.12, color: '#fff27a' },
            { pos: 0.3, color: '#ff8a3a' },
            { pos: 0.45, color: '#ff3d8a' },
            { pos: 0.6, color: '#9a5cff' },
            { pos: 0.75, color: '#3ab8ff' },
            { pos: 1, color: '#3affa0' },
          ],
          interp: 'vivid',
        },
        glow: 100,
      },
      effects: [vignette(0.5)],
    },
    { id: 'purple', label: 'Purple rays', params: { rays: 28, softness: 30, colorA: '#c46bff', colorB: '#2a0848', glow: 60 }, effects: [vignette(0.55)] },
    { id: 'blackGold', label: 'Black & gold', params: { rays: 28, softness: 5, colorMode: 'radial', colorB: '#050505', glow: 40 }, effects: [vignette(0.35)] },
    {
      id: 'focusLines',
      label: 'Focus lines',
      place: 'below',
      params: { style: 'focus', rays: 90, width: 30, widthVariation: 60, lengthVariation: 70, inner: 420, innerSoftness: 40, colorA: '#ffffff', opacity: 55, seed: 6 },
    },
    {
      id: 'twoColourWedges',
      label: 'Two-colour wedges',
      params: { style: 'wedges', rays: 40, width: 40, widthVariation: 50, lengthVariation: 0, inner: 0, alternate: true, colorA: '#e8962a', colorB: '#2e1000', opacity: 100, seed: 4 },
    },
  ],
  handles: [{ x: 'x', y: 'y', label: 'Sunburst centre' }],
  sizes: [{ rx: 'inner', x: 'x', y: 'y', label: 'Inner radius' }],
  directions: [{ angle: 'rotation', label: 'Rotation', convention: 'ccwFromRight' }],
  bounds: () => null,
  // On the layer's pixels only, the rays stay inside its ink; otherwise they fill the frame.
  followReach: (p) => (S(p, 'onLayer') === 'clip' ? 0 : null),
  render(ctx, target, p) {
    const id = followed(p);
    const mode = id ? (MODE_ID[S(p, 'onLayer')] ?? 0) : 0;
    const src = mode ? ctx.layerContent(id) : null;
    if (mode === 1 && !src) {
      ctx.kit.clear(target);
      return;
    }
    const [cx, cy] = centre(ctx, p);
    const duty = Math.min(1, Math.max(0.01, N(p, 'width') / 100));
    const style = S(p, 'style');
    if (BURSTS.includes(style)) {
      const m = material(ctx.kit, 'gen-sunburst-rays', {
        uniforms: {
          ...layerUniforms(),
          tSrc: { value: null },
          uHasSrc: { value: false },
          uC: { value: new THREE.Vector2() },
          uStyle: { value: 0 },
          uMode: { value: 0 },
          uN: { value: 24 },
          uDuty: { value: 0.5 },
          uVar: { value: 0.4 },
          uLenVar: { value: 0.6 },
          uInner: { value: 100 },
          uSoft: { value: 0.6 },
          uOpacity: { value: 0.7 },
          uRot: { value: 0 },
          uSeed: { value: 0 },
          uCol1: { value: new THREE.Color() },
          uCol2: { value: new THREE.Color() },
          uAlt: { value: false },
        },
        fragmentShader: HEAD + burstFrag,
      });
      const u = m.uniforms;
      setLayerUniforms(u as unknown as LayerUniforms, ctx, ctx.layerToRender);
      u.tSrc.value = src;
      u.uHasSrc.value = src !== null;
      u.uC.value.set(cx, cy);
      u.uStyle.value = STYLE_ID[style];
      u.uMode.value = src ? mode : 0;
      u.uN.value = Math.max(1, Math.round(N(p, 'rays')));
      u.uDuty.value = duty;
      u.uVar.value = N(p, 'widthVariation') / 100;
      u.uLenVar.value = N(p, 'lengthVariation') / 100;
      u.uInner.value = Math.max(0, N(p, 'inner'));
      u.uSoft.value = Math.min(1, Math.max(0, N(p, 'innerSoftness') / 100));
      u.uOpacity.value = N(p, 'opacity') / 100;
      u.uRot.value = N(p, 'rotation') * DEG;
      u.uSeed.value = (N(p, 'seed') % 97) * 1.73;
      u.uCol1.value.copy(C(p, 'colorA'));
      u.uCol2.value.copy(C(p, 'colorB'));
      u.uAlt.value = B(p, 'alternate');
      ctx.kit.run(m, target);
      return;
    }
    const m = material(ctx.kit, 'gen-sunburst', {
      uniforms: {
        ...layerUniforms(),
        uC: { value: new THREE.Vector2() },
        uRays: { value: 24 },
        uTwist: { value: 0 },
        uRot: { value: 0 },
        uInner: { value: 0 },
        uSoft: { value: 0 },
        uGlow: { value: 0 },
        uRc: { value: 1 },
        uDuty: { value: 0.5 },
        uA: { value: new THREE.Color() },
        uB: { value: new THREE.Color() },
        uRadial: { value: false },
        uClip: { value: false },
        tGrad: { value: null },
        tSrc: { value: null },
      },
      fragmentShader: HEAD + frag,
    });
    const u = m.uniforms;
    setLayerUniforms(u as unknown as LayerUniforms, ctx, ctx.layerToRender);
    u.uC.value.set(cx, cy);
    u.uRays.value = Math.max(2, Math.round(N(p, 'rays')));
    u.uTwist.value = (N(p, 'twist') * DEG) / 1000;
    u.uRot.value = N(p, 'rotation') * DEG;
    u.uInner.value = Math.max(0, N(p, 'inner'));
    u.uSoft.value = Math.min(1, Math.max(0, N(p, 'softness') / 100));
    u.uGlow.value = Math.max(0, N(p, 'glow') / 100);
    u.uDuty.value = duty;
    // Radius of the gradient: the farthest frame corner from the centre.
    u.uRc.value = Math.max(1, ...framePolygon(ctx).map(([x, y]) => Math.hypot(x - cx, y - cy)));
    u.uA.value.copy(C(p, 'colorA'));
    u.uB.value.copy(C(p, 'colorB'));
    u.uRadial.value = S(p, 'colorMode') === 'radial';
    u.uClip.value = mode === 1;
    u.tGrad.value = ctx.kit.gradientTexture(G(p, 'gradient'));
    u.tSrc.value = src;
    ctx.kit.run(m, target);
  },
};

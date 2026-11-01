import type { EffectDef } from '../../engine/contracts';
import { GRADIENTS } from '../../model/defaults';
import { blur, bounds, BOUNDS_GLSL, BOX_POS_GLSL, sdf } from '../lib';
import { disposeLightGlow, falloffExponent, lightGlowComposeFrag, psfOctaves, scatterLight } from './lightGlow';
import { col, dirVec, followed, grad, num, pass, pColor, pDeg, pFollow, pGrad, pNum, pPx, pSelect, pick } from './util';

/** Fire-coloured edge gradient: the Eye Candy gradient glow (white at the edge → red). */
const CLASSIC_GLOW = {
  stops: [
    { pos: 0, color: '#ffffff' },
    { pos: 0.22, color: '#fff36b' },
    { pos: 0.55, color: '#ff8a00' },
    { pos: 1, color: '#e01400' },
  ],
};

/**
 * Technique, as in Photoshop: Softer = the blurred alpha (a soft halo that rounds corners);
 * Precise = the exact distance from the edge, solid out to Spread / Choke of Size then a smooth
 * falloff to 0 at Size (follows corners and serifs).
 */
const TECHNIQUE = pSelect('technique', 'Technique', 'softer', [
  ['softer', 'Softer'],
  ['precise', 'Precise'],
]);

const OUTER_FILLS = ['solid', 'gradient', 'layer', 'distance'];

const outerGlowFrag = /* glsl */ `
${BOUNDS_GLSL}
${BOX_POS_GLSL}
uniform sampler2D tSrc, tBig, tSmall, tGrad, tSdf;
uniform vec3 uColor; uniform float uInt, uSpread, uOpacity, uOnFace, uSize; uniform int uMode, uFill;
uniform vec2 uDir; uniform bool uPrecise;
void main() {
  vec4 L = texture(tSrc, vUv);
  vec4 B = texture(tBig, vUv);
  float d = uPrecise || uFill == 3 ? texture(tSdf, vUv).r : 0.0;   // render px from the edge, + outside
  float a;
  if (uPrecise) {
    a = (1.0 - smoothstep(min(uSpread, 0.999), 1.0, max(d, 0.0) / uSize)) * clamp(uSize - d + 0.5, 0.0, 1.0);
  } else {
    // From layer: the layer's own light, one Gaussian (the layer is its own core); else a tighter core is mixed in.
    a = uFill == 2 ? B.a : 0.6 * B.a + 0.4 * texture(tSmall, vUv).a;
    a = clamp(a / max(1.0 - uSpread, 0.02), 0.0, 1.0);
  }
  // Gradient fill: the colour runs across the layer's box (clamped beyond it), e.g. pink above, cyan
  // below; from the edge: the colour follows the distance from the edge (left = at the edge).
  vec3 col = uFill == 2 ? B.rgb / max(B.a, 1e-6)
    : uFill == 1 ? texture(tGrad, vec2(clamp(boxPos(uDir), 0.0, 1.0), 0.5)).rgb
    : uFill == 3 ? texture(tGrad, vec2(clamp(max(d, 0.0) / uSize, 0.0, 1.0), 0.5)).rgb
    : uColor;
  float g = clamp(a * uInt, 0.0, 1.0) * uOpacity;
  if (uMode == 0) {
    o = L + vec4(col * g, g) * (1.0 - L.a);
  } else {
    // additive light (may exceed alpha = emissive, intended), over the face by uOnFace (low keeps a title readable)
    o = vec4(L.rgb + col * a * uInt * uOpacity * (1.0 - (1.0 - uOnFace) * L.a), L.a + g * (1.0 - L.a));
  }
}`;

/** Pink above → cyan below: the 虹 title halo. */
const GLOW_GRADIENT = {
  stops: [
    { pos: 0, color: '#ff4ad8' },
    { pos: 1, color: '#30e0ff' },
  ],
};

const outerGlow: EffectDef = {
  type: 'outerGlow',
  label: 'Outer Glow',
  category: 'Glow',
  description:
    "Glow around the layer, behind it like Photoshop (default) or added over it as light; one colour, a gradient across the layer, a gradient from the edge outward, or the layer's own colours.",
  params: [
    pSelect('fill', 'Fill', 'solid', [
      ['solid', 'Colour'],
      ['gradient', 'Gradient across the layer'],
      ['layer', 'From layer'],
      ['distance', 'Gradient from the edge'],
    ]),
    { ...pColor('color', 'Color', '#ffb000'), when: { key: 'fill', value: 'solid' } },
    { ...pGrad('gradient', 'Gradient', GLOW_GRADIENT), when: { key: 'fill', value: ['gradient', 'distance'] } },
    { ...pDeg('angle', 'Gradient angle', 90), when: { key: 'fill', value: 'gradient' } },
    TECHNIQUE,
    pPx('size', 'Size', 40, 1, 400),
    pNum('intensity', 'Intensity', 1.6, 0, 6),
    pNum('spread', 'Spread', 0.15, 0, 1),
    pNum('opacity', 'Opacity', 1, 0, 1),
    pSelect('mode', 'Mode', 'behind', [
      ['behind', 'Behind'],
      ['add', 'Additive (light)'],
    ]),
    { ...pNum('onFace', 'Glow Over Face', 0.15, 0, 1), when: { key: 'mode', value: 'add' } },
  ],
  directions: [{ angle: 'angle', label: 'Gradient direction', convention: 'cwFromRight', when: { key: 'fill', value: 'gradient' } }],
  reach: (p) => num(p, 'size'),
  apply(ctx, input, output, p) {
    const fill = pick(p, 'fill', OUTER_FILLS);
    const precise = p.technique === 'precise';
    const size = Math.max(0.5, num(p, 'size')) * ctx.pxScale;
    // Softer reads the blurs; From layer reads the big blur's colour even when Precise.
    const big = !precise || fill === 2 ? blur(ctx, input, size, 'a').texture : null;
    const small = !precise && fill !== 2 ? blur(ctx, input, size * 0.3, 'b').texture : null;
    pass(
      ctx,
      'outerGlow',
      outerGlowFrag,
      {
        tSrc: input,
        tBig: big,
        tSmall: small,
        tSdf: precise || fill === 3 ? sdf(ctx, input).texture : null,
        tBounds: fill === 1 ? bounds(ctx, input).texture : null,
        tGrad: fill === 1 || fill === 3 ? ctx.kit.gradientTexture(grad(p, 'gradient')) : null,
        uFill: fill,
        uPrecise: precise,
        uSize: size,
        uDir: dirVec(num(p, 'angle')),
        uColor: col(p, 'color'),
        uInt: num(p, 'intensity'),
        uSpread: num(p, 'spread'),
        uOpacity: num(p, 'opacity'),
        uOnFace: num(p, 'onFace'),
        uMode: pick(p, 'mode', ['behind', 'add']),
      },
      output,
    );
  },
};

const innerGlowFrag = /* glsl */ `
uniform sampler2D tSrc, tBlur, tSdf, tGrad;
uniform vec3 uColor; uniform float uInt, uOpacity, uChoke, uSize; uniform int uMode; uniform bool uCenter, uPrecise, uDistance;
void main() {
  vec4 L = texture(tSrc, vUv);
  if (L.a < 1e-5) { o = vec4(0.0); return; }
  float d = uPrecise || uDistance ? texture(tSdf, vUv).r : 0.0;   // render px from the edge, − inside
  float g;
  if (uPrecise) {
    // edge: solid in to Choke of Size, then a smooth falloff to 0 at Size; centre: the reverse
    float s = smoothstep(min(uChoke, 0.999), 1.0, max(-d, 0.0) / uSize);
    g = uCenter ? s : (1.0 - s) * clamp(uSize + d + 0.5, 0.0, 1.0);
  } else {
    float b = texture(tBlur, vUv).a;
    g = (uCenter ? (b - 0.5) * 2.0 : 2.0 * (1.0 - b)) / max(1.0 - uChoke, 0.02);
  }
  g = clamp(g * uInt, 0.0, 1.0) * uOpacity;
  // From the edge: the colour follows the distance from the edge (left = at the edge).
  vec3 col = uDistance ? texture(tGrad, vec2(clamp(max(-d, 0.0) / uSize, 0.0, 1.0), 0.5)).rgb : uColor;
  vec3 c = unpremul(L);
  vec3 r;
  if (uMode == 0) r = mix(c, col, g);
  else if (uMode == 1) r = c + col * g - c * col * g;
  else r = c + col * g;
  o = vec4(r * L.a, L.a);
}`;

const innerGlow: EffectDef = {
  type: 'innerGlow',
  label: 'Inner Glow',
  category: 'Glow',
  description: 'Glow spreading inward from the edges (or outward from the centre) of the layer, in one colour or a gradient from the edge inward.',
  params: [
    pSelect('fill', 'Fill', 'solid', [
      ['solid', 'Colour'],
      ['distance', 'Gradient from the edge'],
    ]),
    { ...pColor('color', 'Color', '#fff4a0'), when: { key: 'fill', value: 'solid' } },
    { ...pGrad('gradient', 'Gradient', CLASSIC_GLOW), when: { key: 'fill', value: 'distance' } },
    TECHNIQUE,
    pPx('size', 'Size', 18, 1, 200),
    pNum('intensity', 'Intensity', 1, 0, 4),
    pNum('choke', 'Choke', 0, 0, 1),
    pNum('opacity', 'Opacity', 1, 0, 1),
    pSelect('mode', 'Mode', 'screen', [
      ['normal', 'Normal'],
      ['screen', 'Screen'],
      ['add', 'Add'],
    ]),
    pSelect('source', 'Source', 'edge', [
      ['edge', 'Edge'],
      ['center', 'Center'],
    ]),
  ],
  apply(ctx, input, output, p) {
    const precise = p.technique === 'precise';
    const distance = p.fill === 'distance';
    const size = Math.max(0.5, num(p, 'size')) * ctx.pxScale;
    pass(
      ctx,
      'innerGlow',
      innerGlowFrag,
      {
        tSrc: input,
        tBlur: precise ? null : blur(ctx, input, size, 'a').texture,
        tSdf: precise || distance ? sdf(ctx, input).texture : null,
        tGrad: distance ? ctx.kit.gradientTexture(grad(p, 'gradient')) : null,
        uColor: col(p, 'color'),
        uInt: num(p, 'intensity'),
        uChoke: num(p, 'choke'),
        uSize: size,
        uOpacity: num(p, 'opacity'),
        uMode: pick(p, 'mode', ['normal', 'screen', 'add']),
        uCenter: p.source === 'center',
        uPrecise: precise,
        uDistance: distance,
      },
      output,
    );
  },
};

// ---------- deep glow (light) ----------

const deepGlow: EffectDef = {
  type: 'deepGlow',
  label: 'Deep Glow (Light)',
  category: 'Glow',
  description:
    'Realistic light glow: the layer becomes a light source whose light scatters like lens bloom and burns toward white where it is over-bright. ' +
    'Exposure (stops) brightens the light and Threshold keeps only its brightest part; the halo falls off as an inverse power law out to Radius ' +
    '(Falloff: long haze ↔ tight, same total light) and Intensity sets how much light scatters. Highlight Shift bleeds over-bright colour into ' +
    'its spectral neighbours (blue → cyan → white, red → orange → yellow → white) while the halo keeps the colour.',
  params: [
    pNum('exposure', 'Exposure (stops)', 1, -4, 6),
    pNum('threshold', 'Threshold', 0, 0, 2),
    pNum('knee', 'Threshold Knee', 0.25, 0, 1),
    pPx('radius', 'Radius', 200, 4, 1000),
    pNum('falloff', 'Falloff', 50, 0, 100, 1, '%'),
    pNum('intensity', 'Intensity', 1, 0, 8),
    pNum('chroma', 'Chromatic Scatter', 0, -100, 100, 1, '%'),
    pSelect('colorMode', 'Glow Color', 'layer', [
      ['layer', 'From layer'],
      ['custom', 'Custom'],
    ]),
    { ...pColor('color', 'Color', '#ffffff'), when: { key: 'colorMode', value: 'custom' } },
    pNum('tintAmount', 'Tint Amount', 0, 0, 1),
    pColor('tintInner', 'Tint Inner', '#ffffff'),
    pColor('tintOuter', 'Tint Outer', '#ff8a2a'),
    pNum('highlightShift', 'Highlight Shift', 60, 0, 100, 1, '%'),
    pNum('coreWhite', 'Core Whiteness', 20, 0, 100, 1, '%'),
    pNum('onFace', 'Glow Over Face', 0, 0, 1),
  ],
  reach: (p) => num(p, 'radius'),
  apply(ctx, input, output, p) {
    const gain = 2 ** num(p, 'exposure');
    const threshold = num(p, 'threshold');
    const knee = num(p, 'knee');
    const glow = ctx.kit.acquire();
    scatterLight(ctx, input, glow, {
      gain,
      threshold,
      knee,
      color: p.colorMode === 'custom' ? col(p, 'color') : null,
      octaves: psfOctaves(Math.max(4, num(p, 'radius')), falloffExponent(num(p, 'falloff')), num(p, 'chroma') / 100, ctx.draft ? 1.5 : 1, ctx.pxScale),
      intensity: num(p, 'intensity'),
      tintInner: col(p, 'tintInner'),
      tintOuter: col(p, 'tintOuter'),
      tintAmount: num(p, 'tintAmount'),
    });
    pass(
      ctx,
      'deepGlow',
      lightGlowComposeFrag,
      {
        tSrc: input,
        tGlow: glow.texture,
        uGain: gain,
        uThresh: threshold,
        uKnee: knee,
        uOnFace: num(p, 'onFace'),
        uShift: num(p, 'highlightShift') / 100,
        uWhite: num(p, 'coreWhite') / 100,
      },
      output,
    );
    ctx.kit.release(glow);
  },
  dispose: disposeLightGlow,
};

// ---------- contour lines (疑似導光板) ----------

const contourFrag = /* glsl */ `
${BOUNDS_GLSL}
uniform sampler2D tSdf, tGrad;
uniform float uSpacing, uWidth, uOffset, uFalloff, uCount; uniform int uMode, uColorBy; uniform vec2 uDir;
void main() {
  float d = texture(tSdf, vUv).r;   // render px, + outside
  // Distance from the silhouette in the direction the lines run: inward, outward or both ways.
  float depth = uMode == 0 ? -d : uMode == 1 ? d : abs(d);
  float k = clamp(floor((depth - uOffset) / uSpacing + 0.5), 0.0, uCount - 1.0);
  float dist = abs(depth - uOffset - k * uSpacing);
  float cov = clamp(0.5 * uWidth - dist + 0.5, 0.0, 1.0);
  float fade = uCount > 1.0 ? 1.0 - uFalloff * k / (uCount - 1.0) : 1.0;
  float t;
  if (uColorBy == 0) {
    // Across the layer box, like the article's lower-left → upper-right gradient + Colorama.
    vec4 b = layerBox();
    vec2 lo = b.xy * uRes, hi = b.zw * uRes;
    vec2 c = 0.5 * (lo + hi), hs = 0.5 * (hi - lo);
    float ext = max(abs(uDir.x) * hs.x + abs(uDir.y) * hs.y, 1.0);
    t = 0.5 + dot(vUv * uRes - c, uDir) / (2.0 * ext);
  } else t = uCount > 1.0 ? k / (uCount - 1.0) : 0.0;
  vec4 g = texture(tGrad, vec2(clamp(t, 0.0, 1.0), 0.5));
  float a = cov * fade * g.a;
  o = vec4(g.rgb * a, a);
}`;

const contourComposeFrag = /* glsl */ `
uniform sampler2D tSrc, tLines, tGlow; uniform float uIntensity, uGlow, uDim;
void main() {
  vec4 L = texture(tSrc, vUv);
  vec4 base = L * vec4(vec3(1.0 - uDim), 1.0);
  // Additive light (alpha-encoded so it survives export on a transparent background).
  vec3 light = max((texture(tLines, vUv).rgb + texture(tGlow, vUv).rgb * uGlow) * uIntensity, 0.0);
  float la = clamp(max(light.r, max(light.g, light.b)), 0.0, 1.0);
  o = vec4(base.rgb + light, base.a + (1.0 - base.a) * la);
}`;

const CONTOUR_MODES = ['inside', 'outside', 'both'];

const contourLines: EffectDef = {
  type: 'contourLines',
  label: 'Contour Lines',
  category: 'Glow',
  description:
    '疑似導光板 (light-guide panel): glowing lines that follow the silhouette at even spacing, inside or around it, ' +
    'coloured by a gradient (rainbow across the layer) and added as light with a glow.',
  params: [
    pSelect('mode', 'Lines', 'inside', [
      ['inside', 'Inside the shape'],
      ['outside', 'Around the shape'],
      ['both', 'Inside and around'],
    ]),
    pNum('count', 'Line count', 6, 1, 40, 1),
    pPx('spacing', 'Spacing', 9, 2, 200, 0.5),
    pPx('width', 'Line width', 2.5, 0.5, 40, 0.5),
    pPx('offset', 'First line inset', 4, 0, 200, 0.5),
    pNum('falloff', 'Falloff', 0.6, 0, 1),
    pGrad('gradient', 'Gradient', GRADIENTS.rainbowSpectrum),
    pSelect('colorBy', 'Colour by', 'across', [
      ['across', 'Across the layer'],
      ['line', 'Line number'],
    ]),
    { ...pDeg('angle', 'Gradient angle', -45), when: { key: 'colorBy', value: 'across' } },
    pNum('intensity', 'Intensity', 1.2, 0, 6),
    pPx('glowSize', 'Glow size', 12, 0, 200),
    pNum('glow', 'Glow amount', 0.8, 0, 4),
    pNum('dim', 'Dim face', 0, 0, 1),
    pFollow(),
  ],
  directions: [{ angle: 'angle', label: 'Gradient direction', convention: 'cwFromRight', when: { key: 'colorBy', value: 'across' } }],
  reach: (p) =>
    (p.mode === 'inside' ? 0 : num(p, 'offset') + (Math.max(1, num(p, 'count')) - 1) * num(p, 'spacing') + num(p, 'width') / 2) +
    num(p, 'glowSize'),
  apply(ctx, input, output, p) {
    const s = ctx.pxScale;
    const traced = followed(ctx, input, p);
    const field = sdf(ctx, traced);
    const box = bounds(ctx, traced);
    const lines = ctx.kit.acquire();
    pass(
      ctx,
      'contourLines',
      contourFrag,
      {
        tSdf: field.texture,
        tBounds: box.texture,
        tGrad: ctx.kit.gradientTexture(grad(p, 'gradient')),
        uSpacing: Math.max(1, num(p, 'spacing') * s),
        uWidth: Math.max(0.5, num(p, 'width') * s),
        uOffset: num(p, 'offset') * s,
        uFalloff: num(p, 'falloff'),
        uCount: Math.max(1, Math.round(num(p, 'count'))),
        uMode: pick(p, 'mode', CONTOUR_MODES),
        uColorBy: pick(p, 'colorBy', ['across', 'line']),
        uDir: dirVec(num(p, 'angle')),
      },
      lines,
    );
    const glowR = num(p, 'glowSize') * s;
    const glow = glowR > 0.5 ? blur(ctx, lines.texture, glowR, 'a').texture : lines.texture;
    pass(
      ctx,
      'contourCompose',
      contourComposeFrag,
      {
        tSrc: input,
        tLines: lines.texture,
        tGlow: glow,
        uIntensity: num(p, 'intensity'),
        uGlow: glowR > 0.5 ? num(p, 'glow') : 0,
        uDim: num(p, 'dim'),
      },
      output,
    );
    ctx.kit.release(lines);
  },
};

export const GLOW_EFFECTS: EffectDef[] = [deepGlow, outerGlow, innerGlow, contourLines];

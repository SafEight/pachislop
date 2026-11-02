import { getEffect } from '../effects/registry';
import type { EffectParams, ParamDef } from '../engine/contracts';
import { getGenerator } from '../generators/registry';
import { GRADIENTS, linearFill, material3D, pattern, solidFill } from '../model/defaults';
import { gradientHasAlpha, hexToRgb, isGradient, sampleGradient, sampleGradientRgba } from '../model/gradient';
import { ownGroupOf } from '../model/companions';
import { sameValue } from '../model/equal';
import { unifyLayerLinks, withoutLink } from '../model/links';
import { isTitleLayer } from '../model/parts';
import { mapMaterials3D } from '../model/bands';
import type {
  EffectInstance,
  Fill,
  GeneratorLayer,
  Gradient,
  GradientSpan,
  Material2D,
  Material3D,
  MaterialPreset,
  ParamValue,
  PartEffects,
  PartKey,
  Pattern,
  Project,
  Title3DLayer,
  Title3DProps,
  TitleStyle2D,
} from '../model/types';
import type { ApplyColourway, Colourway } from './types';

// Colourways: named recolour presets (白 青 緑 紫 赤 金 銀 ゼブラ キリン ヒョウ 虹), applied in one
// click like any other look. Unlike a style preset, a colourway keeps the layer's STRUCTURE — rim
// count, widths, joins, offsets, bevels, textures, gloss, 3D depths/profiles, effects — and only
// changes colours. Each element is classified by role:
//   face        → colourway face paint (3D: the letter's face and bevel, and bands in the face's own
//                 material, unless the colourway has a bevel rim metal: 赤 → gold, 青 / 緑 → silver)
//   base        → 2D rim with an x/y offset (the dropped "seated" base): colourway base colour
//   dark        → any other ring whose current luminance is low (the dark keyline): colourway dark
//   accent      → remaining rings, inner → outer; the OUTERMOST takes the colourway's last accent
//                 (e.g. gold: black keyline + gold line + red outer)
//   side        → 3D side walls of their own (the letter's, a band's): colourway side paint
// 2D rings = rims; 3D rings = bands.
//
// Colour rules (zenn "Matrix" part 2, CGWORLD "Direction Seeds", megabenri 縁取り):
// - blue / green take SILVER accent rims, red takes a GOLD rim;
// - red is pure R255 G0 B0 with contrast from lightness only (no hue drift to pink/orange);
// - gold runs white → yellow → orange → red-brown (never olive), with a second gold gradient on the rim;
// - rims alternate light / dark (keyline dark, line light, frame darker than the line);
// - no black multiply shadows: bevel shadows, drop shadows and the 3D shadow catcher take a
//   tinted dark of the colourway, glows its glow colour, sunburst rays the glow on its dark.
// Gradient geometry (kind / angle / scale / offset / span) stays the element's own, except that
// FACES span each text line ('char' is kept): a two-line title shows the whole colourway ramp
// (金 banding, 虹 spectrum) on both lines, as pachislot titles are set.
// 柄 colourways are a metal face plus pattern marks (ゼブラ: black stripes on pearl silver; キリン /
// ヒョウ: gold). Every other one clears colour patterns; a relief-only pattern (和柄 as a low bump,
// opacity 0) is surface structure like a texture and stays, as do surfaces (liquid / crumple),
// alpha profiles and 3D depth fades. 3D 保留 orbs keep their material model and only change body
// tint (`tintOrb`).

interface Paint {
  fill: () => Fill;
  /** Gradient-map ramp for bevelled (metal) elements; null = no metal mapping (keeps the colour). */
  ramp: Gradient | null;
  m3d: () => Material3D;
  /** Bevel shadow tint (multiply): a deep shade of the paint's own hue, never neutral black. */
  shade: string;
  /** Pattern marks painted over the element (柄 colourway faces only). */
  pattern?: Pattern;
}

interface ColourwayDef {
  /** Short Japanese label (chips, tile names): 白, 赤, ゼブラ … */
  label: string;
  /** English colour name. */
  name: string;
  face: Paint;
  /**
   * 3D only: bands in the face's own material take the colourway's rim metal where the production
   * rules give one (赤 → gold, 青 / 緑 → silver), so they read as a rim against the face. Absent =
   * they follow the face.
   */
  bevel3d?: Paint;
  /** Face inner-glow tint (2D). */
  faceGlow: string;
  dark: Paint;
  /** Inner → outer; the last one is the outermost ring's colour. */
  accents: Paint[];
  base: Paint;
  side3d: () => Material3D;
  /** 保留 orb body tint (see `tintOrb`). */
  orb: OrbPaint;
  glow: string;
  glowGradient: Gradient;
  /** Drop-shadow / shadow-catcher tint. */
  shadow: string;
  /** 3D glint tint. */
  glint: string;
  /** CSS layers drawn over the face gradient in UI swatches (柄 colourways). */
  swatchPattern?: string;
  /** 柄 colourways: the ground a pattern fill's marks sit on (default the gold PATTERN_GROUND). */
  patternGround?: string;
}

/**
 * Body tint of a 保留 orb: `ramp` light centre → body → deep edge, spread radially from the
 * centre (the ball's own depth), or for 虹 a spectrum swept diagonally across the ball (a radial
 * spectrum would read as a target).
 */
interface OrbPaint {
  ramp: Gradient;
  radial: boolean;
}

const g = (...stops: [number, string][]): Gradient => ({ stops: stops.map(([pos, color]) => ({ pos, color })) });
const orbTint = (light: string, body: string, deep: string): OrbPaint => ({ ramp: g([0, light], [0.55, body], [1, deep]), radial: true });

function m3(preset: Exclude<MaterialPreset, 'custom'>, o: Partial<Material3D> | string = {}): Material3D {
  const m = material3D(preset);
  return typeof o === 'string' ? { ...m, preset: 'custom', color: o } : { ...m, ...o };
}

const solidPaint = (color: string, shade: string, m: () => Material3D): Paint => ({ fill: () => solidFill(color), ramp: null, m3d: m, shade });
const metalPaint = (fill: Gradient, ramp: Gradient | null, shade: string, m: () => Material3D): Paint => ({
  fill: () => linearFill(fill),
  ramp,
  m3d: m,
  shade,
});

/**
 * Keylines, dark rings and dropped bases. In 3D they are satin dark metal, not black gloss: a
 * clearcoat mirrors the bright environment and turns the keyline silver, losing the edge.
 */
const darkPaint = (color: string): Paint =>
  solidPaint(color, '#000000', () => ({ ...material3D('custom'), color, metalness: 1, roughness: 0.4, reflectivity: 0.6 }));

// ---------- shared paints ----------

const WHITE = solidPaint('#ffffff', '#5a6478', () => m3('whiteGloss'));
const BLACK = darkPaint('#0a0604');
/** The rim's own gold gradient (banded, bottom → top), distinct from the face gold. */
const GOLD_RIM = metalPaint(GRADIENTS.goldRimFill, GRADIENTS.goldRamp, '#4a2200', () => m3('gold'));
const RED_RIM = metalPaint(GRADIENTS.redFill, GRADIENTS.redRamp, '#3a0000', () => m3('redMetal'));
const SILVER_RIM = metalPaint(
  g([0, '#f4f6fa'], [0.28, '#9aa3b2'], [0.5, '#283040'], [0.72, '#c3cad6'], [1, '#ffffff']),
  GRADIENTS.silverRamp,
  '#1a2234',
  () => m3('chrome'),
);

// ---------- face paints ----------

/** 金: white → yellow → orange → dark brown. */
const GOLD_FACE_FILL = g([0, '#ffffff'], [0.16, '#fff8b8'], [0.38, '#ffd820'], [0.6, '#ff9400'], [0.8, '#b84000'], [1, '#4a1000']);
const GOLD_FACE = metalPaint(GOLD_FACE_FILL, GRADIENTS.goldRamp, '#5a2a00', () => m3('gold'));

/**
 * 赤: hue 0 throughout (#ff0000 with lightness steps only). The gradient map works on Rec.601
 * luminance, where pure red sits at 0.3: the ramp puts #ff0000 exactly there and keeps R at 255
 * above it, so the bevel's lit side brightens toward pink-white and only the shadow side
 * darkens (a ramp that is dark at 0.3 turns the face maroon).
 */
const RED_FACE_FILL = g([0, '#ffc4c4'], [0.18, '#ff4848'], [0.38, '#ff0000'], [0.8, '#f00000'], [1, '#9a0000']);
const RED_RAMP = g([0, '#2a0000'], [0.15, '#a00000'], [0.3, '#ff0000'], [0.6, '#ff4a4a'], [0.85, '#ffa8a8'], [1, '#ffffff']);
/** 3D red bands (top → bottom): R255 except the thin dark horizon just below the middle. */
const RED_3D_BANDS = g([0, '#ff6a6a'], [0.2, '#ff1414'], [0.45, '#ff0000'], [0.52, '#7a0000'], [0.6, '#e00000'], [0.8, '#ff0000'], [1, '#ff5050']);
/**
 * 3D red face as glossy PAINT, not metal: a red metal multiplies the environment into its
 * reflections and reads maroon / copper; a red diffuse base under a clear coat stays R255 and
 * gets its lightness contrast from the white coat highlights. Low reflectivity keeps the lit
 * face below the tone mapper's shoulder, where it would desaturate toward pink.
 */
const red3DFace = () =>
  m3('redMetal', { color: '#ff0000', gradient: RED_3D_BANDS, metalness: 0.3, roughness: 0.22, reflectivity: 0.2, clearcoat: 0.5 });

/**
 * 虹: the saturated spectrum with a deep metal horizon and no white stop (GRADIENTS.rainbowFill);
 * in 3D the rainbow candy metal, whose banding is the same hues with a hot top (no gloss cap there).
 */
const RAINBOW_FACE_FILL: Gradient = GRADIENTS.rainbowFill;

/** A colourway pattern on the gold face: the same marks in 2D and 3D (3D relief a little stronger). */
function goldPatternFace(p: Pattern): Paint {
  return { ...GOLD_FACE, pattern: p, m3d: () => m3('gold', { pattern: { ...p, relief: Math.min(1, p.relief * 1.6) } }) };
}

/**
 * ゼブラ body: pale pearl silver (white top, a soft grey horizon, cool light below), silver-ramp
 * mapped in 2D so the bevel shines like metal; in 3D satin pearl metal under a clear coat, its
 * banding kept light so the black stripes always read against it.
 */
const PEARL_FILL = g([0, '#ffffff'], [0.4, '#eef1f6'], [0.5, '#a9b0bd'], [0.56, '#e2e6ed'], [0.8, '#f7f9fc'], [1, '#c9cfd9']);
const PEARL_3D_BANDS = g([0, '#ffffff'], [0.22, '#f2f4f8'], [0.45, '#c9ced8'], [0.52, '#8e96a4'], [0.6, '#d2d7df'], [0.8, '#f4f6fa'], [1, '#ffffff']);
const pearl3D = () => m3('silver', { color: '#eef1f6', gradient: PEARL_3D_BANDS, metalness: 0.75, roughness: 0.18, clearcoat: 1, reflectivity: 0.85 });

/** A colourway pattern on the pearl face, as `goldPatternFace`. */
function pearlPatternFace(p: Pattern): Paint {
  const face = metalPaint(PEARL_FILL, GRADIENTS.silverRamp, '#2a3040', pearl3D);
  return { ...face, pattern: p, m3d: () => ({ ...pearl3D(), pattern: { ...p, relief: Math.min(1, p.relief * 1.6) } }) };
}

const ZEBRA = pattern({ kind: 'zebra', color: '#060608', scale: 12, angle: -8, seed: 3, shade: 0.55, relief: 0.25 });
const GIRAFFE = pattern({ kind: 'giraffe', color: '#6a300a', scale: 11, seed: 5, shade: 0.5, relief: 0.25 });
const LEOPARD = pattern({ kind: 'leopard', color: '#140800', color2: '#b0580e', scale: 8, seed: 2, shade: 0.5, relief: 0.2 });

const COLOURWAY_DEFS: Record<Colourway, ColourwayDef> = {
  white: {
    label: '白',
    name: 'White',
    face: metalPaint(g([0, '#ffffff'], [0.55, '#eef1f7'], [1, '#b6becc']), null, '#5a6478', () => m3('whiteGloss')),
    faceGlow: '#ffffff',
    dark: darkPaint('#14171f'),
    accents: [WHITE, solidPaint('#58607a', '#1a2030', () => m3('silver', '#58607a'))],
    base: darkPaint('#05070c'),
    side3d: () => m3('silver'),
    orb: orbTint('#ffffff', '#e6eaf2', '#7a8496'),
    glow: '#ffffff',
    glowGradient: g([0, '#ffffff'], [0.4, '#dfe6ff'], [1, '#6a7aa0']),
    shadow: '#1a2040',
    glint: '#ffffff',
  },
  blue: {
    label: '青',
    name: 'Blue',
    bevel3d: SILVER_RIM,
    face: metalPaint(GRADIENTS.blueFill, GRADIENTS.blueRamp, '#001a5c', () => m3('blueMetal')),
    faceGlow: '#d6f0ff',
    dark: darkPaint('#001a5c'),
    accents: [WHITE, SILVER_RIM],
    base: darkPaint('#000a26'),
    side3d: () => m3('blueMetal', '#0a2a8a'),
    orb: orbTint('#8cc8ff', '#1a6aff', '#001a6a'),
    glow: '#3aa8ff',
    glowGradient: g([0, '#ffffff'], [0.3, '#7fd0ff'], [1, '#0030c0']),
    shadow: '#001040',
    glint: '#dff0ff',
  },
  green: {
    label: '緑',
    name: 'Green',
    bevel3d: SILVER_RIM,
    face: metalPaint(GRADIENTS.greenFill, GRADIENTS.greenRamp, '#003a10', () => m3('greenMetal')),
    faceGlow: '#e0ffd6',
    dark: darkPaint('#002a0c'),
    accents: [WHITE, SILVER_RIM],
    base: darkPaint('#001a06'),
    side3d: () => m3('greenMetal', '#0a6a1e'),
    orb: orbTint('#a0ffb4', '#18d040', '#004a14'),
    glow: '#3dff6a',
    glowGradient: g([0, '#ffffff'], [0.3, '#8aff9c'], [1, '#008a20']),
    shadow: '#002a10',
    glint: '#e6ffe6',
  },
  purple: {
    label: '紫',
    name: 'Purple',
    face: metalPaint(g([0, '#ffe0ff'], [0.45, '#b02cff'], [1, '#3a006a']), GRADIENTS.purpleRamp, '#2a0050', () => m3('purpleMetal')),
    faceGlow: '#f6d6ff',
    dark: darkPaint('#12001f'),
    accents: [WHITE, GOLD_RIM],
    base: darkPaint('#08000f'),
    side3d: () => m3('purpleMetal', '#4a0a80'),
    orb: orbTint('#e6a8ff', '#a020ff', '#30006a'),
    glow: '#c04aff',
    glowGradient: g([0, '#ffffff'], [0.3, '#e08aff'], [1, '#5a00b0']),
    shadow: '#20003a',
    glint: '#f4e0ff',
  },
  red: {
    label: '赤',
    name: 'Red',
    bevel3d: GOLD_RIM,
    face: metalPaint(RED_FACE_FILL, RED_RAMP, '#4d0000', red3DFace),
    faceGlow: '#ffd6d6',
    dark: darkPaint('#140000'),
    accents: [WHITE, GOLD_RIM],
    base: darkPaint('#1a0000'),
    side3d: () => m3('redMetal', '#800000'),
    orb: orbTint('#ff7070', '#ff0000', '#6a0000'),
    glow: '#ff2a00',
    glowGradient: g([0, '#ffffff'], [0.3, '#ffb040'], [1, '#d00000']),
    shadow: '#3a0000',
    glint: '#ffe8e0',
  },
  gold: {
    label: '金',
    name: 'Gold',
    face: GOLD_FACE,
    faceGlow: '#fff3b0',
    dark: BLACK,
    accents: [GOLD_RIM, RED_RIM],
    base: darkPaint('#120600'),
    side3d: () => m3('copper'),
    orb: orbTint('#fff4a0', '#ffb000', '#a83800'),
    glow: '#ffb000',
    glowGradient: g([0, '#ffffff'], [0.3, '#ffd040'], [1, '#ff5a00']),
    shadow: '#3a1800',
    glint: '#fff4dc',
  },
  silver: {
    label: '銀',
    name: 'Silver',
    face: metalPaint(GRADIENTS.silverFill, GRADIENTS.silverRamp, '#1a2234', () => m3('chrome')),
    faceGlow: '#f0f6ff',
    dark: darkPaint('#0a0c12'),
    accents: [WHITE, metalPaint(g([0, '#a8c4ff'], [0.5, '#2c4a9a'], [1, '#0c1840']), GRADIENTS.silverRamp, '#0c1840', () => m3('blueMetal', '#2c4a9a'))],
    base: darkPaint('#04060c'),
    side3d: () => m3('silver'),
    orb: orbTint('#ffffff', '#c3cad6', '#3a4252'),
    glow: '#cfe4ff',
    glowGradient: g([0, '#ffffff'], [0.35, '#bcd8ff'], [1, '#3a5aa0']),
    shadow: '#101830',
    glint: '#f0f6ff',
  },
  zebra: {
    label: 'ゼブラ',
    name: 'Zebra',
    face: pearlPatternFace(ZEBRA),
    faceGlow: '#ffffff',
    dark: BLACK,
    accents: [WHITE, GOLD_RIM],
    base: darkPaint('#050608'),
    side3d: () => m3('silver', '#5a6270'),
    orb: orbTint('#ffffff', '#e6eaf2', '#7a8496'),
    glow: '#e8eeff',
    glowGradient: g([0, '#ffffff'], [0.35, '#dfe6ff'], [1, '#6a7aa0']),
    shadow: '#0c0e14',
    glint: '#ffffff',
    patternGround: '#f2f2f0',
    swatchPattern: 'repeating-linear-gradient(104deg, #060608 0 2px, transparent 2px 4px, #060608 4px 5px, transparent 5px 8px)',
  },
  giraffe: {
    label: 'キリン',
    name: 'Giraffe',
    face: goldPatternFace(GIRAFFE),
    faceGlow: '#fff0c8',
    dark: darkPaint('#2a1000'),
    accents: [
      solidPaint('#fff2d0', '#7a4a10', () => m3('whiteGloss', '#fff2d0')),
      metalPaint(g([0, '#ffe0a8'], [0.4, '#e88a20'], [0.6, '#8a3a00'], [1, '#ffc070']), GRADIENTS.copperRamp, '#4a1a00', () => m3('copper')),
    ],
    base: darkPaint('#140800'),
    side3d: () => m3('copper'),
    orb: orbTint('#fff4a0', '#ffb000', '#a83800'),
    glow: '#ff9a20',
    glowGradient: g([0, '#ffffff'], [0.3, '#ffc860'], [1, '#c05000']),
    shadow: '#2a1000',
    glint: '#fff0d8',
    swatchPattern:
      'radial-gradient(closest-side, #5a2606 78%, transparent 88%) 0 0 / 7px 6px, radial-gradient(closest-side, #5a2606 70%, transparent 82%) 3px 3px / 7px 6px',
  },
  leopard: {
    label: 'ヒョウ',
    name: 'Leopard',
    face: goldPatternFace(LEOPARD),
    faceGlow: '#fff3b0',
    dark: BLACK,
    accents: [WHITE, RED_RIM],
    base: darkPaint('#0a0200'),
    side3d: () => m3('copper'),
    orb: orbTint('#fff4a0', '#ffb000', '#a83800'),
    glow: '#ff8a20',
    glowGradient: g([0, '#ffffff'], [0.3, '#ffb848'], [1, '#d03000']),
    shadow: '#2a0800',
    glint: '#fff0dc',
    swatchPattern:
      'radial-gradient(circle, #b0580e 0 22%, #140800 26% 42%, transparent 46%) 0 0 / 7px 7px, radial-gradient(circle, #140800 0 30%, transparent 36%) 3px 4px / 7px 7px',
  },
  rainbow: {
    label: '虹',
    name: 'Rainbow',
    face: metalPaint(RAINBOW_FACE_FILL, null, '#3a0060', () => m3('rainbow')),
    // deep violet: the inner glow darkens the edges toward the bevel like candy depth (white washes the hues pastel)
    faceGlow: '#3a0080',
    dark: darkPaint('#1a0030'),
    accents: [WHITE, GOLD_RIM],
    base: darkPaint('#0a0014'),
    side3d: () => m3('gold'),
    orb: { ramp: GRADIENTS.rainbowSpectrum, radial: false },
    glow: '#fff4c8',
    glowGradient: GRADIENTS.rainbowSpectrum,
    shadow: '#2a0040',
    glint: '#fffaf0',
  },
};

// ---------- UI metadata ----------

export interface ColourwayInfo {
  /** Short Japanese label: 白, 赤, ゼブラ … */
  label: string;
  /** Library tile name: the label and the English colour name, e.g. '赤 Red'. */
  name: string;
  /** Face colours (top → bottom), then the keyline colour, then the outermost rim colour. */
  swatch: string[];
  /** CSS `background` of the colourway face: its gradient, with the pattern marks on top for 柄 colourways. */
  faceCss: string;
}

const paintColor = (p: Paint) => {
  const f = p.fill();
  return f.kind === 'solid' ? f.color : f.gradient.stops[Math.floor(f.gradient.stops.length / 2)].color;
};

export const COLOURWAY_INFO: Record<Colourway, ColourwayInfo> = Object.fromEntries(
  (Object.keys(COLOURWAY_DEFS) as Colourway[]).map((t) => {
    const d = COLOURWAY_DEFS[t];
    const faceFill = d.face.fill();
    const face = faceFill.kind === 'solid' ? [faceFill.color] : faceFill.gradient.stops.map((s) => s.color);
    const gradient = face.length > 1 ? `linear-gradient(180deg, ${face.join(', ')})` : face[0];
    const info: ColourwayInfo = {
      label: d.label,
      name: `${d.label} ${d.name}`,
      swatch: [...face, paintColor(d.dark), paintColor(d.accents[d.accents.length - 1])],
      faceCss: d.swatchPattern ? `${d.swatchPattern}, ${gradient}` : gradient,
    };
    return [t, info];
  }),
) as Record<Colourway, ColourwayInfo>;

// ---------- classification ----------

const DARK_LUMA = 0.18;

const lumaRgb = ([r, gg, b]: [number, number, number]) => 0.299 * r + 0.587 * gg + 0.114 * b;
const lumaHex = (hex: string) => lumaRgb(hexToRgb(hex));
function lumaGradient(gr: Gradient): number {
  let sum = 0;
  for (let i = 0; i <= 8; i++) sum += lumaRgb(sampleGradient(gr, i / 8));
  return sum / 9;
}

const luma3D = (m: Material3D) => (m.gradient ? lumaGradient(m.gradient) : lumaHex(m.color));

/** 'face' = an extension of the face (a 3D band in the face's own material). */
type Role = 'face' | 'dark' | 'accent';

/** Paint for each ring (inner → outer) given its role; accents align so the outermost gets the colourway's last accent. */
function ringPaints(roles: Role[], def: ColourwayDef): Paint[] {
  const n = roles.filter((r) => r === 'accent').length;
  const A = def.accents.length;
  let j = 0;
  return roles.map((role) => {
    if (role === 'face') return def.face;
    if (role === 'dark') return def.dark;
    const k = Math.max(0, A - n + j++);
    return def.accents[k];
  });
}

/** The element's pattern after recolouring: the paint's marks, else only relief-only structure survives. */
function nextPattern(current: Pattern, marks: Pattern | undefined): Pattern {
  if (marks) return { ...marks };
  return current.kind !== 'none' && current.opacity === 0 && current.relief > 0 ? current : pattern();
}

/** Faces span each text line unless they were set per character (see the header). */
const faceSpan = (span: GradientSpan): GradientSpan => (span === 'char' ? 'char' : 'line');

// ---------- 2D ----------

function luma2D(m: Material2D): number {
  const base = m.fill.kind === 'solid' ? lumaHex(m.fill.color) : lumaGradient(m.fill.gradient);
  if (!m.finish.enabled) return base;
  return base + (lumaGradient(m.finish.gradient) - base) * m.finish.amount;
}

const toHex = (rgb: [number, number, number]) => `#${rgb.map((c) => Math.round(c * 255).toString(16).padStart(2, '0')).join('')}`;

/**
 * `next` carrying the alpha profile of `prev`: transparency is structure, like widths (a disc that
 * fades out at its edge stays faded in every colourway).
 */
function keepAlpha(prev: Gradient, next: Gradient): Gradient {
  const at = [...new Set([...next.stops.map((s) => s.pos), ...prev.stops.map((s) => s.pos)])].sort((a, b) => a - b);
  return { ...next, stops: at.map((pos) => ({ pos, color: toHex(sampleGradient(next, pos)), alpha: sampleGradientRgba(prev, pos)[3] })) };
}

/** `glow` = the face's inner-glow tint; given for the face only. */
function paint2D(m: Material2D, p: Paint, face?: { glow: string }): Material2D {
  const next = p.fill();
  // Keep the element's gradient geometry (angle / scale / offset, radial vs linear) and span.
  const geometry = next.kind !== 'solid' && m.fill.kind !== 'solid' ? { kind: m.fill.kind, angle: m.fill.angle, scale: m.fill.scale, offset: m.fill.offset } : {};
  let fill: Fill = { ...next, ...geometry, span: face ? faceSpan(m.fill.span) : m.fill.span };
  // A gradient with transparent stops keeps its geometry and fade even when the paint is solid.
  if (m.fill.kind !== 'solid' && gradientHasAlpha(m.fill.gradient)) {
    const ramp = next.kind === 'solid' ? { stops: [{ pos: 0, color: next.color }, { pos: 1, color: next.color }] } : next.gradient;
    fill = { ...m.fill, color: next.color, gradient: keepAlpha(m.fill.gradient, ramp), span: fill.span };
  }
  const metal = p.ramp !== null && (m.finish.enabled || m.bevel.enabled);
  const finish = p.ramp
    ? { enabled: metal, gradient: p.ramp, amount: m.finish.enabled ? m.finish.amount : 0.7 }
    : { ...m.finish, enabled: false };
  return {
    ...m,
    fill,
    finish,
    bevel: { ...m.bevel, shadowColor: p.shade },
    pattern: nextPattern(m.pattern, p.pattern),
    innerGlow: face ? { ...m.innerGlow, color: face.glow } : m.innerGlow,
  };
}

function recolor2D(style: TitleStyle2D, def: ColourwayDef): TitleStyle2D {
  const ringRims = style.rims.filter((r) => r.offsetX === 0 && r.offsetY === 0);
  const paints = ringPaints(
    ringRims.map((r) => (luma2D(r.material) < DARK_LUMA ? 'dark' : 'accent')),
    def,
  );
  const byId = new Map(ringRims.map((r, i) => [r.id, paints[i]]));
  return {
    ...style,
    face: paint2D(style.face, def.face, { glow: def.faceGlow }),
    rims: style.rims.map((r) => ({ ...r, material: paint2D(r.material, byId.get(r.id) ?? def.base) })),
  };
}

// ---------- 3D ----------

/**
 * Swap a material for the paint's preset material, keeping the element's gradient geometry
 * (kind / angle / scale / offset / span / axis; faces span lines), opacity, surface and
 * relief-only structure. A ramp that runs front → back (gradientAxis 'depth') becomes the new
 * colour fading to black with depth, so recoloured walls keep their fade.
 */
function paint3D(m: Material3D, p: Paint | (() => Material3D), face = false): Material3D {
  const next = typeof p === 'function' ? p() : p.m3d();
  // The paint's 3D material carries the colourway marks (柄 faces); otherwise keep relief-only structure.
  const marks = next.pattern.kind !== 'none' ? next.pattern : undefined;
  const depth = m.gradientAxis === 'depth' ? { gradient: g([0, next.color], [0.35, next.color], [1, '#000000']) } : {};
  return {
    ...next,
    ...depth,
    pattern: nextPattern(m.pattern, marks),
    surface: m.surface,
    gradientKind: m.gradientKind,
    gradientAngle: m.gradientAngle,
    gradientScale: m.gradientScale,
    gradientOffset: m.gradientOffset,
    gradientSpan: face ? faceSpan(m.gradientSpan) : m.gradientSpan,
    gradientAxis: m.gradientAxis,
    opacity: m.opacity,
    ...(m.link ? { link: m.link } : {}),
  };
}

/**
 * The colourway on a 3D style, by role (mapMaterials3D): the letter's face and bevel take the face
 * paint, the bands ring paints (inner → outer), every side wall of its own the side paint; a
 * band's inherited side wall keeps following its band. The letter's inherited side is painted
 * only when the side paint differs from its face's: it then holds that paint itself (unlinked),
 * else it keeps following the face.
 */
function recolor3D(s: Title3DProps, def: ColourwayDef): Title3DProps {
  const sameAsFace = (m: Material3D) =>
    m.preset === s.face.preset && m.color === s.face.color && JSON.stringify(m.gradient) === JSON.stringify(s.face.gradient);
  const ringRole = (m: Material3D): Role => (luma3D(m) < DARK_LUMA ? 'dark' : 'accent');
  const roles = s.bands.map((b): Role => (sameAsFace(b.material) ? 'face' : ringRole(b.material)));
  const paints = ringPaints(roles, def);
  const painted = mapMaterials3D(s, (m, role) => {
    if (role.part === 'face') return paint3D(m, def.face, true);
    if (role.part === 'side' || role.side) return paint3D(m, def.side3d);
    const face = roles[role.index] === 'face';
    return paint3D(m, face && def.bevel3d ? def.bevel3d : paints[role.index], face && !def.bevel3d);
  });
  const styled: Title3DProps = { ...painted, shadow: { ...s.shadow, color: def.shadow }, glint: { ...s.glint, tint: def.glint } };
  if (s.side) return styled;
  const side = paint3D(s.face, def.side3d);
  return sameValue(side, styled.face) ? styled : { ...styled, side: withoutLink(side) };
}

// ---------- 保留 orbs ----------

/**
 * An orb material in a colourway's body tint: base colour, tint ramp and (柄 colourways) pattern marks
 * change; the material model — metal / candy / glass, roughness, coat, flakes — stays. The
 * shared source of the factory orb looks and of colourway recolouring on orb layers, so a 青 / 緑 /
 * 赤 / 金 / 虹 set made either way reads as one family.
 */
export function tintOrb(m: Material3D, colourway: Colourway): Material3D {
  const { ramp, radial } = COLOURWAY_DEFS[colourway].orb;
  const marks = COLOURWAY_DEFS[colourway].face.m3d().pattern;
  return {
    ...m,
    color: toHex(sampleGradient(ramp, 0.55)),
    gradient: structuredClone(ramp),
    gradientKind: radial ? 'radial' : 'linear',
    gradientAngle: radial ? 90 : 60,
    gradientSpan: 'layer',
    gradientScale: 1,
    gradientOffset: 0,
    gradientAxis: 'xy',
    pattern: nextPattern(m.pattern, marks.kind !== 'none' ? marks : undefined),
  };
}

const isOrb = (s: Title3DLayer['source']) => s.kind === 'shape' && s.shape === 'orb';

/** Orbs recolour their body (face, and the side that only applies off-sphere) and keep their bands (the bezel). */
function recolorOrb(s: Title3DProps, colourway: Colourway): Title3DProps {
  const def = COLOURWAY_DEFS[colourway];
  return {
    ...s,
    face: tintOrb(s.face, colourway),
    ...(s.side ? { side: tintOrb(s.side, colourway) } : {}),
    shadow: { ...s.shadow, color: def.shadow },
    glint: { ...s.glint, tint: def.glint },
  };
}

// ---------- generator layers and light effects ----------
//
// Generators (particles, lines, rings, patterns) and the light effects carry plain colour and
// gradient params instead of a style. Each colour is gradient-mapped by its luma onto the
// colourway's light ramp (`LIGHT`): brightness, and with it the additive energy, stays while hue
// and saturation take the colourway's (白 cool greys, 青 / 緑 / 紫, 赤 heating to orange, 金 white →
// yellow → orange → brown). Near-white colours stay (白芯: light keeps its hot core) unless they
// are the layer's only visible colour (white focus lines take the colourway glow). 虹 puts the
// spectrum on every gradient (a white core stop stays) and turns solid particle / line fills into
// gradient fills so it shows; 柄 colourways map like their face metal (ゼブラ silver, キリン / ヒョウ
// gold) and turn a pattern fill into their pattern.
// Recolouring is idempotent: a colour already on the ramp stays.

/** Light ramps, luma ascending; black and white close the ends. 白 → 金 rise in saturation and heat. */
const LIGHT: Record<Colourway, string[]> = {
  white: ['#1e2430', '#5c6678', '#a9b3c4', '#dfe5ef'],
  blue: ['#000c40', '#0030b0', '#1a6aff', '#3aa8ff', '#9ad4ff', '#dff0ff'],
  green: ['#002a0c', '#007a20', '#18d040', '#3dff6a', '#a0ffb4', '#e6ffe6'],
  purple: ['#14002a', '#4a0090', '#a020ff', '#c04aff', '#e6a8ff', '#f4e0ff'],
  red: ['#1a0000', '#6a0000', '#ff0000', '#ff2a00', '#ff7a1a', '#ffb040', '#ffe0b0'],
  gold: ['#2a1000', '#8a3000', '#c85a00', '#ff9400', '#ffb000', '#ffd820', '#fff8b8'],
  silver: ['#101622', '#3a4660', '#7a8aa8', '#b8c8e0', '#cfe4ff', '#f0f6ff'],
  zebra: ['#0c0e12', '#3a3e48', '#7a8090', '#b8bfcc', '#e2e6ed', '#f4f6fa'],
  giraffe: ['#2a1000', '#7a3000', '#e06a10', '#ff9a20', '#ffc860', '#fff0d8'],
  leopard: ['#2a0800', '#801800', '#e04010', '#ff8a20', '#ffb848', '#fff0dc'],
  // 虹 for solid colours: hue by brightness (deep violet → magenta → orange → yellow → ice).
  rainbow: ['#14002a', '#6a1aff', '#ff2ad0', '#ff7a1a', '#ffe040', '#b0fff4'],
};

/** Every channel at least this (0..1): a white core, kept in every colourway. */
const WHITE_CORE = 0.92;
/** A colour within this of its ramp colour (every channel, 0..1) already is the colourway's (8-bit rounding slack). */
const ON_RAMP = 4 / 255;
/** 虹 on a gradient with a white core stop: the share the core keeps before the spectrum starts. */
const CORE_SPAN = 0.15;
/** 柄 colourways: the ground a pattern fill's marks sit on, unless the colourway has its own (`patternGround`). */
const PATTERN_GROUND = '#ffc81e';

type Rgb = [number, number, number];

/** A luma-positioned ramp: interpolating in sRGB keeps luma linear, so a mapped colour keeps its luma. */
interface Ramp {
  at: number[];
  rgb: Rgb[];
}

const RAMPS = Object.fromEntries(
  (Object.keys(LIGHT) as Colourway[]).map((t) => {
    const rgb: Rgb[] = [[0, 0, 0], ...LIGHT[t].map(hexToRgb), [1, 1, 1]];
    return [t, { at: rgb.map(lumaRgb), rgb }];
  }),
) as Record<Colourway, Ramp>;

function rampAt(r: Ramp, x: number): Rgb {
  let i = 1;
  while (i < r.at.length - 1 && r.at[i] < x) i++;
  const a = r.at[i - 1];
  const t = Math.min(1, Math.max(0, (x - a) / (r.at[i] - a)));
  const lo = r.rgb[i - 1];
  const hi = r.rgb[i];
  return [lo[0] + (hi[0] - lo[0]) * t, lo[1] + (hi[1] - lo[1]) * t, lo[2] + (hi[2] - lo[2]) * t];
}

const isWhiteCore = (hex: string) => Math.min(...hexToRgb(hex)) >= WHITE_CORE;

/** `hex` gradient-mapped onto `r` by its luma; white cores and colours already on the ramp stay as they are. */
function onRamp(hex: string, r: Ramp): string {
  if (isWhiteCore(hex)) return hex;
  const rgb = hexToRgb(hex);
  const next = rampAt(r, lumaRgb(rgb));
  return next.every((c, k) => Math.abs(c - rgb[k]) <= ON_RAMP) ? hex : toHex(next);
}

/** 虹: the spectrum across the gradient, after its white core stop when it starts with one; the alpha profile stays. */
function spectrum(gr: Gradient): Gradient {
  const first = gr.stops.reduce((a, s) => (s.pos < a.pos ? s : a), gr.stops[0]);
  const core = gr.stops.length > 1 && isWhiteCore(first.color) ? CORE_SPAN : 0;
  const stops = GRADIENTS.rainbowSpectrum.stops.map((s) => ({ pos: core + s.pos * (1 - core), color: s.color }));
  const next = { ...gr, stops: core ? [{ pos: 0, color: '#ffffff' }, ...stops] : stops };
  return gradientHasAlpha(gr) ? keepAlpha(gr, next) : next;
}

/** Whether `pd`'s control shows for `p` (ParamDef.when; missing values take their defaults). */
function shown(defs: readonly ParamDef[], p: EffectParams, pd: ParamDef): boolean {
  if (!pd.when) return true;
  const { key, value } = pd.when;
  const v = p[key] ?? defs.find((d) => d.key === key)?.default;
  return Array.isArray(value) ? value.includes(v as string) : v === value;
}

/** Solid fills that 虹 turns into a gradient fill so the spectrum shows (generator / effect type → select param). */
const SPECTRUM_FILL: Record<string, { key: string; from: string; to: string }> = {
  particles: { key: 'colorMode', from: 'solid', to: 'palette' },
  speedLines: { key: 'colorMode', from: 'solid', to: 'around' },
};

/** Every colour and gradient param of a generator or light effect of `type` (params `params`, defs `defs`) in `colourway`. */
function recolorLight(type: string, defs: readonly ParamDef[], params: EffectParams, colourway: Colourway): EffectParams {
  const marks = COLOURWAY_DEFS[colourway].face.pattern;
  if (type === 'patternFill' && marks)
    return { ...params, kind: marks.kind, color: marks.color, color2: marks.color2, background: COLOURWAY_DEFS[colourway].patternGround ?? PATTERN_GROUND };
  const r = RAMPS[colourway];
  const rainbow = colourway === 'rainbow';
  const p: EffectParams = { ...params };
  const fill = SPECTRUM_FILL[type];
  if (rainbow && fill && (p[fill.key] ?? defs.find((d) => d.key === fill.key)?.default) === fill.from) p[fill.key] = fill.to;
  // Whether a visible colour carries the colourway; all-white light takes the colourway glow instead.
  let lit = false;
  const white: string[] = [];
  for (const pd of defs) {
    const v = p[pd.key] ?? pd.default;
    if (pd.kind === 'color' && typeof v === 'string') {
      p[pd.key] = onRamp(v, r);
      if (!shown(defs, p, pd)) continue;
      if (isWhiteCore(v)) white.push(pd.key);
      else lit = true;
    } else if (pd.kind === 'gradient' && isGradient(v)) {
      p[pd.key] = rainbow ? spectrum(v) : { ...v, stops: v.stops.map((s) => ({ ...s, color: onRamp(s.color, r) })) };
      if (shown(defs, p, pd) && (rainbow || v.stops.some((s) => !isWhiteCore(s.color)))) lit = true;
    }
  }
  if (!lit && !rainbow) for (const key of white) p[key] = onRamp(COLOURWAY_DEFS[colourway].glow, r);
  return p;
}

/**
 * Generators that keep their colours in every colourway, as the effects they were did: fire, smoke and ink
 * keep their natural colours, the lens flare its tint, glints their star colour.
 */
const OWN_COLOURS: Record<string, true> = { fire: true, smoke: true, inkSplatter: true, lensFlare: true, glints: true };

/**
 * God rays whose colours follow the colourway (param → ColourwayDef key): backlight, and Sunburst's
 * wedges / focus lines / speed rings (its Sunburst style is gradient-mapped like other light).
 */
function rayColors(type: string, params: Record<string, ParamValue>): Record<string, 'glow' | 'shadow'> | null {
  if (type === 'backlight') return { outerColor: 'glow' };
  if (type === 'sunburst' && params.style !== undefined && params.style !== 'sunburst') return { colorA: 'glow', colorB: 'shadow' };
  return null;
}

/** `params` with the ray colours `rays` set to the colourway's glow / dark. */
function recolorRays(params: Record<string, ParamValue>, rays: Record<string, 'glow' | 'shadow'>, colourway: Colourway): Record<string, ParamValue> {
  const out = { ...params };
  for (const [key, role] of Object.entries(rays)) out[key] = COLOURWAY_DEFS[colourway][role];
  return out;
}

function recolorGenerator(layer: GeneratorLayer, colourway: Colourway): GeneratorLayer {
  const gd = getGenerator(layer.generator.type);
  const effects = recolorEffects(layer.effects, colourway);
  if (!gd || OWN_COLOURS[gd.type]) return { ...layer, effects };
  const rays = rayColors(gd.type, layer.generator.params);
  const params = rays ? recolorRays(layer.generator.params, rays, colourway) : recolorLight(gd.type, gd.params, layer.generator.params, colourway);
  return { ...layer, generator: { ...layer.generator, params }, effects };
}

// ---------- effects ----------

/** Light effects recoloured like generators (`recolorLight`): shards, 残像. */
const LIGHT_EFFECTS: Record<string, true> = { shatter: true, motionTrail: true };

/**
 * Glows take the colourway glow colour / gradient; shadows the colourway's tinted dark (never black);
 * light effects their colourway ramp.
 */
function recolorEffects(effects: EffectInstance[], colourway: Colourway): EffectInstance[] {
  const def = COLOURWAY_DEFS[colourway];
  return effects.map((fx) => {
    const ed = getEffect(fx.type);
    if (ed && LIGHT_EFFECTS[fx.type]) return { ...fx, params: recolorLight(fx.type, ed.params, fx.params, colourway) };
    const glow = ed?.category === 'Glow';
    if (!ed || (!glow && ed.category !== 'Shadow')) return fx;
    const params = { ...fx.params };
    for (const pd of ed.params) {
      if (pd.kind === 'color') params[pd.key] = glow ? def.glow : def.shadow;
      else if (pd.kind === 'gradient' && glow) params[pd.key] = structuredClone(def.glowGradient);
    }
    return { ...fx, params };
  });
}

/** Every part's effects recoloured like the layer effects (a glow on Rim 3 takes the colourway glow too). */
function recolorPartEffects(parts: PartEffects, colourway: Colourway): PartEffects {
  const out: PartEffects = {};
  for (const [key, effects] of Object.entries(parts) as [PartKey, EffectInstance[] | undefined][]) if (effects) out[key] = recolorEffects(effects, colourway);
  return out;
}

/**
 * Title and generator layers; groups (the caller recolours their members), adjustment layers and
 * backgrounds come back unchanged. Linked materials of the title come out equal (unifyLayerLinks):
 * a link's materials take the result of its first one, as the store's commit does.
 */
export const applyColourway: ApplyColourway = (layer, colourway) => {
  const def = COLOURWAY_DEFS[colourway];
  if (layer.kind === 'generator') return recolorGenerator(layer, colourway);
  if (!isTitleLayer(layer)) return layer;
  const effects = recolorEffects(layer.effects, colourway);
  const partEffects = recolorPartEffects(layer.partEffects, colourway);
  if (layer.kind === 'title2d') return unifyLayerLinks({ ...layer, style: recolor2D(layer.style, def), effects, partEffects });
  return unifyLayerLinks({ ...layer, style3d: isOrb(layer.source) ? recolorOrb(layer.style3d, colourway) : recolor3D(layer.style3d, def), effects, partEffects });
};

/**
 * `project` with layer `id` recoloured to `colourway` (applyColourway), and the rest of its look:
 * its companions (the glints, rays…) and the effects of the group it sits in with them.
 */
export function applyColourwayToProject(project: Project, id: string, colourway: Colourway): Project {
  const own = ownGroupOf(project.layers, id);
  return {
    ...project,
    layers: project.layers.map((l) => {
      if (l === own) return { ...own, effects: recolorEffects(own.effects, colourway) };
      return l.id === id || (l.kind === 'generator' && l.companionOf === id) ? applyColourway(l, colourway) : l;
    }),
  };
}

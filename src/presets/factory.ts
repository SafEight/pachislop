import { glintOverlay, levels, rainbowOverlay } from '../effects/a/recipes';
import { getEffect } from '../effects/registry';
import type { Companion } from '../generators/fromEffect';
import { generatorFromPreset, getGenerator, presetEffects } from '../generators/registry';
import {
  ao3D,
  band3D,
  bevel2D,
  bevel3D,
  CHROME_RAMP,
  curve,
  createTitle2DLayer,
  createTitle3DLayer,
  erode2D,
  glint3D,
  GRADIENTS,
  linearFill,
  material2D,
  material3D,
  pattern,
  plateShape,
  rim2D,
  satin2D,
  reflection2D,
  shadow3D,
  solidFill,
  uid,
} from '../model/defaults';
import type {
  Band3D,
  Bevel2D,
  BevelProfile3D,
  BevelShape3D,
  EffectInstance,
  EnvPreset,
  Fill,
  Finish2D,
  Gloss2D,
  Glint3D,
  Gradient,
  InnerGlow2D,
  Lighting3D,
  Material2D,
  Material3D,
  MaterialPreset,
  ParamValue,
  Pattern,
  Texture2D,
  Texture2DKind,
  Title3DProps,
  TitleStyle2D,
} from '../model/types';
import { fullLighting } from './apply';
import { applyColourway, COLOURWAY_INFO, tintOrb } from './colourways';
import { more3DLooks } from './factory3dMore';
import { COLOURWAYS, type Colourway, type StylePreset } from './types';

// Factory style library. Every look is authored for a 200 px source (REF): style dimensions are
// % of the source size anyway; effect px params are scaled by apply.ts.
//
// The 2D looks follow the researched production stacks (research-ps §2): a gradient-mapped,
// bevelled metal face with a gloss cap and noisy inner glow, then 2–4 rims inner → outer
// (dark keyline → bright → thick coloured, 1 : 2 width ratio, miter joins, filled counters)
// and a dropped dark base for weight. 3D looks follow the Element 3D recipe (research-e3d §1):
// thick extrusion, round bevel, reflective metal under a hard-light studio environment,
// separate under-plates, and a two-layer (tight + wide) glow.

const REF = 200;

export const g = (...stops: [number, string][]): Gradient => ({ stops: stops.map(([pos, color]) => ({ pos, color })) });

// ---------- effect instances ----------

/** Effect instance with its registry defaults, then `over` (also used by the templates). */
export function fx(type: string, over: Record<string, ParamValue> = {}): EffectInstance {
  const def = getEffect(type);
  if (!def) throw new Error(`Unknown effect ${type}`);
  const params: Record<string, ParamValue> = {};
  for (const p of def.params) params[p.key] = structuredClone(p.default);
  return { id: uid(), type, enabled: true, params: { ...params, ...over } };
}

/**
 * A look's companion (also used by the templates): generator `type` from its preset `presetId`
 * (`params` over it, following the layer), with that preset's place, blend, opacity and effects;
 * `o` over those.
 */
export function companion(type: string, presetId: string, params: Record<string, ParamValue> = {}, o: Partial<Omit<Companion, 'generator'>> = {}): Companion {
  const preset = getGenerator(type)?.presets.find((pr) => pr.id === presetId);
  const g = generatorFromPreset(type, presetId);
  if (!preset || !g) throw new Error(`Unknown generator preset ${type}/${presetId}`);
  const { follow: _, ...own } = g.params;
  return {
    generator: { type, params: { ...own, ...params } },
    place: preset.place ?? 'above',
    ...(preset.blend ? { blend: preset.blend } : {}),
    ...(preset.opacity !== undefined ? { opacity: preset.opacity } : {}),
    ...(preset.effects?.length ? { effects: presetEffects(preset) } : {}),
    ...o,
  };
}

// ---------- 2D material parts ----------

const finish = (gradient: Gradient, amount = 1): Finish2D => ({ enabled: true, gradient, amount });
const glow = (color: string, size: number, opacity: number, noise = 0): InnerGlow2D => ({ enabled: true, color, size, opacity, noise });
const cap = (opacity: number, position = 0.45, softness = 0.12, curve = 0.25, angle = 0): Gloss2D => ({ enabled: true, opacity, position, softness, curve, angle });
const tex = (
  kind: Texture2DKind,
  amount: number,
  scale: number,
  blend: Texture2D['blend'] = 'overlay',
  seed = 1,
  target: Texture2D['target'] = 'color',
): Texture2D => ({ kind, amount, scale, blend, seed, target, angle: 0 });
const lin = (gradient: Gradient, angle = 90, scale = 1, offset = 0): Fill => ({ ...linearFill(gradient, angle), scale, offset });

const solid = (color: string, o: Partial<Material2D> = {}) => material2D(solidFill(color), o);

/** Black keyline (the dark inner stroke that "tightens" the face). */
const keyline = (w: number, color = '#0a0604') => rim2D(w, solid(color));
/** Dropped dark base under everything (weight / contact shadow). */
const base = (w: number, dy: number, color = '#000000', dx = 0) => rim2D(w, solid(color), { offsetX: dx, offsetY: dy });
// Bright rims leave the counters (holes of 口, B, O…) open so the next dark rim fills them:
// counters read dark, as in the production stacks, instead of flooding with gold/white.
/** Thin bright line with a soft bevel (white / pale stroke). */
const lightLine = (w: number, color = '#ffffff') =>
  rim2D(w, solid(color, { bevel: bevel2D({ size: 1.2, depth: 2, gloss: 'linear', highlightOpacity: 0.6, shadowOpacity: 0.35 }) }), {
    fillCounters: false,
  });
/** Bevelled metal ring (gold / red / silver frames). */
const metalRim = (w: number, fill: Gradient, ramp: Gradient | null, o: Partial<Bevel2D> = {}, angle = 270, amount = 0.85) =>
  rim2D(
    w,
    material2D(lin(fill, angle), {
      bevel: bevel2D({ size: Math.max(0.8, w * 0.6), depth: 4, gloss: 'ring', highlightOpacity: 0.85, shadowOpacity: 0.6, ...o }),
      finish: ramp ? finish(ramp, amount) : { enabled: false, gradient: GRADIENTS.goldRamp, amount: 1 },
    }),
    { fillCounters: false },
  );

/** Bevelled, gradient-mapped metal face, optionally with pattern marks (柄). */
function metalFace(
  fill: Gradient,
  ramp: Gradient | null,
  o: {
    bevel?: Partial<Bevel2D>;
    amount?: number;
    glow?: InnerGlow2D;
    cap?: Gloss2D | null;
    texture?: Texture2D;
    angle?: number;
    pattern?: Pattern;
  } = {},
): Material2D {
  return material2D(lin(fill, o.angle ?? 90), {
    bevel: bevel2D({ size: 3, depth: 3, gloss: 'ring', highlightOpacity: 0.85, shadowOpacity: 0.55, ...o.bevel }),
    finish: ramp ? finish(ramp, o.amount ?? 0.85) : { enabled: false, gradient: GRADIENTS.goldRamp, amount: 1 },
    innerGlow: o.glow ?? glow('#fff3b0', 1.5, 0.45, 0.35),
    gloss: o.cap === null ? cap(0) : (o.cap ?? cap(0.4)),
    ...(o.texture ? { texture: o.texture } : {}),
    ...(o.pattern ? { pattern: o.pattern } : {}),
  });
}

// ---------- preset builders ----------

interface Look2D {
  id: string;
  name: string;
  group: string;
  /** `knockout` / `erode` default to a solid face and かすれ off. */
  style: Omit<TitleStyle2D, 'knockout' | 'erode'> & Partial<Pick<TitleStyle2D, 'knockout' | 'erode'>>;
  effects?: EffectInstance[];
  companions?: Companion[];
  groupEffects?: EffectInstance[];
  fontId?: string;
}

const p2 = (l: Look2D): StylePreset => ({
  id: l.id,
  name: l.name,
  group: l.group,
  kind: 'title2d',
  style: { knockout: false, erode: erode2D(), ...l.style },
  effects: l.effects ?? [],
  ...(l.companions ? { companions: l.companions } : {}),
  ...(l.groupEffects ? { groupEffects: l.groupEffects } : {}),
  partEffects: {},
  refSize: REF,
  ...(l.fontId ? { fontId: l.fontId } : {}),
  builtin: true,
});

/** A look's environment, tone mapping, exposure and (optionally) lights; the rest comes from defaultComp(). */
type LookLighting = Partial<Lighting3D>;

interface Look3D {
  id: string;
  name: string;
  group: string;
  /**
   * `skew` / `ao` default to straight extrusion and AO off; `bevelPosition` to 'outside' (the
   * letter's bevel grows outward from the outline); `mode` / `inflate` / `envLock` to the factory layer's.
   */
  style3d: Omit<Title3DProps, 'skew' | 'ao' | 'mode' | 'inflate' | 'envLock' | 'bevelPosition' | 'faceImage' | 'edgeImage' | 'lighting'> &
    Partial<Pick<Title3DProps, 'skew' | 'ao' | 'mode' | 'inflate' | 'envLock' | 'bevelPosition' | 'faceImage' | 'edgeImage'>>;
  effects?: EffectInstance[];
  /** The look's own lighting (style3d.lighting: it sets every value), completed with defaultComp()'s. */
  lighting: LookLighting;
  fontId?: string;
}

export const p3 = (l: Look3D): StylePreset => {
  const { mode, inflate, envLock } = createTitle3DLayer().style3d;
  return {
    id: l.id,
    name: l.name,
    group: l.group,
    kind: 'title3d',
    style3d: { mode, inflate, envLock, skew: { x: 0, y: 0 }, ao: ao3D(), bevelPosition: 'outside', faceImage: 1, edgeImage: 0, ...l.style3d, lighting: fullLighting(l.lighting) },
    effects: l.effects ?? [],
    partEffects: {},
    refSize: REF,
    ...(l.fontId ? { fontId: l.fontId } : {}),
    builtin: true,
  };
};

// ======================================================================================
// Classic outline 縁取り. One canonical structure — megabenri's five layers: metal face with a
// white top highlight, black inner stroke, white stroke, thick coloured outer stroke (1 : 2),
// dropped base + glow — in every colourway (src/presets/colourways.ts), so these looks and the
// Library's Colourways always agree.
// ======================================================================================

function ladderBase(): TitleStyle2D {
  return {
    face: metalFace(GRADIENTS.goldBandsFill, GRADIENTS.goldRamp, {
      bevel: { size: 3.2, depth: 3.5, gloss: 'ring', lightAltitude: 32 },
      amount: 0.8,
      glow: glow('#fff3b0', 1.4, 0.45, 0.4),
      cap: cap(0.42, 0.44, 0.1, 0.25),
    }),
    rims: [
      keyline(1.3),
      lightLine(1.9),
      metalRim(3.6, GRADIENTS.redFill, GRADIENTS.redRamp, { size: 2.2, depth: 3.5 }),
      base(2.4, 3.2),
    ],
    knockout: false,
    erode: erode2D(),
  };
}

const ladderEffects = () => [
  fx('dropShadow', { angle: 90, distance: 6, size: 14, spread: 0.1, opacity: 0.6, color: '#3a1800' }),
  fx('outerGlow', { color: '#ffb000', size: 22, intensity: 0.6, spread: 0.05, opacity: 0.8, mode: 'behind' }),
];

const OUTLINE = 'Classic outline 縁取り';

function outlinePreset(colourway: Colourway): StylePreset {
  const layer = applyColourway({ ...createTitle2DLayer('確定'), style: ladderBase(), effects: ladderEffects() }, colourway);
  if (layer.kind !== 'title2d') throw new Error('unreachable');
  return p2({ id: `f-outline-${colourway}`, name: `${COLOURWAY_INFO[colourway].name} outline`, group: OUTLINE, style: layer.style, effects: layer.effects });
}

const OUTLINE_PRESETS = COLOURWAYS.map(outlinePreset);

// ======================================================================================
// Gold & Metal
// ======================================================================================

const GOLD_METAL = 'Gold & Metal';

/** まぺろに 確定: banded gradient + ring gloss + noisy inner glow, red 8px / black 24px frames. */
const classicGold = p2({
  id: 'f-gold-classic',
  name: 'Classic Gold (まぺろに)',
  group: GOLD_METAL,
  style: {
    face: metalFace(GRADIENTS.goldFill, GRADIENTS.goldRamp, {
      bevel: { size: 3, depth: 4, gloss: 'ring', lightAltitude: 30, highlightOpacity: 0.9 },
      amount: 0.9,
      glow: glow('#fff6d0', 1.6, 0.55, 0.55),
      cap: cap(0.35, 0.42, 0.1, 0.3),
    }),
    rims: [
      keyline(0.6, '#2a1400'),
      metalRim(1.3, GRADIENTS.redFill, GRADIENTS.redRamp, { size: 1.1, depth: 4 }),
      rim2D(
        4,
        solid('#0b0b0d', {
          bevel: bevel2D({ size: 2.2, depth: 3, gloss: 'cove', highlightOpacity: 0.45, shadowOpacity: 0.4 }),
          gloss: cap(0.12, 0.4, 0.1, 0.2),
        }),
      ),
      base(1.6, 2.4, '#000000'),
    ],
  },
  effects: [
    fx('outerGlow', { color: '#ffd6a0', size: 26, intensity: 0.7, spread: 0.05, opacity: 0.9, mode: 'behind' }),
    // Gamma 0.92, then contrast +12 % about mid-grey as a clipped straight line (v ↦ 1.12·v − 0.06).
    fx('adjust', { adjustment: levels(0, 255, 0.92) }),
    fx('adjust', { adjustment: levels((0.06 / 1.12) * 255, (1.06 / 1.12) * 255, 1) }),
  ],
});

/** ヒロデザch: Hiro's gradient-overlay gold with a double gold-gradient stroke, satin depth. */
const hiroGold = p2({
  id: 'f-gold-hiro',
  name: 'Hiro Gold (double stroke)',
  group: GOLD_METAL,
  style: {
    face: metalFace(GRADIENTS.goldBandsFill, GRADIENTS.goldRamp, {
      bevel: { size: 2.6, depth: 3, gloss: 'cove', highlightOpacity: 0.8, shadowOpacity: 0.5 },
      amount: 0.55,
      glow: glow('#ffe87a', 2, 0.55, 0.15),
      cap: cap(0.3, 0.4, 0.14, 0.2),
    }),
    rims: [
      metalRim(2, GRADIENTS.goldRimFill, GRADIENTS.goldRamp, { size: 1.6, depth: 4, gloss: 'ring' }, 270, 0.5),
      metalRim(2.4, g([0, '#5a2e05'], [0.35, '#d9a640'], [0.55, '#fff4b0'], [0.75, '#b07a20'], [1, '#4a2604']), GRADIENTS.goldRamp, {
        size: 1.8,
        depth: 5,
        gloss: 'doubleRing',
      }, 90, 0.6),
      keyline(1.1, '#1a0c00'),
      base(1.6, 2.4),
    ],
  },
  effects: [fx('outerGlow', { color: '#fff4c0', size: 20, intensity: 0.55, spread: 0.05, mode: 'behind' })],
});

/** photoshopvip "Ultimate Gold": 50% grey + deep bevel → gradient map, grunge, sparkle rim, soft glow. */
const ultimateGold = p2({
  id: 'f-gold-ultimate',
  name: 'Ultimate Gold (gradient map)',
  group: GOLD_METAL,
  style: {
    face: material2D(lin(g([0, '#9a9a9a'], [0.5, '#7a7a7a'], [1, '#5a5a5a'])), {
      bevel: bevel2D({ profile: 'smooth', size: 5.5, depth: 7, gloss: 'doubleRing', lightAltitude: 35, highlightOpacity: 1, shadowOpacity: 0.75 }),
      finish: finish(GRADIENTS.goldRamp, 1),
      texture: tex('grunge', 0.45, 6, 'overlay', 3),
      innerGlow: glow('#ffe9a0', 1.2, 0.35, 0.6),
      gloss: cap(0.18, 0.4, 0.2, 0.2),
    }),
    rims: [
      rim2D(
        1.6,
        material2D(lin(GRADIENTS.goldRimFill, 270), {
          bevel: bevel2D({ size: 1, depth: 4, gloss: 'ring' }),
          finish: finish(GRADIENTS.goldRamp, 0.8),
          texture: tex('sparkle', 0.8, 3, 'screen', 5),
        }),
        { fillCounters: false },
      ),
      keyline(1.6, '#140a00'),
      base(1.4, 2.2),
    ],
  },
  effects: [fx('outerGlow', { color: '#ffd300', size: 40, intensity: 0.5, spread: 0, opacity: 0.6, mode: 'add' })],
});

/**
 * Gold whose surface is bent by a texture (Texture2D target 'surface': the height goes into the
 * bevel before lighting and the gradient map, so the metal bands themselves warp): 液体金 large
 * liquid ripples or クシャ crumpled foil. Dark-brown keyline, thick black frame and a black base,
 * as on the 北斗 転生 / 完全復活 key art.
 */
function surfaceGold2D(id: string, name: string, texture: Texture2D): StylePreset {
  return p2({
    id,
    name,
    group: GOLD_METAL,
    style: {
      face: metalFace(GRADIENTS.goldBandsFill, GRADIENTS.goldRamp, {
        bevel: { profile: 'smooth', size: 4, depth: 5, gloss: 'ring', lightAltitude: 34, highlightOpacity: 0.9, shadowColor: '#5a1800' },
        amount: 0.9,
        glow: glow('#fff3b0', 1.2, 0.35, 0.3),
        cap: cap(0.25, 0.42, 0.12, 0.2),
        texture,
      }),
      rims: [keyline(1, '#3a1000'), rim2D(5.5, solid('#050302', { bevel: bevel2D({ size: 1.6, depth: 2, gloss: 'cove', highlightOpacity: 0.35 }) })), base(1.4, 2.4)],
    },
    effects: [fx('outerGlow', { color: '#000000', size: 22, intensity: 0.8, spread: 0.2, opacity: 0.7, mode: 'behind' })],
  });
}

const liquidGold2D = surfaceGold2D('f-gold-liquid', '液体金 Liquid Gold (surface)', tex('liquid', 0.35, 44, 'overlay', 3, 'surface'));
const crumpleGold2D = surfaceGold2D('f-gold-crumple', 'クシャ金 Crumpled Foil (surface)', tex('crumple', 0.55, 9, 'overlay', 5, 'surface'));

/** Pale gold (シャンパンゴールド) — the premium look. */
const paleGold = p2({
  id: 'f-gold-pale',
  name: 'Pale Gold Premium',
  group: GOLD_METAL,
  style: {
    face: metalFace(g([0, '#fffdf2'], [0.3, '#e9d9a6'], [0.48, '#8d7438'], [0.62, '#f2e6be'], [0.85, '#c9ad6a'], [1, '#fff8dc']), GRADIENTS.paleGoldRamp, {
      bevel: { size: 3, depth: 3.5, gloss: 'ring' },
      amount: 0.6,
      glow: glow('#ffffff', 1.4, 0.5, 0.35),
      cap: cap(0.4),
    }),
    rims: [keyline(1.1, '#1a1408'), metalRim(2.2, GRADIENTS.goldRimFill, GRADIENTS.paleGoldRamp, { size: 1.4 }), keyline(1.6, '#0c0a06'), base(1.4, 2.4)],
  },
  effects: [fx('outerGlow', { color: '#fff6dc', size: 24, intensity: 0.55, spread: 0.05, mode: 'behind' })],
});

/** Silver premium: bright banded silver, navy keyline, chrome frame. */
const silverPremium = p2({
  id: 'f-silver-premium',
  name: 'Silver Premium',
  group: GOLD_METAL,
  style: {
    face: metalFace(GRADIENTS.silverFill, GRADIENTS.silverRamp, {
      bevel: { size: 3, depth: 4, gloss: 'ring' },
      amount: 0.6,
      glow: glow('#f0f6ff', 1.4, 0.5, 0.4),
      cap: cap(0.35),
    }),
    rims: [
      keyline(1.1, '#0a0f1e'),
      metalRim(2.2, g([0, '#ffffff'], [0.45, '#aeb6c4'], [0.55, '#4a5160'], [1, '#e6eaf0']), GRADIENTS.silverRamp, { size: 1.5, gloss: 'doubleRing' }),
      rim2D(2.6, solid('#0c1430', { bevel: bevel2D({ size: 1.6, depth: 3, gloss: 'cove', highlightOpacity: 0.5 }) })),
      base(1.4, 2.4),
    ],
  },
  effects: [fx('outerGlow', { color: '#cfe4ff', size: 22, intensity: 0.55, spread: 0.05, mode: 'behind' })],
});

/** Rose gold. */
const roseGold = p2({
  id: 'f-rose-gold',
  name: 'Rose Gold',
  group: GOLD_METAL,
  style: {
    face: metalFace(g([0, '#fff0ea'], [0.25, '#f2b7a1'], [0.48, '#8a4634'], [0.62, '#f6c8b6'], [0.85, '#c47a62'], [1, '#ffe6dc']), GRADIENTS.roseGoldRamp, {
      bevel: { size: 3, depth: 3.5, gloss: 'ring' },
      amount: 0.65,
      glow: glow('#fff0ea', 1.4, 0.45, 0.35),
      cap: cap(0.38),
    }),
    rims: [keyline(1.1, '#2a0e0a'), metalRim(2.2, GRADIENTS.paleGoldRimFill, GRADIENTS.paleGoldRamp, { size: 1.4 }), keyline(2, '#1a0808'), base(1.4, 2.4)],
  },
  effects: [fx('outerGlow', { color: '#ffd2c2', size: 22, intensity: 0.5, spread: 0.05, mode: 'behind' })],
});

/** Copper / bronze. */
const copper = p2({
  id: 'f-copper',
  name: 'Copper',
  group: GOLD_METAL,
  style: {
    face: metalFace(g([0, '#ffd9bf'], [0.25, '#e08a52'], [0.48, '#5e2208'], [0.62, '#f0a070'], [0.85, '#a8481a'], [1, '#ffc9a0']), GRADIENTS.copperRamp, {
      bevel: { size: 3, depth: 4, gloss: 'ring' },
      amount: 0.75,
      glow: glow('#ffd8b8', 1.4, 0.4, 0.45),
      cap: cap(0.32),
      texture: tex('hammered', 0.18, 2.5, 'overlay', 2),
    }),
    rims: [keyline(1.2, '#1a0800'), metalRim(2.2, GRADIENTS.goldRimFill, GRADIENTS.goldRamp, { size: 1.4 }), keyline(2.2, '#120600'), base(1.4, 2.4)],
  },
  effects: [fx('outerGlow', { color: '#ff9a50', size: 22, intensity: 0.5, spread: 0.05, mode: 'behind' })],
});

/** 高級感: black gloss lacquer face with a fine metal frame (Zen Old Mincho). */
function blackGloss(id: string, name: string, rimFill: Gradient, ramp: Gradient, tint: string): StylePreset {
  return p2({
    id,
    name,
    group: GOLD_METAL,
    fontId: 'zen-old-mincho-black',
    style: {
      face: material2D(lin(g([0, '#4a4a52'], [0.45, '#141418'], [0.55, '#050506'], [1, '#26262c'])), {
        bevel: bevel2D({ size: 2.4, depth: 5, gloss: 'cove', lightAltitude: 40, highlightOpacity: 0.9, shadowOpacity: 0.8 }),
        innerGlow: glow(tint, 0.8, 0.25, 0.3),
        gloss: cap(0.28, 0.4, 0.06, 0.3),
      }),
      rims: [
        metalRim(1.4, rimFill, ramp, { size: 1, depth: 4, gloss: 'ring' }, 270, 0.8),
        keyline(1.6, '#050505'),
        metalRim(0.8, rimFill, ramp, { size: 0.6, depth: 3 }, 90, 0.8),
        base(1.2, 2, '#000000'),
      ],
    },
    effects: [fx('outerGlow', { color: tint, size: 18, intensity: 0.4, spread: 0.05, mode: 'behind' })],
  });
}

const blackGold = blackGloss('f-black-gold', 'Black Gloss + Gold Rim (高級)', GRADIENTS.goldRimFill, GRADIENTS.goldRamp, '#ffd27a');
const blackSilver = blackGloss(
  'f-black-silver',
  'Black Gloss + Silver Rim (高級)',
  g([0, '#5d6474'], [0.2, '#ffffff'], [0.4, '#9aa1ad'], [0.6, '#eef1f6'], [0.8, '#7d8592'], [1, '#f4f6fa']),
  GRADIENTS.silverRamp,
  '#dfe9ff',
);

/** Eye Candy Chrome: sky-over-horizon chrome bands, mirror bevel. */
const chrome2D = p2({
  id: 'f-chrome',
  name: 'Chrome (Eye Candy)',
  group: GOLD_METAL,
  style: {
    face: material2D(lin(GRADIENTS.chromeFill), {
      bevel: bevel2D({ profile: 'button', size: 3.5, depth: 5, gloss: 'doubleRing', lightAltitude: 35, highlightOpacity: 0.9, shadowOpacity: 0.7 }),
      finish: finish(GRADIENTS.silverRamp, 0.35),
      innerGlow: glow('#ffffff', 1, 0.35, 0.2),
      gloss: cap(0.15, 0.4, 0.04, 0.15),
    }),
    rims: [
      keyline(1.1, '#05070c'),
      metalRim(2.2, g([0, '#ffffff'], [0.45, '#b8c2d0'], [0.52, '#2c323c'], [0.7, '#cfd6e0'], [1, '#ffffff']), GRADIENTS.silverRamp, { size: 1.5, gloss: 'doubleRing' }, 270, 0.4),
      keyline(1.6, '#05070c'),
      base(1.2, 2.2),
    ],
  },
  effects: [fx('outerGlow', { color: '#d8ecff', size: 18, intensity: 0.45, spread: 0.05, mode: 'behind' })],
});

/**
 * Satin chrome (液体金属): a cool mirror ramp with a hard horizon, and Photoshop Satin as the
 * inner sheen — the silhouette's shifted, blurred copies darken the middle of every stroke in a
 * liquid band that follows the letter shapes instead of the bounding box.
 */
const satinChrome = p2({
  id: 'f-chrome-satin',
  name: 'Satin Chrome (液体金属)',
  group: GOLD_METAL,
  style: {
    face: material2D(lin(g([0, '#ffffff'], [0.3, '#dfe8f4'], [0.48, '#8d9bb0'], [0.5, '#2a3140'], [0.62, '#7d8ba0'], [0.85, '#e8eef6'], [1, '#ffffff'])), {
      bevel: bevel2D({ profile: 'smooth', size: 3, depth: 4, gloss: 'ring', lightAltitude: 38, highlightOpacity: 0.9, shadowOpacity: 0.55, shadowColor: '#0a1630' }),
      finish: finish(GRADIENTS.silverRamp, 0.3),
      satin: satin2D({ enabled: true, color: '#0c1426', blend: 'multiply', opacity: 0.55, angle: 30, distance: 4, size: 4.5 }),
      innerGlow: glow('#ffffff', 0.9, 0.35, 0.15),
      gloss: cap(0.22, 0.42, 0.06, 0.2),
    }),
    rims: [
      keyline(0.9, '#05070c'),
      metalRim(2, g([0, '#ffffff'], [0.45, '#c3ccd8'], [0.52, '#2c323c'], [0.7, '#d6dce6'], [1, '#ffffff']), GRADIENTS.silverRamp, { size: 1.3, gloss: 'doubleRing' }, 270, 0.4),
      keyline(2.4, '#071026'),
      base(1.4, 2.4, '#000000'),
    ],
  },
  effects: [
    fx('outerGlow', { color: '#cfe2ff', size: 18, intensity: 0.45, spread: 0.05, mode: 'behind' }),
    fx('gradientOverlay', glintOverlay({ angle: 30, position: -20, width: 30, softness: 85, double: false, color: '#ffffff', intensity: 45 })),
  ],
});

/**
 * Eye Candy-style bevel profile (edge → in): a soft dome falling gently to a shoulder at ~75 % of
 * the width, then a steep drop.
 */
const EC_PROFILE = curve([0, 0], [0.04, 0.03], [0.13, 0.28], [0.23, 0.41], [0.3, 0.44], [0.45, 0.55], [0.6, 0.68], [1, 1]);
/** Eye Candy-style Bevel: Fit (適合) at 69.31 %, light from 182° (left), 8.8° high. */
const ecBevel = (o: Partial<Bevel2D> = {}) =>
  bevel2D({
    profile: 'custom',
    profileCurve: EC_PROFILE,
    sizeMode: 'fit',
    fit: 69.31,
    depth: 4.5,
    soften: 0.05,
    lightAngle: 182,
    lightAltitude: 8.8,
    gloss: 'linear',
    highlightOpacity: 1,
    shadowOpacity: 0.25,
    ...o,
  });
/** Eye Candy ランプ (lumpy) surface: soft bumps bending the reflections like liquid metal. */
const LUMPY = tex('liquid', 0.2, 40, 'overlay', 1, 'surface');
/** Reflective metal rim: a Fit-bevelled tube reflecting the highway, mapped through a metal ramp. */
const chromeRim = (w: number, ramp: Gradient, blur = 20, highlight = 0.7) =>
  rim2D(
    w,
    solid('#808080', {
      bevel: bevel2D({ profile: 'smooth', sizeMode: 'fit', fit: 100, depth: 5, lightAngle: 182, lightAltitude: 30, gloss: 'linear', highlightOpacity: highlight, shadowOpacity: 0.35 }),
      reflection: reflection2D({ enabled: true, blur }),
      finish: finish(ramp, 1),
    }),
    { fillCounters: false },
  );
/** Yellow chrome gold (not the orange gold ramp): near-black brown flanks → gold → white-hot highlight, for high-contrast tubes. */
const GOLD_CHROME = g([0, '#1e0c00'], [0.25, '#6a3c00'], [0.5, '#d09020'], [0.7, '#ffe060'], [0.88, '#fffbe0'], [1, '#ffffff']);

/**
 * Eye Candy-style liquid chrome: a Fit bevel over the whole glyph (so round strokes dome), crisp
 * ridges, lumpy surface, lit low from the left, a full mirror of the 高速道路 (highway) photo mapped
 * to neutral chrome, and a thin dark edge where the bevel turns away.
 */
const liquidChrome = p2({
  id: 'f-chrome-liquid',
  name: '液体クローム Liquid Chrome (Eye Candy)',
  group: GOLD_METAL,
  style: {
    face: material2D(solidFill('#808080'), {
      bevel: ecBevel({ shadowOpacity: 0.15 }),
      reflection: reflection2D({ enabled: true, rotation: 60, blur: 50 }),
      finish: finish(CHROME_RAMP, 1),
      texture: LUMPY,
    }),
    rims: [keyline(0.2, '#2e2e2e')],
  },
});

// ======================================================================================
// Rainbow & Special
// ======================================================================================

const SPECIAL = 'Rainbow & Special';

/**
 * Rainbow 確定: the saturated 7-hue spectrum per line with its deep metal horizon (no white stop:
 * it read as a white band), a cove bevel shaded in deep violet (black multiply turns yellow
 * olive), a hard-edged gloss cap, white + gold strokes.
 */
const rainbowKakutei = p2({
  id: 'f-rainbow-kakutei',
  name: 'Rainbow 確定',
  group: SPECIAL,
  style: {
    face: material2D(linearFill(GRADIENTS.rainbowFill, 90, 'line'), {
      bevel: bevel2D({ size: 3, depth: 4, gloss: 'cove', highlightOpacity: 1, shadowColor: '#2a0050', shadowOpacity: 0.5 }),
      // A narrow, faint white inner glow: a wide bright one washes every hue toward pastel.
      innerGlow: glow('#ffffff', 0.8, 0.3, 0.25),
      gloss: cap(0.38, 0.4, 0.03, 0.25),
    }),
    rims: [
      lightLine(1.6),
      metalRim(3, GRADIENTS.goldRimFill, GRADIENTS.goldRamp, { size: 1.8, depth: 4, gloss: 'ring' }, 270, 0.7),
      keyline(1.4, '#1a0030'),
      base(1.6, 2.6, '#0a0014'),
    ],
  },
  effects: [fx('outerGlow', { color: '#fff4c8', size: 26, intensity: 0.7, spread: 0.05, mode: 'behind' })],
});

/**
 * 青ブタ虹: the liquid-chrome bevel and highway reflection over ONE vertical rainbow across the
 * whole title (deep crimson top, magenta, purple, blue, cyan, green, yellow only at the bottom),
 * the reflection tinting the hues as coloured glass with white streaks at half strength so the
 * colours stay deep; a silver line, a high-contrast gold chrome rim, a dark line, an outer gold rim
 * and a black keyline, and a tight glow, magenta above and cyan below.
 */
const rainbowGlassGold = p2({
  id: 'f-rainbow-glass-gold',
  name: '青ブタ虹 Rainbow Glass + Gold Rim',
  group: SPECIAL,
  style: {
    face: material2D(
      linearFill(
        g(
          [0, '#e8001a'],
          [0.12, '#f00020'],
          [0.19, '#e8005a'],
          [0.25, '#d000a0'],
          [0.31, '#b000e0'],
          [0.37, '#7010ff'],
          [0.43, '#2020ff'],
          [0.49, '#1070ff'],
          [0.56, '#00c0ff'],
          [0.63, '#00f0ff'],
          [0.73, '#00ffd0'],
          [0.79, '#00ff80'],
          [0.84, '#40ff20'],
          [0.88, '#c0ff00'],
          [0.93, '#ffff00'],
          [1, '#ffc800'],
        ),
        90,
        'layer',
      ),
      {
        bevel: ecBevel({ depth: 2.6, highlightOpacity: 1, shadowOpacity: 0.2 }),
        reflection: reflection2D({ enabled: true, map: 'sky', amount: 0.5, rotation: 60, blur: 50, colorize: 1 }),
        texture: LUMPY,
      },
    ),
    rims: [
      chromeRim(0.6, GRADIENTS.silverRamp),
      chromeRim(1.3, GOLD_CHROME, 6, 1),
      { ...keyline(0.4, '#1a0e00'), join: 'round' },
      { ...chromeRim(1.6, GOLD_CHROME, 6, 1), join: 'round' },
      { ...keyline(1, '#000000'), join: 'round' },
    ],
  },
  effects: [
    fx('outerGlow', {
      fill: 'gradient',
      gradient: g([0, '#ff20e0'], [0.45, '#ff30c0'], [0.6, '#4090ff'], [1, '#00e8ff']),
      size: 14,
      intensity: 1,
      spread: 0.2,
      opacity: 1,
      mode: 'behind',
    }),
  ],
});

/** Hologram: pastel iridescent foil with ripple, chrome frame, rainbow sheen. */
const hologram = p2({
  id: 'f-hologram',
  name: 'Hologram Foil',
  group: SPECIAL,
  style: {
    face: material2D(lin(GRADIENTS.hologramFill, 60, 0.6), {
      bevel: bevel2D({ size: 2.4, depth: 3, gloss: 'doubleRing', highlightOpacity: 0.8, shadowOpacity: 0.35 }),
      texture: tex('ripple', 0.35, 5, 'softLight', 4),
      innerGlow: glow('#ffffff', 1.2, 0.45, 0.6),
      gloss: cap(0.3, 0.4, 0.1, 0.2),
    }),
    rims: [
      keyline(1, '#1a1a3a'),
      metalRim(2.2, g([0, '#ffffff'], [0.45, '#c9cfdb'], [0.52, '#5d6474'], [1, '#f0f3f8']), GRADIENTS.silverRamp, { size: 1.4, gloss: 'doubleRing' }, 270, 0.5),
      keyline(1.8, '#14102a'),
      base(1.2, 2.2, '#05030f'),
    ],
  },
  effects: [
    fx('gradientOverlay', rainbowOverlay({ bands: 1.6, angle: 30, phase: 0, saturation: 0.7, amount: 0.35, mode: 'overlay' })),
    fx('outerGlow', { color: '#e6d8ff', size: 20, intensity: 0.5, spread: 0.05, mode: 'behind' }),
  ],
});

/** Candy glass: deep tinted face, cove bevel catching bright edges, strong gloss cap. */
function glassLook(id: string, name: string, deep: string, mid: string, light: string, glowCol: string): StylePreset {
  return p2({
    id,
    name,
    group: SPECIAL,
    style: {
      face: material2D(lin(g([0, light], [0.35, mid], [0.7, deep], [1, mid])), {
        bevel: bevel2D({ profile: 'smooth', size: 4.5, depth: 6, gloss: 'cove', lightAltitude: 45, highlightOpacity: 1, shadowOpacity: 0.5, shadowColor: deep }),
        innerGlow: glow(light, 2.4, 0.7, 0),
        gloss: cap(0.55, 0.42, 0.05, 0.35),
      }),
      rims: [lightLine(1.2), rim2D(2.4, solid(deep, { bevel: bevel2D({ size: 1.4, depth: 3, gloss: 'cove', highlightOpacity: 0.6 }) })), base(1.2, 2.2, '#000000')],
    },
    effects: [fx('outerGlow', { color: glowCol, size: 24, intensity: 0.7, spread: 0.05, mode: 'behind' })],
  });
}

const glassRed = glassLook('f-glass-red', 'Glass Red', '#4a0008', '#d0001c', '#ff8a8a', '#ff2a3a');
const glassBlue = glassLook('f-glass-blue', 'Glass Blue', '#001a5a', '#0a5cff', '#9cd8ff', '#2a8aff');

/** Neon sign: white-hot tube outlining a dark letter that glows pink from its edges. */
const neon = p2({
  id: 'f-neon',
  name: 'Neon Tube',
  group: SPECIAL,
  style: {
    face: solid('#16030f', { innerGlow: glow('#ff2ab8', 2.6, 0.75, 0) }),
    rims: [
      rim2D(1.6, solid('#ffeefa', { bevel: bevel2D({ profile: 'ridge', size: 0.8, depth: 3, gloss: 'linear', highlightOpacity: 0.9, shadowColor: '#ff1aa8', shadowOpacity: 0.85 }) }), {
        join: 'round',
        fillCounters: false,
      }),
      rim2D(1.2, solid('#16030f'), { join: 'round' }),
    ],
  },
  effects: [
    fx('outerGlow', { color: '#ff2ab8', size: 14, intensity: 1.4, spread: 0.1, mode: 'add' }),
    fx('deepGlow', { exposure: 1.5, threshold: 0.3, knee: 0.2, radius: 240, falloff: 20, intensity: 4, colorMode: 'custom', color: '#ff2ab8', onFace: 0.3 }),
  ],
});

/**
 * Hollow neon (knockout): the face is punched out, so only the tube rings show — a white-hot
 * core line on a magenta tube — over a magenta bloom; the background shows through the letters.
 */
const neonKnockout = p2({
  id: 'f-neon-knockout',
  name: 'Hollow Neon (knockout)',
  group: SPECIAL,
  style: {
    // Fill opacity 0: knockout punches the face area through the rings, and the face itself
    // draws nothing (Photoshop Knockout needs fill opacity below 100 % too).
    face: solid('#ff2ab8', { opacity: 0 }),
    rims: [
      rim2D(1, solid('#fff4fc', { bevel: bevel2D({ profile: 'ridge', size: 0.5, depth: 3, gloss: 'linear', highlightOpacity: 0.9, shadowColor: '#ff1aa8', shadowOpacity: 0.6 }) }), {
        join: 'round',
        fillCounters: false,
      }),
      rim2D(1.6, solid('#ff2ab8', { bevel: bevel2D({ profile: 'ridge', size: 0.8, depth: 3, gloss: 'linear', highlightOpacity: 0.6, shadowColor: '#6a0040', shadowOpacity: 0.7 }) }), {
        join: 'round',
        fillCounters: false,
      }),
    ],
    knockout: true,
  },
  effects: [
    fx('outerGlow', { color: '#ff2ab8', size: 12, intensity: 0.8, spread: 0.1, mode: 'add' }),
    fx('deepGlow', { exposure: 1.5, threshold: 0.3, knee: 0.2, radius: 240, falloff: 20, intensity: 4, colorMode: 'custom', color: '#ff2ab8', onFace: 0.3 }),
  ],
});

/** Ice: frosty white-cyan face with cloudy texture and a blue bevelled frame. */
const ice = p2({
  id: 'f-ice',
  name: 'Ice',
  group: SPECIAL,
  style: {
    face: material2D(lin(GRADIENTS.ice), {
      bevel: bevel2D({ profile: 'chamfer', size: 3, depth: 4, gloss: 'ring', lightAltitude: 40, highlightOpacity: 1, shadowColor: '#002a7a', shadowOpacity: 0.5 }),
      texture: tex('clouds', 0.45, 5, 'screen', 7),
      innerGlow: glow('#ffffff', 2, 0.6, 0.5),
      gloss: cap(0.35, 0.4, 0.06, 0.2),
    }),
    rims: [
      lightLine(1.4),
      metalRim(2.8, g([0, '#bff4ff'], [0.5, '#1a7aff'], [1, '#002a8a']), GRADIENTS.blueRamp, { size: 1.6, profile: 'chamfer' }, 270, 0.5),
      keyline(1.4, '#000a26'),
      base(1.2, 2.2, '#00051a'),
    ],
  },
  effects: [fx('outerGlow', { color: '#7fe8ff', size: 24, intensity: 0.6, spread: 0.05, mode: 'behind' })],
  companions: [companion('glints', 'scatter')],
});

// ======================================================================================
// Fire & Energy
// ======================================================================================

const ENERGY = 'Fire & Energy';

/** 激アツ: red metal face, black + yellow frames, fire behind, deep glow. */
const fireRed = p2({
  id: 'f-fire-gekiatsu',
  name: '激アツ Red Fire',
  group: ENERGY,
  style: {
    face: metalFace(GRADIENTS.redFill, GRADIENTS.redRamp, {
      bevel: { size: 3, depth: 4, gloss: 'ring' },
      amount: 0.75,
      glow: glow('#ffd6a0', 1.4, 0.5, 0.45),
      cap: cap(0.35),
    }),
    rims: [
      keyline(1.2),
      metalRim(2, GRADIENTS.yellowFill, GRADIENTS.goldRamp, { size: 1.3 }, 270, 0.45),
      rim2D(2.8, solid('#3a0000', { bevel: bevel2D({ size: 1.6, depth: 3, gloss: 'cove', highlightColor: '#ff6a3a', highlightOpacity: 0.5 }) })),
      base(1.4, 2.6),
    ],
  },
  companions: [companion('fire', 'red')],
  groupEffects: [
    fx('deepGlow', { exposure: 0.5, threshold: 0.4, knee: 0.3, radius: 220, falloff: 25, intensity: 2.5, chroma: 30, tintAmount: 0.85, tintInner: '#ffa030', tintOuter: '#ff2000' }),
  ],
});

/** Electric blue lightning. */
const lightningBlue = p2({
  id: 'f-lightning-blue',
  name: 'Electric Blue',
  group: ENERGY,
  style: {
    face: metalFace(GRADIENTS.blueFill, GRADIENTS.blueRamp, {
      bevel: { size: 3, depth: 4, gloss: 'ring' },
      amount: 0.7,
      glow: glow('#d6f0ff', 1.6, 0.6, 0.5),
      cap: cap(0.35),
    }),
    rims: [keyline(1.2, '#000a26'), lightLine(1.6, '#e6f6ff'), metalRim(3, g([0, '#6fc4ff'], [0.5, '#1450d8'], [1, '#062a8a']), GRADIENTS.blueRamp, { size: 1.8 }), base(1.4, 2.6, '#00051a')],
  },
  companions: [companion('lightning', 'electricBlue')],
  groupEffects: [
    fx('deepGlow', { exposure: 1, threshold: 0.4, knee: 0.3, radius: 200, falloff: 30, intensity: 2, chroma: -40, tintAmount: 0.7, tintInner: '#9ee6ff', tintOuter: '#1a5cff' }),
  ],
});

/** Corona purple. */
const coronaPurple = p2({
  id: 'f-corona-purple',
  name: 'Corona Purple',
  group: ENERGY,
  style: {
    face: metalFace(g([0, '#ffe0ff'], [0.45, '#b02cff'], [1, '#3a006a']), GRADIENTS.purpleRamp, {
      bevel: { size: 3, depth: 4, gloss: 'ring' },
      amount: 0.7,
      glow: glow('#f6d6ff', 1.6, 0.55, 0.45),
      cap: cap(0.35),
    }),
    rims: [keyline(1.2, '#12001f'), lightLine(1.6), metalRim(3, GRADIENTS.goldRimFill, GRADIENTS.goldRamp, { size: 1.8 }, 270, 0.7), base(1.4, 2.6, '#08000f')],
  },
  companions: [companion('corona', 'purple')],
  groupEffects: [fx('outerGlow', { color: '#c04aff', size: 30, intensity: 0.8, spread: 0.05, mode: 'add' })],
});

// ======================================================================================
// Brush (筆文字)
// ======================================================================================

const BRUSH = 'Brush';

// Brush strokes are irregular: round joins keep the frames from spiking at the dry-brush tips.
function brushLook(id: string, name: string, ink: Gradient, glowCol: string, frame: string, frameW: number): StylePreset {
  return p2({
    id,
    name,
    group: BRUSH,
    fontId: 'yuji-syuku',
    style: {
      face: material2D(lin(ink), {
        bevel: bevel2D({ size: 1.4, depth: 3, gloss: 'cove', lightAltitude: 40, highlightOpacity: 0.6, shadowOpacity: 0.6 }),
        texture: tex('brushed', 0.18, 3, 'overlay', 2),
        innerGlow: glow(glowCol, 0.8, 0.3, 0.6),
        gloss: cap(0.18, 0.4, 0.1, 0.2),
      }),
      rims: [
        metalRim(1.2, GRADIENTS.goldRimFill, GRADIENTS.goldRamp, { size: 0.8, depth: 4 }, 270, 0.8),
        keyline(0.7, '#0a0504'),
        rim2D(frameW, solid(frame, { bevel: bevel2D({ size: 1.2, depth: 2, gloss: 'linear', highlightOpacity: 0.5, shadowOpacity: 0.4 }) })),
        base(1.4, 2.6, '#000000'),
      ].map((r) => ({ ...r, join: 'round' as const })),
    },
    effects: [fx('dropShadow', { angle: 60, distance: 10, size: 16, spread: 0.1, opacity: 0.7 })],
  });
}

const brushBlack = brushLook('f-brush-black', '筆文字 Black Ink', g([0, '#3a3a3a'], [0.5, '#0d0d0d'], [1, '#1c1c1c']), '#ffffff', '#ffffff', 2.6);
const brushRed = brushLook('f-brush-red', '筆文字 Red Ink', g([0, '#ff5a40'], [0.45, '#d4000f'], [1, '#6a0008']), '#ffd0a0', '#0a0504', 2.6);

/**
 * かすれ dry brush: black ink whose outer band is eaten by drag streaks (Erode2D over the whole
 * stack, so the white frame breaks up with the ink), white frame and a red seal-like glow.
 */
const brushKasure = p2({
  id: 'f-brush-kasure',
  name: 'かすれ Dry-brush Ink',
  group: BRUSH,
  fontId: 'yuji-syuku',
  style: {
    face: material2D(lin(g([0, '#2a2a2a'], [0.5, '#050505'], [1, '#141414'])), {
      bevel: bevel2D({ size: 1, depth: 2, gloss: 'cove', lightAltitude: 40, highlightOpacity: 0.45, shadowOpacity: 0.5 }),
      texture: tex('brushed', 0.2, 3, 'overlay', 2),
    }),
    rims: [rim2D(1.4, solid('#ffffff'), { join: 'round' }), base(1.2, 2, '#000000')],
    erode: erode2D({ enabled: true, amount: 0.55, edge: 6, scale: 14, angle: 0, seed: 4 }),
  },
  effects: [fx('outerGlow', { color: '#c80010', size: 26, intensity: 0.7, spread: 0.05, opacity: 0.8, mode: 'behind' })],
});

// ======================================================================================
// Patterns (柄): maker patterns (zebra / giraffe / leopard) and 和柄 over a metal face
// ======================================================================================

const PATTERNS = 'Patterns 柄';

/** Gold face for the pattern looks: white → yellow → orange → dark brown, gold-ramp mapped. */
const PATTERN_GOLD = g([0, '#ffffff'], [0.16, '#fff8b8'], [0.38, '#ffd820'], [0.6, '#f59a00'], [0.8, '#a85400'], [1, '#3e1a00']);

const pat = (kind: Pattern['kind'], o: Partial<Pattern> = {}) => pattern({ kind, ...o });

/** Black lacquer frame band (bevelled, satin) used by the premium pattern looks. */
const blackFrame = (w: number) =>
  rim2D(w, solid('#0b0b0d', { bevel: bevel2D({ size: Math.min(2, w * 0.6), depth: 3, gloss: 'cove', highlightOpacity: 0.45, shadowColor: '#000000', shadowOpacity: 0.4 }), gloss: cap(0.12, 0.4, 0.1, 0.2) }));

/** ゼブラ金: deliberately gold zebra in a gold line + black lacquer frame (the ゼブラ colourway is black on pearl silver). */
const zebraGold = p2({
  id: 'f-pat-zebra',
  name: 'ゼブラ Zebra Gold',
  group: PATTERNS,
  style: {
    face: metalFace(PATTERN_GOLD, GRADIENTS.goldRamp, {
      bevel: { size: 3, depth: 3.5, gloss: 'ring', lightAltitude: 32, shadowColor: '#5a2a00' },
      amount: 0.8,
      glow: glow('#fff3b0', 1.4, 0.45, 0.4),
      cap: cap(0.38, 0.44, 0.1, 0.25),
      pattern: pat('zebra', { color: '#0a0604', scale: 14, angle: -8, seed: 3, shade: 0.55, relief: 0.3 }),
    }),
    rims: [
      keyline(0.9, '#1a0c00'),
      metalRim(1.5, GRADIENTS.goldRimFill, GRADIENTS.goldRamp, { size: 1.1, depth: 4, shadowColor: '#4a2200' }),
      blackFrame(3.2),
      metalRim(1, GRADIENTS.goldRimFill, GRADIENTS.goldRamp, { size: 0.7, depth: 3, shadowColor: '#4a2200' }, 90),
      base(1.4, 2.6, '#0a0400'),
    ],
  },
  effects: [
    fx('dropShadow', { angle: 90, distance: 6, size: 14, spread: 0.1, opacity: 0.6, color: '#2a1400' }),
    fx('outerGlow', { color: '#ffc830', size: 24, intensity: 0.6, spread: 0.05, opacity: 0.85, mode: 'behind' }),
  ],
});

/** キリン柄: cream-gold face with orange-brown patches, copper frame. */
const giraffe = p2({
  id: 'f-pat-giraffe',
  name: 'キリン Giraffe',
  group: PATTERNS,
  style: {
    face: metalFace(g([0, '#fffdf0'], [0.3, '#ffe9a8'], [0.6, '#f0b850'], [1, '#8a5010']), GRADIENTS.goldRamp, {
      bevel: { size: 3, depth: 3.5, gloss: 'ring', shadowColor: '#5a2a00' },
      amount: 0.55,
      glow: glow('#fff0c8', 1.4, 0.45, 0.3),
      cap: cap(0.36),
      pattern: pat('giraffe', { color: '#7a3408', scale: 10, seed: 5, shade: 0.5, relief: 0.3 }),
    }),
    rims: [
      keyline(1.1, '#2a1000'),
      lightLine(1.5, '#fff2d0'),
      metalRim(3, g([0, '#ffe0a8'], [0.4, '#e88a20'], [0.6, '#8a3a00'], [1, '#ffc070']), GRADIENTS.copperRamp, { size: 1.8, shadowColor: '#4a1a00' }),
      base(1.6, 2.6, '#140800'),
    ],
  },
  effects: [
    fx('dropShadow', { angle: 90, distance: 6, size: 14, spread: 0.1, opacity: 0.55, color: '#2a1000' }),
    fx('outerGlow', { color: '#ff9a20', size: 22, intensity: 0.55, spread: 0.05, mode: 'behind' }),
  ],
});

/** 豹柄: gold with black rosettes around amber centres, gold line, black frame. */
const leopard = p2({
  id: 'f-pat-leopard',
  name: '豹 Leopard',
  group: PATTERNS,
  style: {
    face: metalFace(PATTERN_GOLD, GRADIENTS.goldRamp, {
      bevel: { size: 3, depth: 3.5, gloss: 'ring', shadowColor: '#5a2a00' },
      amount: 0.75,
      glow: glow('#fff3b0', 1.4, 0.45, 0.35),
      cap: cap(0.36),
      pattern: pat('leopard', { color: '#140800', color2: '#b0580e', scale: 8, seed: 2, shade: 0.5, relief: 0.25 }),
    }),
    rims: [
      keyline(1, '#0a0400'),
      metalRim(1.6, GRADIENTS.goldRimFill, GRADIENTS.goldRamp, { size: 1.1, depth: 4, shadowColor: '#4a2200' }),
      blackFrame(3),
      base(1.4, 2.6, '#0a0200'),
    ],
  },
  effects: [fx('outerGlow', { color: '#ff8a20', size: 22, intensity: 0.55, spread: 0.05, mode: 'behind' })],
});

/** 虎柄: orange-gold with tapered black stripes, yellow line, black frame. */
const tiger = p2({
  id: 'f-pat-tiger',
  name: '虎 Tiger',
  group: PATTERNS,
  style: {
    face: metalFace(g([0, '#fffbe0'], [0.25, '#ffd040'], [0.55, '#ff8a00'], [0.8, '#c04a00'], [1, '#4a1400']), GRADIENTS.copperRamp, {
      bevel: { size: 3, depth: 3.5, gloss: 'ring', shadowColor: '#5a1a00' },
      amount: 0.45,
      glow: glow('#ffe8b0', 1.4, 0.45, 0.35),
      cap: cap(0.36),
      pattern: pat('tiger', { color: '#0a0400', scale: 6, angle: 6, seed: 4, shade: 0.55, relief: 0.3 }),
    }),
    rims: [
      keyline(1.1, '#0a0400'),
      metalRim(1.6, GRADIENTS.yellowFill, GRADIENTS.goldRamp, { size: 1.1, shadowColor: '#5a3000' }, 270, 0.4),
      blackFrame(3),
      base(1.4, 2.6, '#0a0200'),
    ],
  },
  effects: [
    fx('dropShadow', { angle: 90, distance: 6, size: 14, spread: 0.1, opacity: 0.55, color: '#2a0a00' }),
    fx('outerGlow', { color: '#ff7a10', size: 22, intensity: 0.6, spread: 0.05, mode: 'behind' }),
  ],
});

/** DANGER: yellow / black hazard tape face, white line, red metal frame (警告 / 危険 演出). */
const hazard = p2({
  id: 'f-pat-hazard',
  name: 'DANGER Hazard',
  group: PATTERNS,
  style: {
    face: metalFace(g([0, '#fffbd0'], [0.4, '#ffe600'], [1, '#e0a000']), null, {
      bevel: { size: 2.6, depth: 3, gloss: 'cove', highlightOpacity: 0.8, shadowColor: '#5a3a00', shadowOpacity: 0.5 },
      glow: glow('#fffbe0', 1, 0.35, 0.2),
      cap: cap(0.3, 0.42, 0.08, 0.2),
      pattern: pat('hazard', { color: '#0c0c0c', color2: '#ffe000', scale: 11, seed: 1, shade: 0.75, relief: 0.15 }),
    }),
    rims: [
      keyline(1.1, '#000000'),
      lightLine(1.4),
      metalRim(3.2, GRADIENTS.redFill, GRADIENTS.redRamp, { size: 2, shadowColor: '#3a0000' }),
      base(1.6, 2.8, '#1a0000'),
    ],
  },
  effects: [fx('outerGlow', { color: '#ff3a10', size: 22, intensity: 0.6, spread: 0.05, mode: 'behind' })],
});

/** 桜: pink lacquer with white blossoms, plum keyline, pale-gold frame. */
const sakura = p2({
  id: 'f-pat-sakura',
  name: '桜 Sakura Pink',
  group: PATTERNS,
  style: {
    face: metalFace(g([0, '#fff4f8'], [0.3, '#ffb0d0'], [0.6, '#f0508e'], [1, '#8a0a40']), null, {
      bevel: { size: 3, depth: 3.5, gloss: 'cove', highlightOpacity: 0.85, shadowColor: '#6a0030', shadowOpacity: 0.5 },
      glow: glow('#fff0f6', 1.6, 0.55, 0.3),
      cap: cap(0.4, 0.42, 0.1, 0.25),
      pattern: pat('sakura', { color: '#fff6fa', color2: '#ff4a8a', opacity: 0.9, scale: 11, seed: 6, shade: 0.6, relief: 0.2 }),
    }),
    rims: [
      keyline(1, '#3a0018'),
      lightLine(1.4),
      metalRim(2.8, GRADIENTS.paleGoldRimFill, GRADIENTS.paleGoldRamp, { size: 1.6, shadowColor: '#5a3a20' }),
      base(1.4, 2.6, '#1a0010'),
    ],
  },
  effects: [fx('outerGlow', { color: '#ff8ac0', size: 24, intensity: 0.6, spread: 0.05, mode: 'behind' })],
  companions: [companion('glints', 'scatter', { count: 8, size: 22, spread: 12, color: '#fff0f8', intensity: 100, seed: 8 })],
});

/** 青海波 和柄 gold: the wave motif embossed into the gold (relief only, CGWORLD: 和柄 in the bump slot at a low amount). */
const seigaiha = p2({
  id: 'f-pat-seigaiha',
  name: '青海波 和柄 Gold',
  group: PATTERNS,
  fontId: 'zen-old-mincho-black',
  style: {
    face: metalFace(PATTERN_GOLD, GRADIENTS.goldRamp, {
      bevel: { size: 2.6, depth: 4, gloss: 'ring', lightAltitude: 34, shadowColor: '#5a2a00' },
      amount: 0.85,
      glow: glow('#fff3b0', 1.2, 0.4, 0.35),
      cap: cap(0.32, 0.42, 0.1, 0.25),
      pattern: pat('seigaiha', { color: '#6a3a00', opacity: 0, scale: 9, seed: 1, shade: 1, relief: 0.6 }),
    }),
    rims: [
      keyline(0.8, '#1a0800'),
      metalRim(1.6, g([0, '#ff7a5a'], [0.45, '#d81a10'], [1, '#5a0400']), GRADIENTS.redRamp, { size: 1.1, shadowColor: '#3a0000' }),
      blackFrame(2.8),
      metalRim(1, GRADIENTS.goldRimFill, GRADIENTS.goldRamp, { size: 0.7, depth: 3, shadowColor: '#4a2200' }, 90),
      base(1.2, 2.4, '#0a0400'),
    ],
  },
  effects: [fx('outerGlow', { color: '#ffc040', size: 22, intensity: 0.5, spread: 0.05, mode: 'behind' })],
});

/** Racing checker: black / white chequer face, red line, black frame, chrome edge. */
const checker = p2({
  id: 'f-pat-checker',
  name: 'Checker チェッカー',
  group: PATTERNS,
  style: {
    face: metalFace(GRADIENTS.silverFill, GRADIENTS.silverRamp, {
      bevel: { size: 2.6, depth: 3.5, gloss: 'ring', shadowColor: '#1a2234' },
      amount: 0.4,
      glow: glow('#ffffff', 1, 0.35, 0.2),
      cap: cap(0.3),
      pattern: pat('checker', { color: '#0c0c10', color2: '#f4f6fa', scale: 6.5, angle: 0, seed: 1, shade: 0.7, relief: 0.1 }),
    }),
    rims: [
      keyline(0.9, '#05070c'),
      metalRim(1.6, GRADIENTS.redFill, GRADIENTS.redRamp, { size: 1.1, shadowColor: '#3a0000' }),
      blackFrame(2.6),
      metalRim(1, g([0, '#ffffff'], [0.45, '#b8c2d0'], [0.52, '#2c323c'], [1, '#ffffff']), GRADIENTS.silverRamp, { size: 0.7, depth: 3, shadowColor: '#1a2234' }, 90, 0.4),
      base(1.2, 2.4, '#04060c'),
    ],
  },
  effects: [fx('outerGlow', { color: '#ff4a3a', size: 20, intensity: 0.45, spread: 0.05, mode: 'behind' })],
});

// ======================================================================================
// Plates (shape layers: まくら / badges / bands). Dimensions are % of the shape height, so
// they are authored for plates around 300 px tall; on text they read as a puffy enamel look.
// ======================================================================================

const PLATES = 'Plates';

/** Red enamel badge: pure-red pillow face with a gloss cap, gold-gradient frame, dark keyline. */
const redPlate = p2({
  id: 'f-plate-red',
  name: 'Red Plate + Gold Rim',
  group: PLATES,
  style: {
    face: material2D(lin(g([0, '#ff8080'], [0.35, '#ff1a1a'], [0.7, '#cc0000'], [1, '#660000'])), {
      bevel: bevel2D({ profile: 'smooth', size: 6, depth: 4, gloss: 'cove', lightAltitude: 40, highlightOpacity: 0.8, shadowColor: '#4d0000', shadowOpacity: 0.55 }),
      innerGlow: glow('#ffd0c0', 2, 0.4, 0.15),
      gloss: cap(0.45, 0.42, 0.08, 0.3),
    }),
    rims: [
      keyline(0.8, '#2a0000'),
      metalRim(2.6, GRADIENTS.goldRimFill, GRADIENTS.goldRamp, { size: 1.8, depth: 4, gloss: 'ring', shadowColor: '#4a2200' }),
      keyline(1, '#140600'),
      base(1, 1.8, '#1a0000'),
    ],
  },
  effects: [fx('dropShadow', { angle: 90, distance: 8, size: 16, spread: 0.1, opacity: 0.55, color: '#3a0000' })],
});

/** 図柄 まくら: black lacquer pillow with a double gold frame. */
const makuraPlate = p2({
  id: 'f-plate-makura',
  name: 'まくら Black / Gold',
  group: PLATES,
  style: {
    face: material2D(lin(g([0, '#4a4a54'], [0.4, '#18181e'], [0.6, '#08080a'], [1, '#202028'])), {
      bevel: bevel2D({ profile: 'smooth', size: 7, depth: 5, gloss: 'cove', lightAltitude: 42, highlightOpacity: 0.7, shadowColor: '#000000', shadowOpacity: 0.6 }),
      innerGlow: glow('#ffd27a', 1.2, 0.25, 0.2),
      gloss: cap(0.3, 0.4, 0.06, 0.35),
    }),
    rims: [
      metalRim(1.6, GRADIENTS.goldRimFill, GRADIENTS.goldRamp, { size: 1.1, depth: 4, gloss: 'ring', shadowColor: '#4a2200' }),
      keyline(1.2, '#050505'),
      metalRim(2.4, GRADIENTS.goldRimFill, GRADIENTS.goldRamp, { size: 1.6, depth: 4, gloss: 'doubleRing', shadowColor: '#4a2200' }, 90),
      base(1, 1.8, '#000000'),
    ],
  },
  effects: [fx('outerGlow', { color: '#ffd27a', size: 18, intensity: 0.4, spread: 0.05, mode: 'behind' })],
});

/**
 * 北斗 plate stack: red metal letters with a diagonal white gloss streak, white and black lines,
 * then ONE angular plate around the whole word (PlateShape 'box', leaning with the text shear)
 * in cream, and a dropped black box base.
 */
const hokutoBox = p2({
  id: 'f-plate-hokuto-box',
  name: '北斗 Slanted Box Plate',
  group: PLATES,
  style: {
    face: metalFace(GRADIENTS.redFill, GRADIENTS.redRamp, {
      bevel: { size: 2.6, depth: 3.5, gloss: 'ring', shadowColor: '#3a0000' },
      amount: 0.6,
      glow: glow('#ffd6d6', 1, 0.35, 0.3),
      cap: cap(0.55, 0.5, 0.08, 0, -25),
    }),
    rims: [
      lightLine(1.4),
      keyline(1.8, '#000000'),
      rim2D(3.2, solid('#f4ead2', { bevel: bevel2D({ profile: 'chamfer', size: 1.2, depth: 3, gloss: 'linear', highlightOpacity: 0.6, shadowColor: '#5a4020', shadowOpacity: 0.5 }) }), {
        plate: plateShape({ kind: 'box', corner: 3, slant: 8 }),
      }),
      rim2D(1.6, solid('#000000'), { plate: plateShape({ kind: 'box', corner: 3, slant: 8 }), offsetX: 1.4, offsetY: 2.4 }),
    ],
  },
  effects: [fx('dropShadow', { angle: 90, distance: 6, size: 14, spread: 0.1, opacity: 0.55, color: '#1a0000' })],
});

// ======================================================================================
// 3D (Element 3D)
// ======================================================================================

export const THREE_D = '3D';

// 3D geometry notes (see engine/three/title.ts): a look is a LETTER (face, one bevel, side wall)
// with BANDS stacked behind it (Title3DProps.bands, innermost first). The letter's bevel sits
// OUTSIDE the outline (Title3DProps.bevelPosition): the face keeps the full glyph and the bevel
// adds its width to the silhouette, as does every band's grow, so the edge stays modest
// (≈1.5–2.5 % in all) or tight counters and neighbouring letters close up (titles add tracking
// ≈ 20 × that total, or thin dense kanji with the layer's weight). The letter's bevel is a
// chamfer or round (≈1–1.6 % of the size); a thin dark step ring seated where it ends draws the
// crisp edge line the 2D keyline gives. The outermost wall stays DARK: the inner walls of small
// counters show in perspective and a bright side floods them. Plates follow the rings, each grown
// beyond the previous solid, so a plate's grow is exactly the rim it shows.
// Reflectivity stays 0.7–0.9 (Element 3D advice: lower reads "refined", higher melts the edge).
// Every title look ends in a dark keyline plus a tight glow in its own colour (`edge3D`): the
// silhouette of real 3D titles always ends dark, never in the silver line a plate's top bevel
// catches at grazing angles.

export type P3 = Exclude<MaterialPreset, 'custom'>;

export function m3(preset: P3, o: Partial<Material3D> = {}): Material3D {
  return { ...material3D(preset), ...o };
}

/** Unbanded dark metal for side walls and edge lines. */
export const darkMetal = (color: string, roughness = 0.35): Material3D => ({ ...material3D('custom'), color, metalness: 1, roughness, reflectivity: 0.7 });

/** An edge ring: a band `width` beyond the solid in front of it, its bevel `width` wide and `drop` deep (seated by `letter3D`). */
interface Ring {
  width: number;
  drop: number;
  material: Material3D;
  profile: BevelProfile3D;
}

/** An edge ring (also used by the templates). */
export const ring = (width: number, drop: number, material: Material3D, profile: BevelProfile3D): Ring => ({ width, drop, material, profile });

/**
 * A look's letter and the bands behind it (also used by the templates). Each ring is a band
 * seated where the solid in front of it ends its bevel (offset −that solid's depth: the engine
 * stops it just behind the bevel end).
 * The letter is `depth` deep plus the drops of all rings, each ring `depth` plus the drops of the
 * rings after it, so every back lines up `depth` behind the last ring's bevel: one extrusion.
 * `side` walls the outermost ring (without rings, the letter: inner walls hide inside the bands
 * around them); `plates` follow the rings.
 */
export function letter3D(o: { depth: number; bevel: BevelShape3D; rings?: Ring[]; side?: Material3D; plates?: Band3D[] }): Pick<Title3DProps, 'depth' | 'bevel' | 'side' | 'bands'> {
  const rings = o.rings ?? [];
  const total = o.depth + rings.reduce((s, r) => s + r.drop, 0);
  let front = total;
  const edge = rings.map((r, i): Band3D => {
    const depth = front - r.drop;
    const band: Band3D = { ...band3D(r.width, 'custom'), depth, offset: -front, bevel: bevel3D(r.width, r.drop, r.profile), material: r.material };
    front = depth;
    return o.side && i === rings.length - 1 ? { ...band, side: o.side } : band;
  });
  const side = o.side && !rings.length ? { side: o.side } : {};
  return { depth: total, bevel: o.bevel, ...side, bands: [...edge, ...(o.plates ?? [])] };
}

/** A plate (also used by the templates): a band `grow` beyond the solid in front of it, counters filled, 10 deep, a 0.6 round top bevel; `o` / `mo` over the band / its material. */
export function plate(grow: number, preset: MaterialPreset, o: Partial<Band3D> = {}, mo: Partial<Material3D> = {}): Band3D {
  const b = band3D(grow, preset);
  return { ...b, fillCounters: true, depth: 10, bevel: bevel3D(0.6, 0.6), material: { ...b.material, ...mo }, ...o };
}

/** Black lacquer under-plate whose gloss stays dark at grazing angles (no silver rim line). */
export const blackPlate = (grow: number, o: Partial<Band3D> = {}, mo: Partial<Material3D> = {}) =>
  plate(grow, 'blackGloss', o, { reflectivity: 0.35, ...mo });

/**
 * The letter's bevel (1.6 % chamfer at 45°): narrow, since it widens the silhouette, and steep
 * enough that its facets still read light / dark against the face.
 */
const BEVEL = 1.6;
export const letterBevel = (profile: BevelProfile3D = 'chamfer', width = BEVEL) => bevel3D(width, width, profile);

/** Environment look; rotation slides the reflections across the metal. Punch tone mapping keeps saturated metals saturated in the highlights. */
export const envLook = (preset: EnvPreset, rotation: number, intensity = 1): LookLighting => ({
  environment: { preset, intensity, rotation, tint: '#ffffff', contrast: 1, saturation: 1, blur: 0, repeatX: 1, repeatY: 1 },
  toneMapping: 'punch',
  exposure: 1,
});

/** Studio HDRI (hard light sources → crisp "biki-tto" highlights). */
const studioEnv = (rotation: number): LookLighting => envLook('studio', rotation);

/**
 * Gold under the softbox HDRI: its broad panels keep every bevel facet lit, so the gold stays
 * saturated and bright head-on AND tilted — the studio's dark floor turns down-facing facets of a
 * saturated yellow metal olive. Measured on 大当り (gold-pixel HSV): softbox S 0.79 / V 0.85,
 * studio S 0.74 / V 0.79.
 */
const goldEnv = (rotation: number): LookLighting => envLook('softbox', rotation);

/** Light glow from the hottest highlights only: white-hot near them, the look's colour in the halo. */
export const glow3D = (color: string, intensity = 1.5) => [
  fx('deepGlow', { exposure: 0.5, threshold: 0.5, knee: 0.3, radius: 160, falloff: 35, intensity, tintAmount: 0.7, tintInner: '#ffffff', tintOuter: color }),
];

/** Dark keyline hugging the silhouette, then a tight glow in the title's colour around it. */
export const edge3D = (color: string, keyline = '#0a0604') => [
  fx('keyline', { width: 2.5, color: keyline, opacity: 1, softness: 0 }),
  fx('outerGlow', { color, size: 12, intensity: 1.4, spread: 0.3, opacity: 0.85, mode: 'behind' }),
];

/** A title look's effects: edge (keyline + hugging glow) then the highlight glow. */
export const fx3D = (color: string) => [...edge3D(color), ...glow3D(color)];

const goldEdge = () => ring(0.3, 0.6, darkMetal('#3a1000'), 'step');

const gold3D = p3({
  id: 'f-3d-gold',
  name: 'Element Gold',
  group: THREE_D,
  style3d: {
    curveSegments: 10,
    face: m3('gold', { reflectivity: 0.85 }),
    ...letter3D({ depth: 10, bevel: letterBevel(), rings: [goldEdge()], side: darkMetal('#4a1a00'), plates: [blackPlate(5, { depth: 7 })] }),
    shadow: shadow3D(),
    glint: glint3D(),
  },
  effects: fx3D('#ff9a1a'),
  lighting: goldEnv(25),
});

const chrome3D = p3({
  id: 'f-3d-chrome',
  name: 'Element Chrome',
  group: THREE_D,
  style3d: {
    curveSegments: 10,
    face: m3('chrome', { reflectivity: 0.85 }),
    ...letter3D({
      depth: 10,
      bevel: letterBevel(),
      rings: [ring(0.3, 0.6, darkMetal('#1a1e26'), 'step')],
      side: darkMetal('#2a2f38', 0.25),
      plates: [blackPlate(5, { depth: 7 })],
    }),
    shadow: shadow3D(),
    glint: glint3D(),
  },
  effects: [...edge3D('#7ab4ff', '#05070c'), ...glow3D('#bcd8ff')],
  lighting: studioEnv(-30),
});

/** Blender "Cornice Molding" / pachimoji 3-segment bevel: gold face, white band, red band. */
const cornice3D = p3({
  id: 'f-3d-cornice',
  name: 'Cornice Bands (gold / white / red)',
  group: THREE_D,
  style3d: {
    curveSegments: 10,
    face: m3('gold', { reflectivity: 0.8 }),
    ...letter3D({
      depth: 9,
      bevel: letterBevel('chamfer', 0.6),
      rings: [ring(0.2, 0.3, darkMetal('#2a0a00'), 'step'), ring(0.5, 0.4, m3('whiteGloss'), 'step'), ring(1, 1.2, m3('redMetal'), 'round')],
      side: darkMetal('#4a000a'),
      plates: [blackPlate(4.8, { depth: 6 })],
    }),
    shadow: shadow3D(),
    glint: glint3D(),
  },
  effects: fx3D('#ff6a1a'),
  lighting: goldEnv(25),
});

/** Element 3D under-plates (外枠): gold letters on a black then a red extruded plate. */
const goldPlate3D = p3({
  id: 'f-3d-gold-plate',
  name: 'Gold on Black/Red Plates (外枠)',
  group: THREE_D,
  style3d: {
    curveSegments: 10,
    face: m3('gold', { reflectivity: 0.85 }),
    ...letter3D({
      depth: 10,
      bevel: letterBevel(),
      rings: [goldEdge()],
      side: darkMetal('#4a1a00'),
      plates: [blackPlate(5, { depth: 8 }), plate(2.4, 'redMetal', { depth: 6, bevel: bevel3D(1.4, 1.4) })],
    }),
    shadow: shadow3D(),
    glint: glint3D(),
  },
  effects: fx3D('#ff7a10'),
  lighting: goldEnv(25),
});

/**
 * 虹 candy metal: the banded rainbow metal (vertical spectrum per line, so ATTACK / CHANCE both
 * carry the whole spectrum) with a gentle liquid surface, so the studio's hard lights break into
 * white streaks across the face and every hue shades deep → bright through the warped
 * reflections. A thin white gloss line then a chunky gold round band face the camera, so the rim
 * catches light head-on.
 */
const rainbow3D = p3({
  id: 'f-3d-rainbow',
  name: '虹 Rainbow Candy (gold rim)',
  group: THREE_D,
  style3d: {
    curveSegments: 10,
    face: m3('rainbow', { roughness: 0.14, surface: { kind: 'liquid', amount: 0.3, scale: 30, seed: 2 } }),
    // the white line is not the face's material: the letter has no bevel and every ring is a band
    ...letter3D({
      depth: 9,
      bevel: bevel3D(0, 0),
      rings: [ring(0.3, 0.4, m3('whiteGloss'), 'round'), ring(1.6, 1.6, m3('gold'), 'round'), goldEdge()],
      side: darkMetal('#4a1a00'),
      plates: [blackPlate(4.2, { depth: 7 }, { color: '#12001f' })],
    }),
    shadow: shadow3D(),
    glint: glint3D(),
  },
  effects: [...edge3D('#b040ff', '#0a0014'), ...glow3D('#fff4c8')],
  lighting: studioEnv(-20),
});

const silver3D = p3({
  id: 'f-3d-silver',
  name: 'Silver Premium',
  group: THREE_D,
  style3d: {
    curveSegments: 10,
    face: m3('silver', { reflectivity: 0.8 }),
    // the chrome bevel is not the silver face's material: it is a band, the letter has no bevel
    ...letter3D({
      depth: 10,
      bevel: bevel3D(0, 0),
      rings: [ring(BEVEL, BEVEL, m3('chrome', { reflectivity: 0.85 }), 'chamfer'), ring(0.3, 0.6, darkMetal('#14182a'), 'step')],
      side: darkMetal('#262b36', 0.25),
      plates: [blackPlate(4.8, { depth: 8 }), plate(2.2, 'blueMetal', { depth: 6, bevel: bevel3D(1.2, 1.2) })],
    }),
    shadow: shadow3D(),
    glint: glint3D(),
  },
  effects: [...edge3D('#4a8aff', '#05070c'), ...glow3D('#cfe4ff')],
  lighting: studioEnv(120),
});

const red3D = p3({
  id: 'f-3d-red',
  name: 'Red Metal',
  group: THREE_D,
  style3d: {
    curveSegments: 10,
    face: m3('redMetal', { reflectivity: 0.8 }),
    ...letter3D({
      depth: 10,
      bevel: letterBevel('chamfer', 1.1),
      rings: [ring(0.6, 0.6, m3('gold'), 'step'), ring(0.25, 0.5, darkMetal('#2a0004'), 'step')],
      side: darkMetal('#4a0008'),
      plates: [blackPlate(4.5, { depth: 8 })],
    }),
    shadow: shadow3D(),
    glint: glint3D(),
  },
  effects: fx3D('#ff2a10'),
  lighting: studioEnv(25),
});

/** Glint on the HDR specular highlights: soft bloom plus 4-point star streaks. */
export const starGlint = (o: Partial<Glint3D> = {}): Glint3D =>
  glint3D({ enabled: true, threshold: 1, intensity: 1, radius: 5, streaks: 4, length: 32, angle: 15, ...o });

/** 遊技機 gold pushed past physical (Spec / Env multipliers) under strip lights, with star glints. */
const punchyGold3D = p3({
  id: 'f-3d-punchy-gold',
  name: '派手金 Punchy Gold + Glint',
  group: THREE_D,
  style3d: {
    curveSegments: 10,
    face: m3('punchyGold'),
    ...letter3D({
      depth: 10,
      bevel: letterBevel('round'),
      rings: [goldEdge()],
      side: darkMetal('#4a1a00'),
      plates: [blackPlate(4.8, { depth: 8 }), plate(2.2, 'redMetal', { depth: 6, bevel: bevel3D(1.2, 1.2) })],
    }),
    shadow: shadow3D(),
    glint: starGlint({ intensity: 0.5, threshold: 1.6 }),
  },
  effects: fx3D('#ff8a10'),
  lighting: envLook('strips', 20),
});

/**
 * Gold-framed gem inlay. A gem body shows what the title has right behind it
 * (engine/three/materials.ts), and every band is a whole copy of the outline: a `bed` band flush
 * with the letters (no grow, no bevel) comes first, so the stone takes its colour (silver for
 * diamond, red metal for ruby) instead of the dark ring's; the frame rings follow, then a rim of
 * the bed and a black plate that separates it from the background.
 */
function gemInlay(id: string, name: string, gem: P3, bed: P3, glowCol: string, tint: string): StylePreset {
  const solids = letter3D({
    depth: 9,
    // the dark line is not the gem's material: the letter has no bevel and every ring is a band
    bevel: bevel3D(0, 0),
    rings: [ring(0.25, 0.4, darkMetal('#3a1000'), 'step'), ring(1.3, 1.3, m3('punchyGold'), 'chamfer'), goldEdge()],
    side: darkMetal('#4a1a00'),
    plates: [plate(1.2, bed, { depth: 3 }), blackPlate(3, { depth: 7 })],
  });
  // slid forward to just behind the face; the first ring then seats just behind the bed
  const stoneBed: Band3D = { ...band3D(0, bed), depth: 1, offset: -solids.depth, bevel: bevel3D(0, 0) };
  return p3({
    id,
    name,
    group: THREE_D,
    style3d: {
      curveSegments: 10,
      face: m3(gem, { flakes: 0.8, flakeScale: 0.8 }),
      ...solids,
      bands: [stoneBed, ...solids.bands],
      shadow: shadow3D(),
      glint: starGlint({ intensity: 0.7, threshold: 1.4, tint }),
    },
    effects: fx3D(glowCol),
    lighting: envLook('strips', -15),
  });
}

const diamond3D = gemInlay('f-3d-diamond', 'ダイヤ Diamond Inlay', 'diamond', 'silver', '#e8f4ff', '#f4faff');
const ruby3D = gemInlay('f-3d-ruby', 'ルビー Ruby', 'ruby', 'redMetal', '#ff2a40', '#ffe0e4');

/**
 * Candy-apple glitter paint with a chrome step and a white enamel plate (pop). The paint is a
 * deep red whose clear coat stays glossy (roughness 0.2): the studio's softboxes sit behind the
 * title (rotation 150) so they lay a sheen across the tops instead of washing a letter pink, and
 * a high frontal key light makes the glitter sparkle; only the hottest sparkles throw stars. The
 * keyline comes first, before the glows, so it hugs the silhouette and never the light.
 */
const candy3D = p3({
  id: 'f-3d-candy',
  name: 'キャンディ Candy Glitter',
  group: THREE_D,
  style3d: {
    curveSegments: 10,
    face: m3('candy', { color: '#b00016', roughness: 0.2 }),
    ...letter3D({
      depth: 10,
      bevel: letterBevel('round'),
      rings: [ring(0.35, 0.5, m3('chrome'), 'step'), ring(0.25, 0.4, darkMetal('#2a0008'), 'step')],
      side: darkMetal('#4a0010'),
      plates: [plate(4.7, 'whiteGloss', { depth: 7 }), blackPlate(1.6, { depth: 5, bevel: bevel3D(0.8, 0.8) }, { color: '#1a0008' })],
    }),
    shadow: shadow3D(),
    glint: starGlint({ intensity: 0.8, threshold: 1.3, length: 28, tint: '#ffe8f0' }),
  },
  effects: [...edge3D('#ff3a6a', '#1a0008'), ...glow3D('#ff3a6a')],
  lighting: {
    ...studioEnv(150),
    lights: [
      { id: uid(), type: 'directional', color: '#ffffff', intensity: 3, x: -300, y: 900, z: 900 },
      { id: uid(), type: 'ambient', color: '#ffffff', intensity: 0.3, x: 0, y: 0, z: 0 },
    ],
  },
});

/**
 * Element 3D Matte Shadow showcase: a gold title floating just above a lit panel. A nearly
 * frontal key light (a little upper left) drops a soft crimson shadow a short way below right of
 * the letters, never a black or far-offset blob; the edge has no hugging glow, which would bury
 * the shadow, only the dark keyline and the highlight glow. The softbox sits at rotation 0: its
 * dark horizon then stays a thin band across every letter instead of muddying one end of the title.
 */
const shadowGold3D = p3({
  id: 'f-3d-tinted-shadow',
  name: '影 Gold + Tinted Shadow',
  group: THREE_D,
  style3d: {
    curveSegments: 10,
    face: m3('gold', { reflectivity: 0.85 }),
    ...letter3D({ depth: 10, bevel: letterBevel(), rings: [goldEdge()], side: darkMetal('#4a1a00'), plates: [blackPlate(4.6, { depth: 7 }, { color: '#1a0800' })] }),
    shadow: shadow3D({ enabled: true, color: '#7a0c20', opacity: 0.85, softness: 0.4 }),
    glint: glint3D(),
  },
  effects: [fx('keyline', { width: 2.5, color: '#0a0604', opacity: 1, softness: 0 }), ...glow3D('#ff9a1a')],
  lighting: {
    ...goldEnv(0),
    lights: [
      { id: uid(), type: 'directional', color: '#fff4e0', intensity: 1.2, x: -400, y: 800, z: 2000 },
      { id: uid(), type: 'ambient', color: '#ffffff', intensity: 0.3, x: 0, y: 0, z: 0 },
    ],
  },
});

/** Red paint whose ramp runs front → back (Material3D.gradientAxis 'depth'): walls fade to black with depth. */
const depthRedWall = (): Material3D => ({
  ...material3D('custom'),
  color: '#c80000',
  gradient: g([0, '#ff2a00'], [0.35, '#d00000'], [1, '#160000']),
  gradientAxis: 'depth',
  metalness: 0.5,
  roughness: 0.3,
  reflectivity: 0.5,
  clearcoat: 0.4,
});

/**
 * 飛び出し (LUSTR 押し出し角度): a deep oblique extrusion whose red side walls show head-on
 * below-right of the gold letters, so they jump out toward the upper left; the walls fade to
 * black with depth and AO darkens the crevices between the bands and where the walls meet.
 */
const popout3D = p3({
  id: 'f-3d-popout',
  name: '飛び出し Pop-out Gold (skew + AO)',
  group: THREE_D,
  style3d: {
    curveSegments: 10,
    skew: { x: 0.35, y: -0.5 },
    face: m3('gold', { reflectivity: 0.85 }),
    ...letter3D({ depth: 24, bevel: letterBevel('chamfer', 1.3), rings: [goldEdge()], side: depthRedWall() }),
    shadow: shadow3D(),
    glint: starGlint({ intensity: 0.45, threshold: 1.6 }),
    ao: ao3D({ enabled: true, radius: 4, intensity: 1.2 }),
  },
  effects: [...edge3D('#ff3a10'), ...glow3D('#ffb43c')],
  lighting: goldEnv(25),
});

/**
 * 元祖 / ツラヌキ deep title: a straight deep extrusion whose red walls fade to black with depth
 * (no skew), a dark keyline and a red glow hugging the silhouette.
 */
const deepRed3D = p3({
  id: 'f-3d-deep-red-walls',
  name: '赤壁 Gold + Depth-fade Red Walls',
  group: THREE_D,
  style3d: {
    curveSegments: 10,
    face: m3('gold', { reflectivity: 0.85 }),
    ...letter3D({ depth: 18, bevel: letterBevel('chamfer', 1.3), rings: [goldEdge()], side: depthRedWall() }),
    shadow: shadow3D(),
    glint: glint3D(),
  },
  effects: [...edge3D('#ff1a00'), ...glow3D('#ff6a1a')],
  lighting: goldEnv(25),
});

/** Gold surface look: `surface` bends the reflections (液体金 liquid ripples, クシャ crumpled foil). */
function surfaceGold3D(id: string, name: string, surface: Material3D['surface'], glowCol: string): StylePreset {
  const gold = m3('gold', { reflectivity: 0.9, surface });
  return p3({
    id,
    name,
    group: THREE_D,
    style3d: {
      curveSegments: 10,
      face: gold,
      ...letter3D({ depth: 10, bevel: letterBevel('round', 1.3), rings: [goldEdge()], side: darkMetal('#4a1a00'), plates: [blackPlate(4.3, { depth: 7 })] }),
      shadow: shadow3D(),
      glint: glint3D(),
    },
    effects: fx3D(glowCol),
    lighting: goldEnv(25),
  });
}

const liquidGold3D = surfaceGold3D('f-3d-liquid-gold', '液体金 Liquid Gold', { kind: 'liquid', amount: 0.55, scale: 34, seed: 3 }, '#ff8a10');
const crumpleGold3D = surfaceGold3D('f-3d-crumple-gold', 'クシャ金 Crumpled Gold Foil', { kind: 'crumple', amount: 0.45, scale: 12, seed: 5 }, '#ff9a1a');

/**
 * 北斗-style slanted box plates: one angular plate around the WHOLE word (PlateShape 'box', leaning
 * with the text) instead of rings that follow every glyph bump: red, then a black base plate.
 */
const boxPlate3D = p3({
  id: 'f-3d-box-plate',
  name: '北斗 Slanted Box Plates',
  group: THREE_D,
  style3d: {
    curveSegments: 10,
    face: m3('gold', { reflectivity: 0.85 }),
    // A box base hugs the ink box (grown from the edge ring's outer edge), so its grow is the
    // margin around the bevelled letters.
    ...letter3D({
      depth: 9,
      bevel: letterBevel('chamfer', 1.2),
      rings: [goldEdge()],
      side: darkMetal('#4a1a00'),
      plates: [
        plate(3.4, 'redMetal', { depth: 5, shape: plateShape({ kind: 'box', corner: 3, slant: 12 }), bevel: { ...bevel3D(1.2, 1.2, 'chamfer'), segments: 1 } }),
        blackPlate(2.5, { depth: 7, shape: plateShape({ kind: 'box', corner: 4, slant: 12 }) }),
      ],
    }),
    shadow: shadow3D(),
    glint: glint3D(),
  },
  effects: [...edge3D('#ff3a10'), ...glow3D('#ffb43c')],
  lighting: goldEnv(25),
});

/**
 * ぷっくり inflate (Illustrator 3D Inflate): the face rises as a puffy height field from the
 * outline (the letter's bevel is ignored in this mode), candy paint over a white enamel plate and
 * a dark base.
 */
const inflate3D = p3({
  id: 'f-3d-inflate',
  name: 'ぷっくり Inflate Candy',
  group: THREE_D,
  style3d: {
    mode: 'inflate',
    inflate: { height: 24, profile: curve([0, 0], [0.25, 0.72], [1, 1]), smoothness: 0, detail: 1 },
    depth: 4,
    curveSegments: 12,
    face: m3('candy', { color: '#e0102a', roughness: 0.25, flakes: 0.3 }),
    bevel: bevel3D(0, 0),
    side: darkMetal('#4a0010'),
    bands: [plate(3, 'whiteGloss', { depth: 5, bevel: bevel3D(1.4, 1.4) }), blackPlate(4.6, { depth: 4 }, { color: '#1a0008' })],
    shadow: shadow3D(),
    glint: starGlint({ intensity: 0.5, threshold: 1.4, tint: '#ffe8f0' }),
  },
  effects: fx3D('#ff3a6a'),
  lighting: envLook('softbox', 30),
});

/**
 * Eye Candy-style inflate profile (x = distance from the edge over the title's widest inset): a
 * steep drop at the silhouette, a flat ledge (a frame round every glyph), a short steep step, then
 * a straight chisel rise to the ridge (crisp mitres down straight strokes) that rounds over only on
 * the widest strokes, so round ends dome.
 */
const LIQUID_PROFILE = curve([0, 0], [0.045, 0.11, true], [0.105, 0.11, true], [0.143, 0.2, true], [0.6, 0.74], [0.85, 0.94], [1, 1]);

/**
 * Liquid chrome in 3D: the face inflated over the outline's distance field with LIQUID_PROFILE,
 * on a fine grid so the ridges run straight, and lumpy like Eye Candy's ランプ surface. Light silver
 * metal mirrors the roadside photo (Autumn Road: overcast sky, trees, grey road; Eye Candy's 沿道),
 * graded grey and soft, with a low key light from the left.
 */
const liquidChrome3D: StylePreset = (() => {
  const chrome: Material3D = {
    ...material3D('custom'),
    color: '#d6d6d6',
    metalness: 1,
    roughness: 0.15,
    reflectivity: 1,
    surface: { kind: 'liquid', amount: 0.5, scale: 12, seed: 1 },
  };
  return p3({
    id: 'f-3d-chrome-liquid',
    name: '液体クローム Liquid Chrome (3D)',
    group: THREE_D,
    style3d: {
      mode: 'inflate',
      inflate: { height: 5.7, profile: LIQUID_PROFILE, smoothness: 10, detail: 4 },
      depth: 1,
      curveSegments: 12,
      face: chrome,
      bevel: bevel3D(0, 0),
      bands: [],
      shadow: shadow3D(),
      glint: glint3D(),
    },
    lighting: {
      environment: { preset: 'highway', intensity: 1.45, rotation: 0, tint: '#ffffff', contrast: 0.5, saturation: 0, blur: 0, repeatX: 1, repeatY: 1 },
      lights: [{ id: uid(), type: 'directional', color: '#ffffff', intensity: 1.2, x: -1000, y: -35, z: 155 }],
      toneMapping: 'punch',
      exposure: 1,
    },
  });
})();

/**
 * One vertical rainbow down the whole title: crimson top, hot pink, magenta, purple, blue, a long
 * cyan, green, then yellow only at the bottom.
 */
const GLASS_RAINBOW = g(
  [0, '#e00008'],
  [0.08, '#f80420'],
  [0.12, '#f7058d'],
  [0.19, '#ce129b'],
  [0.26, '#ac27bc'],
  [0.32, '#8424d7'],
  [0.37, '#3030e0'],
  [0.42, '#0a58e8'],
  [0.47, '#0aa0f2'],
  [0.53, '#09dcf8'],
  [0.6, '#05fbf6'],
  [0.7, '#08fac8'],
  [0.76, '#0ef76e'],
  [0.79, '#30ef19'],
  [0.82, '#d5fa31'],
  [0.86, '#f4ff20'],
  [0.92, '#ffff50'],
  [1, '#fff070'],
);

/**
 * 青ブタ虹 in 3D: the liquid-chrome profile inflated taller in saturated candy glass with one
 * vertical rainbow across the whole layer. The glass deepens toward its turned-away edges and the
 * ramp bends with the dome, so the green glows as a core inside the cyan; the face mirrors its own
 * softbox (big window highlights). Bands as rims, each a half-round tube: a cream inner glass
 * edge, one chunky gold tube, a dark brown separator, a slim gold tube and a black keyline; the
 * gold mirrors its own contrasty city street through big liquid lumps, so the rims carry broken
 * highlights along their length. A tight halo, pink above, cyan below.
 */
const rainbowGlassGold3D: StylePreset = (() => {
  const candy: Material3D = {
    ...material3D('custom'),
    gradient: GLASS_RAINBOW,
    gradientSpan: 'layer',
    gradientAngle: 90,
    gradientBend: 0.35,
    glassDepth: 1,
    metalness: 0,
    roughness: 0.15,
    clearcoat: 1,
    reflectivity: 1,
    surface: { kind: 'liquid', amount: 0.5, scale: 12, seed: 1 },
    // the part's own reflections; blur and repeat stay the layer's
    environment: { preset: 'softbox', intensity: 2.8, rotation: 30, tint: '#ffffff', contrast: 1.6, saturation: 1 },
  };
  const gold: Material3D = {
    ...material3D('custom'),
    color: '#ffe4a0',
    metalness: 1,
    roughness: 0.08,
    reflectivity: 1.6,
    surface: { kind: 'liquid', amount: 0.75, scale: 25, seed: 3 },
    environment: { preset: 'city', intensity: 4, rotation: 0, tint: '#ffffff', contrast: 1.8, saturation: 0 },
  };
  const cream: Material3D = { ...material3D('custom'), color: '#fff6e0', metalness: 1, roughness: 0.04, reflectivity: 2 };
  const tube = (grow: number, material: Material3D, profile: BevelProfile3D = 'tube'): Band3D => ({
    ...band3D(grow, 'custom'),
    join: 'round',
    depth: 1,
    bevel: { ...bevel3D(grow, profile === 'tube' ? grow / 2 : grow, profile), segments: 16 },
    material,
  });
  const look = p3({
    id: 'f-3d-rainbow-glass-gold',
    name: '青ブタ虹 Rainbow Glass + Gold Tubes (3D)',
    group: THREE_D,
    style3d: {
      mode: 'inflate',
      inflate: { height: 8, profile: LIQUID_PROFILE, smoothness: 10, detail: 4 },
      depth: 1,
      curveSegments: 12,
      face: candy,
      bevel: bevel3D(0, 0),
      // the two gold tubes are one "Gold"
      bands: [tube(1.6, cream), tube(3.2, { ...gold, link: 'gold' }), tube(0.45, darkMetal('#2a1200')), tube(1.4, { ...gold, link: 'gold' }), tube(1.33, m3('blackGloss', { reflectivity: 0.35 }), 'round')],
      shadow: shadow3D(),
      glint: glint3D(),
    },
    effects: [
      fx('outerGlow', {
        fill: 'gradient',
        gradient: g([0, '#ff20e0'], [0.45, '#ff30c0'], [0.6, '#4090ff'], [1, '#00e8ff']),
        size: 14,
        intensity: 1,
        spread: 0.2,
        opacity: 1,
        mode: 'behind',
      }),
    ],
    lighting: {
      environment: { preset: 'highway', intensity: 3.4, rotation: 0, tint: '#ffffff', contrast: 2.2, saturation: 0, blur: 0, repeatX: 1, repeatY: 1 },
      lights: [
        // a low key light from the left, and a fill from below the camera so the lower curves stay lemon, not olive
        { id: uid(), type: 'directional', color: '#ffffff', intensity: 1.5, x: -1000, y: -35, z: 155 },
        { id: uid(), type: 'directional', color: '#ffffff', intensity: 2.5, x: 0, y: -700, z: 1000 },
      ],
      toneMapping: 'punch',
      exposure: 1,
    },
  });
  return { ...look, links: { gold: { name: 'Gold' } } };
})();

// ======================================================================================
// 保留 orbs. Shape 'orb' is a true sphere in 3D: it takes the FACE material all round plus
// the bands (grown from its outline at the equator: the bezel); the letter's bevel, side and
// depth only apply when the look goes on text or another outline.
// ======================================================================================

const ORBS = '保留 Orbs';

export type OrbFinish = 'candy' | 'glass' | 'metal';

const ORB_FINISH_NAMES: Record<OrbFinish, string> = { candy: '保留 candy', glass: 'ガラス保留 Glass', metal: 'メタル保留 Metal' };

/**
 * Material model of a 保留 orb, before its colourway tint (colourways.ts `tintOrb`). Candy: tinted metallic
 * paint with fine glitter under a clear coat — the coat mirrors the softbox as one crisp window
 * highlight, the paint gives the body its colour. Glass: a clear tinted body with a little fire.
 * Metal: a satin metal (roughness 0.4) whose highlight is one soft blob: a mirror finish turns
 * the softbox panels into blocky rectangles on a sphere.
 */
function orbBody(finish: OrbFinish): Material3D {
  if (finish === 'candy') return m3('candy', { roughness: 0.3, flakes: 0.35, reflectivity: 1.1 });
  if (finish === 'glass') return { ...material3D('custom'), roughness: 0.02, transmission: 1, ior: 1.5, dispersion: 0.2, clearcoat: 1, reflectivity: 1.4, specBoost: 2 };
  return m3('gold', { preset: 'custom', roughness: 0.4, reflectivity: 1.2 });
}

/**
 * A 保留 orb look in a colourway: the finish's material model tinted per colourway, a thin chrome
 * bezel ring, under a softbox (no strip lights, whose arcs streak across a sphere), glint off.
 * Every colourway of one finish shares everything but the tint, so a set reads as one family.
 */
export function orbLook(finish: OrbFinish, colourway: Colourway): StylePreset {
  const face = tintOrb(orbBody(finish), colourway);
  const bezel = plate(3, 'chrome', { depth: 4, bevel: bevel3D(1.2, 1.2) });
  return p3({
    id: `f-orb-${finish}-${colourway}`,
    name: `${ORB_FINISH_NAMES[finish]} ${COLOURWAY_INFO[colourway].label}`,
    group: ORBS,
    style3d: {
      curveSegments: 10,
      face,
      ...letter3D({ depth: 10, bevel: bevel3D(1, 1.2), plates: [bezel] }),
      shadow: shadow3D(),
      glint: glint3D(),
    },
    lighting: envLook('softbox', 30),
  });
}

/** The candy family first (the default look of Shape ▸ Orb), then the glass and metal finishes. */
const ORB_PRESETS = [
  ...(['blue', 'green', 'red', 'gold', 'rainbow', 'white', 'purple'] as const).map((t) => orbLook('candy', t)),
  orbLook('glass', 'green'),
  orbLook('glass', 'purple'),
  orbLook('metal', 'gold'),
  orbLook('metal', 'silver'),
];

// ======================================================================================
// Effects-led looks
// ======================================================================================

const FX = 'Glow & Light';

/** Deep glow (light: highlights exposed +1 stop, long-tailed warm halo) on classic gold. */
const deepGlowGold = p2({
  id: 'f-fx-deepglow-gold',
  name: 'Deep Glow Gold',
  group: FX,
  style: classicGold.style!,
  effects: [fx('deepGlow', { exposure: 1, threshold: 0.45, knee: 0.3, radius: 240, falloff: 25, intensity: 2.5, tintAmount: 0.7, tintInner: '#ffe8a0', tintOuter: '#ff9010' })],
});

/** 大当り: gold with backlight god-rays, sparkles and deep glow. */
const jackpot = p2({
  id: 'f-fx-jackpot',
  name: '大当り Rays + Sparkles',
  group: FX,
  style: ladderBase(),
  companions: [
    companion('backlight', 'jackpot'),
    // After the deep glow: on the highlights of the title with its rays and glow, not glowed itself.
    companion('glints', 'highlights', { large: 4, small: 8, size: 36, seed: 5 }, { outer: true }),
  ],
  groupEffects: [fx('deepGlow', { exposure: 0.5, threshold: 0.5, knee: 0.3, radius: 160, falloff: 35, intensity: 1.2, tintAmount: 0.6, tintInner: '#fff0c0', tintOuter: '#ffa020' })],
});

/** Chrome with star glints on the brightest highlights. */
const chromeGlint = p2({
  id: 'f-fx-chrome-glint',
  name: 'Chrome Star Glints',
  group: FX,
  style: chrome2D.style!,
  effects: [fx('outerGlow', { color: '#d8ecff', size: 18, intensity: 0.45, spread: 0.05, mode: 'behind' })],
  companions: [companion('glints', 'stars')],
  groupEffects: [fx('gradientOverlay', glintOverlay({ angle: 30, position: -15, width: 40, softness: 85, double: true, color: '#ffffff', intensity: 55 }))],
});

export const FACTORY_STYLES: StylePreset[] = [
  ...OUTLINE_PRESETS,
  classicGold,
  hiroGold,
  ultimateGold,
  liquidGold2D,
  crumpleGold2D,
  paleGold,
  silverPremium,
  roseGold,
  copper,
  blackGold,
  blackSilver,
  chrome2D,
  satinChrome,
  liquidChrome,
  rainbowKakutei,
  rainbowGlassGold,
  hologram,
  glassRed,
  glassBlue,
  neon,
  neonKnockout,
  ice,
  fireRed,
  lightningBlue,
  coronaPurple,
  brushBlack,
  brushRed,
  brushKasure,
  zebraGold,
  giraffe,
  leopard,
  tiger,
  hazard,
  sakura,
  seigaiha,
  checker,
  redPlate,
  makuraPlate,
  hokutoBox,
  gold3D,
  chrome3D,
  cornice3D,
  goldPlate3D,
  boxPlate3D,
  rainbow3D,
  rainbowGlassGold3D,
  silver3D,
  red3D,
  punchyGold3D,
  liquidGold3D,
  crumpleGold3D,
  diamond3D,
  ruby3D,
  candy3D,
  inflate3D,
  liquidChrome3D,
  shadowGold3D,
  popout3D,
  deepRed3D,
  ...more3DLooks(),
  ...ORB_PRESETS,
  deepGlowGold,
  jackpot,
  chromeGlint,
];

/** Lookup for templates; throws on a missing id (factory ids are stable). */
export function factoryStyle(id: string): StylePreset {
  const p = FACTORY_STYLES.find((s) => s.id === id);
  if (!p) throw new Error(`Missing factory style ${id}`);
  return p;
}

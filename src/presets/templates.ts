import type { Companion } from '../generators/fromEffect';
import { particleGlow } from '../generators/particles';
import { createGeneratorLayer } from '../generators/registry';
import {
  backplate3D,
  band3D,
  createAdjustmentLayer,
  createBackgroundLayer,
  createGroupLayer,
  createTitle2DLayer,
  createTitle3DLayer,
  curve,
  defaultComp,
  erode2D,
  linearCurve,
  linearFill,
  material2D,
  material3D,
  pattern,
  shapeSource,
  solidFill,
  uid,
} from '../model/defaults';
import { freshLinks, withoutLink, type MaterialLinks } from '../model/links';
import { bandKey, rimKey, type TitleLayer } from '../model/parts';
import { sideMaterial, withCharSide } from '../model/sides';
import type {
  Adjustment,
  AdjustmentLayer,
  BackgroundLayer,
  BlendMode,
  CharAdjust,
  EffectInstance,
  Fill,
  GeneratorInstance,
  GeneratorLayer,
  Glint3D,
  Gradient,
  Layer,
  LayerSourceMask,
  LineAdjust,
  ParamValue,
  PartEffects,
  Project,
  ShapeKind,
  ShapeSource,
  Title2DLayer,
  Title3DLayer,
  Warp,
} from '../model/types';
import { applyPreset, placeLook } from './apply';
import { companion, factoryStyle, fx, orbLook, type OrbFinish } from './factory';
import { applyColourway, applyColourwayToProject } from './colourways';
import { ownGroupOf } from '../model/companions';
import { noLighting } from '../model/lighting';
import type { Colourway, StylePreset, Template } from './types';

// Complete starting documents ("New from template"). Each opens finished: a styled title on a
// mock backdrop. Backdrops are GUIDE layers (visible in the editor, excluded from the
// transparent PNG export) unless the backdrop is part of the artwork (the 新台入替 flyer burst);
// rays that belong to the art sit on their own real layer (`raysLayer`). Parts that belong
// together (button + label, plate + title, kicker + column) are grouped. Machine-asset
// templates (図柄, 保留, PUSH, カットイン, セリフ) are built from shape layers, warp, per-character
// faces and patterns, so every part stays editable. Three (rim glow, zebra clip, BIG BONUS groups)
// show off the layer model: part effects (a glow on one rim / band), clipping masks, nested groups
// and adjustment layers. The recipe templates at the end stack generator layers (registry presets,
// only placed) bottom → top as pachinko 演出 frames are composed: 激熱 plate, cut-in band, RUSH
// title, premium 虹 and 保留変化 一閃. Each stack is one group, so a Library colourway recolours all of it.

const g = (...stops: [number, string][]): Gradient => ({ stops: stops.map(([pos, color]) => ({ pos, color })) });

function backdrop(gradient: Gradient, companions: Companion[] = [], guide = true): BackgroundLayer {
  const bg = createBackgroundLayer();
  return withLook({ ...bg, guide, fill: { ...bg.fill, kind: 'radial', color: gradient.stops.at(-1)?.color ?? '#000000', gradient } }, { companions: [], refSize: 0 }, companions);
}

/**
 * The look a layer still has to get its companions (and group effects) from: `project()` places
 * them (placeLook) once the layer list is complete, since they become layers of their own.
 * Carried on the layer under a symbol, which spreads keep.
 */
const LOOK = Symbol('look');

interface PendingLook {
  preset: Pick<StylePreset, 'companions' | 'groupEffects' | 'refSize'>;
  extra: Companion[];
  /** Effects after the look's companions: they go on its group (they ran on the layer and them). */
  after?: EffectInstance[];
  colourway?: Colourway;
}

/** Names of the material links a layer's look brought (freshLinks), for the project's materialLinks. */
const LINKS = Symbol('links');

type WithLook<L> = L & { [LOOK]?: PendingLook; [LINKS]?: MaterialLinks };

/** `layer` marked to get `preset`'s companions and group effects, then `extra` ones (see LOOK). */
function withLook<L extends Layer>(layer: L, preset: PendingLook['preset'], extra: Companion[], colourway?: Colourway, after: EffectInstance[] = []): L {
  if (!preset.companions?.length && !preset.groupEffects?.length && !extra.length) return layer;
  const look: PendingLook = { preset, extra, ...(after.length ? { after } : {}), ...(colourway ? { colourway } : {}) };
  return { ...layer, [LOOK]: look };
}

interface LayerOpts {
  /** Factory style id, or a generated look (保留 orbs in a colourway). */
  preset: string | StylePreset;
  /** Recolour the whole layer to this colourway after the preset. */
  colourway?: Colourway;
  x?: number;
  y?: number;
  rotZ?: number;
  warp?: Partial<Warp>;
  /** Appended after the preset's own effects. */
  extraEffects?: EffectInstance[];
  /** Companions after the preset's own (after its group effects too: then they follow that group). */
  companions?: Companion[];
}

interface TitleOpts extends LayerOpts {
  size: number;
  /** Builtin font id, overriding the look's own font. */
  fontId?: string;
  shear?: number;
  tracking?: number;
  lineHeight?: number;
  /** 長体 (< 1) / 平体 (> 1): horizontal glyph scale of the whole text. */
  hScale?: number;
  vertical?: boolean;
  /** 詰め: proportional kana spacing 0..1. */
  tsume?: number;
  /** Per-character adjustments by code-point index (unset fields: no change). */
  chars?: Record<number, Partial<CharAdjust>>;
  /** Per-line adjustments by line index (a small 超 over a big 激アツ). */
  lines?: Record<number, Partial<LineAdjust>>;
  /** Per-character faces by index in a colourway's face colours (split-colour words: 激 red / アツ gold, 赤文字); in 3D the glyph's bands and side follow. */
  faces?: Record<number, Colourway>;
}

const NO_ADJUST: CharAdjust = { dx: 0, dy: 0, scale: 1, rotate: 0 };
const NO_LINE_ADJUST: LineAdjust = { scale: 1, dx: 0, dy: 0 };

/**
 * Preset (+ colourway, + extra effects and companions) onto a placed layer. The layer is placed and
 * warped first: applyPreset positions effect handles relative to it and keeps warp and transform;
 * the look's companions are placed by `project()` (withLook).
 */
function styled<L extends TitleLayer>(layer: L, o: LayerOpts): L {
  const placed = { ...layer, transform: { ...layer.transform, x: o.x ?? 0, y: o.y ?? 0, rotZ: o.rotZ ?? 0 }, warp: { ...layer.warp, ...o.warp } };
  const preset = typeof o.preset === 'string' ? factoryStyle(o.preset) : o.preset;
  let out = applyPreset(placed, preset, { applyFont: true, keepLinks: true }) as L;
  const fresh = freshLinks(out, preset.links);
  out = { ...(fresh.layer as L), [LINKS]: fresh.links };
  if (o.colourway) out = applyColourway(out, o.colourway) as L;
  const extra = (o.companions ?? []).map((c): Companion => (preset.groupEffects?.length ? { ...c, outer: true } : c));
  // Extra effects come after the whole look: with companions, on their group.
  const grouped = !!(preset.companions?.length || preset.groupEffects?.length);
  const after = grouped ? (o.extraEffects ?? []) : [];
  return withLook({ ...out, effects: [...out.effects, ...(grouped ? [] : (o.extraEffects ?? []))] }, preset, extra, o.colourway, after);
}

/** Text title: per-character adjustments and split-colour faces on top of the preset. */
function text<L extends TitleLayer>(layer: L, o: TitleOpts): L {
  if (layer.source.kind !== 'text') throw new Error('unreachable');
  const base = styled(
    {
      ...layer,
      source: {
        ...layer.source,
        size: o.size,
        shear: o.shear ?? 0,
        tracking: o.tracking ?? 0,
        lineHeight: o.lineHeight ?? layer.source.lineHeight,
        vertical: o.vertical ?? false,
        tsume: o.tsume ?? layer.source.tsume,
        hScale: o.hScale ?? layer.source.hScale,
        ...(o.fontId ? { fontId: o.fontId } : {}),
      },
    },
    o,
  );
  if (base.source.kind !== 'text') throw new Error('unreachable');
  const chars: Record<number, CharAdjust> = {};
  for (const [i, adj] of Object.entries(o.chars ?? {})) chars[+i] = { ...NO_ADJUST, ...adj };
  for (const [i, colourway] of Object.entries(o.faces ?? {})) {
    const t = applyColourway(base, colourway);
    const adj = chars[+i] ?? NO_ADJUST;
    if (t.kind === 'title2d') chars[+i] = { ...adj, face: withoutLink(t.style.face) };
    else if (t.kind === 'title3d' && base.kind === 'title3d') {
      const own = { ...adj, face3d: withoutLink(t.style3d.face), bands3d: t.style3d.bands.map((b) => withoutLink(b.material)) };
      chars[+i] = withCharSide(base.style3d, own, withoutLink(sideMaterial(t.style3d)));
    }
  }
  const lines: Record<number, LineAdjust> = {};
  for (const [i, adj] of Object.entries(o.lines ?? {})) lines[+i] = { ...NO_LINE_ADJUST, ...adj };
  return { ...base, source: { ...base.source, chars, lines } };
}

const title2D = (s: string, o: TitleOpts) => text(createTitle2DLayer(s), o);
const title3D = (s: string, o: TitleOpts & { rotX?: number; rotY?: number }): Title3DLayer => {
  const l = text(createTitle3DLayer(s), o);
  return { ...l, transform: { ...l.transform, rotX: o.rotX ?? 0, rotY: o.rotY ?? 0 } };
};

/** A parametric plate / badge / band layer (shape source) named `name`. */
function shape<L extends TitleLayer>(layer: L, name: string, kind: ShapeKind, size: number, o: LayerOpts & { src?: Partial<ShapeSource> }): L {
  return styled({ ...layer, name, source: { ...shapeSource(kind, size), ...o.src } }, o);
}

const shape2D = (name: string, kind: ShapeKind, size: number, o: LayerOpts & { src?: Partial<ShapeSource> }) =>
  shape(createTitle2DLayer(name), name, kind, size, o);
const shape3D = (name: string, kind: ShapeKind, size: number, o: LayerOpts & { src?: Partial<ShapeSource> }) =>
  shape(createTitle3DLayer(name), name, kind, size, o);

/**
 * PUSH button dome: an ellipse extruded shallow with one deep round band in the face material
 * (the bevel IS the dome), a thin dark edge, a chrome ring plate and a black outer plate. The
 * bands sit inside the ellipse, so the shape's size stays the button's footprint.
 */
function dome(layer: Title3DLayer, ring = true): Title3DLayer {
  const s = layer.style3d;
  const edge = { ...band3D(0.8, 1, 'custom', 'step'), material: { ...material3D('custom'), color: '#1a0c02', metalness: 1, roughness: 0.35 } };
  const chrome = { ...backplate3D(5, 'chrome'), depth: 6 };
  chrome.bevel = { ...chrome.bevel, width: 2.5, depth: 2.5 };
  const black = { ...backplate3D(2.5, 'blackGloss'), depth: 4 };
  black.bevel = { ...black.bevel, width: 1, depth: 1 };
  return {
    ...layer,
    style3d: {
      ...s,
      depth: 6,
      curveSegments: 24,
      bevelPosition: 'inside',
      bands: [{ ...band3D(30, 24, 'custom', 'round'), material: structuredClone(s.face) }, edge],
      backplates: ring ? [chrome, black] : [black],
    },
  };
}

/** Turns the 3D glint on (or retunes it). */
function glinted(l: Title3DLayer, o: Partial<Glint3D>): Title3DLayer {
  return { ...l, style3d: { ...l.style3d, glint: { ...l.style3d.glint, enabled: true, ...o } } };
}

/**
 * `members` (bottom → top) as one group named `name`: members sit directly below the group row.
 * Members that already belong to a group (the members of a nested group) keep their parent.
 * `companions` follow the group (placed by `project()`, see withLook).
 */
function group(name: string, members: Layer[], companions: Companion[] = []): Layer[] {
  const g = withLook(createGroupLayer(name), { companions: [], refSize: 0 }, companions);
  return [...members.map((m) => (m.parentId ? m : { ...m, parentId: g.id })), g];
}

/** Adjustment layer with settings `adj`, named after its type as in Photoshop; `clip` clips it to the layer below. */
function adjust(adj: Adjustment, clip = false): AdjustmentLayer {
  return { ...createAdjustmentLayer(adj.type), adjustment: adj, clip };
}

/**
 * A disc whose fill fades out well inside its rim (a radial span reaches 1 at the box corner, the
 * disc edge sits near 0.7), in the rays' ground colour: the alpha the clipped rays fade with.
 */
const fadingDisc = (color: string): Fill => ({
  ...linearFill({ stops: [{ pos: 0, color }, { pos: 0.3, color, alpha: 0.95 }, { pos: 0.62, color, alpha: 0 }, { pos: 1, color, alpha: 0 }] }),
  kind: 'radial',
});

/**
 * 集中線 sunburst that belongs to the artwork (exported, unlike a guide backdrop): two-colour
 * Sunburst wedges — `color` on a `color2` ground — painted on the pixels of a hidden 2D disc that
 * fades toward its rim (it follows the disc, Only on its pixels). A colourway turns the wedges to
 * its glow and the ground to its dark.
 */
function raysLayer(size: number, color: string, color2: string): Layer[] {
  const l = createTitle2DLayer('Rays mask');
  const disc: Title2DLayer = {
    ...l,
    name: 'Rays mask',
    visible: false,
    source: shapeSource('ellipse', size),
    style: { face: material2D(fadingDisc(color2)), rims: [], knockout: false, erode: erode2D() },
  };
  const rays = gen('sunburst', 'twoColourWedges', { name: 'Rays', params: { colorA: color, colorB: color2, follow: disc.id, centre: 'point', onLayer: 'clip' } });
  return [disc, { ...rays, companionOf: disc.id }];
}

/**
 * `preset3d`: the (factory id or generated) 3D look whose lighting every 3D layer gets as its
 * own (`style3d.lighting`, whatever look styled it); without one they set none, so they use the
 * comp's. The comp keeps the default lighting.
 */
function project(name: string, layers: Layer[], o: { width?: number; height?: number; preset3d?: string | StylePreset } = {}): Project {
  const comp = { ...defaultComp(), width: o.width ?? 1920, height: o.height ?? 1080 };
  const look = typeof o.preset3d === 'string' ? factoryStyle(o.preset3d) : o.preset3d;
  const lighting = look?.style3d?.lighting ?? noLighting();
  const lit = layers.map((l) => (l.kind === 'title3d' ? { ...l, style3d: { ...l.style3d, lighting: structuredClone(lighting) } } : l));
  const pending = lit.flatMap((l: WithLook<Layer>) => (l[LOOK] ? [{ id: l.id, look: l[LOOK] }] : []));
  const materialLinks: MaterialLinks = Object.assign({}, ...lit.map((l: WithLook<Layer>) => l[LINKS] ?? {}));
  let out: Project = {
    version: 10,
    name,
    comp,
    layers: lit.map((l: WithLook<Layer>) => {
      const { [LOOK]: _look, [LINKS]: _links, ...rest } = l;
      return rest as Layer;
    }),
    ...(Object.keys(materialLinks).length ? { materialLinks } : {}),
  };
  for (const { id, look } of pending) {
    out = placeLook(out, id, look.preset, look.extra);
    const own = ownGroupOf(out.layers, id);
    const after = look.after ?? [];
    if (own && after.length) out = { ...out, layers: out.layers.map((l) => (l === own ? { ...own, effects: [...own.effects, ...after] } : l)) };
    // The layer itself was recoloured with the look's own effects: recolour the rest of its look.
    const recolour = look.colourway;
    if (recolour) {
      const title = out.layers.find((l) => l.id === id)!;
      const recoloured = applyColourwayToProject(out, id, recolour);
      out = { ...recoloured, layers: recoloured.layers.map((l) => (l.id === id ? title : l)) };
    }
  }
  return out;
}

const BG_PURPLE = g([0, '#4a1060'], [0.55, '#14041e'], [1, '#000000']);
const BG_RED = g([0, '#5a0a0a'], [0.6, '#1a0204'], [1, '#000000']);
const BG_NAVY = g([0, '#10306a'], [0.6, '#040c22'], [1, '#000000']);
const BG_GOLD = g([0, '#4a3008'], [0.6, '#120a02'], [1, '#000000']);
const BG_GREEN = g([0, '#0a4a3a'], [0.6, '#03140f'], [1, '#000000']);

/** Sunburst wedges painted on the layer's own pixels (a backdrop's), centred on the comp. */
const wedges = (params: Record<string, ParamValue>): Companion => ({
  generator: {
    type: 'sunburst',
    params: {
      style: 'wedges',
      centre: 'point',
      onLayer: 'clip',
      x: 0,
      y: 0,
      widthVariation: 40,
      lengthVariation: 60,
      innerSoftness: 60,
      rotation: 0,
      alternate: false,
      colorB: '#ff4a1c',
      ...params,
    },
  },
  place: 'above',
});

const rays = (color: string, opacity: number, o: Record<string, number> = {}) => wedges({ rays: 36, width: 40, inner: 200, innerSoftness: 80, colorA: color, opacity, seed: 4, ...o });

/** One long anamorphic cross over the title plus a few small stars (not a scatter of clip-art stars). */
const hero = (o: Record<string, ParamValue> = {}) => companion('glints', 'hero', o);
/** A few large glints on the brightest highlight peaks plus small ones. */
const glints = (o: Record<string, ParamValue> = {}) => companion('glints', 'highlights', { large: 3, small: 5, size: 44, ...o });
/** Big flare stars on the three hottest highlight peaks. */
const stars = (o: Record<string, ParamValue>) => companion('glints', 'stars', { stars: 3, threshold: 85, ...o });

/** Sparks bursting off the layer's edge, out along its normal, in front of it, glowing. */
const EDGE_SPARKS: Companion = {
  generator: { type: 'particles', params: { emitter: 'layer', source: 'edge', travel: 180, distanceRandom: 100, cone: 30, glintMix: 5, count: 700, size: 6, seed: 4 } },
  place: 'above',
  blend: 'add',
  effects: [particleGlow(10)],
};

interface GenOpts {
  name?: string;
  blend?: BlendMode;
  opacity?: number;
  clip?: boolean;
  x?: number;
  y?: number;
  /** Placement over the preset (centre, radius, angle); the look stays the preset's. */
  params?: GeneratorInstance['params'];
  /** Effects over the preset's own (its glow, vignette…). */
  effects?: EffectInstance[];
  /** Recolour to this colourway after the preset (虹 bokeh, red sparks). */
  colourway?: Colourway;
}

/** Generator layer from the registry preset `presetId` of `type`, placed (and optionally colourway-recoloured) per `o`. */
function gen(type: string, presetId: string, o: GenOpts = {}): GeneratorLayer {
  const l = createGeneratorLayer(type, presetId);
  if (!l) throw new Error(`Unknown generator ${type}`);
  const out: GeneratorLayer = {
    ...l,
    name: o.name ?? l.name,
    blend: o.blend ?? l.blend,
    clip: o.clip ?? false,
    transform: { ...l.transform, x: o.x ?? 0, y: o.y ?? 0, opacity: o.opacity ?? l.transform.opacity },
    generator: { ...l.generator, params: { ...l.generator.params, ...o.params } },
    effects: [...l.effects, ...(o.effects ?? [])],
  };
  return o.colourway ? (applyColourway(out, o.colourway) as GeneratorLayer) : out;
}

export const TEMPLATES: Template[] = [
  {
    id: 't-kakutei-rainbow',
    name: '確定 (rainbow)',
    build: () =>
      project('確定', [
        backdrop(BG_PURPLE),
        title2D('確定', { preset: 'f-rainbow-kakutei', size: 400, tracking: -20, companions: [hero({ color: '#ffffff', seed: 9 })] }),
      ]),
  },
  {
    id: 't-gekiatsu-fire',
    name: '激アツ (fire red)',
    build: () => project('激アツ', [backdrop(BG_RED), title2D('激アツ', { preset: 'f-fire-gekiatsu', size: 340, shear: 12, tracking: -30, y: -20 })]),
  },
  {
    id: 't-gekiatsu-burst',
    name: '激アツ ギザギザ (激 red / アツ gold on a burst)',
    build: () =>
      project('激アツ', [
        backdrop(BG_RED, [rays('#ff7a2a', 18, { count: 30, inner: 320 })]),
        ...group('激アツ stamp', [
          shape2D('Burst plate', 'burst', 640, {
            preset: 'f-plate-makura',
            rotZ: -3,
            src: { aspect: 1.8, points: 22, inner: 0.8, jitter: 0.3, seed: 3 },
          }),
          title2D('激アツ', {
            preset: 'f-outline-gold',
            size: 280,
            shear: 10,
            tracking: -40,
            y: 10,
            faces: { 0: 'red' },
            chars: { 0: { scale: 1.18 } },
            companions: [glints({ size: 40, seed: 4 })],
          }),
        ]),
      ]),
  },
  {
    id: 't-oatari-3d',
    name: '大当り (3D gold + rays)',
    build: () =>
      project(
        '大当り',
        [
          backdrop(BG_GOLD),
          // The rays are part of the art (exported, recoloured with the title as one group).
          ...group('大当り', [
            ...raysLayer(1400, '#e8962a', '#2e1000'),
            // Glyphs thinned by the bands' width: the outside bevel ends on the font's outline, so
            // 当's narrow counters stay open.
            { ...title3D('大当り', { preset: 'f-3d-gold', size: 380, rotX: 8, rotY: -12, companions: [hero({ size: 64, heroWidth: 90 })] }), weight: -1.9 },
          ]),
        ],
        { preset3d: 'f-3d-gold' },
      ),
  },
  {
    id: 't-bigbonus-3d',
    name: 'BIG BONUS (3D gold plates)',
    build: () =>
      project(
        'BIG BONUS',
        [
          backdrop(BG_NAVY),
          title3D('BIG\nBONUS', {
            preset: 'f-3d-gold-plate',
            size: 260,
            tracking: 40,
            lineHeight: 1.02,
            rotX: 6,
            rotY: -8,
            companions: [hero({ heroStars: 2, heroAngle: -8 })],
          }),
        ],
        { preset3d: 'f-3d-gold-plate' },
      ),
  },
  {
    id: 't-bonus-ribbon',
    name: 'BONUS ribbon (arch warp)',
    build: () =>
      project('BONUS', [
        backdrop(BG_NAVY),
        ...group('BONUS ribbon', [
          shape2D('Ribbon', 'ribbon', 300, {
            preset: 'f-plate-red',
            y: -10,
            src: { aspect: 5, inner: 0.4, tail: { x: 55, y: 0, width: 0 } },
            warp: { style: 'arch', bend: 28 },
          }),
          title2D('BONUS', {
            preset: 'f-outline-gold',
            size: 220,
            tracking: 20,
            y: 10,
            warp: { style: 'arch', bend: 28 },
            companions: [stars({ size: 110, color: '#fff6d8', intensity: 120 })],
          }),
        ]),
      ]),
  },
  {
    id: 't-counter-100g',
    name: '+100G counter',
    build: () =>
      project('+100G', [
        backdrop(BG_NAVY),
        // Small + and G sit on the digits' baseline (per-character scale reflows the line).
        title2D('+100G', {
          preset: 'f-outline-gold',
          size: 320,
          shear: 12,
          tracking: -50,
          chars: { 0: { scale: 0.72, dy: 8 }, 4: { scale: 0.62 } },
          companions: [hero({ seed: 7 })],
        }),
      ]),
  },
  {
    id: 't-giji-ren',
    name: '擬似連 ×3 (slanted)',
    build: () =>
      project('擬似連', [
        backdrop(BG_NAVY, [rays('#3a8aff', 16, { count: 40, inner: 300 })]),
        title2D('擬似連×3', {
          preset: 'f-outline-blue',
          size: 230,
          shear: 14,
          tracking: -40,
          rotZ: -6,
          faces: { 3: 'gold', 4: 'gold' },
          chars: { 3: { scale: 1.1, dy: 6 }, 4: { scale: 1.45 } },
        }),
      ]),
  },
  {
    id: 't-horyu-orb',
    name: '保留 orbs (3D spheres)',
    build: () => {
      // The 保留 ladder as one matched candy set on true spheres, then the big ゼブラ metal orb
      // with a soft star glint.
      const orb = (size: number, x: number, y: number, finish: OrbFinish, colourway: Colourway) =>
        shape3D(`保留 ${colourway}`, 'orb', size, { preset: orbLook(finish, colourway), x, y });
      const row: Colourway[] = ['white', 'blue', 'green', 'red', 'gold', 'rainbow'];
      const main = orb(380, 0, 80, 'metal', 'zebra');
      return project(
        '保留',
        [
          backdrop(BG_PURPLE),
          ...row.map((t, i) => orb(130, -450 + i * 180, -310, 'candy', t)),
          glinted(main, { intensity: 0.4, threshold: 1.4, streaks: 4, length: 30, angle: 15 }),
        ],
        { preset3d: orbLook('candy', 'blue') },
      );
    },
  },
  {
    id: 't-push-button',
    name: 'PUSH button (3D candy dome)',
    build: () =>
      project(
        'PUSH',
        [
          backdrop(BG_RED),
          ...group('PUSH button', [
            glinted(dome(shape3D('Button', 'ellipse', 520, { preset: 'f-3d-candy' })), { intensity: 0.35, threshold: 1.5 }),
            title2D('PUSH', { preset: 'f-outline-white', size: 170, tracking: 30, y: 6 }),
          ]),
        ],
        { preset3d: 'f-3d-candy' },
      ),
  },
  {
    id: 't-zugara-7',
    name: '図柄 7 (まくら + 帯)',
    build: () =>
      project(
        '図柄 7',
        [
          backdrop(BG_GOLD),
          ...group('図柄 7', [
            shape2D('帯', 'rect', 170, { preset: 'f-plate-red', y: 0, src: { aspect: 5.2, corner: 8 } }),
            shape2D('まくら', 'rect', 560, { preset: 'f-plate-makura', src: { aspect: 0.82, corner: 22 } }),
            title2D('7', { preset: 'f-outline-red', size: 500, shear: 8, y: 10 }),
          ]),
        ],
        { height: 1080, width: 1080 },
      ),
  },
  {
    id: 't-serif',
    name: 'セリフ枠 (赤文字)',
    build: () => {
      const line = title2D('ここで決めろ！', { preset: 'f-brush-black', size: 150, tracking: -30, tsume: 1, y: 24 });
      const red = factoryStyle('f-brush-red').style;
      if (!red || line.source.kind !== 'text') throw new Error('unreachable');
      const chars = { ...line.source.chars, 3: { ...NO_ADJUST, scale: 1.12, face: structuredClone(red.face) }, 4: { ...NO_ADJUST, scale: 1.12, face: structuredClone(red.face) } };
      return project('セリフ', [
        backdrop(BG_GREEN),
        ...group('セリフ', [
          shape2D('セリフ枠', 'speech', 330, {
            preset: 'f-outline-white',
            y: 20,
            src: { aspect: 3.4, corner: 45, tail: { x: -60, y: -78, width: 18 } },
          }),
          { ...line, source: { ...line.source, chars } },
        ]),
      ]);
    },
  },
  {
    id: 't-cutin',
    name: 'カットイン band (チャンス)',
    build: () =>
      project('カットイン', [
        backdrop(BG_PURPLE),
        ...group('カットイン', [
          shape2D('Cut-in band', 'parallelogram', 300, {
            preset: 'f-plate-makura',
            src: { aspect: 7.5, slant: 20, corner: 2 },
            companions: [companion('sunburst', 'focusLines', { centre: 'point', onLayer: 'all' })],
          }),
          title2D('チャンス', { preset: 'f-outline-red', size: 230, shear: 20, tracking: -30, tsume: 1, y: 6 }),
        ]),
      ]),
  },
  {
    id: 't-kakutei-giraffe-3d',
    name: 'キリン柄 確定 (3D glint)',
    build: () => {
      // Silhouette first (real キリン柄 titles keep the glyph dominant): an open-countered black
      // gothic, large soft patches (1–2 per stroke, partly see-through), a warm gold round band
      // WITHOUT patches (marks on a bevel read as mud), a wide dark keyline, then a thick dark
      // plate and a gold frame plate. The glyphs are thinned (weight) by the bands' width, so the
      // outside bands end on the font's outline and keep its counters open.
      const t = title3D('確定', { preset: 'f-3d-gold', colourway: 'giraffe', size: 400, tracking: -20, rotX: 6, rotY: -6 });
      if (t.source.kind !== 'text') throw new Error('unreachable');
      const s = t.style3d;
      const darkMetal = { ...material3D('custom'), color: '#1a0800', metalness: 1, roughness: 0.4, reflectivity: 0.6 };
      const face = { ...s.face, pattern: { ...s.face.pattern, color: '#6a300a', opacity: 0.85, scale: 15, relief: 0.2 } };
      const warmBand = { ...material3D('gold'), reflectivity: 0.8 };
      const darkPlate = { ...backplate3D(4.4, 'custom'), depth: 7, face: darkMetal };
      darkPlate.bevel = { ...darkPlate.bevel, width: 0.8, depth: 0.8 };
      const goldPlate = { ...backplate3D(1.8, 'gold'), depth: 5 };
      goldPlate.bevel = { ...goldPlate.bevel, width: 1.2, depth: 1.2 };
      const title: Title3DLayer = {
        ...t,
        weight: -1.8,
        source: { ...t.source, fontId: 'zen-kaku-gothic-black' },
        style3d: {
          ...s,
          face,
          bands: [
            { ...band3D(1.2, 1.2, 'custom', 'round'), material: warmBand },
            { ...band3D(0.6, 0.6, 'custom', 'step'), material: darkMetal },
          ],
          backplates: [darkPlate, goldPlate],
        },
      };
      return project(
        '確定',
        [
          backdrop(BG_GOLD, [rays('#ffb43c', 18, { inner: 280 })]),
          glinted(title, { intensity: 0.35, threshold: 1.5, streaks: 4, length: 30, angle: 15 }),
        ],
        { preset3d: 'f-3d-gold' },
      );
    },
  },
  {
    id: 't-shindai-flyer',
    name: '新台入替 (gold flyer)',
    build: () =>
      project('新台入替', [
        backdrop(
          g([0, '#ffcf3a'], [0.35, '#e0400a'], [1, '#5a0000']),
          [wedges({ rays: 32, width: 50, widthVariation: 20, lengthVariation: 0, inner: 0, colorA: '#ffe066', alternate: true, colorB: '#c81400', opacity: 55, seed: 2 })],
          false,
        ),
        title2D('新台入替', { preset: 'f-gold-classic', size: 300, shear: 8, tracking: -20 }),
      ]),
  },
  {
    id: 't-chance',
    name: 'チャンス / CHANCE (green / blue)',
    build: () =>
      project('チャンス', [
        backdrop(BG_GREEN),
        ...group('チャンス', [
          title2D('チャンス', { preset: 'f-outline-green', size: 300, shear: 10, tracking: -40, tsume: 1, y: 70 }),
          title2D('CHANCE', { preset: 'f-outline-blue', size: 150, shear: 10, tracking: 40, y: -170 }),
        ]),
      ]),
  },
  {
    id: 't-gekinetsu-brush',
    name: '激熱 brush (vertical 1080×1920)',
    build: () =>
      project(
        '激熱',
        [
          backdrop(BG_RED),
          title2D('激熱', {
            preset: 'f-brush-red',
            size: 600,
            vertical: true,
            lineHeight: 1,
            tracking: -60,
            companions: [companion('fire', 'blaze')],
          }),
        ],
        { width: 1080, height: 1920 },
      ),
  },
  {
    id: 't-premium',
    name: 'プレミアム (black gloss mincho)',
    build: () =>
      project('プレミアム', [
        backdrop(g([0, '#5a6a90'], [0.45, '#18203a'], [1, '#000000'])),
        // Weight + (Offset Path on the glyphs) so the hairline mincho strokes hold the frame.
        {
          ...title2D('プレミアム', {
            preset: 'f-black-silver',
            size: 300,
            tracking: -40,
            tsume: 1,
            companions: [stars({ size: 120, color: '#ffffff', intensity: 130 })],
          }),
          weight: 2.2,
        },
      ]),
  },
  {
    id: 't-rainbow-3d',
    name: 'ATTACK CHANCE (3D 虹, two lines)',
    build: () =>
      project(
        'ATTACK CHANCE',
        [
          backdrop(BG_PURPLE, [rays('#c060ff', 14, { inner: 300 })]),
          title3D('ATTACK\nCHANCE', {
            preset: 'f-3d-rainbow',
            size: 230,
            lineHeight: 1.02,
            tracking: 40,
            shear: 8,
            rotX: 6,
            rotY: -10,
            companions: [glints({ large: 4, small: 6, size: 64, threshold: 40, spectral: true, color: '#ffffff', intensity: 140 })],
          }),
        ],
        { preset3d: 'f-3d-rainbow' },
      ),
  },
  {
    id: 't-popout-3d',
    name: '飛び出し RUSH (3D skew + AO)',
    build: () =>
      project(
        'RUSH',
        [
          backdrop(BG_RED, [rays('#ff6a2a', 18, { inner: 280 })]),
          title3D('RUSH', { preset: 'f-3d-popout', size: 380, shear: 10, tracking: 40, y: 20 }),
        ],
        { preset3d: 'f-3d-popout' },
      ),
  },
  {
    id: 't-cho-gekiatsu',
    name: '超 / 激アツ (line scale)',
    build: () =>
      project('超激アツ', [
        backdrop(BG_RED),
        title2D('超\n激アツ', {
          preset: 'f-fire-gekiatsu',
          colourway: 'red',
          size: 300,
          shear: 10,
          tracking: -30,
          lineHeight: 0.92,
          // A small gold 超 tucked over the left of a big red 激アツ.
          lines: { 0: { scale: 0.5, dx: -36, dy: -6 } },
          faces: { 0: 'gold' },
        }),
      ]),
  },
  {
    id: 't-satin-chrome',
    name: 'SPECIAL (satin chrome)',
    build: () =>
      project('SPECIAL', [
        backdrop(BG_NAVY),
        title2D('SPECIAL', {
          preset: 'f-chrome-satin',
          size: 260,
          shear: 10,
          tracking: -20,
          companions: [stars({ size: 120, color: '#ffffff', intensity: 120 })],
        }),
      ]),
  },
  {
    id: 't-hokuto-box',
    name: '北斗-style slanted box plate (2D)',
    build: () =>
      project('覇王伝説', [
        backdrop(g([0, '#3a0a06'], [0.6, '#100202'], [1, '#000000'])),
        // One angular plate leaning with the text shear around the whole word, not rings that
        // follow every glyph bump; the face carries a diagonal white gloss streak.
        title2D('覇王伝説', { preset: 'f-plate-hokuto-box', size: 260, shear: 12, tracking: -30 }),
      ]),
  },
  {
    id: 't-kanzen-fukkatsu',
    name: '完全復活 vertical liquid gold + 転生 kicker',
    build: () =>
      project(
        '完全復活',
        [
          backdrop(g([0, '#3a2a10'], [0.55, '#100a04'], [1, '#000000'])),
          // A horizontal kicker over a vertical column: two orientations, so two layers, grouped.
          ...group('完全復活', [
            { ...title2D('完全復活', { preset: 'f-gold-liquid', size: 360, vertical: true, lineHeight: 1, tracking: -70, y: -110 }), weight: 1.2 },
            { ...title2D('転生', { preset: 'f-gold-liquid', size: 190, tracking: -20, y: 740 }), weight: 1.2 },
          ]),
        ],
        { width: 1080, height: 1920 },
      ),
  },
  {
    id: 't-push-inflate',
    name: 'PUSH button (3D inflate)',
    build: () =>
      project(
        'PUSH',
        [
          backdrop(BG_NAVY),
          ...group('PUSH button', [
            glinted(shape3D('Button', 'ellipse', 520, { preset: 'f-3d-inflate' }), { intensity: 0.35, threshold: 1.5 }),
            title2D('PUSH', { preset: 'f-outline-white', size: 170, tracking: 30, y: 10 }),
          ]),
        ],
        { preset3d: 'f-3d-inflate' },
      ),
  },
  {
    id: 't-ganso-3d',
    name: '元祖 3D (depth-fade red walls, white 元祖)',
    build: () =>
      project(
        '元祖',
        [
          backdrop(BG_RED),
          // 元祖 small, white all through (face, bands, side) by per-character override; the red
          // walls fade to black with depth; one long horizontal hero beam. Thinned glyphs keep the
          // small 元祖 open under the outside bands.
          {
            ...title3D('元祖ツラヌキ', {
              preset: 'f-3d-deep-red-walls',
              size: 260,
              shear: 12,
              tracking: 10,
              tsume: 1,
              rotX: 14,
              rotY: -20,
              faces: { 0: 'white', 1: 'white' },
              chars: { 0: { scale: 0.66 }, 1: { scale: 0.66 } },
              companions: [hero({ heroWidth: 110, heroCross: 10, heroStars: 2, color: '#fff0e0' })],
            }),
            weight: -1,
          },
        ],
        { preset3d: 'f-3d-deep-red-walls' },
      ),
  },
  {
    id: 't-yaku-80',
    name: '約80% (small–big–small, 3D gold)',
    build: () =>
      project(
        '約80%',
        [
          backdrop(BG_NAVY),
          // 約 and % at 0.56 reflow on the digits' baseline (no manual offsets); thinned glyphs
          // keep the small 約 open under the outside bands.
          {
            ...title3D('約80%', {
              preset: 'f-3d-gold',
              size: 360,
              shear: 8,
              tracking: 20,
              chars: { 0: { scale: 0.56 }, 3: { scale: 0.56 } },
              companions: [hero({ heroWidth: 80, size: 70 })],
            }),
            weight: -1.6,
          },
        ],
        { preset3d: 'f-3d-gold' },
      ),
  },
  {
    id: 't-neon-knockout',
    name: 'FEVER hollow neon (knockout)',
    build: () =>
      project('FEVER', [
        backdrop(BG_PURPLE, [rays('#ff4ad0', 22, { inner: 120, count: 28 })]),
        title2D('FEVER', { preset: 'f-neon-knockout', size: 300, tracking: 40, shear: 6 }),
      ]),
  },
  {
    id: 't-kasure-brush',
    name: '覚醒 かすれ dry brush',
    build: () =>
      project('覚醒', [
        backdrop(g([0, '#7a0a0a'], [0.6, '#200202'], [1, '#000000'])),
        title2D('覚醒', { preset: 'f-brush-kasure', size: 520, tracking: -60 }),
      ]),
  },
  {
    id: 't-gekiatsu-rim-glow',
    name: '激アツ rim glow + red echo (part effect, Hue/Saturation)',
    build: () => {
      // The Outer Glow sits on the OUTERMOST rim only (a part effect), so it hugs the red frame
      // instead of haloing the whole title. The dropped base is left out (an offset ring would be
      // the outermost rim); the ladder's Drop Shadow carries the weight.
      const gekiatsu = (name: string, x: number, y: number): Title2DLayer => {
        const t = title2D('激アツ', { preset: 'f-outline-gold', size: 320, shear: 12, tracking: -30, x, y, chars: { 0: { scale: 1.15 } } });
        const rims = t.style.rims.filter((r) => r.offsetX === 0 && r.offsetY === 0);
        const outer = rims.at(-1);
        if (!outer) throw new Error('unreachable');
        const partEffects: PartEffects = {};
        partEffects[rimKey(outer.id)] = [fx('outerGlow', { color: '#ffb000', size: 36, intensity: 1.8, spread: 0.1, opacity: 0.9 })];
        return { ...t, name, style: { ...t.style, rims }, effects: t.effects.filter((e) => e.type !== 'outerGlow'), partEffects };
      };
      return project('激アツ', [
        backdrop(BG_RED),
        ...group('激アツ', [
          // The echo: the same title under it, turned red by a Hue/Saturation layer clipped to it.
          gekiatsu('激アツ echo', 34, 26),
          adjust({ type: 'hueSaturation', hue: 0, saturation: 80, lightness: -12, colorize: true }, true),
          gekiatsu('激アツ', 0, -10),
        ]),
      ]);
    },
  },
  {
    id: 't-kakutei-zebra-clip',
    name: '確定 gold + zebra (clipping mask, Curves)',
    build: () => {
      // Zebra stripes on a plain shape layer clipped to the title (⌥⌘G): they only show inside
      // the lettering and stay editable on their own; Multiply keeps the gold under the white
      // ground. A Curves S-curve clipped to the title adds punch to the title alone.
      const zebra = createTitle2DLayer('Zebra');
      return project('確定', [
        backdrop(BG_PURPLE),
        ...group('確定', [
          title2D('確定', { preset: 'f-gold-classic', size: 400, tracking: -20 }),
          {
            ...zebra,
            name: 'Zebra',
            clip: true,
            blend: 'multiply',
            source: { ...shapeSource('rect', 520), aspect: 2.2, corner: 0 },
            style: {
              face: material2D(solidFill('#ffffff'), { pattern: pattern({ kind: 'zebra', color: '#000000', opacity: 0.9, scale: 14, angle: -20, seed: 3 }) }),
              rims: [],
              knockout: false,
              erode: erode2D(),
            },
          },
          adjust({ type: 'curves', channels: { rgb: curve([0, 0], [0.25, 0.18], [0.75, 0.86], [1, 1]), r: linearCurve(), g: linearCurve(), b: linearCurve() } }, true),
        ]),
      ]);
    },
  },
  {
    id: 't-bigbonus-3d-groups',
    name: 'BIG BONUS 3D (band glow, nested groups, Photo Filter)',
    build: () => {
      // Band 1 (the face-edge bevel) alone glows, a part effect: the gold bevel lights up without
      // haloing the plates. The title group (with its own hero sparkle) sits inside the plate +
      // rays group, so the stamp moves and recolours as one; a warming Photo Filter on top grades
      // everything below it.
      const t = title3D('BIG BONUS', { preset: 'f-3d-gold', size: 220, tracking: 30, shear: 6, rotX: 6, rotY: -10 });
      const band1 = t.style3d.bands[0];
      if (!band1) throw new Error('unreachable');
      const partEffects: PartEffects = {};
      partEffects[bandKey(band1.id)] = [fx('outerGlow', { color: '#ffd060', size: 30, intensity: 1.4, spread: 0.05, opacity: 0.85, mode: 'add' })];
      return project(
        'BIG BONUS',
        [
          backdrop(BG_NAVY),
          ...group('BIG BONUS stamp', [
            ...raysLayer(1500, '#e8962a', '#1a0a2e'),
            shape2D('Plate', 'parallelogram', 340, { preset: 'f-plate-red', src: { aspect: 5.4, slant: 12, corner: 3 } }),
            ...group('BIG BONUS', [{ ...t, partEffects }], [hero({ heroStars: 2, heroAngle: -8 })]),
          ]),
          adjust({ type: 'photoFilter', color: '#ec8a00', density: 30, preserveLuminosity: true }),
        ],
        { preset3d: 'f-3d-gold' },
      );
    },
  },
  {
    id: 't-recipe-gekinetsu',
    name: '激熱 plate (集中線 + fire + 火の粉)',
    build: () =>
      project('激熱', [
        backdrop(BG_RED),
        ...group('激熱', [
          gen('speedLines', 'focusRed', { name: '集中線', blend: 'add', params: { rx: 640, ry: 300 } }),
          // Fire wreath behind the glyphs and the three strokes (dark keyline, gold line, dark frame).
          title2D('激熱', { preset: 'f-fire-gekiatsu', size: 400, shear: 10, tracking: -30, companions: [glints({ seed: 5 })] }),
          gen('particles', 'embers', { name: '火の粉', blend: 'add', y: -80 }),
        ]),
      ]),
  },
  {
    id: 't-recipe-cutin',
    name: 'カットイン帯 (流線 masked to the 帯 + edge lightning + セリフ)',
    build: () => {
      // The 流線 and the huge faint English type behind the character show only inside the
      // diagonal 帯 (a layer mask from its bare shape, the hidden 帯 mask), over the band and the
      // edge lightning and sparks that follow it.
      const tilt = -10;
      const big = title2D('CHANCE', { preset: 'f-outline-white', size: 420, shear: 12, tracking: 40, rotZ: tilt });
      const bandOpts = { rotZ: tilt, src: { aspect: 7, slant: 18, corner: 2 } };
      const band = shape2D('帯', 'parallelogram', 320, { preset: 'f-plate-makura', ...bandOpts, companions: [companion('lightning', 'electrify'), EDGE_SPARKS] });
      const shape = { ...shape2D('帯 mask', 'parallelogram', 320, { preset: 'f-plate-makura', ...bandOpts }), visible: false, effects: [] };
      const inBand = (): LayerSourceMask[] => [{ id: uid(), kind: 'layer', enabled: true, invert: false, feather: 0, density: 1, linked: false, layerId: shape.id, channel: 'alpha' }];
      const lines = gen('speedLines', 'flowDiag', { name: '流線', blend: 'add', params: { angle: -tilt } });
      return project('カットイン', [
        backdrop(BG_NAVY),
        ...group('カットイン', [
          shape,
          band,
          { ...lines, masks: inBand() },
          { ...big, masks: inBand(), transform: { ...big.transform, opacity: 0.14 } },
          title2D('ここで決めろ！', { preset: 'f-brush-black', size: 200, tracking: -30, tsume: 1, rotZ: tilt, y: 10 }),
        ]),
      ]);
    },
  },
  {
    id: 't-recipe-rush',
    name: 'RUSH title (sunburst + 集中線 + glitter, bokeh, flare)',
    build: () =>
      project('RUSH', [
        backdrop(BG_RED),
        ...group('RUSH', [
          gen('sunburst', 'redGold', { name: '放射' }),
          gen('speedLines', 'focus', { name: '集中線', blend: 'add', opacity: 0.6, params: { rx: 660, ry: 300 } }),
          gen('particles', 'bokeh', { name: 'ボケ', blend: 'screen' }),
          gen('particles', 'goldDust', { name: '金粉', blend: 'add' }),
          title2D('RUSH', {
            preset: 'f-gold-classic',
            size: 420,
            shear: 10,
            tracking: 20,
            companions: [glints({ seed: 3 }), companion('lensFlare', 'gold', { follow: '' })],
          }),
        ]),
      ]),
  },
  {
    id: 't-recipe-premium-rainbow',
    name: 'Premium 虹 (rainbow tunnel + shards + 虹 bokeh)',
    build: () => {
      const t = title2D('PREMIUM', {
        preset: 'f-rainbow-kakutei',
        size: 280,
        shear: 8,
        tracking: 10,
        companions: [glints({ large: 4, small: 8, size: 56, spectral: true, color: '#ffffff', seed: 6 })],
      });
      // 虹 digits wear a THICK white rim: the look's inner white line, widened.
      const title = { ...t, style: { ...t.style, rims: t.style.rims.map((r, i) => (i === 0 ? { ...r, width: 3.4 } : r)) } };
      return project('PREMIUM', [
        backdrop(BG_PURPLE),
        ...group('PREMIUM', [
          gen('speedLines', 'rainbow', { name: '虹トンネル', blend: 'add', params: { rx: 620, ry: 300 } }),
          shape2D('Crystal', 'burst', 620, {
            preset: 'f-ice',
            src: { aspect: 1.9, points: 16, inner: 0.75, jitter: 0.25, seed: 5 },
            extraEffects: [fx('shatter', { pattern: 'glass', pieces: 120, radius: 700, seed: 2 })],
          }),
          gen('particles', 'bokeh', { name: '虹ボケ', blend: 'screen', colourway: 'rainbow' }),
          title,
        ]),
      ]);
    },
  },
  {
    id: 't-recipe-horyu-issen',
    name: '保留変化 一閃 (ink burst + light pillar + ring glow)',
    build: () =>
      project(
        '保留変化',
        [
          // The scene, desaturated by a Hue/Saturation layer; the 保留 stack above stays in colour.
          backdrop(g([0, '#9ab8c8'], [0.55, '#4a6474'], [1, '#14202a'])),
          adjust({ type: 'hueSaturation', hue: 0, saturation: -85, lightness: 0, colorize: false }),
          ...group('保留', [
            gen('brushSwirl', 'ink', { name: '墨', params: { radius: 300 } }),
            // Pillar, ring and sparks in the orb's colourway.
            gen('lightStreaks', 'anamorphic', { name: '光柱', blend: 'add', params: { angle: 90 }, colourway: 'red' }),
            shape3D('保留', 'orb', 240, { preset: orbLook('candy', 'red') }),
            gen('shockwave', 'halo', { name: 'Ring glow', blend: 'add', params: { radius: 160 }, colourway: 'red' }),
            gen('particles', 'goldDust', { name: 'Sparks', blend: 'add', params: { rx: 260, ry: 260 }, colourway: 'red' }),
          ]),
        ],
        { preset3d: orbLook('candy', 'red') },
      ),
  },
];

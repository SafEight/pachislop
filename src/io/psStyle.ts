import {
  readPsd,
  type BlendMode as PsdBlendMode,
  type Color,
  type EffectContour,
  type EffectNoiseGradient,
  type EffectSolidGradient,
  type GradientStyle,
  type LayerEffectBevel,
  type LayerEffectsInfo,
  type LayerEffectStroke,
  type Layer as PsdLayer,
  type UnitsValue,
} from 'ag-psd';
import { GrdT, parseEffects, readVersionAndDescriptor } from 'ag-psd/dist/descriptor';
import { createReader, readSignature, readUint16, readUint32, skipBytes } from 'ag-psd/dist/psdReader';
import { bevel2D, curve, erode2D, material2D, pattern, rim2D, satin2D, solidFill, uid } from '../model/defaults';
import { hexToRgb } from '../model/gradient';
import type { Bevel2D, Curve, EffectInstance, Fill, FillKind, GlossContour, Gradient, GradientStop, Material2D, PatternKind, Rim2D, Satin2D } from '../model/types';
import { fx } from '../presets/factory';
import type { StylePreset } from '../presets/types';
import { errorMsg, joinMsgs, msg, MsgError, type Msg, type Text } from '../store/msg';

// Photoshop layer-style import: the layer effects of a .psd (every layer that has some) or the
// styles of an .asl style library become 2D user presets.
//
// Mapping (Photoshop → this app):
// - Stroke(s) → rims. Rims grow outward from the face, so strokes are ordered by how far they
//   reach (outside = size, centre = size / 2, inside drawn outside) and a stroke hidden under a
//   wider one above it is dropped. Colour / gradient (Shape Burst included) fills carry over.
// - Colour / gradient overlay → the face fill, mixed over the base colour (text colour) by
//   opacity; pattern overlay → the closest procedural pattern by name.
// - Bevel & Emboss → the face bevel (inner / outer / emboss / pillow), or the bevel of every rim
//   for Stroke Emboss; technique → profile, Contour → custom profile, gloss contour → the named
//   GlossContour or a custom curve.
// - Satin → Material2D.satin; Inner Glow → the face inner glow.
// - Outer Glow / Drop Shadow / Inner Shadow → the outerGlow / dropShadow / innerShadow effects
//   ("Use Global Light" kept: the effect then follows comp.globalLight).
// Sizes: style dimensions are % of the source size, so px become % of the PS layer's font size
// (or a size the user confirms); effect params stay px with `refSize` = that size, so applyPreset
// rescales them to the target layer.

// ag-psd 33 rejects the Stroke effect's Shape Burst gradient type ('GrdT.shapeburst' is missing
// from Photoshop's published terminology, so its enum lacks it) and then drops the layer's WHOLE
// style. Decode it as a 'shapeburst' style instead; `gradientFill` maps it to 'shapeBurst'.
const decodeGrdT = GrdT.decode;
GrdT.decode = (v: string) => (v === 'GrdT.shapeburst' ? ('shapeburst' as GradientStyle) : decodeGrdT(v));

/** A layer style found in a file, before conversion. */
export interface PsStyleSource {
  name: string;
  /** Where it came from, shown to the user ('text layer', 'layer', 'style library'). */
  origin: Text;
  effects: LayerEffectsInfo;
  /** Face colour under the overlays: the text colour, else white. */
  baseColor: string;
  /** Font size in px when the style sits on a text layer: the reference for % conversion. */
  fontPx: number | null;
  /** Size offered for confirmation when the font size is unknown (layer height, else 100 px). */
  suggestedPx: number;
  /** How `fontPx` / `suggestedPx` was derived. */
  sizeNote: Text;
  /** Document global light (effects with "Use Global Light"), degrees. */
  globalAngle: number;
  globalAltitude: number;
  /** Document resolution, for effect sizes stored in points / mm. */
  ppi: number;
  /** Photoshop Fill Opacity 0..1 (layer blending option; 1 for style libraries). */
  fillOpacity: number;
  /** Photoshop Knockout (layer blending option; false for style libraries). */
  knockout: boolean;
}

export interface PsStyleFile {
  styles: PsStyleSource[];
  /** Styles that could not be read, one line each. */
  skipped: Msg[];
}

export interface ConvertedStyle {
  preset: StylePreset;
  /** What was mapped ('2 rims', 'gradient face', 'bevel'…). */
  summary: Text[];
  /** Approximations and dropped settings. */
  notes: Text[];
}

/** Library group of imported presets (the library lists every user preset under My Styles). */
const GROUP = 'My Styles';
const DEFAULT_PX = 100;

// ---------------------------------------------------------------------------------------------
// Reading

/** Reads the styles of a .psd (layers with effects) or an .asl style library. */
export async function readPsStyles(file: File): Promise<PsStyleFile> {
  const buffer = await file.arrayBuffer();
  const sig = new TextDecoder('latin1').decode(new Uint8Array(buffer, 0, Math.min(6, buffer.byteLength)));
  if (sig.startsWith('8BPS')) return psdStyles(buffer);
  if (sig.slice(2, 6) === '8BSL') return aslStyles(buffer);
  throw new MsgError(msg('Not a Photoshop file: choose a .psd or an .asl style library'));
}

const hasEnabled = (fx: LayerEffectsInfo) =>
  !fx.disabled &&
  Object.values(fx).some((v) => (Array.isArray(v) ? v.some((e) => e?.enabled) : typeof v === 'object' && v !== null && 'enabled' in v && v.enabled));

/** Every layer (groups included, top → bottom) with at least one enabled effect. */
export function psdStyles(buffer: ArrayBuffer): PsStyleFile {
  const psd = readPsd(buffer, { skipLayerImageData: true, skipCompositeImageData: true, skipThumbnail: true, skipLinkedFilesData: true, useImageData: true });
  const res = psd.imageResources?.resolutionInfo;
  const ppi = res ? (res.horizontalResolutionUnit === 'PPCM' ? res.horizontalResolution * 2.54 : res.horizontalResolution) : 72;
  const globalAngle = psd.imageResources?.globalAngle ?? 120;
  const globalAltitude = psd.imageResources?.globalAltitude ?? 30;
  const styles: PsStyleSource[] = [];
  const walk = (layers: PsdLayer[] | undefined) => {
    // ag-psd lists children bottom → top; the Layers panel (and this list) goes top → bottom.
    for (const l of [...(layers ?? [])].reverse()) {
      if (l.effects && hasEnabled(l.effects)) styles.push(layerSource(l, l.effects, { ppi, globalAngle, globalAltitude }));
      walk(l.children);
    }
  };
  walk(psd.children);
  if (!styles.length) throw new MsgError(msg('No layer in this PSD has layer effects'));
  return { styles, skipped: [] };
}

function layerSource(l: PsdLayer, effects: LayerEffectsInfo, doc: Pick<PsStyleSource, 'ppi' | 'globalAngle' | 'globalAltitude'>): PsStyleSource {
  const name = l.name?.trim() || 'PS style';
  const blending = { fillOpacity: clamp(l.fillOpacity ?? 1, 0, 1), knockout: !!l.knockout };
  const height = Math.max(0, (l.bottom ?? 0) - (l.top ?? 0));
  const suggestedPx = height > 0 ? Math.round(height) : DEFAULT_PX;
  const text = l.text;
  const style = text?.style ?? text?.styleRuns?.[0]?.style;
  const color = style?.fillColor;
  const baseColor = color ? colorHex(color) : '#ffffff';
  if (!text || !style?.fontSize)
    return { name, origin: 'layer', effects, baseColor, fontPx: null, suggestedPx, sizeNote: height > 0 ? 'layer height' : 'unknown size', ...doc, ...blending };
  // Type size is in points; free-transforming a text layer scales its matrix instead of the size.
  const [, , yx = 0, yy = 1] = text.transform ?? [];
  const k = Math.hypot(yx, yy) || 1;
  const fontPx = Math.round(style.fontSize * k * (doc.ppi / 72) * 10) / 10;
  const vars = { pt: round(style.fontSize), k: round(k), ppi: round(doc.ppi) };
  const scaled = Math.abs(k - 1) > 0.005;
  const sizeNote =
    doc.ppi !== 72
      ? msg(scaled ? 'font {pt} pt × {k} at {ppi} ppi' : 'font {pt} pt at {ppi} ppi', vars)
      : msg(scaled ? 'font {pt} pt × {k}' : 'font {pt} pt', vars);
  return { name, origin: 'text layer', effects, baseColor, fontPx, suggestedPx: fontPx, sizeNote, ...doc, ...blending };
}

/**
 * Styles of a Photoshop style library: version 2, '8BSL', patterns version, the pattern block
 * (skipped: bitmap patterns have no equivalent here), then per style its length, a name / id
 * descriptor and a style descriptor whose 'Lefx' holds the same effects as a layer's 'lfx2'.
 */
export function aslStyles(buffer: ArrayBuffer): PsStyleFile {
  const r = createReader(buffer);
  if (readUint16(r) !== 2 || readSignature(r) !== '8BSL') throw new MsgError(msg('Not a Photoshop style library (.asl)'));
  readUint16(r);
  skipBytes(r, readUint32(r));
  const count = readUint32(r);
  const styles: PsStyleSource[] = [];
  const skipped: Msg[] = [];
  for (let i = 0; i < count; i++) {
    const length = readUint32(r);
    const start = r.offset;
    let name = `Style ${i + 1}`;
    try {
      const ident = readVersionAndDescriptor(r) as { 'Nm  '?: string };
      name = ident['Nm  ']?.replace(/\0/g, '').trim() || name;
      const desc = readVersionAndDescriptor(r) as { Lefx?: Parameters<typeof parseEffects>[0] };
      const effects = desc.Lefx ? parseEffects(desc.Lefx, false) : null;
      if (effects && hasEnabled(effects))
        styles.push({
          name,
          origin: 'style library',
          effects,
          baseColor: '#ffffff',
          fontPx: null,
          suggestedPx: DEFAULT_PX,
          sizeNote: 'unknown size',
          ppi: 72,
          globalAngle: 120,
          globalAltitude: 30,
          fillOpacity: 1,
          knockout: false,
        });
      else skipped.push(msg('{name}: no layer effects (blending options only)', { name }));
    } catch (e) {
      skipped.push(msg('{name}: {error}', { name, error: errorMsg(e) }));
    }
    // Style blocks are padded to 4 bytes.
    r.offset = start + Math.ceil(length / 4) * 4;
  }
  if (!styles.length) throw new MsgError(skipped.length ? msg('No usable styles ({list})', { list: joinMsgs(skipped, '; ') }) : msg('The style library is empty'));
  return { styles, skipped };
}

// ---------------------------------------------------------------------------------------------
// Values

const round = (v: number) => Math.round(v * 100) / 100;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** `v` in px: layer styles store px, but points / physical units occur in hand-made files. */
function toPx(u: UnitsValue | undefined, ppi: number, fallback: number): number {
  if (!u) return fallback;
  const k: Partial<Record<UnitsValue['units'], number>> = { Points: ppi / 72, Picas: ppi / 6, Inches: ppi, Millimeters: ppi / 25.4, Centimeters: ppi / 2.54 };
  return u.value * (k[u.units] ?? 1);
}

const hex2 = (v: number) =>
  Math.round(clamp(v, 0, 1) * 255)
    .toString(16)
    .padStart(2, '0');
const rgbHex = (r: number, g: number, b: number) => `#${hex2(r)}${hex2(g)}${hex2(b)}`;

/** sRGB hex of a Photoshop colour (RGB, float RGB, HSB, CMYK naive, grey, Lab D50). */
export function colorHex(c: Color): string {
  if ('r' in c) return rgbHex(c.r / 255, c.g / 255, c.b / 255);
  if ('fr' in c) return rgbHex(c.fr, c.fg, c.fb);
  if ('h' in c) {
    const f = (n: number) => {
      const k = (n + c.h / 60) % 6;
      return c.b - c.b * c.s * Math.max(0, Math.min(k, 4 - k, 1));
    };
    return rgbHex(f(5), f(3), f(1));
  }
  if ('c' in c) {
    const k = 1 - c.k / 255;
    return rgbHex((1 - c.c / 255) * k, (1 - c.m / 255) * k, (1 - c.y / 255) * k);
  }
  if ('l' in c) {
    // Lab (D50) → XYZ → linear sRGB (Bradford-adapted matrix) → sRGB.
    const fy = (c.l * 100 + 16) / 116;
    const fx = fy + c.a / 500;
    const fz = fy - c.b / 200;
    const inv = (t: number) => (t ** 3 > 0.008856 ? t ** 3 : (t - 16 / 116) / 7.787);
    const [X, Y, Z] = [0.9642 * inv(fx), inv(fy), 0.8249 * inv(fz)];
    const lin = [3.1339 * X - 1.6169 * Y - 0.4906 * Z, -0.9788 * X + 1.9161 * Y + 0.0335 * Z, 0.0719 * X - 0.229 * Y + 1.4052 * Z];
    const [r, g, b] = lin.map((v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.max(0, v) ** (1 / 2.4) - 0.055));
    return rgbHex(r, g, b);
  }
  return rgbHex(1 - c.k / 255, 1 - c.k / 255, 1 - c.k / 255);
}

function mixHex(a: string, b: string, t: number): string {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  return rgbHex(ar + (br - ar) * t, ag + (bg - ag) * t, ab + (bb - ab) * t);
}

/** Photoshop contour (0..255 grid) as a Curve; PS files don't keep the corner flags, so every point is smooth. */
function contourCurve(c: EffectContour): Curve {
  const pts = c.curve.map((p) => [clamp(p.x / 255, 0, 1), clamp(p.y / 255, 0, 1)] as [number, number]).sort((a, b) => a[0] - b[0]);
  if (!pts.length || pts[0][0] > 0) pts.unshift([0, pts[0]?.[1] ?? 0]);
  if (pts[pts.length - 1][0] < 1) pts.push([1, pts[pts.length - 1][1]]);
  return curve(...pts);
}

const isLinearContour = (c: EffectContour | undefined) => !c || c.curve.every((p) => Math.abs(p.x - p.y) <= 2);

/** Photoshop's preset gloss contours (English and Japanese names) that have a named equivalent here. */
const GLOSS_NAMES: [RegExp, GlossContour][] = [
  [/^(linear|線形)$/i, 'linear'],
  [/^(ring|リング)$/i, 'ring'],
  [/^(ring - double|リング - ダブル)$/i, 'doubleRing'],
  [/^(cove - (deep|shallow)|くぼみ)/i, 'cove'],
  [/^(rounded steps|ステップ)/i, 'roundedSteps'],
  [/^(sawtooth|のこぎり)/i, 'sawtooth'],
];

function glossOf(c: EffectContour | undefined): Pick<Bevel2D, 'gloss' | 'glossCurve'> {
  const named = c && GLOSS_NAMES.find(([re]) => re.test(c.name.trim()))?.[1];
  if (named) return { gloss: named, glossCurve: contourCurve(c) };
  if (isLinearContour(c)) return { gloss: 'linear', glossCurve: curve([0, 0], [1, 1]) };
  return { gloss: 'custom', glossCurve: contourCurve(c!) };
}

/** Procedural pattern for a Photoshop pattern name (bitmap patterns themselves can't be imported). */
const PATTERN_NAMES: [RegExp, PatternKind][] = [
  [/zebra|ゼブラ|シマウマ/i, 'zebra'],
  [/tiger|タイガー|虎|トラ/i, 'tiger'],
  [/giraffe|キリン/i, 'giraffe'],
  [/leopard|豹|ヒョウ|レオパード/i, 'leopard'],
  [/check|市松|チェック/i, 'checker'],
  [/hazard|danger|caution|警告/i, 'hazard'],
  [/stripe|ストライプ|縞/i, 'stripes'],
  [/dot|polka|ドット|水玉/i, 'dots'],
  [/sakura|cherry|桜/i, 'sakura'],
  [/seigaiha|青海波/i, 'seigaiha'],
  [/asanoha|麻の葉/i, 'asanoha'],
  [/shippo|七宝/i, 'shippo'],
  [/kikko|亀甲/i, 'kikko'],
  [/uroko|鱗/i, 'uroko'],
];

const patternKind = (name: string | undefined): PatternKind | null => (name ? (PATTERN_NAMES.find(([re]) => re.test(name))?.[1] ?? null) : null);

/** Photoshop gradient (colour stops; each stop's midpoint shapes the segment before it) as stops. */
function gradientStops(g: EffectSolidGradient, notes: Text[]): Gradient {
  const src = [...g.colorStops].sort((a, b) => a.location - b.location);
  const stops: GradientStop[] = [];
  for (const [i, s] of src.entries()) {
    const prev = src[i - 1];
    if (prev && Math.abs(s.midpoint - 0.5) > 0.02 && s.location > prev.location) {
      // The 50 % colour sits at the midpoint instead of halfway.
      stops.push({ pos: prev.location + s.midpoint * (s.location - prev.location), color: mixHex(colorHex(prev.color), colorHex(s.color), 0.5) });
    }
    stops.push({ pos: clamp(s.location, 0, 1), color: colorHex(s.color) });
  }
  if (g.opacityStops.some((o) => o.opacity < 0.99)) notes.push(msg('gradient “{name}”: transparency stops ignored', { name: g.name }));
  return { stops: stops.length ? stops : [{ pos: 0, color: '#ffffff' }] };
}

const FILL_KINDS: Record<string, FillKind> = { linear: 'linear', radial: 'radial', angle: 'angle', reflected: 'reflected', diamond: 'diamond', shapeburst: 'shapeBurst' };

interface GradientInfo {
  gradient?: EffectSolidGradient | EffectNoiseGradient;
  style?: string;
  angle?: number;
  scale?: number;
  reverse?: boolean;
  offset?: { x: number; y: number };
}

/**
 * Fill for a Photoshop gradient. PS angles run counter-clockwise from the start stop towards the
 * end stop (90 = bottom → top); Fill.angle is clockwise on screen (90 = top → bottom).
 */
function gradientFill(g: GradientInfo, notes: Text[]): Fill | null {
  if (!g.gradient) return null;
  if (g.gradient.type === 'noise') {
    notes.push(msg('noise gradient “{name}” is not supported', { name: g.gradient.name }));
    return null;
  }
  const grad = gradientStops(g.gradient, notes);
  if (g.reverse) grad.stops = grad.stops.map((s) => ({ ...s, pos: 1 - s.pos })).reverse();
  const psAngle = g.angle ?? 90;
  const a = (psAngle * Math.PI) / 180;
  // Offset is a fraction of the box; keep its component along the gradient axis (screen y is down).
  const along = g.offset ? g.offset.x * Math.cos(a) - g.offset.y * Math.sin(a) : 0;
  return {
    kind: FILL_KINDS[g.style ?? 'linear'] ?? 'linear',
    color: grad.stops[0].color,
    gradient: grad,
    angle: (((360 - psAngle) % 360) + 360) % 360,
    scale: clamp(g.scale ?? 1, 0.05, 4),
    offset: clamp(along, -1, 1),
    span: 'layer',
  };
}

/** `over` painted on top of `under` at `opacity` (normal blend): solid over gradient mixes every stop. */
function overFill(under: Fill, over: Fill, opacity: number): Fill {
  if (opacity >= 0.99) return over;
  if (over.kind === 'solid') {
    if (under.kind === 'solid') return solidFill(mixHex(under.color, over.color, opacity));
    return { ...under, gradient: { stops: under.gradient.stops.map((s) => ({ ...s, color: mixHex(s.color, over.color, opacity) })) } };
  }
  const base = under.kind === 'solid' ? under.color : under.gradient.stops[0].color;
  return { ...over, gradient: { stops: over.gradient.stops.map((s) => ({ ...s, color: mixHex(base, s.color, opacity) })) } };
}

const SATIN_BLEND: Partial<Record<PsdBlendMode, Satin2D['blend']>> = {
  normal: 'normal',
  multiply: 'multiply',
  darken: 'multiply',
  'color burn': 'multiply',
  'linear burn': 'multiply',
  screen: 'screen',
  lighten: 'screen',
  'color dodge': 'screen',
  'linear dodge': 'screen',
  overlay: 'overlay',
  'soft light': 'overlay',
  'hard light': 'overlay',
};

/** Blend modes that brighten: an outer glow in one of them is additive light here. */
const LIGHT_BLENDS: Partial<Record<PsdBlendMode, true>> = { screen: true, 'linear dodge': true, 'color dodge': true, lighten: true, 'lighter color': true };
const enabled = <T extends { enabled?: boolean }>(e: T | undefined): e is T => !!e && e.enabled !== false;
/** `what`: the Photoshop effect (an English key, e.g. 'stroke'); the PS blend mode id is translated too. */
const blendNote = (what: string, mode: string | undefined, notes: Text[]) => {
  if (mode && mode !== 'normal') notes.push(msg('{what}: blend mode “{mode}” approximated as normal', { what: msg(what), mode: msg(mode) }));
};

/** `list` without repeats (messages compared by content), first occurrence kept. */
function uniqueTexts(list: Text[]): Text[] {
  const seen = new Set<string>();
  return list.filter((m) => {
    const k = JSON.stringify(m);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ---------------------------------------------------------------------------------------------
// Conversion

/**
 * Converts one Photoshop style into a 2D user preset for a source of `sizePx` px (the PS layer's
 * font size, or the size the user confirmed).
 */
export function convertPsStyle(src: PsStyleSource, sizePx: number): ConvertedStyle {
  if (!(sizePx > 0)) throw new MsgError(msg('The reference size must be above 0 px'));
  const e = src.effects;
  const notes: Text[] = [];
  const summary: Text[] = [];
  const k = e.scale ?? 1; // "Scale Effects"
  const px = (u: UnitsValue | undefined, fallback: number) => toPx(u, src.ppi, fallback) * k;
  const pct = (u: UnitsValue | undefined, fallback: number) => round((px(u, fallback) / sizePx) * 100);
  const light = (useGlobal: boolean | undefined, angle: number | undefined, altitude?: number) => ({
    angle: useGlobal ? src.globalAngle : (angle ?? 120),
    altitude: useGlobal ? src.globalAltitude : (altitude ?? 30),
  });

  // Face fill: base colour, then (bottom → top) gradient overlays and colour overlays.
  let fill = solidFill(src.baseColor);
  for (const g of [...(e.gradientOverlay ?? [])].reverse().filter(enabled)) {
    const f = gradientFill({ ...g, style: g.type }, notes);
    if (!f) continue;
    blendNote('gradient overlay', g.blendMode, notes);
    fill = overFill(fill, f, g.opacity ?? 1);
    summary.push('gradient face');
  }
  for (const c of [...(e.solidFill ?? [])].reverse().filter(enabled)) {
    blendNote('colour overlay', c.blendMode, notes);
    fill = overFill(fill, solidFill(c.color ? colorHex(c.color) : '#000000'), c.opacity ?? 1);
    summary.push('colour face');
  }
  const face: Material2D = material2D(fill, { opacity: src.fillOpacity });
  if (src.fillOpacity < 0.99) summary.push(msg('fill opacity {n} %', { n: Math.round(src.fillOpacity * 100) }));

  const po = e.patternOverlay;
  if (enabled(po)) {
    const kind = patternKind(po.pattern?.name);
    if (kind) {
      face.pattern = pattern({ kind, opacity: po.opacity ?? 1, scale: round(12 * (po.scale ?? 1)), angle: -(po.angle ?? 0) });
      summary.push(msg('{kind} pattern', { kind }));
    } else notes.push(msg('pattern overlay “{name}”: bitmap patterns have no equivalent; skipped', { name: po.pattern?.name ?? '?' }));
  }

  const ig = e.innerGlow;
  if (enabled(ig)) {
    const color = ig.color ? colorHex(ig.color) : ig.gradient?.type === 'solid' ? colorHex(ig.gradient.colorStops[0].color) : '#ffffbe';
    face.innerGlow = { enabled: true, color, size: pct(ig.size, 5), opacity: ig.opacity ?? 0.75, noise: ig.noise ?? 0 };
    if (ig.source === 'center') notes.push('inner glow: “Center” source drawn from the edge');
    summary.push('inner glow');
  }

  const sa = e.satin;
  if (enabled(sa)) {
    face.satin = satin2D({
      enabled: true,
      color: sa.color ? colorHex(sa.color) : '#000000',
      blend: SATIN_BLEND[sa.blendMode ?? 'multiply'] ?? 'normal',
      opacity: sa.opacity ?? 0.5,
      angle: sa.angle ?? 19,
      distance: pct(sa.distance, 11),
      size: pct(sa.size, 14),
      ...(sa.contour ? { contour: contourCurve(sa.contour) } : {}),
      invert: sa.invert ?? true,
    });
    summary.push('satin');
  }

  // Strokes → rims. Top-most first: a stroke reaching no further than one above it is hidden.
  const reach = (s: LayerEffectStroke) => {
    const size = px(s.size, 3);
    return s.position === 'center' ? size / 2 : size;
  };
  const shown: { stroke: LayerEffectStroke; reach: number }[] = [];
  for (const s of (e.stroke ?? []).filter(enabled)) {
    const r = reach(s);
    if (r > 0 && shown.every((o) => o.reach < r)) shown.push({ stroke: s, reach: r });
  }
  shown.sort((a, b) => a.reach - b.reach);
  const rims: Rim2D[] = [];
  let inner = 0;
  for (const { stroke: s, reach: r } of shown) {
    if (s.position === 'inside') notes.push('inside stroke drawn outside the face (rims grow outward)');
    if ((s.opacity ?? 1) < 0.99) notes.push(msg('stroke opacity {n} % drawn opaque', { n: Math.round((s.opacity ?? 1) * 100) }));
    blendNote('stroke', s.blendMode, notes);
    const solid = solidFill(s.color ? colorHex(s.color) : '#000000');
    const rimFill = s.fillType === 'gradient' && s.gradient ? (gradientFill({ ...s.gradient, gradient: s.gradient }, notes) ?? solid) : solid;
    const material = material2D(rimFill);
    if (s.fillType === 'pattern') {
      const kind = patternKind(s.pattern?.name);
      if (kind) material.pattern = pattern({ kind, scale: round(12 * (s.pattern?.scale ?? 1)) });
      else notes.push(msg('stroke pattern “{name}”: bitmap patterns have no equivalent; drawn {color}', { name: s.pattern?.name ?? '?', color: rimFill.color }));
    }
    rims.push(rim2D(round(((r - inner) / sizePx) * 100), material, { join: 'round', fillCounters: false }));
    inner = r;
  }
  if (rims.length) summary.unshift(rims.length === 1 ? '1 rim' : msg('{n} rims', { n: rims.length }));
  if (src.knockout) summary.push('knockout');

  const bv = e.bevel;
  if (enabled(bv)) {
    // Direction "Down" flips the light, so only an "Up" bevel can keep following the global light.
    const global = !!bv.useGlobalLight && bv.direction !== 'down';
    const bevel = { ...bevelOf(bv, pct, light(bv.useGlobalLight, bv.angle, bv.altitude), notes), useGlobalLight: global };
    const style = bv.style ?? 'inner bevel';
    if (style === 'stroke emboss') {
      if (rims.length) for (const r of rims) r.material.bevel = bevel;
      else notes.push('stroke emboss without a stroke has no effect');
    } else if (style === 'outer bevel' && rims.length) rims[rims.length - 1].material.bevel = bevel;
    else {
      if (style === 'outer bevel') notes.push('outer bevel without a stroke applied to the face');
      face.bevel = bevel;
    }
    summary.push(style === 'stroke emboss' ? 'rim bevel' : 'bevel');
  }

  const effects: EffectInstance[] = [];
  for (const s of [...(e.innerShadow ?? [])].reverse().filter(enabled)) {
    const l = light(s.useGlobalLight, s.angle);
    effects.push(
      fx('innerShadow', {
        // Like the drop shadow: the shadow falls away from the light (clockwise screen direction).
        angle: (((180 - l.angle) % 360) + 360) % 360,
        distance: round(px(s.distance, 5)),
        size: round(px(s.size, 5)),
        choke: clamp((s.choke?.value ?? 0) / 100, 0, 0.95),
        color: s.color ? colorHex(s.color) : '#000000',
        opacity: s.opacity ?? 0.75,
        useGlobalLight: !!s.useGlobalLight,
      }),
    );
    blendNote('inner shadow', s.blendMode, notes);
    summary.push('inner shadow');
  }
  for (const s of [...(e.dropShadow ?? [])].reverse().filter(enabled)) {
    const l = light(s.useGlobalLight, s.angle);
    effects.push(
      fx('dropShadow', {
        // The shadow falls away from the light: PS angle (counter-clockwise light direction) → clockwise screen direction.
        angle: (((180 - l.angle) % 360) + 360) % 360,
        distance: round(px(s.distance, 5)),
        size: round(px(s.size, 5)),
        spread: clamp((s.choke?.value ?? 0) / 100, 0, 0.95),
        color: s.color ? colorHex(s.color) : '#000000',
        opacity: s.opacity ?? 0.75,
        useGlobalLight: !!s.useGlobalLight,
      }),
    );
    summary.push('drop shadow');
  }
  const og = e.outerGlow;
  if (enabled(og)) {
    const color = og.color ? colorHex(og.color) : og.gradient?.type === 'solid' ? colorHex(og.gradient.colorStops[0].color) : '#ffffbe';
    effects.push(
      fx('outerGlow', {
        color,
        size: round(Math.max(1, px(og.size, 5))),
        intensity: 1,
        spread: clamp((og.choke?.value ?? 0) / 100, 0, 0.95),
        opacity: og.opacity ?? 0.75,
        mode: og.blendMode && LIGHT_BLENDS[og.blendMode] ? 'add' : 'behind',
      }),
    );
    summary.push('outer glow');
  }

  const preset: StylePreset = {
    id: uid(),
    name: src.name,
    group: GROUP,
    kind: 'title2d',
    style: { face, rims, knockout: src.knockout, erode: erode2D() },
    effects,
    partEffects: {},
    refSize: sizePx,
    builtin: false,
  };
  return { preset, summary: uniqueTexts(summary), notes: uniqueTexts(notes) };
}

const BEVEL_PROFILE: Record<NonNullable<LayerEffectBevel['technique']>, Bevel2D['profile']> = {
  smooth: 'smooth',
  'chisel hard': 'chamfer',
  'chisel soft': 'chamfer',
};

function bevelOf(
  b: LayerEffectBevel,
  pct: (u: UnitsValue | undefined, fallback: number) => number,
  light: { angle: number; altitude: number },
  notes: Text[],
): Bevel2D {
  // Direction "Down" swaps highlights and shadows: the same as light from the opposite side.
  const angle = (light.angle + (b.direction === 'down' ? 180 : 0)) % 360;
  const shape = b.useShape && !isLinearContour(b.shapeContour) && b.shapeContour;
  if (b.technique === 'chisel soft') notes.push('bevel: Chisel Soft drawn as a chamfer');
  return bevel2D({
    enabled: true,
    profile: shape ? 'custom' : BEVEL_PROFILE[b.technique ?? 'smooth'],
    ...(shape ? { profileCurve: contourCurve(shape) } : {}),
    size: Math.max(0.1, pct(b.size, 5)),
    depth: clamp(b.strength ?? 1, 0, 10),
    soften: pct(b.soften, 0),
    lightAngle: angle,
    lightAltitude: clamp(light.altitude, 0, 90),
    ...glossOf(b.contour),
    highlightColor: b.highlightColor ? colorHex(b.highlightColor) : '#ffffff',
    highlightOpacity: b.highlightOpacity ?? 0.75,
    shadowColor: b.shadowColor ? colorHex(b.shadowColor) : '#000000',
    shadowOpacity: b.shadowOpacity ?? 0.75,
  });
}

import {
  writePsdUint8Array,
  type AdjustmentLayer as PsdAdjustment,
  type BlendMode as PsdBlendMode,
  type HueSaturationAdjustmentChannel,
  type ImageResources,
  type Layer as PsdLayer,
  type RGB,
} from 'ag-psd';
import { fromBlendMode } from 'ag-psd/dist/helpers';
import { drawnLayers, drawTree, type DrawNode } from '../engine/drawTree';
import type { Engine } from '../engine/Engine';
import { rimKey } from '../model/parts';
import type { AdjustChannel, Adjustment, AdjustmentLayer, BlendMode, Curve, Layer, PartEffects, PartKey, Project, Title2DLayer } from '../model/types';
import { english, formatMsg, msg, type Msg } from '../store/msg';
import { withDescendants } from '../store/tree';
import {
  asciiName,
  blankImage,
  contentFrame,
  depthOf,
  drawOnly,
  exportContext,
  pngBatch,
  prepareRender,
  renderFrame,
  renderMaskFrame,
  roundFrame,
  roundingOf,
  safeWordName,
  throwIfAborted,
  uniqueStem,
  zipFiles,
  type BitDepth,
  type ExportContext,
  type ExportImage,
  type Frame,
  type StillOptions,
} from './export';

// Layered delivery for compositors: one raster layer per exported comp layer, every layer
// rendered alone into the same frame as the full composite so all of them register, with the
// layer's blend mode and opacity on the PSD layer (8-bit RGBA, straight alpha — what PSD stores;
// ag-psd writes no other depth, so `bitDepth` applies to the registered PNGs only).
// - Layer groups become PSD groups, nested as in the app (flat records with section dividers;
//   their blend + opacity; members inside). When a group has effects they run on the members'
//   composite and can't be split, so the members go in hidden and the group's baked render
//   ('fx') sits on top, visible.
// - Clipped layers get Photoshop's clipping flag. Each is rendered unclipped and then masked by
//   its base's content alpha (before the base's effects), because Photoshop clips to the base's
//   stored pixels, which include its baked glow / shadow. Photoshop can't clip to a group, so
//   layers clipped to a group are written masked but unclipped (with a warning).
// - Adjustment layers are written as native Photoshop adjustment layers (`psdAdjustment`). One
//   that can't be (see there; or clipped to a group; or with enabled effects, which Photoshop
//   adjustment layers can't hold) is baked: a pixel layer '<name> (baked)' holding everything
//   below it in its parent, adjusted, with what it covers hidden below it (clipped: its clip
//   group up to it, adjusted, clipped to the base), plus a warning. An Effects only layer
//   without enabled effects changes nothing and is left out.
// - Effects of style parts are in each layer's pixels. With `splitTitles` each 2D title becomes a
//   group holding, bottom → top, every rim alone, the face alone (each with its own part effects,
//   without the layer effects, hidden), the full layer with its effects ('fx', visible) and the
//   layers clipped to the title (clipped to 'fx').
// - Layer masks become Photoshop layer masks (raster: the combined enabled masks, feather and
//   density included) on the layer, group or adjustment layer, whose pixels are written whole, so
//   the mask stays editable in Photoshop; a split title's mask sits on its part group, so it masks
//   the parts and the layers clipped to it. Clipped layers are masked by the base's unmasked
//   content: Photoshop clips to the base's pixels × its layer mask, as the app does. Layers
//   clipped to a masked group are written with the group's mask baked in (with a warning), as
//   they sit outside the group. Baked adjustment layers hold every mask they cover, baked.
// - The document resolution is the comp's dpi.
// The same parts can be written as registered PNGs in a ZIP instead (all on the shared frame;
// adjustment layers baked, as PNGs have no adjustment layers; every mask baked, a group's into
// each of its members; per-layer trimmed PNGs are `exportLayerParts` in export.ts).
//
// The engine blends in linear light while Photoshop blends in sRGB, so layers recombined in
// Photoshop differ slightly from the app wherever they overlap with partial alpha (soft glows,
// group / layer opacity) or use add / screen / overlay; the PSD's flattened composite is the
// engine's own render.

export interface LayeredOptions extends StillOptions {
  /** File stem: PNG parts are `${baseName}_${NN}_${layer}_${part}.png`. */
  baseName: string;
  /** Half-width (ASCII) layer names in PNG part file names (non-ASCII names fall back to `layerNN`). */
  ascii: boolean;
  /** Split every 2D title into rims / face / fx. */
  splitTitles: boolean;
  onProgress: (done: number, total: number) => void;
}

export interface LayeredResult {
  blob: Blob;
  warnings: Msg[];
}

const PSD_BLEND: Record<BlendMode, PsdBlendMode> = {
  normal: 'normal',
  add: 'linear dodge',
  screen: 'screen',
  multiply: 'multiply',
  overlay: 'overlay',
};

// ---------------------------------------------------------------------------------------------
// Adjustment layers

/** Photoshop's record order of per-channel settings (Levels, Curves): composite, red, green, blue. */
const PS_CHANNELS: AdjustChannel[] = ['rgb', 'r', 'g', 'b'];

/** Most points a Photoshop curve takes (endpoints included). */
const PS_CURVE_POINTS = 16;

/** Photoshop's default Hue/Saturation colour range (a b c d, degrees) of each colour, with no change in it. */
const hueRange = (a: number, b: number, c: number, d: number): HueSaturationAdjustmentChannel => ({ a, b, c, d, hue: 0, saturation: 0, lightness: 0 });
const HUE_RANGES = {
  reds: hueRange(315, 345, 15, 45),
  yellows: hueRange(15, 45, 75, 105),
  greens: hueRange(75, 105, 135, 165),
  cyans: hueRange(135, 165, 195, 225),
  blues: hueRange(195, 225, 255, 285),
  magentas: hueRange(255, 285, 315, 345),
};

const hexRgb = (hex: string): RGB => {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Photoshop Curves points (0..255) of `c`, or null when Photoshop can't draw it: a corner point
 * between the endpoints (Photoshop curves are always smooth), fewer than 2 or more than
 * PS_CURVE_POINTS points, or two points on the same input level. Outside the first / last point
 * both stay flat, like `curveFn`. Smooth segments are Photoshop's spline, not the app's monotone
 * one: a close match for ordinary curves.
 */
function psCurve(c: Curve): { input: number; output: number }[] | null {
  const pts = [...c.points].sort((p, q) => p.x - q.x);
  if (pts.length < 2 || pts.length > PS_CURVE_POINTS || pts.slice(1, -1).some((p) => p.corner)) return null;
  const out = pts.map((p) => ({ input: Math.round(clamp(p.x, 0, 1) * 255), output: Math.round(clamp(p.y, 0, 1) * 255) }));
  return out.every((p, i) => i === 0 || p.input > out[i - 1].input) ? out : null;
}

/**
 * The ag-psd `adjustment` of a native Photoshop adjustment layer equal to `a`, or null when
 * Photoshop can't express it (curves: see psCurve; a gradient map with 'vivid' (OKLCH)
 * interpolation, which Photoshop doesn't have; Effects only, which has no Photoshop
 * counterpart: see adjustWrite). Every one of the 13 Photoshop types is otherwise native.
 */
function psdAdjustment(a: Adjustment): PsdAdjustment | null {
  switch (a.type) {
    case 'brightnessContrast':
      // useLegacy false: the modern algorithm and ranges (-150..150 / -50..100), stored in 'CgEd'.
      return { type: 'brightness/contrast', brightness: Math.round(a.brightness), contrast: Math.round(a.contrast), useLegacy: false };
    case 'levels':
      return {
        type: 'levels',
        channels: PS_CHANNELS.map((k) => {
          const c = a.channels[k];
          return {
            shadowInput: Math.round(c.inBlack),
            highlightInput: Math.round(c.inWhite),
            shadowOutput: Math.round(c.outBlack),
            highlightOutput: Math.round(c.outWhite),
            midtoneInput: c.gamma,
          };
        }),
      };
    case 'curves': {
      const channels: { input: number; output: number }[][] = [];
      for (const k of PS_CHANNELS) {
        const pts = psCurve(a.channels[k]);
        if (!pts) return null;
        const identity = pts.length === 2 && pts[0].input === 0 && pts[0].output === 0 && pts[1].input === 255 && pts[1].output === 255;
        // Unchanged colour channels are left out (empty), as Photoshop stores them.
        channels.push(k !== 'rgb' && identity ? [] : pts);
      }
      return { type: 'curves', channels };
    }
    case 'exposure':
      return { type: 'exposure', exposure: a.exposure, offset: a.offset, gamma: a.gamma };
    case 'vibrance':
      return { type: 'vibrance', vibrance: Math.round(a.vibrance), saturation: Math.round(a.saturation) };
    case 'hueSaturation': {
      const hsl = { hue: Math.round(a.hue), saturation: Math.round(a.saturation), lightness: Math.round(a.lightness) };
      // Colorize: Photoshop's hue 0..360 and saturation 0..100 from the same fields.
      return a.colorize
        ? { type: 'hue/saturation', colorize: true, colorization: { hue: (hsl.hue + 360) % 360, saturation: clamp(hsl.saturation, 0, 100), lightness: hsl.lightness }, master: { hue: 0, saturation: 0, lightness: 0 }, ...HUE_RANGES }
        : { type: 'hue/saturation', colorize: false, master: hsl, ...HUE_RANGES };
    }
    case 'colorBalance': {
      const range = (r: { cyanRed: number; magentaGreen: number; yellowBlue: number }) => ({ cyanRed: Math.round(r.cyanRed), magentaGreen: Math.round(r.magentaGreen), yellowBlue: Math.round(r.yellowBlue) });
      return { type: 'color balance', shadows: range(a.shadows), midtones: range(a.midtones), highlights: range(a.highlights), preserveLuminosity: a.preserveLuminosity };
    }
    case 'blackWhite':
      return {
        type: 'black & white',
        reds: Math.round(a.reds),
        yellows: Math.round(a.yellows),
        greens: Math.round(a.greens),
        cyans: Math.round(a.cyans),
        blues: Math.round(a.blues),
        magentas: Math.round(a.magentas),
        useTint: a.tint,
        tintColor: hexRgb(a.tintColor),
      };
    case 'photoFilter':
      // ag-psd density is a fraction (Photoshop's percent / 100).
      return { type: 'photo filter', color: hexRgb(a.color), density: a.density / 100, preserveLuminosity: a.preserveLuminosity };
    case 'gradientMap': {
      if (a.gradient.interp === 'vivid') return null;
      const stops = [...a.gradient.stops].sort((p, q) => p.pos - q.pos);
      // The app ramps in linear-light RGB: Photoshop's 'Linear' interpolation method.
      return {
        type: 'gradient map',
        gradientType: 'solid',
        method: 'linear',
        reverse: a.reverse,
        colorStops: stops.map((s) => ({ color: hexRgb(s.color), location: s.pos, midpoint: s.mid ?? 0.5 })),
        opacityStops: stops.map((s) => ({ opacity: s.alpha ?? 1, location: s.pos, midpoint: s.mid ?? 0.5 })),
      };
    }
    case 'invert':
      return { type: 'invert' };
    case 'posterize':
      return { type: 'posterize', levels: clamp(Math.round(a.levels), 2, 255) };
    case 'threshold':
      return { type: 'threshold', level: clamp(Math.round(a.level), 1, 255) };
    case 'effectsOnly':
      return null;
  }
}

const bakedName = (l: AdjustmentLayer) => `${l.name} (baked)`;

const bakedWarning = (l: AdjustmentLayer) =>
  l.effects.some((fx) => fx.enabled)
    ? msg('Adjustment layer "{name}" has effects, which Photoshop adjustment layers can\'t hold, so it was baked into the pixel layer "{baked}"', { name: l.name, baked: bakedName(l) })
    : msg('Adjustment layer "{name}" can\'t be a Photoshop adjustment layer here, so it was baked into the pixel layer "{baked}"', { name: l.name, baked: bakedName(l) });

/**
 * How adjustment layer `l` is written: 'skip' (Effects only without enabled effects: no change
 * at all), its native ag-psd adjustment when `native` allows one (no enabled effects and
 * psdAdjustment encodes it), else 'bake'.
 */
function adjustWrite(l: AdjustmentLayer, native: boolean): PsdAdjustment | 'skip' | 'bake' {
  const fx = l.effects.some((e) => e.enabled);
  if (!fx && l.adjustment.type === 'effectsOnly') return 'skip';
  return (native && !fx && psdAdjustment(l.adjustment)) || 'bake';
}

// ---------------------------------------------------------------------------------------------
// Plan

/** Fields every exported PSD layer has. */
interface Common {
  name: string;
  /** Hidden in the PSD: a guide (left out of PNG parts too) or an alternate part (`excluded` false). */
  hidden: boolean;
  /** Guide layer: hidden in the PSD and left out of the PNG parts. */
  excluded: boolean;
  opacity: number;
  /** Photoshop clipping mask: clipped to the layer below. */
  clipping: boolean;
  /** Id of the layer whose combined masks are this record's Photoshop layer mask (PSD only), or null. */
  mask: string | null;
}

/** A raster layer of the export. */
interface Pixels extends Common {
  kind: 'pixels';
  blend: BlendMode;
  image: ExportImage;
}

/** A native Photoshop adjustment layer. */
interface Adjust extends Common {
  kind: 'adjust';
  blend: BlendMode;
  adjustment: PsdAdjustment;
}

/** A PSD group; `blend` null = pass through (title part groups). */
interface Group extends Common {
  kind: 'group';
  blend: BlendMode | null;
  children: Node[];
}

type Node = Pixels | Adjust | Group;

/** A raster layer to render into the frame. */
interface Job extends Common {
  kind: 'job';
  blend: BlendMode;
  /** The project drawing only what this layer holds. */
  project: Project;
  /** Clip bases whose content alpha (before their effects) masks the render (see the notes above). */
  masks: string[];
  /** Layers whose combined masks multiply the render: masked groups around it, in PNG parts. */
  bake: string[];
  /** Alpha made opaque before masking: a baked clipped adjustment replaces its clip group's colour. */
  opaque: boolean;
}

/** A node to build: a job, an adjustment layer, or a group of them. */
type Plan = Job | Adjust | (Omit<Group, 'children'> & { children: Plan[] });

interface PlanContext {
  /** The project the plan draws. */
  project: Project;
  /** Ids drawn with the export's own guide setting; the other drawn layers are excluded guides. */
  shown: Set<string>;
  split: boolean;
  /** Write adjustment layers as Photoshop adjustment layers where they encode (PSD); false bakes them all (PNG parts). */
  native: boolean;
  warn: (m: Msg) => void;
}

/** What a node inherits from its ancestors / clip base. */
interface Inherited {
  excluded: boolean;
  /** Inside a group whose baked render stands in for it: hidden. */
  alternate: boolean;
  masks: string[];
  bake: string[];
}

/** Some mask of `l` is enabled. */
const masked = (l: Layer) => l.masks.some((m) => m.enabled);

const job = (
  name: string,
  project: Project,
  f: Inherited,
  o: { blend: BlendMode; opacity: number; clipping: boolean; hidden?: boolean; opaque?: boolean; mask?: string | null },
): Job => ({
  kind: 'job',
  name,
  project,
  hidden: f.excluded || f.alternate || !!o.hidden,
  excluded: f.excluded,
  blend: o.blend,
  opacity: o.opacity,
  clipping: o.clipping,
  mask: o.mask ?? null,
  masks: f.masks,
  bake: f.bake,
  opaque: !!o.opaque,
});

const adjustPlan = (l: AdjustmentLayer, adjustment: PsdAdjustment, f: Inherited, clipping: boolean): Adjust => ({
  kind: 'adjust',
  name: l.name,
  hidden: f.excluded || f.alternate,
  excluded: f.excluded,
  blend: l.blend,
  opacity: Math.min(1, l.transform.opacity),
  clipping,
  mask: masked(l) ? l.id : null,
  adjustment,
});

/** `l.partEffects` reduced to part `key`'s (a part drawn on its own keeps only its own effects). */
const onlyPart = (l: Title2DLayer, key: PartKey): PartEffects => (l.partEffects[key] ? { [key]: l.partEffects[key] } : {});

/**
 * Parts of a 2D title, bottom → top: each enabled rim alone (`rim N`, N = 1 innermost, outermost
 * at the bottom), the face alone, then the full layer with effects (`fx`). A rim alone is drawn
 * with the face hidden and the rims inside it removed; its width becomes the cumulative width
 * so its outline is unchanged. Rims and face keep their own part effects, not the layer's.
 */
function titleParts(l: Title2DLayer): { name: string; layer: Title2DLayer; hidden: boolean }[] {
  const rims: { name: string; layer: Title2DLayer; hidden: boolean }[] = [];
  let grown = 0;
  for (const [i, rim] of l.style.rims.entries()) {
    if (!rim.enabled || !(rim.width > 0)) continue;
    grown += rim.width;
    const style = { ...l.style, hideFace: true, rims: [{ ...rim, width: grown }] };
    rims.push({ name: `rim ${i + 1}`, layer: { ...l, effects: [], partEffects: onlyPart(l, rimKey(rim.id)), style }, hidden: true });
  }
  return [
    ...rims.reverse(),
    { name: 'face', layer: { ...l, effects: [], partEffects: onlyPart(l, 'face'), style: { ...l.style, rims: [] } }, hidden: true },
    { name: 'fx', layer: l, hidden: false },
  ];
}

/** `project` drawing only layer `l` (as `as`; unclipped, see drawOnly), with its subtree but not the layers clipped to it. */
const alone = (project: Project, l: Layer, as: Layer = l): Project =>
  drawOnly(project, new Set(withDescendants(project.layers, [l.id])), l.id, (x) => (x.id === l.id ? as : x));

/** Plans of sibling nodes (bottom → top) with what they inherit. */
function siblingsPlan(nodes: readonly DrawNode[], s: PlanContext, inherited: Inherited): Plan[] {
  const out: Plan[] = [];
  for (const [i, n] of nodes.entries()) {
    const f = { ...inherited, excluded: inherited.excluded || !s.shown.has(n.layer.id) };
    if (n.kind !== 'adjust') {
      out.push(...nodePlan(n, s, f, false));
      continue;
    }
    const write = adjustWrite(n.layer, s.native);
    if (write === 'skip') continue;
    if (write !== 'bake') {
      out.push(adjustPlan(n.layer, write, f, false));
      continue;
    }
    if (s.native) s.warn(bakedWarning(n.layer));
    // Everything below it in its parent, adjusted: it stands in for those layers, now hidden.
    for (const p of out) p.hidden = true;
    const keep = new Set([...drawnLayers(nodes.slice(0, i).filter((m) => s.shown.has(m.layer.id))).map((l) => l.id), n.layer.id]);
    out.push(job(bakedName(n.layer), drawOnly(s.project, keep, null), f, { blend: 'normal', opacity: 1, clipping: false }));
  }
  return out;
}

/** Plans of a leaf or group node: itself (a job, its PSD group, or its split-title group), then the layers clipped to it. */
function nodePlan(n: Exclude<DrawNode, { kind: 'adjust' }>, s: PlanContext, f: Inherited, clipping: boolean): Plan[] {
  const l = n.layer;
  const opacity = Math.min(1, l.transform.opacity);
  const hidden = f.excluded || f.alternate;
  // PSD: the masks go on the record as a Photoshop layer mask and the pixels are drawn whole.
  const psdMask = s.native && masked(l);
  const mask = psdMask ? l.id : null;
  const whole: Layer = psdMask ? { ...l, masks: [] } : l;
  let own: Plan;
  /** Where the clipped layers go: next to the node, or inside a split title's group on top of its fx part. */
  let host: Plan[] | null = null;
  if (n.kind === 'group') {
    const baked = l.effects.some((fx) => fx.enabled);
    // PNG parts can't carry the group's mask: it is baked into every member.
    const bake = !s.native && masked(l) ? [...f.bake, l.id] : f.bake;
    const children = siblingsPlan(n.children, s, { ...f, alternate: f.alternate || baked, bake });
    if (baked) children.push(job('fx', alone(s.project, l, whole), f, { blend: 'normal', opacity: 1, clipping: false }));
    own = { kind: 'group', name: l.name, hidden, excluded: f.excluded, blend: n.layer.blend, opacity, clipping, mask, children };
  } else if (s.split && n.layer.kind === 'title2d') {
    const title = n.layer;
    host = titleParts(title).map((p) =>
      job(p.name, alone(s.project, title, psdMask ? { ...p.layer, masks: [] } : p.layer), f, { blend: title.blend, opacity, clipping: false, hidden: p.hidden }),
    );
    own = { kind: 'group', name: l.name, hidden, excluded: f.excluded, blend: null, opacity: 1, clipping, mask, children: host };
  } else own = job(l.name, alone(s.project, l, whole), f, { blend: l.blend, opacity, clipping, mask });
  if (!n.clipped.length) return [own];

  // Photoshop clips to a pixel layer only (a split title's fx part); a group can't be a base.
  const pixelBase = n.kind === 'leaf';
  if (!pixelBase && s.native) {
    s.warn(msg('Layers clipped to the group "{name}" are written already masked, without a clipping mask: Photoshop can\'t clip to a group', { name: l.name }));
    if (masked(l)) s.warn(msg('The layer mask of the group "{name}" is baked into the layers clipped to it: Photoshop can\'t clip to a group', { name: l.name }));
  }
  // A pixel base clips in Photoshop with its layer mask, so what is drawn of it here is whole.
  const base = pixelBase ? whole : l;
  const cf: Inherited = { ...f, masks: [...f.masks, l.id] };
  const clipped: Plan[] = [];
  for (const [i, c] of n.clipped.entries()) {
    const ff = { ...cf, excluded: cf.excluded || !s.shown.has(c.layer.id) };
    if (c.kind !== 'adjust') {
      clipped.push(...nodePlan(c, s, ff, pixelBase));
      continue;
    }
    const write = adjustWrite(c.layer, s.native && pixelBase);
    if (write === 'skip') continue;
    if (write !== 'bake') {
      clipped.push(adjustPlan(c.layer, write, ff, true));
      continue;
    }
    if (s.native) s.warn(bakedWarning(c.layer));
    // Its clip group up to it, adjusted, opaque inside the base: replaces the clip group's colour.
    const below = n.clipped.slice(0, i).filter((m) => s.shown.has(m.layer.id));
    const keep = new Set([...withDescendants(s.project.layers, [l.id]), ...drawnLayers(below).map((m) => m.id), c.layer.id]);
    clipped.push(job(bakedName(c.layer), drawOnly(s.project, keep, l.id, (x) => (x.id === l.id ? base : x)), ff, { blend: 'normal', opacity: 1, clipping: pixelBase, opaque: true }));
  }
  if (!host) return [own, ...clipped];
  host.push(...clipped);
  return [own];
}

/** The layer plan of `project`, bottom → top: every drawn node (guides too, hidden unless included). */
function stackPlan(project: Project, opts: LayeredOptions, native: boolean, warn: (m: Msg) => void): Plan[] {
  const shown = new Set(drawnLayers(drawTree(project, opts.includeGuides)).map((l) => l.id));
  return siblingsPlan(drawTree(project, true), { project, shown, split: opts.splitTitles, native, warn }, { excluded: false, alternate: false, masks: [], bake: [] });
}

/**
 * Renders in `plans`: jobs, plus one per clip base mask (collected into `clipBases`) and one per
 * layer mask, Photoshop's or baked (collected into `layerMasks`).
 */
function countRenders(plans: Plan[], clipBases: Set<string>, layerMasks: Set<string>): number {
  let n = 0;
  for (const p of plans) {
    if (p.mask) layerMasks.add(p.mask);
    if (p.kind === 'group') n += countRenders(p.children, clipBases, layerMasks);
    else if (p.kind === 'job') {
      n++;
      for (const m of p.masks) clipBases.add(m);
      for (const m of p.bake) layerMasks.add(m);
    }
  }
  return n;
}

// ---------------------------------------------------------------------------------------------
// Build

/** Opaque `w × h` pixels of `color` at `depth` bits per channel. */
function solidImage(color: string, w: number, h: number, depth: BitDepth): ExportImage {
  const img = blankImage(depth, w, h);
  const n = parseInt(color.slice(1), 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  const px = new Uint32Array(img.data.buffer);
  // Little-endian RGBA as u32: 8-bit 0xAABBGGRR; 16-bit two words, 0xGGGGRRRR and 0xAAAABBBB.
  if (depth === 8) px.fill((0xff000000 | (b << 16) | (g << 8) | r) >>> 0);
  else {
    const rg = ((g * 257) << 16) | (r * 257);
    const ba = (0xffff0000 | (b * 257)) >>> 0;
    for (let i = 0; i < px.length; i += 2) {
      px[i] = rg;
      px[i + 1] = ba;
    }
  }
  return img;
}

/**
 * Renders every planned layer of `project` (the project the plan was made from) into `frame`, and
 * every layer mask the plan names (for the Photoshop records, by layer id). `native`: the plan is
 * a PSD's, whose pixel clip bases clip with their own layer masks.
 */
async function build(c: ExportContext, project: Project, plans: Plan[], frame: Frame, native: boolean, tick: () => void) {
  // Content alpha of each clip base (before its own effects), rendered once. A PSD's pixel base
  // is drawn without its masks: Photoshop clips to its pixels × its layer mask.
  const clipBases = new Map<string, ExportImage['data']>();
  const clipBase = async (id: string) => {
    let m = clipBases.get(id);
    if (!m) {
      const base = project.layers.find((l) => l.id === id)!;
      const masks = native && base.kind !== 'group' ? [] : base.masks;
      m = (await renderFrame(c, alone(project, base, { ...base, effects: [], masks } as Layer), frame)).data;
      tick();
      clipBases.set(id, m);
    }
    return m;
  };
  // Combined masks of each layer, rendered once (r = g = b = 255 where it shows).
  const layerMasks = new Map<string, ImageData>();
  const layerMask = async (id: string) => {
    let m = layerMasks.get(id);
    if (!m) {
      m = await renderMaskFrame(c, project, id, frame);
      tick();
      layerMasks.set(id, m);
    }
    return m;
  };
  const walk = async (ps: Plan[]): Promise<Node[]> => {
    const out: Node[] = [];
    for (const p of ps) {
      if (p.mask) await layerMask(p.mask);
      if (p.kind === 'group') {
        out.push({ ...p, children: await walk(p.children) });
        continue;
      }
      if (p.kind === 'adjust') {
        out.push(p);
        continue;
      }
      const image = await renderFrame(c, p.project, frame);
      tick();
      const d = image.data;
      const max = depthOf(image) === 16 ? 65535 : 255;
      if (p.opaque) for (let i = 3; i < d.length; i += 4) if (d[i] > 0) d[i] = max;
      for (const id of p.masks) {
        const m = await clipBase(id);
        for (let i = 3; i < d.length; i += 4) d[i] = Math.round((d[i] * m[i]) / max);
      }
      for (const id of p.bake) {
        const m = (await layerMask(id)).data;
        for (let i = 3; i < d.length; i += 4) d[i] = Math.round((d[i] * m[i - 3]) / 255);
      }
      const { name, hidden, excluded, blend, opacity, clipping, mask } = p;
      out.push({ kind: 'pixels', name, hidden, excluded, blend, opacity, clipping, mask, image });
    }
    return out;
  };
  return { nodes: await walk(plans), layerMasks };
}

/**
 * Renders every exported layer (and its parts) and the composite into one shared frame.
 * `native`: adjustment layers stay Photoshop adjustment layers where they encode.
 */
async function renderLayered(engine: Engine, project: Project, opts: LayeredOptions, native: boolean) {
  const c: ExportContext = exportContext(engine, project, opts);
  // Guide layers are exported too (hidden unless included), so load their assets as well.
  const warnings = await prepareRender(engine, project, true);
  throwIfAborted(opts.signal);
  // One warning per message.
  const planWarnings = new Map<string, Msg>();
  const plan = stackPlan(project, opts, native, (m) => void planWarnings.set(formatMsg(m, english), m));
  const clipBases = new Set<string>();
  const maskIds = new Set<string>();
  const total = 2 + countRenders(plan, clipBases, maskIds) + clipBases.size + maskIds.size;
  let done = 0;
  const tick = () => opts.onProgress(++done, total);
  opts.onProgress(0, total);

  const frame: Frame = roundFrame(await contentFrame(c, project, opts), roundingOf(opts));
  tick();
  const composite = await renderFrame(c, project, frame);
  tick();

  const { nodes, layerMasks } = await build(c, project, plan, frame, native, tick);
  const background: Pixels | null = project.comp.background.transparent
    ? null
    : {
        kind: 'pixels',
        name: 'Comp background',
        image: solidImage(project.comp.background.color, frame.w, frame.h, c.depth),
        hidden: false,
        excluded: false,
        blend: 'normal',
        opacity: 1,
        clipping: false,
        mask: null,
      };
  return { frame, composite, background, nodes, layerMasks, warnings: [...warnings, ...planWarnings.values(), ...c.warnings.values()] };
}

/** PSD resolution resource for `dpi` (cm display units for print pages, as Japanese print shops measure in mm). */
function resolutionInfo(dpi: number, print: boolean): NonNullable<ImageResources['resolutionInfo']> {
  const unit = print ? 'Centimeters' : 'Inches';
  return { horizontalResolution: dpi, horizontalResolutionUnit: 'PPI', widthUnit: unit, verticalResolution: dpi, verticalResolutionUnit: 'PPI', heightUnit: unit };
}

/**
 * Layered PSD (8-bit RGB + transparency, whatever `bitDepth` asks): one raster layer per comp
 * layer, nested groups as groups, clipping masks, layer masks, native adjustment layers, titles
 * optionally split, at the comp's dpi.
 */
export async function exportPsd(engine: Engine, project: Project, opts: LayeredOptions): Promise<LayeredResult> {
  const r = await renderLayered(engine, project, { ...opts, bitDepth: 8 }, true);
  throwIfAborted(opts.signal);
  // Flat layer records, bottom → top, as the file stores them: a group is its '</Layer group>' end
  // marker, its members, then the group record itself. Written out here rather than as ag-psd
  // `children`, whose end markers get no layer id.
  const records: PsdLayer[] = [];
  const add = (n: Node) => {
    const { name, hidden, opacity, clipping } = n;
    // The layer mask covers the whole document.
    const m = n.mask ? r.layerMasks.get(n.mask)! : null;
    const mask = m ? { top: 0, left: 0, right: m.width, bottom: m.height, defaultColor: 0, imageData: m } : undefined;
    if (n.kind === 'pixels') {
      records.push({ id: records.length + 1, name, hidden, blendMode: PSD_BLEND[n.blend], opacity, clipping, mask, imageData: n.image });
      return;
    }
    if (n.kind === 'adjust') {
      records.push({ id: records.length + 1, name, hidden, blendMode: PSD_BLEND[n.blend], opacity, clipping, mask, adjustment: n.adjustment });
      return;
    }
    records.push({ id: records.length + 1, name: '</Layer group>', sectionDivider: { type: 3 } });
    for (const c of n.children) add(c);
    // A pass-through group stores 'normal' in its record and the real mode in the section divider.
    const key = n.blend ? fromBlendMode[PSD_BLEND[n.blend]] : 'pass';
    records.push({
      id: records.length + 1,
      name,
      hidden,
      blendMode: n.blend ? PSD_BLEND[n.blend] : 'normal',
      opacity,
      clipping,
      mask,
      sectionDivider: { type: 1, key, subType: 0 },
    });
  };
  if (r.background) add(r.background);
  for (const n of r.nodes) add(n);
  const imageResources: ImageResources = { resolutionInfo: resolutionInfo(project.comp.dpi, !!opts.print) };
  const bytes = writePsdUint8Array(
    { width: r.frame.w, height: r.frame.h, imageData: r.composite, imageResources, children: records },
    { trimImageData: true, noBackground: true, generateThumbnail: true },
  );
  return { blob: new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'image/vnd.adobe.photoshop' }), warnings: r.warnings };
}

/**
 * The same layers / parts as registered PNGs in a ZIP, at the export's bit depth:
 * `${base}_composite.png` plus `${base}_${NN}_${layer}[_${part}…].png`, NN = stacking order from
 * the bottom. Guide layers are left out; adjustment layers are baked (PNGs can't carry them).
 */
export async function exportPartsZip(engine: Engine, project: Project, opts: LayeredOptions): Promise<LayeredResult> {
  const r = await renderLayered(engine, project, opts, false);
  const pngs = pngBatch(project.comp.dpi, opts.signal);
  const used = new Set<string>();
  const base = opts.ascii ? (asciiName(opts.baseName) ?? 'title') : safeWordName(opts.baseName) || 'title';
  // pngBatch takes over each image: the composite and node images aren't used after `add`.
  await pngs.add(`${uniqueStem(`${base}_composite`, used)}.png`, r.composite);
  const shown = [...(r.background ? [r.background] : []), ...r.nodes].filter((n) => !n.excluded && n.kind !== 'adjust');
  const label = (name: string) => (opts.ascii ? asciiName(name) : safeWordName(name)) || '';
  const write = async (n: Node, stem: string): Promise<void> => {
    throwIfAborted(opts.signal);
    if (n.kind === 'pixels') await pngs.add(`${uniqueStem(stem, used)}.png`, n.image);
    else if (n.kind === 'group')
      for (const [i, child] of n.children.entries()) if (!child.excluded) await write(child, `${stem}_${label(child.name).replace(/_+/g, '') || `part${i + 1}`}`);
  };
  for (const [i, n] of shown.entries()) {
    const nn = String(i + 1).padStart(String(shown.length).length, '0');
    await write(n, `${base}_${nn}_${label(n.name) || `layer${nn}`}`);
  }
  const files = await pngs.files();
  throwIfAborted(opts.signal);
  return { blob: await zipFiles(files), warnings: r.warnings };
}

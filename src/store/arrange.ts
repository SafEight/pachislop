import { followTarget } from '../generators/registry';
import type { Layer, ShapeSource } from '../model/types';
import { isTitleLayer, type TitleLayer } from '../model/parts';
import type { Bounds } from '../text/layout';
import { layerLocalBounds, toComp } from '../ui/viewport/geometry';
import { ancestorsOf, childrenOf, isGroup, normalizeTree, rootIds, subtreeIds, unionCompBounds, withDescendants } from './tree';

// Pure helpers behind the store's multi-layer commands (stacking, align / distribute, naming,
// backing-shape fitting). Comp space: px, origin = comp centre, +y up. A selected group acts as
// one unit made of its descendants (its own transform is unused).

export type AlignMode = 'left' | 'hcenter' | 'right' | 'top' | 'vmiddle' | 'bottom';
export type ArrangeOp = 'forward' | 'backward' | 'front' | 'back';

/**
 * Layers a move / align / distribute may shift: title and generator layers that are not locked
 * and not inside a locked group (backgrounds fill the comp, groups move through their
 * descendants, adjustment layers have no position).
 */
export function isMovable(layers: readonly Layer[], l: Layer): boolean {
  return (isTitleLayer(l) || l.kind === 'generator') && !l.locked && !ancestorsOf(layers, l.id).some((g) => g.locked);
}

/** `ids` in stacking order (bottom first), unknown ids dropped. */
export function orderIds(layers: readonly Layer[], ids: readonly string[]): string[] {
  const set = new Set(ids);
  return layers.filter((l) => set.has(l.id)).map((l) => l.id);
}

/**
 * Photoshop Arrange on a flat list, keeping the picked items' relative order. Forward /
 * backward step each picked item past ONE unpicked neighbour; front / back move the whole set
 * to the top / bottom. Unpicked floor items at the bottom stay the floor (like PS's Background
 * layer), so "send to back" never hides a title under the backdrop.
 */
function arrangeFlat<T>(items: readonly T[], sel: (t: T) => boolean, floor: (t: T) => boolean, op: ArrangeOp): T[] {
  const out = items.slice();
  const isFloor = (t: T) => floor(t) && !sel(t);
  if (op === 'front' || op === 'back') {
    const picked = out.filter(sel);
    const rest = out.filter((t) => !sel(t));
    if (op === 'front') return [...rest, ...picked];
    let f = 0;
    while (f < rest.length && isFloor(rest[f])) f++;
    return [...rest.slice(0, f), ...picked, ...rest.slice(f)];
  }
  if (op === 'forward') {
    for (let i = out.length - 2; i >= 0; i--) if (sel(out[i]) && !sel(out[i + 1])) [out[i], out[i + 1]] = [out[i + 1], out[i]];
  } else {
    for (let i = 1; i < out.length; i++)
      if (sel(out[i]) && !sel(out[i - 1]) && !isFloor(out[i - 1])) [out[i], out[i - 1]] = [out[i - 1], out[i]];
  }
  return out;
}

/**
 * Put the siblings `sibs` (one parent's children, bottom first) in the order `next` (the same
 * layers), carrying their subtrees; the rest of the stack is untouched. Normalised.
 */
function reorderSiblings(layers: readonly Layer[], sibs: readonly Layer[], next: readonly Layer[]): Layer[] {
  const out = layers.slice();
  sibs.forEach((s, k) => (out[layers.indexOf(s)] = next[k]));
  return normalizeTree(out);
}

/**
 * Arrange in the tree. The picked layers (a picked group carries its subtree) reorder among the
 * children of their deepest common parent; a picked layer deeper than that stands for its
 * ancestor at that level. A clip group (base + the layers clipped to it) moves as one unit, a
 * picked clipped layer standing for its clip group, except when every pick is clipped to the same
 * unpicked base: those reorder inside the clip group. Normalised.
 */
export function arrange(layers: readonly Layer[], ids: ReadonlySet<string>, op: ArrangeOp): Layer[] {
  const roots = rootIds(layers, [...ids]);
  if (!roots.length) return layers.slice();
  const chains = roots.map((id) => [id, ...ancestorsOf(layers, id).map((g) => g.id)].reverse());
  // Deepest group every chain passes through (null = top level).
  let depth = 0;
  while (chains.every((c) => c.length > depth + 1 && c[depth] === chains[0][depth])) depth++;
  const parent = depth ? chains[0][depth - 1] : null;
  const items = new Set(chains.map((c) => c[depth]));
  const sibs = childrenOf(layers, parent);
  // Clip groups of the sibling list, bottom first.
  const units: Layer[][] = [];
  for (const s of sibs) {
    if (s.clip && units.length) units[units.length - 1].push(s);
    else units.push([s]);
  }
  const inClip = units.find((u) => u.slice(1).some((s) => items.has(s.id)));
  if (inClip && !items.has(inClip[0].id) && [...items].every((id) => inClip.slice(1).some((s) => s.id === id))) {
    const clipped = arrangeFlat(inClip.slice(1), (s) => items.has(s.id), () => false, op);
    return reorderSiblings(layers, sibs, units.flatMap((u) => (u === inClip ? [u[0], ...clipped] : u)));
  }
  const next = arrangeFlat(
    units,
    (u) => u.some((s) => items.has(s.id)),
    (u) => u[0].kind === 'background',
    op,
  );
  return reorderSiblings(layers, sibs, next.flat());
}

/** Sub-pixel positions are kept (a box of odd width needs a half-pixel centre to touch an edge). */
const r2 = (v: number) => Math.round(v * 100) / 100;

const shifted = (l: Layer, dx: number, dy: number): Layer =>
  dx === 0 && dy === 0 ? l : ({ ...l, transform: { ...l.transform, x: r2(l.transform.x + dx), y: r2(l.transform.y + dy) } } as Layer);

/** Translate the listed movable layers (groups: their descendants) by (dx, dy) comp px. */
export function nudge(layers: readonly Layer[], ids: ReadonlySet<string>, dx: number, dy: number): Layer[] {
  const set = new Set(withDescendants(layers, [...ids]));
  return layers.map((l) => (set.has(l.id) && isMovable(layers, l) && !ridesAlong(l, set) ? shifted(l, dx, dy) : l));
}

/**
 * A generator following a layer of `moved`: it draws where that layer is (its transform an offset
 * on top), so moving both would move it twice.
 */
export const ridesAlong = (l: Layer, moved: ReadonlySet<string>): boolean => l.kind === 'generator' && moved.has(followTarget(l.generator));

/** One thing to align / distribute: a single layer or a group's movable descendants, with their common comp box. */
interface Unit {
  ids: Set<string>;
  box: Bounds;
}

/**
 * The listed layers as units; layers inside a listed group move with it. Layers without a box
 * (adjustments) take no part; a full-frame generator's box is the comp (`compW` × `compH`).
 */
function units(layers: readonly Layer[], ids: ReadonlySet<string>, compW: number, compH: number): Unit[] {
  const comp = { x0: -compW / 2, y0: -compH / 2, x1: compW / 2, y1: compH / 2 };
  const out: Unit[] = [];
  for (const id of rootIds(layers, [...ids])) {
    const l = layers.find((x) => x.id === id)!;
    const movers = (isGroup(l) ? subtreeIds(layers, id) : [id]).filter((m) => isMovable(layers, layers.find((x) => x.id === m)!));
    const box = movers.length ? unionCompBounds(layers, movers, comp) : null;
    if (box) out.push({ ids: new Set(movers), box });
  }
  return out;
}

/** Shift every layer of each unit by that unit's delta. */
function shiftUnits(layers: readonly Layer[], moves: { unit: Unit; dx: number; dy: number }[]): Layer[] {
  const by = new Map<string, { dx: number; dy: number }>();
  for (const m of moves) for (const id of m.unit.ids) by.set(id, m);
  return layers.map((l) => {
    const d = by.get(l.id);
    return d ? shifted(l, d.dx, d.dy) : l;
  });
}

/**
 * Align the visible boxes (rims included, effects not) of the listed units: to their common
 * box when two or more take part, otherwise to the comp (`compW` × `compH`).
 */
export function align(layers: readonly Layer[], ids: ReadonlySet<string>, mode: AlignMode, compW: number, compH: number): Layer[] {
  const us = units(layers, ids, compW, compH);
  if (us.length === 0) return layers.slice();
  const t =
    us.length >= 2
      ? { x0: Math.min(...us.map((u) => u.box.x0)), y0: Math.min(...us.map((u) => u.box.y0)), x1: Math.max(...us.map((u) => u.box.x1)), y1: Math.max(...us.map((u) => u.box.y1)) }
      : { x0: -compW / 2, y0: -compH / 2, x1: compW / 2, y1: compH / 2 };
  return shiftUnits(
    layers,
    us.map((unit) => {
      const b = unit.box;
      const dx = mode === 'left' ? t.x0 - b.x0 : mode === 'right' ? t.x1 - b.x1 : mode === 'hcenter' ? (t.x0 + t.x1 - b.x0 - b.x1) / 2 : 0;
      const dy = mode === 'bottom' ? t.y0 - b.y0 : mode === 'top' ? t.y1 - b.y1 : mode === 'vmiddle' ? (t.y0 + t.y1 - b.y0 - b.y1) / 2 : 0;
      return { unit, dx, dy };
    }),
  );
}

/**
 * Distribute the listed units (3+) along an axis with EQUAL GAPS between their boxes
 * (Illustrator / PS "distribute spacing"): the outermost two stay put. For same-size parts such
 * as 保留 orbs this is the same as equal centre steps. Full-frame generators span the comp
 * (`compW` × `compH`). Returns null when fewer than 3 take part.
 */
export function distribute(layers: readonly Layer[], ids: ReadonlySet<string>, axis: 'x' | 'y', compW: number, compH: number): Layer[] | null {
  const items = units(layers, ids, compW, compH).map((unit) =>
    axis === 'x' ? { unit, lo: unit.box.x0, size: unit.box.x1 - unit.box.x0 } : { unit, lo: unit.box.y0, size: unit.box.y1 - unit.box.y0 },
  );
  if (items.length < 3) return null;
  items.sort((a, b) => a.lo + a.size / 2 - (b.lo + b.size / 2));
  const first = items[0];
  const last = items[items.length - 1];
  const total = items.reduce((s, it) => s + it.size, 0);
  const gap = (last.lo + last.size - first.lo - total) / (items.length - 1);
  let at = first.lo;
  const moves = items.map((it) => {
    const d = at - it.lo;
    at += it.size + gap;
    return axis === 'x' ? { unit: it.unit, dx: d, dy: 0 } : { unit: it.unit, dx: 0, dy: d };
  });
  return shiftUnits(layers, moves);
}

/** The name a text layer gets from its text: the first non-empty line, trimmed ('' if none). */
export const textName = (text: string) => text.split('\n').find((s) => s.trim())?.trim() ?? '';

/** The text a project may be named after: its first line, or all lines joined by spaces (`whole`). */
export const titleForm = (text: string, whole: boolean) => (whole ? text.replace(/\s+/g, ' ').trim() : textName(text));

/** Whether `name` is `base` or a numbered copy of it (“確定 2”). */
export const isNumberedName = (name: string, base: string) => name === base || (name.startsWith(`${base} `) && /^\d+$/.test(name.slice(base.length + 1)));

/**
 * `name` when free, else its next free numbered form: “確定” → “確定 2”, “確定 3”… A trailing
 * number is the counter, so duplicating “確定 2” gives “確定 3” (never “確定 2 2”).
 */
export function uniqueName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name;
  const base = name.replace(/ \d+$/, '');
  let n = 2;
  while (taken.has(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}

/**
 * Photoshop's name for a new group / adjustment / generator layer: `prefix` (already in the UI language) plus
 * one more than the highest number among layer names “prefix N” (“レベル補正 3” → “レベル補正 4”);
 * “prefix 1” when there is none.
 */
export function numberedName(prefix: string, names: Iterable<string>): string {
  let max = 0;
  for (const name of names) {
    const n = name.startsWith(`${prefix} `) ? name.slice(prefix.length + 1) : '';
    if (/^\d+$/.test(n)) max = Math.max(max, Number(n));
  }
  return `${prefix} ${max + 1}`;
}

/**
 * Room left around the content when a plate-like shape is fitted to it, as fractions of the
 * content height: enough to leave a まくら plate some air at the ends. The content box already
 * includes the title's own rims.
 */
const FIT_PAD_X = 0.4;
const FIT_PAD_Y = 0.22;
/** Air between the content and a burst's valleys / a speech bubble's inner edge, × content height. */
const FIT_PAD_INNER = 0.08;
/**
 * Semi-axis factors of the ellipse through the padded box's corners (1/X² + 1/Y² = 1): wider
 * than tall, so a wide title gets a squatter badge than the √2 / √2 area-minimal ellipse.
 */
const ELL_X = 1.25;
const ELL_Y = 1 / Math.sqrt(1 - 1 / (ELL_X * ELL_X));
/**
 * How far into the spike zone (0 = the valleys, 1 = the tips) a burst lets the content's
 * corners reach: the edges between valleys and tips bulge outward there, so a corner a third
 * of the way in still reads as inside, like a hand-fitted 確定 stamp.
 */
const SPIKE_REACH = 0.35;
/** Burst aspect follows the content's (h / w) ^ this: < 1 keeps wide titles on a rounder badge. */
const SPIKE_ASPECT_EXP = 0.6;

/**
 * Body box (W × H comp px; H becomes `size`) a shape needs so a w × h content box sits inside
 * it with padding, the content turned by `rel` radians in the shape's frame.
 */
function fitBody(src: ShapeSource, w: number, h: number, rel: number): { W: number; H: number } {
  const [cos, sin] = [Math.cos(rel), Math.sin(rel)];
  // The content's extents in the shape's frame (what an axis-aligned body has to hold).
  const ew = w * Math.abs(cos) + h * Math.abs(sin);
  const eh = w * Math.abs(sin) + h * Math.abs(cos);
  const pad = FIT_PAD_INNER * h;
  switch (src.shape) {
    case 'parallelogram': {
      const H = eh + 2 * FIT_PAD_Y * h;
      // The lean eats |H·tan(slant)| of the width (top shifts right, bottom left).
      return { W: ew + 2 * FIT_PAD_X * h + Math.abs(H * Math.tan((Math.max(-80, Math.min(80, src.slant)) * Math.PI) / 180)), H };
    }
    case 'ellipse':
    case 'orb': {
      // The padded box's corners graze the ellipse.
      const p = FIT_PAD_Y * h;
      return { W: (ew + 2 * p) * ELL_X, H: (eh + 2 * p) * ELL_Y };
    }
    case 'polygon':
      return { W: (ew + 2 * FIT_PAD_X * h) * 1.2, H: (eh + 2 * FIT_PAD_Y * h) * 1.2 };
    case 'shield':
      return { W: (ew + 2 * FIT_PAD_X * h) * 1.15, H: (eh + 2 * FIT_PAD_Y * h) * 1.3 };
    case 'star':
    case 'burst':
    case 'shout': {
      // Deepest valley as a fraction of the tip ellipse: `inner`, less jitter's ±10 % (bursts),
      // or the star's inscribed edge midpoints. The padded content's own (turned) corners must
      // sit within SPIKE_REACH of it, so a rotated burst doesn't pay for the content's bounding box.
      const inner0 = Math.max(0.05, Math.min(1, src.inner));
      const inner = src.shape === 'star' ? inner0 * Math.cos(Math.PI / Math.max(3, src.points)) : inner0 * (1 - 0.1 * Math.max(0, Math.min(1, src.jitter)));
      const reach = inner + SPIKE_REACH * (1 - inner);
      const q = Math.pow((eh + 2 * pad) / (ew + 2 * pad), SPIKE_ASPECT_EXP); // H / W
      const [hw, hh] = [w / 2 + pad, h / 2 + pad];
      let a = 0; // tip semi-axis along x
      for (const [x0, y0] of [[hw, hh], [hw, -hh]]) {
        const x = x0 * cos + y0 * sin;
        const y = -x0 * sin + y0 * cos;
        a = Math.max(a, Math.hypot(x, y / q) / reach);
      }
      return { W: 2 * a, H: 2 * a * q };
    }
    case 'speech': {
      // Rounded body (corner % of the height): the padded box's corners must clear the corner arcs.
      const by = eh / 2 + pad;
      const bx = ew / 2 + pad;
      const Y = by * 1.12;
      const r = Math.min((Math.max(0, src.corner) / 100) * 2 * Y, Y);
      const dy = Math.max(0, by - (Y - r));
      const X = bx + r - Math.sqrt(Math.max(0, r * r - dy * dy));
      return { W: 2 * Math.max(X, r), H: 2 * Y };
    }
    default:
      return { W: ew + 2 * FIT_PAD_X * h, H: eh + 2 * FIT_PAD_Y * h };
  }
}

/**
 * Fit a shape layer behind `target` (a text or shape title): centred on the target's drawn box
 * (rims included), sized to it plus padding at 100 % scale so Height is the real px size. The
 * shape keeps its own rotation (the box is measured in the shape's frame) and is shrunk to stay
 * inside the comp (`compW` × `compH`). Null when the target has no box yet (font loading).
 */
export function fitShapeTo(shape: TitleLayer & { source: ShapeSource }, target: TitleLayer, compW: number, compH: number): TitleLayer | null {
  const b = layerLocalBounds(target);
  if (!b) return null;
  const s = Math.abs(target.transform.scale);
  const c = toComp(target, { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 });
  const rel = ((shape.transform.rotZ - target.transform.rotZ) * Math.PI) / 180;
  const body = fitBody(shape.source, (b.x1 - b.x0) * s, (b.y1 - b.y0) * s, rel);
  // Shrink to the comp: the body's axis-aligned box at the shape's rotation.
  const a = (shape.transform.rotZ * Math.PI) / 180;
  const [ca, sa] = [Math.abs(Math.cos(a)), Math.abs(Math.sin(a))];
  const k = Math.min(1, compW / (body.W * ca + body.H * sa), compH / (body.W * sa + body.H * ca));
  const t = target.transform;
  return {
    ...shape,
    source: { ...shape.source, size: Math.round(body.H * k), aspect: Math.round((body.W / body.H) * 100) / 100 },
    transform: { ...shape.transform, x: r2(c.x), y: r2(c.y), scale: 1, ...(shape.kind === 'title3d' && target.kind === 'title3d' ? { z: t.z, rotX: t.rotX, rotY: t.rotY } : {}) },
  } as TitleLayer;
}

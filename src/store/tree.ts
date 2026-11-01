import type { GroupLayer, Layer, PartKey, Transform } from '../model/types';
import { isTitleLayer, layerParts, prunePartEffects, type TitleLayer } from '../model/parts';
import type { Bounds } from '../text/layout';
import { layerCompBounds } from '../ui/viewport/geometry';

// The layer tree (nested groups, clipping masks): pure helpers behind the store. Invariants (see
// LayerBase.parentId / clip): every group's whole subtree sits contiguously DIRECTLY BELOW the
// group in `Project.layers`, every parentId names an existing group (no cycles), and `clip` is
// only set where the layer has a clip base. `normalizeTree` re-establishes them after any mutation.

export const isGroup = (l: Layer | null | undefined): l is GroupLayer => l?.kind === 'group';

/** Children of group `parentId` (null = top level), bottom first. */
export const childrenOf = (layers: readonly Layer[], parentId: string | null): Layer[] => layers.filter((l) => (l.parentId ?? null) === parentId);

/** Groups containing `id`, nearest first (empty for top-level layers and unknown ids). */
export function ancestorsOf(layers: readonly Layer[], id: string): GroupLayer[] {
  const byId = new Map(layers.map((l) => [l.id, l]));
  const out: GroupLayer[] = [];
  let pid = byId.get(id)?.parentId;
  while (pid !== undefined) {
    const g = byId.get(pid);
    if (!isGroup(g) || out.includes(g)) break;
    out.push(g);
    pid = g.parentId;
  }
  return out;
}

/** Nesting depth: 0 at top level, 1 inside one group… */
export const depthOf = (layers: readonly Layer[], id: string): number => ancestorsOf(layers, id).length;

/** Ids of every descendant of group `groupId` (the group itself excluded), in stack order (bottom first); empty for non-groups. */
export function subtreeIds(layers: readonly Layer[], groupId: string): string[] {
  const inside = new Set([groupId]);
  const out: string[] = [];
  // The array may not be normalised yet (any order), so grow the set until it stops changing.
  for (let grew = true; grew; ) {
    grew = false;
    for (const l of layers)
      if (l.parentId !== undefined && inside.has(l.parentId) && !inside.has(l.id)) {
        inside.add(l.id);
        grew = true;
      }
  }
  for (const l of layers) if (l.id !== groupId && inside.has(l.id)) out.push(l.id);
  return out;
}

/** `ids` plus every descendant of each listed group, in stack order (bottom first). */
export function withDescendants(layers: readonly Layer[], ids: readonly string[]): string[] {
  const set = new Set(ids);
  for (const id of ids) for (const d of subtreeIds(layers, id)) set.add(d);
  return layers.filter((l) => set.has(l.id)).map((l) => l.id);
}

/** The listed ids that have no listed ancestor (the roots of a selection), in stack order. */
export function rootIds(layers: readonly Layer[], ids: readonly string[]): string[] {
  const set = new Set(ids);
  return layers.filter((l) => set.has(l.id) && !ancestorsOf(layers, l.id).some((g) => set.has(g.id))).map((l) => l.id);
}

/**
 * The clip base of layer `id`: the nearest sibling below it that is not clipped itself. Null when
 * the layer isn't clipped, has no such sibling, or that sibling is an adjustment layer
 * (adjustments are never bases; the engine's drawTree uses the same rule).
 */
export function clipBaseOf(layers: readonly Layer[], id: string): Layer | null {
  const l = layers.find((x) => x.id === id);
  if (!l?.clip) return null;
  const sibs = childrenOf(layers, l.parentId ?? null);
  let j = sibs.indexOf(l) - 1;
  while (j >= 0 && sibs[j].clip) j--;
  const base = sibs[j];
  return base && base.kind !== 'adjustment' ? base : null;
}

/** The layer has `clip` set AND a base to clip to. */
export const isClipped = (layers: readonly Layer[], id: string): boolean => clipBaseOf(layers, id) !== null;

/** Layers clipped to `baseId` (its clip group above it), bottom first; empty when it is clipped itself or no base. */
export function clippedTo(layers: readonly Layer[], baseId: string): Layer[] {
  const base = layers.find((x) => x.id === baseId);
  if (!base || base.clip || base.kind === 'adjustment') return [];
  const sibs = childrenOf(layers, base.parentId ?? null);
  const out: Layer[] = [];
  for (let j = sibs.indexOf(base) + 1; j < sibs.length && sibs[j].clip; j++) out.push(sibs[j]);
  return out;
}

/** Layer with `parentId` set (or removed when undefined); the same object when unchanged. */
export function withParent<L extends Layer>(l: L, parentId: string | undefined): L {
  if (l.parentId === parentId) return l;
  if (parentId === undefined) {
    const { parentId: _, ...rest } = l;
    return rest as L;
  }
  return { ...l, parentId };
}

/**
 * Whether title `l` has style part `part`. A hidden 2D face (`style.hideFace`) still counts: its
 * eye in the Layers panel brings it back, effects included, so it stays selectable and keeps them.
 */
export const hasPart = (l: TitleLayer, part: PartKey): boolean => (part === 'face' && l.kind === 'title2d') || layerParts(l).includes(part);

/**
 * Re-establish the tree invariants. Stray parentIds (a missing or non-group parent, a cycle) are
 * dropped; then every group's subtree is gathered directly below it, recursively. Siblings keep
 * the relative order they have in the input, so a mutation picks where a block lands by where it
 * leaves the block's top layer (a group's position is its own row's). Title part effects of parts
 * that no longer exist (see hasPart) are pruned, and `clip` is cleared where the layer has no base
 * (see clipBaseOf). Returns `layers` itself when nothing changed.
 */
export function normalizeTree(layers: readonly Layer[]): Layer[] {
  const byId = new Map(layers.map((l) => [l.id, l]));
  /** Valid parent of `l`: an existing group whose chain of parents never comes back to `l`. */
  const parentOk = (l: Layer): boolean => {
    if (l.parentId === undefined || !isGroup(byId.get(l.parentId))) return false;
    const seen = new Set([l.id]);
    for (let pid: string | undefined = l.parentId; pid !== undefined; pid = byId.get(pid)?.parentId) {
      if (seen.has(pid)) return false;
      seen.add(pid);
    }
    return true;
  };
  const fixed = layers.map((l) => {
    let out = withParent(l, parentOk(l) ? l.parentId : undefined);
    if (isTitleLayer(out)) {
      // Prune as if a hidden 2D face were shown, so hiding it keeps its effects (see hasPart).
      const partEffects = prunePartEffects(out.kind === 'title2d' && out.style.hideFace ? { ...out, style: { ...out.style, hideFace: false } } : out);
      if (partEffects !== out.partEffects) out = { ...out, partEffects };
    }
    return out;
  });
  const kids = new Map<string | null, Layer[]>();
  for (const l of fixed) {
    const k = l.parentId ?? null;
    (kids.get(k) ?? kids.set(k, []).get(k)!).push(l);
  }
  const out: Layer[] = [];
  const emit = (parent: string | null) => {
    let base: Layer | null = null;
    for (let l of kids.get(parent) ?? []) {
      if (l.clip && (!base || base.kind === 'adjustment')) l = { ...l, clip: false };
      if (!l.clip) base = l;
      if (isGroup(l)) emit(l.id);
      out.push(l);
    }
  };
  emit(null);
  return out.length === layers.length && out.every((l, i) => l === layers[i]) ? (layers as Layer[]) : out;
}

/**
 * Union of the comp boxes of the listed layers; groups contribute their descendants, adjustments
 * and backgrounds nothing. Full-frame generators (no box of their own) count as `fullFrame` when
 * given (align / distribute: the comp), else nothing. Null when none has a box.
 */
export function unionCompBounds(layers: readonly Layer[], ids: readonly string[], fullFrame?: Bounds): Bounds | null {
  const set = new Set(withDescendants(layers, ids));
  let u: Bounds | null = null;
  for (const l of layers) {
    if (!set.has(l.id)) continue;
    const b = layerCompBounds(l) ?? (l.kind === 'generator' ? fullFrame : undefined);
    if (!b) continue;
    u = u ? { x0: Math.min(u.x0, b.x0), y0: Math.min(u.y0, b.y0), x1: Math.max(u.x1, b.x1), y1: Math.max(u.y1, b.y1) } : b;
  }
  return u;
}

/**
 * Free transform of several layers as one: translate by (dx, dy) comp px, scale by `scale` and
 * rotate by `rotate` degrees (clockwise, like rotZ) about `about` (comp px, +y up). Positions
 * move with the transform; each layer's own scale / rotZ follow so the parts stay locked together.
 */
export interface LayerXform {
  dx?: number;
  dy?: number;
  scale?: number;
  rotate?: number;
  about?: { x: number; y: number };
}

const r2 = (v: number) => Math.round(v * 100) / 100;

/** `t` under `xf` (about point required when scaling / rotating). */
export function xformTransform(t: Transform, xf: LayerXform, about: { x: number; y: number }): Transform {
  const s = xf.scale ?? 1;
  const deg = xf.rotate ?? 0;
  const a = (deg * Math.PI) / 180;
  const vx = (t.x - about.x) * s;
  const vy = (t.y - about.y) * s;
  // Clockwise on screen with +y up.
  const x = about.x + vx * Math.cos(a) + vy * Math.sin(a) + (xf.dx ?? 0);
  const y = about.y - vx * Math.sin(a) + vy * Math.cos(a) + (xf.dy ?? 0);
  const rotZ = deg ? Math.round((((t.rotZ + deg + 540) % 360) - 180) * 10) / 10 : t.rotZ;
  return { ...t, x: r2(x), y: r2(y), rotZ, scale: s === 1 ? t.scale : Math.max(0.01, Math.round(t.scale * s * 1000) / 1000) };
}

import { createGroupLayer, defaultTransform } from './defaults';
import type { GeneratorLayer, GroupLayer, Layer } from './types';

// Companion generators (GeneratorLayer.companionOf): the generators a look or "on <layer>" made
// for a layer (glints on its highlights, fire behind it). They sit directly below the layer or
// above its clip group, in a group with it, so the group composites them with the layer alone (an
// 'add' companion lights only the layer, as the effects they replaced did) and moves as one.

/** The companions of layer `id`. */
export const companionsOf = (layers: readonly Layer[], id: string): GeneratorLayer[] =>
  layers.filter((l): l is GeneratorLayer => l.kind === 'generator' && l.companionOf === id);

/**
 * Index span [from, to] of layer `i` with its subtree (contiguous directly below a group's row)
 * and its clip group (the clipped siblings above it, with their subtrees).
 */
function blockOf(layers: readonly Layer[], i: number): [number, number] {
  const l = layers[i];
  const pid = l.parentId;
  const inside = new Set([l.id]);
  for (let grew = l.kind === 'group'; grew; ) {
    grew = false;
    for (const x of layers)
      if (x.parentId !== undefined && inside.has(x.parentId) && !inside.has(x.id)) {
        inside.add(x.id);
        grew = true;
      }
  }
  let from = i;
  while (from > 0 && inside.has(layers[from - 1].id)) from--;
  // The clip group: siblings above that are clipped (the rows between are their subtrees).
  let to = i;
  for (let k = i + 1; k < layers.length; ) {
    let m = k;
    while (m < layers.length && layers[m].parentId !== pid && layers[m].id !== pid) m++;
    if (m >= layers.length || layers[m].id === pid || !layers[m].clip) break;
    to = m;
    k = m + 1;
  }
  return [from, to];
}

/**
 * The group layer `id` sits in on its own: its parent, when that holds only the layer, its clip
 * group and its companions; else null.
 */
export function ownGroupOf(layers: readonly Layer[], id: string): GroupLayer | null {
  const i = layers.findIndex((l) => l.id === id);
  if (i < 0) return null;
  return ownParent(layers, i, blockOf(layers, i));
}

function ownParent(layers: readonly Layer[], i: number, [from, to]: [number, number]): GroupLayer | null {
  const layer = layers[i];
  const parent = layer.parentId !== undefined ? layers.find((l) => l.id === layer.parentId) : undefined;
  if (parent?.kind !== 'group') return null;
  const block = new Set(layers.slice(from, to + 1).map((l) => l.id));
  return layers.every((l) => l.parentId !== parent.id || block.has(l.id) || (l.kind === 'generator' && l.companionOf === layer.id)) ? parent : null;
}

/**
 * What a new group wrapping a layer and its companions starts as. `fresh`: always a new group,
 * even when the layer has one of its own (the migration, whose group carries the effects that
 * came after the replaced ones).
 */
export type GroupInit = Partial<Pick<GroupLayer, 'effects' | 'name'>> & { fresh?: boolean };

/**
 * `layers` with the companions of layer `id` replaced by `below` and `above` (each bottom first):
 * `below` directly under the layer, `above` over its clip group, marked `companionOf` it and
 * shown / guide like it, in a group with it. That group is the one it sits in on its own
 * (ownGroupOf, unless `init.fresh`); else a new group named after the layer (`init` over that)
 * takes the layer's place, clipping, blend and opacity, so it composites exactly as the layer did.
 * With nothing to add (no companions, no `init.effects`), the old companions are just removed.
 */
export function placeCompanions(layers: readonly Layer[], id: string, below: readonly GeneratorLayer[], above: readonly GeneratorLayer[], init?: GroupInit): Layer[] {
  const kept = layers.filter((l) => !(l.kind === 'generator' && l.companionOf === id));
  if (!below.length && !above.length && !init?.effects?.length) return kept;
  const i = kept.findIndex((l) => l.id === id);
  if (i < 0) return kept;
  const layer = kept[i];
  const [from, to] = blockOf(kept, i);
  const own = init?.fresh ? null : ownParent(kept, i, [from, to]);
  let groupId: string;
  let out: Layer[];
  if (own) {
    groupId = own.id;
    out = kept.slice();
  } else {
    const { fresh: _, ...fields } = init ?? {};
    const g: GroupLayer = {
      ...createGroupLayer(layer.name),
      companionGroupOf: id,
      ...fields,
      clip: layer.clip,
      blend: layer.blend,
      transform: { ...defaultTransform(), opacity: layer.transform.opacity },
      ...(layer.parentId !== undefined ? { parentId: layer.parentId } : {}),
    };
    groupId = g.id;
    const inner = kept.slice(from, to + 1).map((l): Layer => {
      if (l.id === id) return { ...l, parentId: g.id, clip: false, blend: 'normal', transform: { ...l.transform, opacity: 1 } };
      return l.parentId === layer.parentId ? { ...l, parentId: g.id } : l;
    });
    out = [...kept.slice(0, from), ...inner, g, ...kept.slice(to + 1)];
  }
  const mark = (c: GeneratorLayer): GeneratorLayer => ({ ...c, companionOf: id, parentId: groupId, visible: layer.visible, guide: layer.guide });
  // `from` / `to` still index the block: a new group row went in after it.
  return [...out.slice(0, from), ...below.map(mark), ...out.slice(from, to + 1), ...above.map(mark), ...out.slice(to + 1)];
}

/**
 * `layers` with generator `g` added as a companion of layer `id`, keeping its others: at the top
 * (`above`) or the bottom (`below`) of the group the layer sits in on its own, else in a new one
 * (placeCompanions).
 */
export function addCompanion(layers: readonly Layer[], id: string, g: GeneratorLayer, place: 'above' | 'below'): Layer[] {
  const layer = layers.find((l) => l.id === id);
  if (!layer) return layers.slice();
  const own = ownGroupOf(layers, id);
  if (!own) {
    // placeCompanions replaces the layer's companions: set the current ones aside while it places `g`.
    const others = new Set(companionsOf(layers, id).map((c) => c.id));
    const aside = layers.map((l) => (others.has(l.id) && l.kind === 'generator' ? { ...l, companionOf: undefined } : l));
    const placed = placeCompanions(aside, id, place === 'below' ? [g] : [], place === 'above' ? [g] : []);
    return placed.map((l) => (others.has(l.id) ? { ...l, companionOf: id } : l));
  }
  const marked: GeneratorLayer = { ...g, companionOf: id, parentId: own.id, visible: layer.visible, guide: layer.guide };
  // The group row tops its subtree; its block starts at the subtree's bottom row.
  const top = layers.indexOf(own);
  const at = place === 'above' ? top : blockOf(layers, top)[0];
  return [...layers.slice(0, at), marked, ...layers.slice(at)];
}

/**
 * `layers` with the companion groups (GroupLayer.companionGroupOf) among layer `id`'s ancestors
 * dissolved where they no longer hold anything but one member and carry nothing of their own (no
 * effects or masks; blend / opacity only where the member has none): the member takes the group's
 * place, clipping, blend and opacity back. An empty one is removed. Innermost first, so a group
 * left holding only a dissolved group's member (or a still needed inner group) goes too.
 */
export function dissolveCompanionGroups(layers: readonly Layer[], id: string): Layer[] {
  let out = layers.slice();
  for (let pid = out.find((l) => l.id === id)?.parentId; pid !== undefined; ) {
    const g = out.find((l) => l.id === pid);
    if (g?.kind !== 'group') break;
    const next = g.parentId;
    const kids = out.filter((l) => l.parentId === g.id);
    const member = kids[0];
    const plain = (l: Layer) => l.blend === 'normal' && l.transform.opacity === 1;
    const loose = g.companionGroupOf !== undefined && !g.effects.length && !g.masks.length && kids.length <= 1 && (!member || plain(member) || plain(g));
    if (!loose) {
      pid = next;
      continue;
    }
    out = out.flatMap((l): Layer[] => {
      if (l === g) return [];
      if (l !== member) return [l];
      const { parentId: _, ...rest } = l;
      return [{ ...rest, ...(next !== undefined ? { parentId: next } : {}), clip: g.clip, ...(plain(l) ? { blend: g.blend, transform: { ...l.transform, opacity: g.transform.opacity } } : {}) } as Layer];
    });
    pid = next;
  }
  return out;
}

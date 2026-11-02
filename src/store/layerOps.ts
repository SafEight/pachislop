import { getEffect } from '../effects/registry';
import type { ParamDef } from '../engine/contracts';
import { createGeneratorLayer, generatorFromPreset, getGenerator, presetEffects } from '../generators/registry';
import { addCompanion } from '../model/companions';
import { ADJUSTMENT_NAMES, createAdjustmentLayer, createGroupLayer, uid } from '../model/defaults';
import { bandKey, isTitleLayer, rimKey, type TitleLayer } from '../model/parts';
import type { Layer, ParamValue, PartEffects, PartKey } from '../model/types';
import { applyPresetToProject, presetFromLayer } from '../presets/apply';
import { tr } from '../ui/i18n';
import { arrange, isNumberedName, numberedName, uniqueName } from './arrange';
import type { Core, Slice } from './core';
import { commit, editLayer } from './history';
import { msg, type Text } from './msg';
import { layerNode, selection } from './selection';
import type { LayerDest } from './store';
import { childrenOf, clipBaseOf, clippedTo, isGroup, normalizeTree, rootIds, subtreeIds, withDescendants, withParent } from './tree';

// Layer stack actions: add, delete, duplicate, move / arrange, group / ungroup, clip, rename, copy / paste style.

/** Deep copy with fresh ids (layer, effects, masks, rims, bands; part-effect keys follow their parts). */
export function cloneLayerFresh<L extends Layer>(layer: L): L {
  const copy = structuredClone(layer);
  copy.id = uid();
  copy.effects = copy.effects.map((e) => ({ ...e, id: uid() }));
  copy.masks = copy.masks.map((m) => ({ ...m, id: uid() }));
  if (!isTitleLayer(copy)) return copy;
  // Same object, typed as a title so the kind checks below narrow it.
  const title: TitleLayer = copy;
  const keys = new Map<string, PartKey>();
  const fresh = <T extends { id: string }>(list: T[], key: (id: string) => PartKey) =>
    list.map((x) => {
      const id = uid();
      keys.set(key(x.id), key(id));
      return { ...x, id };
    });
  if (title.kind === 'title2d') title.style.rims = fresh(title.style.rims, rimKey);
  else title.style3d.bands = fresh(title.style3d.bands, bandKey);
  title.partEffects = Object.fromEntries(
    Object.entries(title.partEffects).map(([k, fx]) => [keys.get(k) ?? k, (fx ?? []).map((e) => ({ ...e, id: uid() }))]),
  ) as PartEffects;
  return copy;
}

/**
 * Re-point a fresh copy's layer pickers ('layer' kind generator and effect params, layer-source
 * masks) at the copies of the layers they name (`fresh`: original id → copy id), so a duplicated
 * group's particles keep emitting from its own copied title. Mutates `copy` (a fresh clone).
 */
function repointCopy(copy: Layer, fresh: ReadonlyMap<string, string>): void {
  const repoint = (defs: readonly ParamDef[] | undefined, params: Record<string, ParamValue>) => {
    for (const pd of defs ?? []) {
      const v = params[pd.key];
      if (pd.kind === 'layer' && typeof v === 'string' && fresh.has(v)) params[pd.key] = fresh.get(v)!;
    }
  };
  if (copy.kind === 'generator') repoint(getGenerator(copy.generator.type)?.params, copy.generator.params);
  const stacks = [copy.effects, ...(isTitleLayer(copy) ? Object.values(copy.partEffects) : [])];
  for (const list of stacks) for (const fx of list ?? []) repoint(getEffect(fx.type)?.params, fx.params);
  copy.masks = copy.masks.map((m) => (m.kind === 'layer' && fresh.has(m.layerId) ? { ...m, layerId: fresh.get(m.layerId)! } : m));
}

/**
 * `layers` with `block` (layers in stack order, subtrees contiguous, roots already re-parented to
 * `parent`) taken out of their old places and put among `parent`'s children directly above
 * sibling `under` (null = at the bottom of the parent). Not normalised.
 */
function insertBlock(layers: readonly Layer[], block: readonly Layer[], parent: string | null, under: Layer | null): Layer[] {
  const ids = new Set(block.map((l) => l.id));
  const rest = layers.filter((l) => !ids.has(l.id));
  const g = parent === null ? -1 : rest.findIndex((l) => l.id === parent);
  const at = under ? rest.indexOf(under) + 1 : g < 0 ? 0 : g - subtreeIds(rest, parent!).length;
  return [...rest.slice(0, at), ...block, ...rest.slice(at)];
}

/** Whether the gap above sibling `under` (null = the bottom) of `parent` lies inside a clip group: the sibling just above it is clipped. */
function gapInClip(layers: readonly Layer[], parent: string | null, under: Layer | null): boolean {
  const sibs = childrenOf(layers, parent);
  return !!sibs[under ? sibs.indexOf(under) + 1 : 0]?.clip;
}

/** Parent and sibling just below the gap (null = the bottom) that `to` names in `layers`; null when its layer / group isn't there. */
function slotOf(layers: readonly Layer[], to: LayerDest): { parent: string | null; under: Layer | null } | null {
  if ('into' in to) {
    if (to.into !== null && !isGroup(layers.find((l) => l.id === to.into))) return null;
    const sibs = childrenOf(layers, to.into);
    return { parent: to.into, under: sibs[Math.max(0, Math.min(sibs.length, to.index ?? sibs.length)) - 1] ?? null };
  }
  const t = layers.find((l) => l.id === ('aboveId' in to ? to.aboveId : to.belowId));
  if (!t) return null;
  const parent = t.parentId ?? null;
  const sibs = childrenOf(layers, parent);
  return { parent, under: 'aboveId' in to ? t : (sibs[sibs.indexOf(t) - 1] ?? null) };
}

/** History-label subject for a set of layers: “Plate” or “3 layers”. */
export const what = (layers: readonly Layer[]) => (layers.length === 1 ? msg('“{name}”', { name: layers[0].name }) : msg('{n} layers', { n: layers.length }));

/**
 * Insert a new layer and select it: at `at` when given, else above the primary selection in
 * its parent (top of the stack when none). Like PS it is clipped when it lands inside a clip
 * group (just above a clipped layer, or between a base and its clipped layers), and anyway
 * when `clip` is set.
 */
function insertNew(core: Core, layer: Layer, label: Text, at?: LayerDest, clip = false): void {
  const { project, selectedLayerId } = core.get();
  const L = project.layers;
  const sel = L.find((l) => l.id === selectedLayerId);
  const slot = at && slotOf(L, at);
  const parent = slot ? slot.parent : (sel?.parentId ?? null);
  const under = slot ? slot.under : (sel ?? childrenOf(L, parent).at(-1) ?? null);
  // The layer it lands right above (the selection, or `aboveId`) clips it when clipped itself.
  const above = slot ? (at && 'aboveId' in at ? slot.under : null) : sel;
  const inClip = !!above?.clip || gapInClip(L, parent, under);
  const added = withParent({ ...layer, clip: layer.clip || clip || inClip }, parent ?? undefined);
  commit(core, { ...project, layers: insertBlock(L, [added], parent, under) }, undefined, label);
  core.anchor = layer.id;
  core.set(selection(core, [], layer.id, layerNode(layer.id)));
}

/**
 * Where a copy of `l` goes so it stacks just above it: directly above a clipped layer (the copy
 * stays in its clip group), above the whole clip group of a base (so it steals no clipped layers).
 */
const copyAnchor = (layers: readonly Layer[], l: Layer): Layer => (l.clip ? l : (clippedTo(layers, l.id).at(-1) ?? l));

/** The roots of `ids` (see rootIds), with every listed base carrying the layers clipped to it; stack order. */
function carryRoots(layers: readonly Layer[], ids: readonly string[]): string[] {
  const roots = rootIds(layers, ids);
  return rootIds(layers, [...roots, ...roots.flatMap((id) => clippedTo(layers, id).map((c) => c.id))]);
}

export const layerSlice: Slice<'addLayer' | 'removeLayers' | 'duplicateLayers' | 'duplicateAsGhost' | 'copyStyle' | 'pasteStyle' | 'moveLayers' | 'arrangeLayers' | 'groupLayers' | 'ungroupLayers' | 'toggleClip' | 'addAdjustment' | 'addGenerator' | 'applyGeneratorPreset' | 'renameLayer' | 'patchLayer' | 'replaceLayer'> = (core) => {
  const { get, set } = core;
  return {
    addLayer(layer, at) {
      const below = at && 'belowId' in at ? get().project.layers.find((l) => l.id === at.belowId) : undefined;
      insertNew(core, layer, below ? msg('Add “{name}” below “{below}”', { name: layer.name, below: below.name }) : msg('Add “{name}”', { name: layer.name }), at);
    },
    removeLayers(ids) {
      const { project } = get();
      const L = project.layers;
      const gone = new Set(withDescendants(L, ids));
      const roots = new Set(rootIds(L, [...gone]));
      const removed = L.filter((l) => roots.has(l.id));
      if (!removed.length) return;
      const layers = L.filter((l) => !gone.has(l.id));
      commit(core, { ...project, layers }, undefined, msg('Delete {what}', { what: what(removed) }));
      // Like PS: the sibling that slid into the lowest deleted slot, else the one below it, else
      // the parent group; at top level with nothing left, the new top layer.
      const low = removed[0];
      const parent = low.parentId ?? null;
      const sibs = childrenOf(layers, parent);
      const lowAt = L.indexOf(low);
      const next = sibs.find((s) => L.indexOf(s) > lowAt) ?? sibs.at(-1) ?? (parent !== null ? layers.find((l) => l.id === parent) : layers.at(-1));
      core.anchor = next?.id ?? null;
      set(selection(core, [], next?.id ?? null, layerNode(next?.id ?? null)));
    },
    duplicateLayers(ids) {
      const { project, selectedLayerId } = get();
      const L = project.layers;
      const roots = rootIds(L, ids).map((id) => L.find((l) => l.id === id)!);
      if (!roots.length) return;
      const taken = new Set(L.map((l) => l.name));
      /** Copy blocks (subtree then the root, stack order) to insert after each anchor layer. */
      const after = new Map<Layer, Layer[]>();
      const rootCopies = new Map<string, Layer>();
      for (const root of roots) {
        const fresh = new Map<string, string>();
        const block = [...subtreeIds(L, root.id).map((id) => L.find((l) => l.id === id)!), root].map((l) => {
          const copy = cloneLayerFresh(l);
          fresh.set(l.id, copy.id);
          // Numbered copies (“確定 2”); a text copy so named still follows its text (see setText).
          copy.name = uniqueName(l.name, taken);
          taken.add(copy.name);
          return copy;
        });
        for (const c of block) repointCopy(c, fresh);
        // Re-point the copied children at the copied groups; the root copy keeps the original's parent.
        const copies = block.map((c) => (c.parentId !== undefined && fresh.has(c.parentId) ? withParent(c, fresh.get(c.parentId)) : c));
        rootCopies.set(root.id, copies.at(-1)!);
        const at = copyAnchor(L, root);
        after.set(at, [...(after.get(at) ?? []), ...copies]);
      }
      const layers = L.flatMap((l) => [l, ...(after.get(l) ?? [])]);
      commit(core, { ...project, layers }, undefined, msg('Duplicate {what}', { what: what(roots) }));
      const tops = [...rootCopies.values()];
      const primary = rootCopies.get(selectedLayerId ?? '') ?? tops.at(-1)!;
      core.anchor = primary.id;
      set(selection(core, tops.map((c) => c.id), primary.id, layerNode(primary.id)));
    },
    duplicateAsGhost(id) {
      const { project } = get();
      const src = project.layers.find((l) => l.id === id);
      if (!isTitleLayer(src)) return;
      const ghost = cloneLayerFresh(src);
      ghost.name = `${src.name} ghost`;
      ghost.guide = true;
      ghost.locked = true;
      ghost.solo = false;
      ghost.transform = { ...ghost.transform, opacity: 0.3 };
      // Same parent and clip state as the source (a clone keeps both), just above it.
      const i = project.layers.indexOf(copyAnchor(project.layers, src));
      commit(core, { ...project, layers: [...project.layers.slice(0, i + 1), ghost, ...project.layers.slice(i + 1)] }, undefined, msg('Ghost guide of “{name}”', { name: src.name }));
    },
    copyStyle(id) {
      const { project, notify } = get();
      const layer = project.layers.find((l) => l.id === id);
      if (!isTitleLayer(layer)) return notify('Only title layers have a style to copy', 'error');
      set({ styleClip: presetFromLayer(project, layer.id, layer.name, 'Clipboard') });
      notify(msg('Copied the style of “{name}”', { name: layer.name }));
    },
    pasteStyle(ids) {
      const { project, styleClip, notify } = get();
      if (!styleClip) return notify('No style copied yet (⌘⌥C on a title layer)', 'error');
      const picked = new Set(ids);
      // A listed group passes the paste on to the title layers inside it.
      const all = new Set(withDescendants(project.layers, ids));
      const targets = project.layers.filter((l) => all.has(l.id) && !isGroup(l) && (isTitleLayer(l) || picked.has(l.id)));
      const ok = targets.filter((l) => l.kind === styleClip.kind);
      const dim = styleClip.kind === 'title2d' ? '2D' : '3D';
      if (!ok.length) return notify(msg('“{name}” is a {dim} style; paste it onto a {dim} layer', { name: styleClip.name, dim }), 'error');
      commit(core,
        ok.reduce((p, l) => applyPresetToProject(p, l.id, styleClip, { applyFont: false, keepLinks: true }), project),
        undefined,
        ok.length > 1 ? msg('Paste style “{name}” on {n} layers', { name: styleClip.name, n: ok.length }) : msg('Paste style “{name}”', { name: styleClip.name }),
      );
      const skipped = targets.length - ok.length;
      const pasted = msg('Pasted the style of “{name}” onto {what}', { name: styleClip.name, what: what(ok) });
      notify(skipped ? msg('{pasted} ({n} non-{dim} skipped)', { pasted, n: skipped, dim }) : pasted);
    },
    moveLayers(ids, to) {
      const { project, notify } = get();
      const L = project.layers;
      const roots = carryRoots(L, ids);
      if (!roots.length) return;
      const moving = new Set(withDescendants(L, roots));
      const rest = L.filter((l) => !moving.has(l.id));
      const destId = 'into' in to ? to.into : 'aboveId' in to ? to.aboveId : to.belowId;
      // Dropping next to a moved layer itself changes nothing; into or next to one inside a moved group would nest it in itself.
      if (destId !== null && moving.has(destId)) return !('into' in to) && roots.includes(destId) ? undefined : notify('A group can’t be moved into itself', 'error');
      const slot = slotOf(rest, to);
      if (!slot) return;
      const { parent, under } = slot;
      // Landing inside a clip group clips; a clipped layer keeps its clip only beside its own base (moved along, or dropped right on it).
      const inClip = gapInClip(rest, parent, under);
      const block = L.filter((l) => moving.has(l.id)).map((l) => {
        if (!roots.includes(l.id)) return l;
        const base = clipBaseOf(L, l.id);
        const clip = inClip || (!!base && (moving.has(base.id) || base === under));
        return withParent(clip === l.clip ? l : { ...l, clip }, parent ?? undefined);
      });
      const layers = normalizeTree(insertBlock(L, block, parent, under));
      if (layers.length === L.length && layers.every((l, i) => l === L[i])) return;
      const reparented = roots.some((id) => (L.find((l) => l.id === id)!.parentId ?? null) !== parent);
      const group = parent === null ? undefined : L.find((l) => l.id === parent);
      commit(core, { ...project, layers }, undefined, !reparented ? 'Reorder layers' : group ? msg('Move into “{name}”', { name: group.name }) : 'Move out of group');
    },
    arrangeLayers(ids, op) {
      const { project } = get();
      const layers = arrange(project.layers, new Set(ids), op);
      if (layers.every((l, i) => l === project.layers[i])) return;
      const label = { forward: 'Bring forward', backward: 'Send backward', front: 'Bring to front', back: 'Send to back' }[op];
      commit(core, { ...project, layers }, undefined, label);
    },
    groupLayers(ids) {
      const { project } = get();
      const L = project.layers;
      const roots = carryRoots(L, ids);
      if (!roots.length) return null;
      const picked = L.filter((l) => roots.includes(l.id));
      const top = picked.at(-1)!;
      const parent = top.parentId ?? null;
      const moving = new Set(withDescendants(L, roots));
      const rest = L.filter((l) => !moving.has(l.id));
      // The group takes the topmost picked layer's place in that layer's parent.
      const topAt = L.indexOf(top);
      const under = childrenOf(rest, parent).findLast((s) => L.indexOf(s) < topAt) ?? null;
      // Named in the UI language like PS (“Group 2” / “グループ 2”); from here on the name is data.
      const name = numberedName(tr('Group'), L.map((l) => l.name));
      const group = withParent({ ...createGroupLayer(name), clip: gapInClip(rest, parent, under) }, parent ?? undefined);
      const block = [...L.filter((l) => moving.has(l.id)).map((l) => (roots.includes(l.id) ? withParent(l, group.id) : l)), group];
      commit(core, { ...project, layers: insertBlock(L, block, parent, under) }, undefined, msg('Group {what}', { what: what(picked) }));
      core.anchor = group.id;
      set(selection(core, [], group.id, layerNode(group.id)));
      return group.id;
    },
    ungroupLayers(ids) {
      const { project, notify } = get();
      const L = project.layers;
      const byId = new Map(L.map((l) => [l.id, l]));
      const gone = new Set(
        ids.flatMap((id) => {
          const l = byId.get(id);
          return isGroup(l) ? [l.id] : l?.parentId !== undefined ? [l.parentId] : [];
        }),
      );
      if (!gone.size) return notify('Select a group (or a layer in one) to ungroup', 'error');
      /** The nearest parent that is not being dissolved. */
      const lift = (pid: string | undefined) => {
        while (pid !== undefined && gone.has(pid)) pid = byId.get(pid)?.parentId;
        return pid;
      };
      const groups = L.filter((l) => gone.has(l.id));
      const freed = L.filter((l) => !gone.has(l.id) && l.parentId !== undefined && gone.has(l.parentId));
      // Children stay where they are in the array: right where their group was, now in its parent.
      const layers = L.filter((l) => !gone.has(l.id)).map((l) => (l.parentId !== undefined && gone.has(l.parentId) ? withParent(l, lift(l.parentId)) : l));
      commit(core, { ...project, layers }, undefined, msg('Ungroup {what}', { what: what(groups) }));
      const primary = freed.at(-1)?.id ?? null;
      set(selection(core, freed.map((m) => m.id), primary, layerNode(primary)));
      const fx = groups.reduce((s, g) => s + g.effects.length, 0);
      if (fx) notify(msg(fx > 1 ? "Ungrouped: the group's {n} effects were removed (⌘Z brings them back)" : "Ungrouped: the group's effect was removed (⌘Z brings it back)", { n: fx }));
    },
    toggleClip(ids) {
      const { project, selectedLayerIds, notify } = get();
      const L = project.layers;
      const list = new Set(ids ?? selectedLayerIds);
      const picked = L.filter((l) => list.has(l.id));
      if (!picked.length) return;
      // All clipped: release them, and (PS) the clipped layers above each in its clip group.
      const release = picked.every((l) => l.clip);
      const flip = new Set(list);
      if (release)
        for (const l of picked) {
          const sibs = childrenOf(L, l.parentId ?? null);
          for (let j = sibs.indexOf(l) + 1; j < sibs.length && sibs[j].clip; j++) flip.add(sibs[j].id);
        }
      const layers = normalizeTree(L.map((l) => (flip.has(l.id) && l.clip === release ? { ...l, clip: !release } : l)));
      if (layers.every((l, i) => l.clip === L[i].clip)) return notify(msg('Nothing below “{name}” to clip to', { name: picked[0].name }), 'error');
      commit(core, { ...project, layers }, undefined, release ? 'Release clipping mask' : 'Create clipping mask');
    },
    addAdjustment(type, opts) {
      const layer = createAdjustmentLayer(type);
      // Named in the UI language like PS (“Levels 1” / “レベル補正 1”); from here on the name is data.
      layer.name = numberedName(tr(ADJUSTMENT_NAMES[type], undefined, { ctx: 'adjustment' }), get().project.layers.map((l) => l.name));
      insertNew(core, layer, msg('Add “{name}”', { name: layer.name }), undefined, !!opts?.clip);
      return layer.id;
    },
    addGenerator(type, presetId, on) {
      const layer = createGeneratorLayer(type, presetId);
      const def = getGenerator(type);
      if (!layer || !def) return null;
      const preset = def.presets.find((p) => p.id === presetId) ?? def.presets[0];
      const { project } = get();
      // Named in the UI language like an adjustment (“Gold dust 1” / “金粉 1”); from here on the name is data.
      layer.name = numberedName(tr(preset?.label ?? def.label), project.layers.map((l) => l.name));
      const target = on && def.follow ? project.layers.find((l) => l.id === on) : undefined;
      if (!target) {
        insertNew(core, layer, msg('Add “{name}”', { name: layer.name }));
        return layer.id;
      }
      // On a layer: a companion following it, in a group with it, above or below as its preset says.
      const companion = { ...layer, generator: { ...layer.generator, params: { ...layer.generator.params, follow: target.id } } };
      const layers = addCompanion(project.layers, target.id, companion, preset?.place ?? 'above');
      commit(core, { ...project, layers }, undefined, msg('Add “{name}” on “{layer}”', { name: layer.name, layer: target.name }));
      core.anchor = layer.id;
      core.set(selection(core, [], layer.id, layerNode(layer.id)));
      return layer.id;
    },
    applyGeneratorPreset(layerId, presetId) {
      const { project } = get();
      const l = project.layers.find((x) => x.id === layerId);
      const def = l?.kind === 'generator' ? getGenerator(l.generator.type) : undefined;
      const preset = def?.presets.find((p) => p.id === presetId);
      const next = def && preset ? generatorFromPreset(def.type, preset.id) : null;
      if (l?.kind !== 'generator' || !def || !preset || !next) return;
      // Picked source layers belong to this document, not to the look: they stay.
      for (const pd of def.params) if (pd.kind === 'layer' && l.generator.params[pd.key] !== undefined) next.params[pd.key] = l.generator.params[pd.key];
      const label = tr(preset.label);
      const autoNamed = def.presets.some((p) => isNumberedName(l.name, tr(p.label)));
      const others = project.layers.filter((x) => x.id !== layerId).map((x) => x.name);
      const name = autoNamed && !isNumberedName(l.name, label) ? numberedName(label, others) : l.name;
      // The previous preset's effects (glow, vignette…) give way to this one's, under the user's own.
      const effects = [...presetEffects(preset), ...l.effects.filter((fx) => !fx.fromPreset)];
      editLayer(core, layerId, (x) => ({ ...x, name, generator: next, blend: preset.blend ?? x.blend, effects }) as Layer, undefined, msg('Preset “{name}”', { name: msg(preset.label) }));
    },
    renameLayer(id, name) {
      const l = get().project.layers.find((x) => x.id === id);
      const next = name.trim();
      if (!l || !next || next === l.name) return;
      core.namePending.delete(id);
      editLayer(core, id, (x) => ({ ...x, name: next }), undefined, msg('Rename “{old}” to “{name}”', { old: l.name, name: next }));
    },
    patchLayer: (id, patch, coalesce, label) => editLayer(core, id, (l) => ({ ...l, ...patch }) as Layer, coalesce, label),
    replaceLayer: (id, layer, coalesce, label) => editLayer(core, id, () => ({ ...layer, id }) as Layer, coalesce, label),
  };
};

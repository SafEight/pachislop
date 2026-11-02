import { isTitleLayer, layerParts, type TitleLayer } from '../model/parts';
import type { PartKey, Project } from '../model/types';
import { orderIds } from './arrange';
import type { Core, Slice } from './core';
import { effectsOf } from './effects';
import type { EditorState, NodeRef } from './store';
import { ancestorsOf, hasPart } from './tree';

// Selection: selected layers, the focused Layers-panel node, picked characters, inline text editing.

export const layerNode = (id: string | null): NodeRef | null => (id ? { kind: 'layer', layerId: id } : null);

/** Whether `node`'s layer, part(s), effect or mask all still exist (a glint node: its layer is a 3D title). */
function nodeExists(project: Project, node: NodeRef): boolean {
  const l = project.layers.find((x) => x.id === node.layerId);
  if (!l) return false;
  if (node.kind === 'layer') return true;
  if (node.kind === 'mask') return l.masks.some((m) => m.id === node.maskId);
  if (node.kind === 'glint') return l.kind === 'title3d';
  if (node.kind === 'parts') return isTitleLayer(l) && node.parts.every((p) => hasPart(l, p));
  if (node.part !== null && !(isTitleLayer(l) && hasPart(l, node.part))) return false;
  return node.kind === 'part' || effectsOf(project, node).some((e) => e.id === node.effectId);
}

/** The parts of `node` (a 'part' or 'parts' node) on layer `layerId`; none for other nodes or layers. */
export const nodeParts = (node: NodeRef | null, layerId: string): PartKey[] =>
  node?.layerId !== layerId ? [] : node.kind === 'part' ? [node.part] : node.kind === 'parts' ? node.parts : [];

/** The node selecting `parts` of layer `layerId`: 2+ → 'parts', one → 'part', none → the layer. */
export const partsNode = (layerId: string, parts: readonly PartKey[]): NodeRef =>
  parts.length > 1 ? { kind: 'parts', layerId, parts: [...parts] } : parts.length === 1 ? { kind: 'part', layerId, part: parts[0] } : { kind: 'layer', layerId };

/** A title's parts front to back, as the Layers panel lists them (a hidden 2D face included). */
function listedParts(l: TitleLayer): PartKey[] {
  const parts = layerParts(l).reverse();
  if (l.kind === 'title2d' && l.style.hideFace) parts.unshift('face');
  return parts;
}

/** The node one level up: effect → its part or layer, part / mask / glint → its layer, layer → none. */
export const ownerNode = (node: NodeRef): NodeRef | null =>
  node.kind === 'effect' && node.part !== null ? { kind: 'part', layerId: node.layerId, part: node.part } : node.kind === 'layer' ? null : layerNode(node.layerId);

/**
 * What a fresh project shows selected: its top non-guide layer, or nothing (Blank: not the guide
 * backdrop). A companion group (a template's title wrapped with its generators) gives its title,
 * so the first click and Properties land on the title rather than the wrapper.
 */
export function initialSelection(p: Project): string | null {
  const top = p.layers.findLast((l) => !l.guide && !l.parentId);
  const main = top?.kind === 'group' && top.companionGroupOf !== undefined ? p.layers.find((l) => l.id === top.companionGroupOf) : undefined;
  return main?.id ?? top?.id ?? null;
}

/**
 * Selection patch: `ids` (+ the primary) in stack order, focusing `node` (default: the
 * primary's layer node when the primary changes, else the current node). Glyph picks and
 * inline text editing belong to the old primary, so they reset when it changes.
 */
export function selection(core: Core, ids: readonly string[], primary: string | null, node?: NodeRef | null): Partial<EditorState> {
  const s = core.get();
  const patch: Partial<EditorState> = { selectedLayerId: primary, selectedLayerIds: orderIds(s.project.layers, primary ? [...ids, primary] : []) };
  if (node !== undefined) patch.selectedNode = node;
  else if (primary !== s.selectedLayerId) patch.selectedNode = layerNode(primary);
  return primary === s.selectedLayerId ? patch : { ...patch, selectedChars: [], textEditLayerId: null };
}

/**
 * Keep selection pointers valid after the project changed under them (an empty selection
 * stays empty). A focused part / effect / mask that no longer exists falls back to its owner;
 * selected parts that are gone leave the parts selection; “View mask” of a layer left without
 * masks ends.
 */
export function fixSelection(core: Core): void {
  const { project, selectedLayerId, selectedLayerIds, textEditLayerId } = core.get();
  const ids = orderIds(project.layers, selectedLayerIds);
  const layer = project.layers.find((l) => l.id === selectedLayerId);
  if (selectedLayerId !== null && !layer) core.set(selection(core, ids, ids.at(-1) ?? project.layers.at(-1)?.id ?? null));
  else if (ids.length !== selectedLayerIds.length) core.set({ selectedLayerIds: ids });
  const s = core.get();
  let node = s.selectedNode;
  if (node?.kind === 'parts') {
    const { layerId, parts } = node;
    const l = project.layers.find((x) => x.id === layerId);
    const live = isTitleLayer(l) ? parts.filter((p) => hasPart(l, p)) : [];
    if (live.length !== parts.length) node = partsNode(layerId, live);
  }
  while (node && !nodeExists(project, node)) node = ownerNode(node);
  if (node?.layerId !== (s.selectedLayerId ?? undefined)) node = layerNode(s.selectedLayerId);
  if (node !== s.selectedNode) core.set({ selectedNode: node });
  if (textEditLayerId && !project.layers.some((l) => l.id === textEditLayerId)) core.set({ textEditLayerId: null });
  // “View mask” ends with the last mask of its layer (or the layer).
  const { view } = core.get();
  if (view.viewMask && !project.layers.find((l) => l.id === view.viewMask)?.masks.length) core.set({ view: { ...view, viewMask: null } });
}

export const selectionSlice: Slice<'selectLayer' | 'selectLayers' | 'toggleLayerSelection' | 'selectNode' | 'selectChars' | 'beginTextEdit' | 'endTextEdit'> = (core) => {
  const { get, set } = core;
  return {
    selectLayer(id) {
      core.anchor = id;
      set(selection(core, [], id, layerNode(id)));
    },
    selectLayers(ids, primary) {
      const { project, selectedLayerId } = get();
      const valid = orderIds(project.layers, ids);
      const p = primary && valid.includes(primary) ? primary : selectedLayerId && valid.includes(selectedLayerId) ? selectedLayerId : (ids.filter((id) => valid.includes(id)).at(-1) ?? null);
      set(selection(core, valid, p));
    },
    toggleLayerSelection(id) {
      const { selectedLayerIds, selectedLayerId, project } = get();
      if (!project.layers.some((l) => l.id === id)) return;
      core.anchor = id;
      if (!selectedLayerIds.includes(id)) return set(selection(core, [...selectedLayerIds, id], id));
      const rest = selectedLayerIds.filter((x) => x !== id);
      set(selection(core, rest, selectedLayerId === id ? (rest.at(-1) ?? null) : selectedLayerId));
    },
    selectNode(node, opts) {
      const { project, selectedLayerIds, selectedLayerId, view } = get();
      if (!node) {
        core.anchor = null;
        return set(selection(core, [], null, null));
      }
      if (!nodeExists(project, node)) return;
      const id = node.layerId;
      const keep = selectedLayerIds.includes(id) ? selectedLayerIds : [];
      if (node.kind === 'part') {
        const l = project.layers.find((x) => x.id === id) as TitleLayer;
        const current = nodeParts(get().selectedNode, id);
        const order = listedParts(l);
        const anchor = core.partAnchor?.layerId === id ? order.indexOf(core.partAnchor.part) : -1;
        if (opts?.range && anchor >= 0) {
          // ⇧-click: the listed parts between the last clicked one and this one.
          const at = order.indexOf(node.part);
          return set(selection(core, keep, id, partsNode(id, order.slice(Math.min(anchor, at), Math.max(anchor, at) + 1))));
        }
        core.partAnchor = { layerId: id, part: node.part };
        if (opts?.additive) {
          // ⌘-click: toggle this part in the layer's selected parts (listed order).
          const parts = current.includes(node.part) ? current.filter((p) => p !== node.part) : [...current, node.part];
          return set(selection(core, keep, id, partsNode(id, order.filter((p) => parts.includes(p)))));
        }
      }
      if (node.kind !== 'layer') return set(selection(core, keep, id, node));
      if (opts?.range) {
        const from = project.layers.findIndex((l) => l.id === (core.anchor ?? selectedLayerId));
        const to = project.layers.findIndex((l) => l.id === id);
        if (from >= 0) {
          // Rows the panel shows between the two (project.layers reversed = panel order); rows inside closed groups are skipped.
          const [a, b] = from < to ? [from, to] : [to, from];
          const shown = project.layers.slice(a, b + 1).filter((l) => ancestorsOf(project.layers, l.id).every((g) => view.expanded[g.id] ?? true));
          return set(selection(core, shown.map((l) => l.id), id, node));
        }
      }
      if (opts?.additive) return get().toggleLayerSelection(id);
      core.anchor = id;
      set(selection(core, [], id, node));
    },
    beginTextEdit(id) {
      const layer = get().project.layers.find((l) => l.id === id);
      if (!isTitleLayer(layer) || layer.source.kind !== 'text' || layer.locked) return;
      set({ ...selection(core, [], id, layerNode(id)), selectedChars: [], textEditLayerId: id });
    },
    endTextEdit: () => set({ textEditLayerId: null }),
    selectChars: (selectedChars) => set({ selectedChars }),
  };
};

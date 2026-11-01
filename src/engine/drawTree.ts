import type { AdjustmentLayer, GroupLayer, Layer, Project } from '../model/types';

/** A layer that draws pixels itself (everything but groups and adjustment layers). */
export type LeafLayer = Exclude<Layer, GroupLayer | AdjustmentLayer>;

/**
 * One compositing step (see `drawTree`). `clipped`: the nodes clipped to this one (its clip
 * group, bottom first), composited onto it masked by its content alpha before its own effects;
 * a clipped node's own `clipped` is always empty, and so is an adjustment's (never a base).
 * `children`: a group's drawn members, bottom first.
 */
export type DrawNode =
  | { kind: 'leaf'; layer: LeafLayer; clipped: DrawNode[] }
  | { kind: 'group'; layer: GroupLayer; children: DrawNode[]; clipped: DrawNode[] }
  | { kind: 'adjust'; layer: AdjustmentLayer; clipped: DrawNode[] };

/**
 * What the compositor draws, top level bottom first: the one visibility rule shared by preview
 * and export.
 * - A layer draws when it is visible, opacity > 0 and (`includeGuides` or not a guide); a group
 *   failing that hides its whole subtree, and a group with no drawn child is dropped.
 * - Clipping (LayerBase.clip): the base is the nearest sibling below with `clip` off. When that
 *   base is hidden (or an empty group) its clipped layers are hidden too, as in Photoshop. When
 *   there is no base, or the base would be an adjustment layer, `clip` is ignored and the layer
 *   draws as an ordinary sibling (never a base itself).
 * - Solo: with any solo node in the visible tree, a solo node draws with its whole subtree and
 *   clip group; its ancestors draw as context holding only their branches with a solo node (so
 *   their effects, blend and opacity still apply), and a clip base whose clip group holds a solo
 *   node draws whole, as the clip mask needs it. Everything else is dropped.
 */
export function drawTree(project: Project, includeGuides: boolean): DrawNode[] {
  const shown = (l: Layer) => l.visible && l.transform.opacity > 0 && (includeGuides || !l.guide);
  const groups = new Set<string>();
  for (const l of project.layers) if (l.kind === 'group') groups.add(l.id);
  // children per parent id ('' = top level), bottom first; stray parentIds count as top level
  const kids = new Map<string, Layer[]>();
  for (const l of project.layers) {
    const key = l.parentId !== undefined && groups.has(l.parentId) ? l.parentId : '';
    const list = kids.get(key);
    if (list) list.push(l);
    else kids.set(key, [l]);
  }

  const node = (l: Layer): DrawNode | null => {
    switch (l.kind) {
      case 'group': {
        const children = build(l.id);
        return children.length ? { kind: 'group', layer: l, children, clipped: [] } : null;
      }
      case 'adjustment':
        return { kind: 'adjust', layer: l, clipped: [] };
      case 'title2d':
      case 'title3d':
      case 'background':
      case 'generator':
        return { kind: 'leaf', layer: l, clipped: [] };
    }
  };
  const build = (parentId: string): DrawNode[] => {
    const out: DrawNode[] = [];
    // clip base for clip-on siblings above: its node, 'hidden' (they hide too) or null (clip ignored)
    let base: DrawNode | 'hidden' | null = null;
    for (const l of kids.get(parentId) ?? []) {
      if (l.clip && base !== null) {
        if (base !== 'hidden' && shown(l)) {
          const n = node(l);
          if (n) base.clipped.push(n);
        }
        continue;
      }
      const n = shown(l) ? node(l) : null;
      if (n) out.push(n);
      if (!l.clip) base = l.kind === 'adjustment' ? null : (n ?? 'hidden');
    }
    return out;
  };
  const top = build('');

  const hasSolo = (n: DrawNode): boolean => n.layer.solo || (n.kind === 'group' && n.children.some(hasSolo)) || n.clipped.some(hasSolo);
  if (!top.some(hasSolo)) return top;
  const keep = (nodes: DrawNode[], inSolo: boolean): DrawNode[] => {
    const out: DrawNode[] = [];
    for (const n of nodes) {
      const self = inSolo || n.layer.solo;
      if (!self && !hasSolo(n)) continue;
      const clipped = keep(n.clipped, self);
      if (n.kind !== 'group') {
        out.push({ ...n, clipped });
        continue;
      }
      const children = self || clipped.length ? n.children : keep(n.children, false);
      if (children.length) out.push({ ...n, children, clipped });
    }
    return out;
  };
  return keep(top, false);
}

/**
 * Every layer `nodes` draw (groups, leaves, adjustments) in `Project.layers` order: a group's
 * subtree, then the group, then the nodes clipped to it.
 */
export function drawnLayers(nodes: readonly DrawNode[]): Layer[] {
  const out: Layer[] = [];
  const walk = (list: readonly DrawNode[]) => {
    for (const n of list) {
      if (n.kind === 'group') walk(n.children);
      out.push(n.layer);
      walk(n.clipped);
    }
  };
  walk(nodes);
  return out;
}

export const isLeaf = (l: Layer): l is LeafLayer => l.kind !== 'group' && l.kind !== 'adjustment';

/** True when some leaf in `nodes` (subtrees and clip groups included) is a 3D title. */
export function holds3D(nodes: readonly DrawNode[]): boolean {
  for (const n of nodes) {
    if (n.kind === 'leaf' && n.layer.kind === 'title3d') return true;
    if (n.kind === 'group' && holds3D(n.children)) return true;
    if (holds3D(n.clipped)) return true;
  }
  return false;
}

/** The node of layer `id` anywhere in `nodes`, or null when it does not draw. */
export function findNode(nodes: readonly DrawNode[], id: string): DrawNode | null {
  for (const n of nodes) {
    if (n.layer.id === id) return n;
    const hit = (n.kind === 'group' ? findNode(n.children, id) : null) ?? findNode(n.clipped, id);
    if (hit) return hit;
  }
  return null;
}

/**
 * `project` as seen when inspecting layer `id` on its own: it and its ancestor groups shown
 * (visible, opacity > 0), no solo anywhere, supersample 1 (thumbnails and histograms are draft).
 */
export function inspectView(project: Project, id: string): Project {
  const byId = new Map(project.layers.map((l) => [l.id, l]));
  const lift = new Set<string>();
  for (let l = byId.get(id); l && !lift.has(l.id); l = l.parentId !== undefined ? byId.get(l.parentId) : undefined) lift.add(l.id);
  const layers = project.layers.map((l): Layer => {
    if (lift.has(l.id)) return { ...l, visible: true, solo: false, transform: l.transform.opacity > 0 ? l.transform : { ...l.transform, opacity: 1 } };
    return l.solo ? { ...l, solo: false } : l;
  });
  const comp = project.comp.supersample === 1 ? project.comp : { ...project.comp, supersample: 1 as const };
  return { ...project, comp, layers };
}

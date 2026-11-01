import type { Layer, Project } from '../model/types';
import type { Core, Slice } from './core';
import { describePath, diffLabel } from './labels';
import { syncLinks } from './links';
import { msg, type Text } from './msg';
import { absPath, getRef, refKey, refList, updateIn } from './paths';
import { fixSelection, initialSelection, layerNode, selection } from './selection';
import type { PropRef, Refs } from './store';
import { normalizeTree } from './tree';

// Undo history: every project change goes through commit; undo / redo / jumpTo walk the steps.

const HISTORY_LIMIT = 100;

/**
 * Every commit keeps linked materials equal (see syncLinks), re-establishes the tree invariants
 * (see normalizeTree), whatever the mutation did, and moves a focus whose part / effect / layer
 * is gone to its owner.
 */
export function commit(core: Core, next: Project, coalesce?: string, label?: Text): void {
  const s = core.get();
  if (next === s.project) return;
  const linked = syncLinks(s.project, next);
  const layers = normalizeTree(linked.layers);
  const p = layers === linked.layers ? linked : { ...linked, layers };
  const merge = !!coalesce && s.lastCoalesce === coalesce;
  core.set({
    project: p,
    past: merge ? s.past : [...s.past, { project: s.project, label: label ?? diffLabel(s.project, p) }].slice(-HISTORY_LIMIT),
    future: [],
    lastCoalesce: coalesce ?? null,
  });
  fixSelection(core);
}

/** Apply `fn` (its value and target index → the new value) at every target of `refs` in one commit; targets that no longer exist are skipped. */
export function editRefs(core: Core, refs: Refs, fn: (v: unknown, i: number) => unknown, coalesce?: string, label?: Text): void {
  const p = core.get().project;
  let next = p;
  refList(refs).forEach((r, i) => {
    const ap = absPath(p, r);
    if (ap) next = updateIn(next, ap, (v) => fn(v, i));
  });
  commit(core, next, coalesce, label);
}

/**
 * History label of an edit at `refs`: the path's description (“Rim width”), and for several
 * targets what they share, counted: “Rim width on 3 layers”, “Rim width of 2 parts”, “Fill
 * colour of 4 parts” (one layer, parts of different kinds).
 */
function refsLabel(p: Project, refs: readonly PropRef[]): Text {
  const layerOf = (r: PropRef) => (r.layerId === null ? null : (p.layers.find((l) => l.id === r.layerId) ?? null));
  const first = refs[0];
  if (!first) return 'Edit';
  if (refs.length === 1) return describePath(layerOf(first), first.path);
  // Paths that differ only in list indices (rim 1 and rim 3) read as the first one's; else the
  // common tail names what is edited, without the parts that differ.
  const sameKind = refs.every((r) => r.path.length === first.path.length && r.path.every((k, i) => k === first.path[i] || (typeof k === 'number' && typeof first.path[i] === 'number')));
  const tailAt = (r: PropRef, n: number) => r.path[r.path.length - 1 - n];
  let n = 0;
  while (n < first.path.length && refs.every((r) => n < r.path.length && tailAt(r, n) === tailAt(first, n))) n++;
  const d = sameKind ? describePath(layerOf(first), first.path) : n === 0 ? 'Edit' : describePath(layerOf(first), first.path.slice(first.path.length - n));
  const what = typeof d === 'string' ? msg(d) : d;
  const layers = new Set(refs.map((r) => r.layerId)).size;
  return layers > 1 ? msg('{what} on {n} layers', { what, n: layers }) : msg('{what} of {n} parts', { what, n: refs.length });
}

export const editLayer = (core: Core, id: string, fn: (l: Layer) => Layer, coalesce?: string, label?: Text) =>
  editRefs(core, { layerId: id, path: [] }, (l) => fn(l as Layer), coalesce, label);

/** Fresh selection + transient state for a replaced project; the rename offer starts over. */
function resetForProject(core: Core, p: Project): void {
  core.renameSettled = false;
  core.anchor = null;
  core.partAnchor = null;
  const top = initialSelection(p);
  core.set({ ...selection(core, [], top, layerNode(top)), selectedChars: [], textEditLayerId: null, previewOverride: null, renameOffer: null });
}

export const historySlice: Slice<'edit' | 'setAt' | 'setEachAt' | 'setProject' | 'replaceProject' | 'loadProject' | 'undo' | 'redo' | 'jumpTo'> = (core) => {
  const { get, set } = core;
  return {
    edit: (fn, coalesce, label) => commit(core, fn(get().project), coalesce, label),
    setAt: (ref, value, coalesce, label) => editRefs(core, ref, () => value, coalesce, label ?? refsLabel(get().project, refList(ref))),
    setEachAt(ref, fn, coalesce, label) {
      const targets = refKey(ref);
      const base = core.gestureBase;
      const values = coalesce && base?.key === coalesce && base.targets === targets ? base.values : refList(ref).map((r) => getRef(get().project, r));
      core.gestureBase = coalesce ? { key: coalesce, targets, values } : null;
      editRefs(core, ref, (_, i) => fn(values[i], i), coalesce, label ?? refsLabel(get().project, refList(ref)));
    },

    setProject(p, label = 'New project') {
      commit(core, p, undefined, label);
      resetForProject(core, get().project);
    },
    async replaceProject(p, label, what) {
      const { project, confirm } = get();
      const work = project.layers.some((l) => !l.guide && l.kind !== 'group');
      const message = msg('“{name}” will be replaced by {what}. Undo (⌘Z) brings it back.', { name: project.name, what: typeof what === 'string' ? msg(what) : what });
      if (work && !(await confirm({ title: 'Replace the current project?', message, ok: 'Replace' })))
        return false;
      get().setProject(p, label);
      return true;
    },
    loadProject(p) {
      const layers = normalizeTree(p.layers);
      set({ project: layers === p.layers ? p : { ...p, layers }, past: [], future: [], lastCoalesce: null });
      resetForProject(core, get().project);
    },

    undo() {
      const { past, project, future } = get();
      const step = past.at(-1);
      if (!step) return;
      set({ project: step.project, past: past.slice(0, -1), future: [{ project, label: step.label }, ...future], lastCoalesce: null });
      fixSelection(core);
    },
    redo() {
      const { past, project, future } = get();
      const step = future[0];
      if (!step) return;
      set({ project: step.project, future: future.slice(1), past: [...past, { project, label: step.label }], lastCoalesce: null });
      fixSelection(core);
    },
    jumpTo(applied) {
      const { past, future } = get();
      const n = Math.max(0, Math.min(past.length + future.length, applied));
      for (let k = past.length; k > n; k--) get().undo();
      for (let k = past.length; k < n; k++) get().redo();
    },
  };
};

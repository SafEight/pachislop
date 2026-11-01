import { describe, expect, it } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { createProject, createTitle2DLayer } from '../../src/model/defaults';
import { rimKey } from '../../src/model/parts';
import type { PartKey, Project, Title2DLayer } from '../../src/model/types';
import type { Core } from '../../src/store/core';
import { effectsSlice } from '../../src/store/effectsOps';
import { historySlice } from '../../src/store/history';
import { formatMsg, english } from '../../src/store/msg';
import { getRef, MIXED, type Path } from '../../src/store/paths';
import { selectionSlice } from '../../src/store/selection';
import type { EditorState, PropRef } from '../../src/store/store';
import { DEFAULT_VIEW } from '../../src/store/view';

/** A project with two 2D titles of two rims each (rim widths 2 / 4 and 3 / 4). */
function twoTitles(): Project {
  const p = createProject();
  const a = createTitle2DLayer('A');
  const b = createTitle2DLayer('B');
  for (const [l, w] of [
    [a, 2],
    [b, 3],
  ] as const) {
    l.style.rims = [
      { ...l.style.rims[0], id: `${l.id}-r1`, width: w },
      { ...l.style.rims[0], id: `${l.id}-r2`, width: 4 },
    ];
  }
  return { ...p, layers: [...p.layers, a, b] };
}

/** The history and selection slices on a bare store, as createEditorStore wires them. */
function editor(project: Project) {
  return createStore<EditorState>()((set, get) => {
    const core: Core = { set, get, anchor: null, partAnchor: null, renameSettled: false, namePending: new Set(), gestureBase: null };
    return {
      project,
      selectedLayerId: null,
      selectedLayerIds: [],
      selectedNode: null,
      selectedChars: [],
      textEditLayerId: null,
      view: DEFAULT_VIEW,
      past: [],
      future: [],
      lastCoalesce: null,
      ...historySlice(core),
      ...selectionSlice(core),
      ...effectsSlice(core),
    } as unknown as EditorState;
  });
}

const rimWidth = (layerId: string, i: number): PropRef => ({ layerId, path: ['style', 'rims', i, 'width'] as Path });

describe('multi-target refs', () => {
  it('reads the shared value, or MIXED', () => {
    const p = twoTitles();
    const [a, b] = p.layers.slice(-2);
    expect(getRef(p, [rimWidth(a.id, 1), rimWidth(b.id, 1)])).toBe(4);
    expect(getRef(p, [rimWidth(a.id, 0), rimWidth(b.id, 0)])).toBe(MIXED);
    expect(getRef(p, [rimWidth(a.id, 0)])).toBe(2);
    // Structurally equal objects are one value.
    expect(getRef(p, [{ layerId: a.id, path: ['style', 'face', 'fill'] }, { layerId: b.id, path: ['style', 'face', 'fill'] }])).toEqual((a as Title2DLayer).style.face.fill);
  });

  it('sets every target in one labelled undo step', () => {
    const store = editor(twoTitles());
    const [a, b] = store.getState().project.layers.slice(-2);
    store.getState().setAt([rimWidth(a.id, 0), rimWidth(b.id, 0)], 5, 'k');
    store.getState().setAt([rimWidth(a.id, 0), rimWidth(b.id, 0)], 6, 'k');
    const s = store.getState();
    expect(getRef(s.project, [rimWidth(a.id, 0), rimWidth(b.id, 0)])).toBe(6);
    expect(s.past).toHaveLength(1);
    expect(formatMsg(s.past[0].label, english)).toBe('Rim width on 2 layers');
    s.undo();
    expect(getRef(store.getState().project, rimWidth(a.id, 0))).toBe(2);
    expect(getRef(store.getState().project, rimWidth(b.id, 0))).toBe(3);
  });

  it('labels parts of one layer by what they share', () => {
    const store = editor(twoTitles());
    const a = store.getState().project.layers.at(-2)!;
    store.getState().setAt([rimWidth(a.id, 0), rimWidth(a.id, 1)], 7);
    expect(formatMsg(store.getState().past[0].label, english)).toBe('Rim width of 2 parts');
    const colour = (path: Path): PropRef => ({ layerId: a.id, path: [...path, 'fill', 'color'] });
    store.getState().setAt([colour(['style', 'face']), colour(['style', 'rims', 1, 'material'])], '#ff0000');
    expect(formatMsg(store.getState().past[1].label, english)).toBe('Fill colour of 2 parts');
  });

  it('shifts every target from its own start through one gesture', () => {
    const store = editor(twoTitles());
    const [a, b] = store.getState().project.layers.slice(-2);
    const refs = [rimWidth(a.id, 0), rimWidth(b.id, 0)];
    const shift = (d: number) => store.getState().setEachAt(refs, (v) => (v as number) + d, 'scrub');
    shift(1);
    shift(2);
    expect(getRef(store.getState().project, refs[0])).toBe(4);
    expect(getRef(store.getState().project, refs[1])).toBe(5);
    expect(store.getState().past).toHaveLength(1);
  });

  it('selects several parts of one layer with ⌘ and ⇧', () => {
    const store = editor(twoTitles());
    const l = store.getState().project.layers.at(-1) as Title2DLayer;
    const [r1, r2] = l.style.rims.map((r) => rimKey(r.id));
    const { selectNode } = store.getState();
    selectNode({ kind: 'part', layerId: l.id, part: 'face' });
    selectNode({ kind: 'part', layerId: l.id, part: r2 }, { range: true });
    expect(store.getState().selectedNode).toEqual({ kind: 'parts', layerId: l.id, parts: ['face', r1, r2] });
    selectNode({ kind: 'part', layerId: l.id, part: r1 }, { additive: true });
    expect(store.getState().selectedNode).toEqual({ kind: 'parts', layerId: l.id, parts: ['face', r2] });
    selectNode({ kind: 'part', layerId: l.id, part: 'face' }, { additive: true });
    expect(store.getState().selectedNode).toEqual({ kind: 'part', layerId: l.id, part: r2 });
    // A removed part leaves the selection.
    selectNode({ kind: 'part', layerId: l.id, part: r1 }, { additive: true });
    const i = store.getState().project.layers.findIndex((x) => x.id === l.id);
    store.getState().edit((p) => ({ ...p, layers: p.layers.map((x, j) => (j === i ? { ...l, style: { ...l.style, rims: [l.style.rims[1]] } } : x)) }));
    expect(store.getState().selectedNode).toEqual({ kind: 'part', layerId: l.id, part: r2 });
  });

  it('adds one effect to each of several parts in one undo step, keeping the selection', () => {
    const store = editor(twoTitles());
    const l = store.getState().project.layers.at(-1) as Title2DLayer;
    const parts: PartKey[] = ['face', ...l.style.rims.map((r) => rimKey(r.id))];
    store.getState().selectNode({ kind: 'parts', layerId: l.id, parts });
    const id = store.getState().addEffect(parts.map((part) => ({ layerId: l.id, part })), 'adjust');
    const s = store.getState();
    const added = parts.map((p) => (s.project.layers.at(-1) as Title2DLayer).partEffects[p] ?? []);
    expect(added.map((fx) => fx.length)).toEqual([1, 1, 1]);
    expect(added[0][0].id).toBe(id);
    expect(new Set(added.map((fx) => fx[0].id)).size).toBe(3);
    expect(s.past).toHaveLength(1);
    expect(formatMsg(s.past[0].label, english)).toBe('Add Hue/Saturation to 3 parts');
    expect(s.selectedNode).toEqual({ kind: 'parts', layerId: l.id, parts });
    s.undo();
    expect((store.getState().project.layers.at(-1) as Title2DLayer).partEffects).toEqual({});
  });
});

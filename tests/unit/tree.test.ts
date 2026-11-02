import { describe, expect, it } from 'vitest';
import { classicTitleStyle2D, createAdjustmentLayer, createGroupLayer, createTitle2DLayer } from '../../src/model/defaults';
import type { EffectInstance, Layer } from '../../src/model/types';
import {
  ancestorsOf,
  clipBaseOf,
  clippedTo,
  depthOf,
  isGroup,
  normalizeTree,
  rootIds,
  subtreeIds,
  withDescendants,
} from '../../src/store/tree';

type Opts = { parent?: string; clip?: boolean };
const place = <L extends Layer>(l: L, id: string, o: Opts): L => ({ ...l, id, name: id, clip: o.clip ?? false, ...(o.parent ? { parentId: o.parent } : {}) });
const T = (id: string, o: Opts = {}) => place(createTitle2DLayer(id), id, o);
const G = (id: string, o: Opts = {}) => place(createGroupLayer(id), id, o);
const A = (id: string, o: Opts = {}) => place(createAdjustmentLayer('invert'), id, o);

const ids = (ls: readonly Layer[]) => ls.map((l) => l.id);
const byId = (ls: readonly Layer[], id: string) => ls.find((l) => l.id === id)!;
const fx = (): EffectInstance => ({ id: 'e', type: 'outerGlow', enabled: true, params: {} }) as EffectInstance;

/** Every invariant normalizeTree promises (see the header of store/tree.ts). */
function expectInvariants(out: readonly Layer[]) {
  const map = new Map(out.map((l) => [l.id, l]));
  for (const l of out) {
    if (l.parentId !== undefined) expect(isGroup(map.get(l.parentId)), `${l.id} → ${l.parentId}`).toBe(true);
    expect(ancestorsOf(out, l.id).some((g) => g.id === l.id), `cycle at ${l.id}`).toBe(false);
    if (l.clip) expect(clipBaseOf(out, l.id), `clip without base: ${l.id}`).not.toBeNull();
  }
  out.forEach((g, gi) => {
    if (!isGroup(g)) return;
    const sub = subtreeIds(out, g.id);
    expect(ids(out.slice(gi - sub.length, gi)), `subtree of ${g.id} directly below it`).toEqual(sub);
  });
}

describe('normalizeTree', () => {
  it('returns the input array itself when nothing changes', () => {
    const layers = [T('a', { parent: 'g' }), T('b', { parent: 'g', clip: true }), G('g'), T('c')];
    expect(normalizeTree(layers)).toBe(layers);
  });

  it('gathers a group subtree directly below the group, siblings keeping their input order', () => {
    // c (in g) sits above g: it is moved down into g's block, after a.
    const out = normalizeTree([T('a', { parent: 'g' }), G('g'), T('b'), T('c', { parent: 'g' })]);
    expect(ids(out)).toEqual(['a', 'c', 'g', 'b']);
    expectInvariants(out);
  });

  it('nests groups recursively and keeps the input order at every level', () => {
    const input = [G('g1'), T('y', { parent: 'g1' }), T('z'), T('x', { parent: 'g2' }), G('g2', { parent: 'g1' })];
    const out = normalizeTree(input);
    expect(ids(out)).toEqual(['y', 'x', 'g2', 'g1', 'z']);
    expect(ancestorsOf(out, 'x').map((g) => g.id)).toEqual(['g2', 'g1']);
    expect(depthOf(out, 'x')).toBe(2);
    expect(depthOf(out, 'z')).toBe(0);
    expectInvariants(out);
    // Layers whose parent didn't change keep their identity.
    expect(byId(out, 'z')).toBe(input[2]);
  });

  it('drops parentIds naming a missing layer or a non-group', () => {
    const out = normalizeTree([T('a', { parent: 'nope' }), T('host'), T('b', { parent: 'host' })]);
    expect(out.map((l) => l.parentId)).toEqual([undefined, undefined, undefined]);
    expect(out.every((l) => !('parentId' in l))).toBe(true);
    expect(ids(out)).toEqual(['a', 'host', 'b']);
  });

  it('breaks parent cycles without losing layers', () => {
    const out = normalizeTree([T('x', { parent: 'g1' }), G('g1', { parent: 'g2' }), G('g2', { parent: 'g1' }), G('self', { parent: 'self' })]);
    expect(ids(out).sort()).toEqual(['g1', 'g2', 'self', 'x']);
    expect(byId(out, 'g1').parentId).toBeUndefined();
    expect(byId(out, 'g2').parentId).toBeUndefined();
    expect(byId(out, 'self').parentId).toBeUndefined();
    expectInvariants(out);
    expect(normalizeTree(out)).toBe(out);
  });

  it('keeps a clip chain on its base', () => {
    const out = normalizeTree([T('a'), T('b', { clip: true }), T('c', { clip: true }), T('d')]);
    expect(out.map((l) => l.clip)).toEqual([false, true, true, false]);
    expect(clipBaseOf(out, 'c')?.id).toBe('a');
    expect(ids(clippedTo(out, 'a'))).toEqual(['b', 'c']);
    expect(clippedTo(out, 'b')).toEqual([]);
    expect(clipBaseOf(out, 'd')).toBeNull();
  });

  it('unclips a layer whose base was removed or moved above it', () => {
    const removed = normalizeTree([T('b', { clip: true }), T('c', { clip: true })]);
    expect(removed.map((l) => l.clip)).toEqual([false, true]);
    expect(clipBaseOf(removed, 'c')?.id).toBe('b');
    const movedAbove = normalizeTree([T('b', { clip: true }), T('a')]);
    expect(byId(movedAbove, 'b').clip).toBe(false);
  });

  it('never clips across a group boundary; the group itself is a valid base', () => {
    // k is the bottom child of g: no base inside g even though a lies below g.
    const out = normalizeTree([T('a'), T('k', { parent: 'g', clip: true }), G('g'), T('c', { clip: true })]);
    expect(byId(out, 'k').clip).toBe(false);
    expect(byId(out, 'c').clip).toBe(true);
    expect(clipBaseOf(out, 'c')?.id).toBe('g');
  });

  it('a base moved into a group leaves its clipped layer to clip to the next sibling below', () => {
    const before = normalizeTree([G('g'), T('a'), T('b', { clip: true })]);
    expect(clipBaseOf(before, 'b')?.id).toBe('a');
    const moved = before.map((l) => (l.id === 'a' ? { ...l, parentId: 'g' } : l));
    const out = normalizeTree(moved);
    expect(ids(out)).toEqual(['a', 'g', 'b']);
    expect(clipBaseOf(out, 'b')?.id).toBe('g');
  });

  it('adjustments are never bases: the clip is cleared and the next layer clips to the unclipped one', () => {
    const out = normalizeTree([A('adj'), T('b', { clip: true }), T('c', { clip: true })]);
    expect(out.map((l) => l.clip)).toEqual([false, false, true]);
    expect(clipBaseOf(out, 'c')?.id).toBe('b');
    expectInvariants(out);
  });

  it('prunes part effects of parts the style no longer has, but keeps a hidden face’s', () => {
    const t = { ...T('t'), style: classicTitleStyle2D() };
    const rimId = t.style.rims[0].id;
    const live = { ...t, partEffects: { [`rim:${rimId}`]: [fx()], 'rim:deleted': [fx()], face: [fx()] } };
    const hidden = { ...live, id: 'h', style: { ...live.style, hideFace: true } };
    const out = normalizeTree([live, hidden]);
    for (const l of out) {
      if (l.kind !== 'title2d') throw new Error('expected titles');
      expect(Object.keys(l.partEffects).sort()).toEqual(['face', `rim:${rimId}`]);
    }
  });

  it('fuzz: any parent / clip / order mess comes out valid, complete, order-preserving and idempotent', () => {
    let s = 12345;
    const rnd = (n: number) => {
      s = (Math.imul(s, 1103515245) + 12345) >>> 0;
      return (s >>> 8) % n;
    };
    for (let round = 0; round < 400; round++) {
      const n = 2 + rnd(12);
      const names = Array.from({ length: n }, (_, i) => `L${i}`);
      const input: Layer[] = names.map((id) => {
        const r = rnd(10);
        const parent = rnd(3) === 0 ? undefined : rnd(8) === 0 ? 'missing' : names[rnd(n)];
        const o = { parent, clip: rnd(2) === 0 };
        return r < 3 ? G(id, o) : r < 4 ? A(id, o) : T(id, o);
      });
      const out = normalizeTree(input);
      expect(ids(out).sort(), `round ${round}`).toEqual([...names].sort());
      expectInvariants(out);
      expect(normalizeTree(out), `idempotent, round ${round}`).toBe(out);
      // Siblings in the output keep their relative input order.
      const pos = new Map(input.map((l, i) => [l.id, i]));
      const parents = new Set(out.map((l) => l.parentId ?? null));
      for (const p of parents) {
        const sibs = out.filter((l) => (l.parentId ?? null) === p).map((l) => pos.get(l.id)!);
        expect(sibs, `round ${round}, parent ${p}`).toEqual([...sibs].sort((a, b) => a - b));
      }
      // A parent is only ever dropped, never invented or changed.
      for (const l of out) if (l.parentId !== undefined) expect(l.parentId).toBe(byId(input, l.id).parentId);
    }
  });
});

describe('selection helpers', () => {
  const layers = normalizeTree([T('a', { parent: 'g2' }), G('g2', { parent: 'g1' }), T('b', { parent: 'g1' }), G('g1'), T('c')]);

  it('subtreeIds lists every descendant bottom first (also on unnormalised input)', () => {
    expect(subtreeIds(layers, 'g1')).toEqual(['a', 'g2', 'b']);
    expect(subtreeIds(layers, 'c')).toEqual([]);
    expect(subtreeIds([G('g1'), T('x', { parent: 'g2' }), G('g2', { parent: 'g1' })], 'g1')).toEqual(['x', 'g2']);
  });

  it('withDescendants and rootIds', () => {
    expect(withDescendants(layers, ['c', 'g2'])).toEqual(['a', 'g2', 'c']);
    expect(rootIds(layers, ['a', 'g1', 'c'])).toEqual(['g1', 'c']);
    expect(rootIds(layers, ['a', 'b'])).toEqual(['a', 'b']);
  });
});

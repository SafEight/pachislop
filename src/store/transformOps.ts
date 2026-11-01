import { isTitleLayer } from '../model/parts';
import type { Layer, ShapeSource, Transform } from '../model/types';
import { align, distribute, fitShapeTo, isMovable, nudge, ridesAlong } from './arrange';
import type { Slice } from './core';
import { commit } from './history';
import { what } from './layerOps';
import { msg } from './msg';
import { isGroup, unionCompBounds, withDescendants, xformTransform } from './tree';

// Placement actions: nudge, free transform, flip, align / distribute, backing shapes fitted to a title.

/** The layers a flip of `ids` mirrors: the movable ones among them and their descendants (a group's own transform is never touched). */
export function flipTargets(layers: readonly Layer[], ids: readonly string[]): Layer[] {
  const set = new Set(withDescendants(layers, ids));
  return layers.filter((l) => set.has(l.id) && isMovable(layers, l));
}

const neg = (v: number) => (v ? -v : 0);

/**
 * `t` mirrored on screen across the vertical ('x') / horizontal ('y') line through `about` (comp
 * px): the position mirrors, flipX / flipY toggles, and the rotations conjugate by the mirror
 * (horizontal: rotY and rotZ change sign; vertical: rotX and rotZ), since the flip applies
 * before them.
 */
function flipTransform(t: Transform, axis: 'x' | 'y', about: number): Transform {
  const rotZ = neg(t.rotZ);
  return axis === 'x'
    ? { ...t, x: Math.round((2 * about - t.x) * 100) / 100, rotY: neg(t.rotY), rotZ, flipX: !t.flipX }
    : { ...t, y: Math.round((2 * about - t.y) * 100) / 100, rotX: neg(t.rotX), rotZ, flipY: !t.flipY };
}

export const transformSlice: Slice<'addBackingShape' | 'fitShapeLayer' | 'nudgeLayers' | 'transformLayers' | 'flipLayers' | 'alignLayers' | 'distributeLayers'> = (core) => {
  const { get } = core;
  return {
    addBackingShape(shape, targetId) {
      const target = get().project.layers.find((l) => l.id === targetId);
      const { width, height } = get().project.comp;
      const turned = isTitleLayer(target) ? ({ ...shape, transform: { ...shape.transform, rotZ: target.transform.rotZ } } as typeof shape) : shape;
      const fitted = isTitleLayer(target) && turned.source.kind === 'shape' ? fitShapeTo(turned as typeof shape & { source: ShapeSource }, target, width, height) : null;
      get().addLayer(fitted ?? shape, fitted ? { belowId: targetId } : undefined);
    },
    fitShapeLayer(id, to) {
      const { project, notify } = get();
      const i = project.layers.findIndex((l) => l.id === id);
      const shape = project.layers[i];
      if (!isTitleLayer(shape) || shape.source.kind !== 'shape') return;
      const order = to === 'above' ? project.layers.slice(i + 1) : project.layers.slice(0, i).reverse();
      for (const target of order) {
        if (!isTitleLayer(target) || !target.visible) continue;
        const fitted = fitShapeTo(shape as typeof shape & { source: ShapeSource }, target, project.comp.width, project.comp.height);
        if (!fitted) continue;
        get().replaceLayer(id, fitted, undefined, msg('Fit “{shape}” to “{target}”', { shape: shape.name, target: target.name }));
        return;
      }
      notify(msg(to === 'above' ? 'No visible text or shape layer above “{name}” to fit to' : 'No visible text or shape layer below “{name}” to fit to', { name: shape.name }), 'error');
    },
    nudgeLayers(ids, dx, dy, coalesce) {
      const { project } = get();
      const picked = new Set(ids);
      const moved = project.layers.filter((l) => picked.has(l.id) && (isGroup(l) || isMovable(project.layers, l)));
      if (!moved.length || (dx === 0 && dy === 0)) return;
      commit(core, { ...project, layers: nudge(project.layers, picked, dx, dy) }, coalesce, msg('Move {what}', { what: what(moved) }));
    },
    transformLayers(ids, xf, coalesce, label, base) {
      const { project } = get();
      const from = base ?? project.layers;
      const targets = new Set(withDescendants(project.layers, ids));
      const box = xf.about ? null : unionCompBounds(from, [...targets]);
      const about = xf.about ?? (box ? { x: (box.x0 + box.x1) / 2, y: (box.y0 + box.y1) / 2 } : { x: 0, y: 0 });
      const start = new Map(from.map((l) => [l.id, l]));
      let changed = false;
      const layers = project.layers.map((l) => {
        if (!targets.has(l.id) || !isMovable(project.layers, l) || ridesAlong(l, targets)) return l;
        const transform = xformTransform((start.get(l.id) ?? l).transform, xf, about);
        const t = l.transform;
        if (transform.x === t.x && transform.y === t.y && transform.rotZ === t.rotZ && transform.scale === t.scale) return l;
        changed = true;
        return { ...l, transform } as Layer;
      });
      if (!changed) return;
      const named = project.layers.filter((l) => ids.includes(l.id));
      commit(core, { ...project, layers }, coalesce, label ?? msg('Transform {what}', { what: what(named) }));
    },
    flipLayers(ids, axis) {
      const { project } = get();
      const targets = flipTargets(project.layers, ids);
      if (!targets.length) return;
      // Photoshop: the common box stays put (one layer included); layers without a box of their
      // own (full-frame generators) alone mirror about their positions' mean.
      const box = unionCompBounds(project.layers, targets.map((l) => l.id));
      const about = box ? (axis === 'x' ? (box.x0 + box.x1) / 2 : (box.y0 + box.y1) / 2) : targets.reduce((s, l) => s + (axis === 'x' ? l.transform.x : l.transform.y), 0) / targets.length;
      const picked = new Set(targets.map((l) => l.id));
      const layers = project.layers.map((l) => (picked.has(l.id) ? ({ ...l, transform: flipTransform(l.transform, axis, about) } as Layer) : l));
      const named = project.layers.filter((l) => ids.includes(l.id));
      commit(core, { ...project, layers }, undefined, msg(axis === 'x' ? 'Flip {what} horizontally' : 'Flip {what} vertically', { what: what(named) }));
    },
    alignLayers(ids, mode) {
      const { project } = get();
      const layers = align(project.layers, new Set(ids), mode, project.comp.width, project.comp.height);
      if (layers.every((l, i) => l === project.layers[i])) return;
      const label = { left: 'Align left', hcenter: 'Align centre', right: 'Align right', top: 'Align top', vmiddle: 'Align middle', bottom: 'Align bottom' }[mode];
      commit(core, { ...project, layers }, undefined, label);
    },
    distributeLayers(ids, axis) {
      const { project, notify } = get();
      const layers = distribute(project.layers, new Set(ids), axis, project.comp.width, project.comp.height);
      if (!layers) return notify('Distribute needs 3 or more unlocked layers selected (⇧ / ⌘-click in Layers)', 'error');
      if (layers.every((l, i) => l === project.layers[i])) return;
      commit(core, { ...project, layers }, undefined, axis === 'x' ? 'Distribute horizontally' : 'Distribute vertically');
    },
  };
};

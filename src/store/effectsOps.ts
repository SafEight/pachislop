import { uid } from '../model/defaults';
import { isTitleLayer, parsePartKey } from '../model/parts';
import type { Layer } from '../model/types';
import type { Core, Slice } from './core';
import { effectName, effectsOf, makeEffect, setEffects, takesEffects } from './effects';
import { commit } from './history';
import { partLabel } from './labels';
import { msg, type Text } from './msg';
import type { EffectOwner } from './store';

// Effect stack actions (add / remove / show / move) and part show / hide.

/** Name of an effect owner for History labels: “BIG BONUS” or Rim 2 of “BIG BONUS”. */
function ownerName(core: Core, owner: EffectOwner): Text {
  const l = core.get().project.layers.find((x) => x.id === owner.layerId);
  const name = l?.name ?? '';
  return owner.part !== null && isTitleLayer(l) ? msg('{part} of “{name}”', { part: partLabel(l, owner.part), name }) : msg('“{name}”', { name });
}

export const effectsSlice: Slice<'addEffect' | 'removeEffect' | 'setEffectEnabled' | 'moveEffect' | 'setPartEnabled'> = (core) => {
  const { get } = core;
  return {
    addEffect(owner, type, params) {
      const { project } = get();
      const owners = ('layerId' in owner ? [owner] : owner).filter((o) => takesEffects(project.layers.find((x) => x.id === o.layerId), o.part));
      // makeEffect is null for every owner alike (an unknown type).
      const added = owners.map(() => makeEffect(type, params)).filter((fx) => fx !== null);
      const first = added[0];
      if (!first) return null;
      const next = owners.reduce((p, o, i) => setEffects(p, o, [...effectsOf(p, o), added[i]]), project);
      const effect = effectName(first);
      const parts = owners.length > 1 && owners.every((o) => o.part !== null);
      commit(core, next, undefined, parts ? msg('Add {effect} to {n} parts', { effect, n: owners.length }) : msg('Add {effect}', { effect }));
      if (owners.length === 1) get().selectNode({ kind: 'effect', layerId: owners[0].layerId, part: owners[0].part, effectId: first.id });
      return first.id;
    },
    removeEffect(owner, effectId) {
      const { project } = get();
      const list = effectsOf(project, owner);
      const fx = list.find((e) => e.id === effectId);
      // The focus, if on this effect, falls back to its owner (commit → fixSelection).
      if (fx) commit(core, setEffects(project, owner, list.filter((e) => e !== fx)), undefined, msg('Delete {effect}', { effect: effectName(fx) }));
    },
    setEffectEnabled(owner, effectId, enabled) {
      const { project } = get();
      const list = effectsOf(project, owner);
      const fx = list.find((e) => e.id === effectId);
      if (!fx || fx.enabled === enabled) return;
      commit(core, 
        setEffects(project, owner, list.map((e) => (e === fx ? { ...e, enabled } : e))),
        undefined,
        msg(enabled ? 'Show {effect}' : 'Hide {effect}', { effect: effectName(fx) }),
      );
    },
    moveEffect(from, effectId, to, index, copy) {
      const { project, notify } = get();
      const ids = typeof effectId === 'string' ? [effectId] : effectId;
      const src = effectsOf(project, from);
      const moving = ids.flatMap((id) => src.filter((e) => e.id === id));
      if (!moving.length) return;
      const target = project.layers.find((l) => l.id === to.layerId);
      if (!takesEffects(target, to.part)) {
        if (target) notify(msg('{target} can’t take effects', { target: ownerName(core, to) }), 'error');
        return;
      }
      const same = from.layerId === to.layerId && from.part === to.part;
      const block = copy ? moving.map((e) => ({ ...structuredClone(e), id: uid() })) : moving;
      const left = copy ? src : src.filter((e) => !moving.includes(e));
      const dest = same ? left : effectsOf(project, to);
      const at = Math.max(0, Math.min(dest.length, index));
      const placed = [...dest.slice(0, at), ...block, ...dest.slice(at)];
      if (same && !copy && placed.every((e, i) => e === src[i])) return;
      const p = same || copy ? project : setEffects(project, from, left);
      const effect = block.length === 1 ? effectName(block[0]) : msg('{n} effects', { n: block.length });
      const label = same
        ? msg(copy ? 'Duplicate {effect}' : 'Reorder {effect}', { effect })
        : msg(copy ? 'Copy {effect} to {target}' : 'Move {effect} to {target}', { effect, target: ownerName(core, to) });
      commit(core, setEffects(p, to, placed), undefined, label);
      get().selectNode({ kind: 'effect', layerId: to.layerId, part: to.part, effectId: block[0].id });
    },
    setPartEnabled(layerId, part, enabled) {
      const { project } = get();
      const l = project.layers.find((x) => x.id === layerId);
      if (!isTitleLayer(l)) return;
      const { kind, id } = parsePartKey(part);
      const flip = <T extends { id: string; enabled: boolean }>(list: T[]) => list.map((x) => (x.id === id ? { ...x, enabled } : x));
      let next: Layer | null = null;
      if (l.kind === 'title2d') {
        if (kind === 'face' && !l.style.hideFace !== enabled) next = { ...l, style: { ...l.style, hideFace: !enabled } };
        if (kind === 'rim' && l.style.rims.some((r) => r.id === id && r.enabled !== enabled)) next = { ...l, style: { ...l.style, rims: flip(l.style.rims) } };
      } else if (kind === 'band' && l.style3d.bands.some((b) => b.id === id && b.enabled !== enabled)) {
        next = { ...l, style3d: { ...l.style3d, bands: flip(l.style3d.bands) } };
      }
      if (!next) return;
      const layer = next;
      commit(core, { ...project, layers: project.layers.map((x) => (x.id === layerId ? layer : x)) }, undefined, msg(enabled ? 'Show {part}' : 'Hide {part}', { part: partLabel(l, part) }));
    },
  };
};

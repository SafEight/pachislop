import { isTitleLayer } from '../model/parts';
import type { CharAdjust, Layer } from '../model/types';
import { isNumberedName, textName, titleForm, uniqueName } from './arrange';
import type { Slice } from './core';
import { commit } from './history';
import { msg } from './msg';

// Text edits: setText (per-character adjustments and auto-names follow the text) and the project rename offer.

/**
 * Re-key per-character adjustments (indices into Array.from(text)) after a text edit, using
 * the common prefix/suffix of the old and new code points: keys in the prefix stay, keys in
 * the suffix shift by the length change, keys inside the replaced middle are dropped.
 */
function remapChars(chars: Record<number, CharAdjust>, oldText: string, newText: string): Record<number, CharAdjust> {
  const a = Array.from(oldText);
  const b = Array.from(newText);
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const shift = b.length - a.length;
  const out: Record<number, CharAdjust> = {};
  for (const [k, v] of Object.entries(chars)) {
    const i = Number(k);
    if (i < pre) out[i] = v;
    else if (i >= a.length - suf && i < a.length) out[i + shift] = v;
  }
  return out;
}

export const textSlice: Slice<'setText' | 'settleRenameOffer'> = (core) => {
  const { get, set } = core;
  return {
    setText(layerId, text, coalesce) {
      const { project } = get();
      const layer = project.layers.find((l) => l.id === layerId);
      if (!isTitleLayer(layer) || layer.source.kind !== 'text') return;
      const src = layer.source;
      // Auto-named = still named after its text, or a numbered duplicate of that (“確定 2”).
      // Clearing the text keeps the old name for the moment; `namePending` remembers that it
      // should follow again once text is typed.
      const oldName = textName(src.text);
      const auto = (oldName !== '' && isNumberedName(layer.name, oldName)) || (oldName === '' && core.namePending.has(layerId));
      const next = textName(text);
      if (auto && !next) core.namePending.add(layerId);
      else core.namePending.delete(layerId);
      const others = () => new Set(project.layers.filter((l) => l.id !== layerId).map((l) => l.name));
      const name = auto && next ? (next === oldName ? layer.name : uniqueName(next, others())) : layer.name;
      const chars = remapChars(src.chars, src.text, text);
      // Its companion group (a template's wrapper) still named after it follows the new name, in the same step.
      const group = name !== layer.name ? project.layers.find((l) => l.kind === 'group' && l.companionGroupOf === layerId && l.name === layer.name) : undefined;
      const layers = project.layers.map((l) => (l.id === layerId ? ({ ...l, name, source: { ...src, text, chars } } as Layer) : l === group ? { ...l, name } : l));
      commit(core, { ...project, layers }, coalesce, 'Edit text');
      // A project still named after this text: offer (once) to rename it after the new text.
      if (!core.renameSettled && !get().renameOffer) {
        const pn = project.name;
        const whole = pn !== oldName && pn === titleForm(src.text, true);
        if ((pn === oldName || whole) && titleForm(text, whole) !== pn) set({ renameOffer: { layerId, whole } });
      }
      // Picked characters follow the edit too (or are dropped with it).
      const { selectedChars, selectedLayerId } = get();
      if (selectedLayerId === layerId && selectedChars.length) {
        const marks = Object.fromEntries(selectedChars.map((i) => [i, { dx: 0, dy: 0, scale: 1, rotate: 0 }]));
        set({ selectedChars: Object.keys(remapChars(marks, src.text, text)).map(Number).sort((a, b) => a - b) });
      }
    },
    settleRenameOffer(accept) {
      const { renameOffer, project } = get();
      core.renameSettled = true;
      set({ renameOffer: null });
      const l = renameOffer && project.layers.find((x) => x.id === renameOffer.layerId);
      const name = isTitleLayer(l) && l.source.kind === 'text' ? titleForm(l.source.text, renameOffer!.whole) : '';
      if (accept && name && name !== project.name) commit(core, { ...project, name }, undefined, msg('Rename project to “{name}”', { name }));
    },
  };
};

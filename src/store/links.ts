import { forEachMaterial, setIn, withoutLink, type AnyMaterial } from '../model/links';
import type { Project } from '../model/types';
import { sameValue } from './paths';

// The commit hook of linked materials (see src/model/links.ts): after any project change, every
// linked material that changed is copied to the other materials of its link, in the same commit
// and so the same undo step. It works on the result, whatever made it (a field edit, a preset, a
// colourway, a pasted material or style), so no editor needs to know about links.

/** Linked materials of a project by `${layerId}|${slot key}` (cached per project object). */
const indexCache = new WeakMap<Project, Map<string, AnyMaterial>>();

function linkedIndex(p: Project): Map<string, AnyMaterial> {
  const cached = indexCache.get(p);
  if (cached) return cached;
  const out = new Map<string, AnyMaterial>();
  for (const l of p.layers)
    forEachMaterial(l, (s) => {
      if (s.mat.link) out.set(`${l.id}|${s.key}`, s.mat);
    });
  indexCache.set(p, out);
  return out;
}

interface Member {
  layerIndex: number;
  path: (string | number)[];
  mat: AnyMaterial;
  /** The linked material in this slot before the edit (undefined: it was not linked there). */
  old: AnyMaterial | undefined;
}

/**
 * `next` (the project an edit of `prev` produced) with its material links kept: a rewritten
 * material without a `link` key keeps the link its slot had; an own `link` key holding nothing
 * (an unlink) is removed; in every link, the first material (layer, then part order) whose
 * content the edit changed — else the first newly linked one (a duplicated layer, a material just
 * linked) — is copied to the others; names of links no longer used are dropped.
 * Returns `next` itself when there is nothing to do.
 */
export function syncLinks(prev: Project, next: Project): Project {
  const before = linkedIndex(prev);
  const groups = new Map<string, Member[]>();
  const writes: { layerIndex: number; path: (string | number)[]; mat: AnyMaterial }[] = [];
  next.layers.forEach((l, layerIndex) => {
    forEachMaterial(l, (s) => {
      let mat = s.mat;
      const old = before.get(`${l.id}|${s.key}`);
      const own = 'link' in mat;
      if (own && !mat.link) {
        mat = withoutLink(mat);
        writes.push({ layerIndex, path: s.path, mat });
      } else if (!own && old && old !== mat) {
        mat = { ...mat, link: old.link };
        writes.push({ layerIndex, path: s.path, mat });
      }
      if (!mat.link) return;
      const g = `${s.kind}:${mat.link}`;
      const list = groups.get(g) ?? [];
      list.push({ layerIndex, path: s.path, mat, old });
      groups.set(g, list);
    });
  });
  for (const members of groups.values()) {
    const winner = members.find((m) => m.old && !sameValue(m.old, m.mat)) ?? members.find((m) => !m.old);
    if (!winner || members.length < 2) continue;
    for (const m of members) {
      if (m === winner || sameValue(m.mat, winner.mat)) continue;
      writes.push({ layerIndex: m.layerIndex, path: m.path, mat: { ...winner.mat } });
    }
  }
  let out = next;
  if (writes.length) {
    const layers = next.layers.slice();
    for (const w of writes) layers[w.layerIndex] = setIn(layers[w.layerIndex], w.path, w.mat);
    out = { ...next, layers };
  }
  return pruneNames(out, groups);
}

/** `p` without the names of links no material uses any more (and without an empty name table). */
function pruneNames(p: Project, groups: Map<string, Member[]>): Project {
  const names = p.materialLinks;
  if (!names) return p;
  const used = new Set([...groups.keys()].map((g) => g.slice(3)));
  const ids = Object.keys(names);
  if (ids.every((id) => used.has(id))) return p;
  const kept = Object.fromEntries(ids.filter((id) => used.has(id)).map((id) => [id, names[id]]));
  const { materialLinks: _, ...rest } = p;
  return Object.keys(kept).length ? { ...p, materialLinks: kept } : rest;
}

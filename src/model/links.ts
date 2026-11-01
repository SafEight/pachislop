import { uid } from './defaults';
import { bandKey, plateKey, rimKey } from './parts';
import type { Layer, Material2D, Material3D, PartKey, Project } from './types';

// Linked materials (Element 3D material groups): materials of title parts and letters that carry
// the same `link` id are ONE material, across parts and layers. 2D and 3D materials with the same
// id are separate groups (a 2D face never mirrors a 3D one). The store keeps them equal on every
// commit (store/links.ts syncLinks); the renderers never look at `link`. The names live in
// `Project.materialLinks` (empty name = automatic, from the material).
//
// `link` states: a non-empty string = linked; absent = unlinked. An OWN `link` key holding
// undefined (or '') is the explicit "unlink" of an edit: syncLinks strips it, whereas a rewritten
// material that simply lacks the key (a preset, a colourway, a pasted material) keeps the link its
// slot had.

export type LinkKind = '2d' | '3d';
export type AnyMaterial = Material2D | Material3D;
export type MaterialLinks = NonNullable<Project['materialLinks']>;
type Path = (string | number)[];

/** One material of a layer, where it sits and what shows it. */
export interface MaterialSlot {
  /** Stable within the layer across reorders: 'face', 'rim:<id>', 'plate:<id>:side', 'char:3:band:1'… */
  key: string;
  /** Path from the layer object. */
  path: Path;
  kind: LinkKind;
  mat: AnyMaterial;
  /** The style part showing it; null for a letter's own material. */
  part: PartKey | null;
  /** The letter (code-point index) owning it, for per-character materials. */
  char?: number;
}

/**
 * Every linkable material of `l`: the style parts' (2D face and rims; 3D face, side, bands and
 * plates' front and edge) then the letters' own (2D face; 3D face, bands and side), in that order.
 */
export function forEachMaterial(l: Layer, fn: (s: MaterialSlot) => void): void {
  if (l.kind === 'title2d') {
    fn({ key: 'face', path: ['style', 'face'], kind: '2d', mat: l.style.face, part: 'face' });
    l.style.rims.forEach((r, i) => fn({ key: rimKey(r.id), path: ['style', 'rims', i, 'material'], kind: '2d', mat: r.material, part: rimKey(r.id) }));
  } else if (l.kind === 'title3d') {
    const s = l.style3d;
    fn({ key: 'face', path: ['style3d', 'face'], kind: '3d', mat: s.face, part: 'face' });
    fn({ key: 'side', path: ['style3d', 'side'], kind: '3d', mat: s.side, part: 'side' });
    s.bands.forEach((b, i) => fn({ key: bandKey(b.id), path: ['style3d', 'bands', i, 'material'], kind: '3d', mat: b.material, part: bandKey(b.id) }));
    s.backplates.forEach((p, i) => {
      fn({ key: `${plateKey(p.id)}:face`, path: ['style3d', 'backplates', i, 'face'], kind: '3d', mat: p.face, part: plateKey(p.id) });
      fn({ key: `${plateKey(p.id)}:side`, path: ['style3d', 'backplates', i, 'side'], kind: '3d', mat: p.side, part: plateKey(p.id) });
    });
  } else return;
  if (l.source.kind !== 'text') return;
  for (const [k, c] of Object.entries(l.source.chars)) {
    const char = Number(k);
    const at = ['source', 'chars', k];
    if (c.face) fn({ key: `char:${k}:face`, path: [...at, 'face'], kind: '2d', mat: c.face, part: null, char });
    if (c.face3d) fn({ key: `char:${k}:face3d`, path: [...at, 'face3d'], kind: '3d', mat: c.face3d, part: null, char });
    c.bands3d?.forEach((m, j) => m && fn({ key: `char:${k}:band:${j}`, path: [...at, 'bands3d', j], kind: '3d', mat: m, part: null, char }));
    if (c.side3d) fn({ key: `char:${k}:side3d`, path: [...at, 'side3d'], kind: '3d', mat: c.side3d, part: null, char });
  }
}

/** A linked material of the project: its slot and the layer it is in. */
export interface LinkedSlot extends MaterialSlot {
  layerId: string;
  link: string;
}

/** Every linked material of `project` (link `id` and `kind` only, when given), in layer order. */
export function linkedSlots(project: Project, id?: string, kind?: LinkKind): LinkedSlot[] {
  const out: LinkedSlot[] = [];
  for (const l of project.layers)
    forEachMaterial(l, (s) => {
      const link = s.mat.link;
      if (link && (id === undefined || link === id) && (kind === undefined || s.kind === kind)) out.push({ ...s, layerId: l.id, link });
    });
  return out;
}

/** `obj` with `value` at `path`; only the objects along the path are copied. */
export function setIn<T>(obj: T, path: readonly (string | number)[], value: unknown): T {
  if (path.length === 0) return value as T;
  const [k, ...rest] = path;
  const src = obj as Record<string | number, unknown>;
  const next = setIn(src[k], rest, value);
  if (next === src[k]) return obj;
  if (Array.isArray(obj)) {
    const copy = obj.slice();
    copy[k as number] = next;
    return copy as T;
  }
  return { ...(obj as object), [k]: next } as T;
}

/** `m` without its link (a material copied out of a linked one, e.g. into a letter or the clipboard). */
export function withoutLink<M extends AnyMaterial>(m: M): M {
  if (!('link' in m)) return m;
  const { link: _, ...rest } = m;
  return rest as M;
}

/**
 * `l` with every material link renamed by `map`: a string relinks, null removes the link (the
 * material becomes independent), undefined keeps it. The same layer when nothing changes.
 */
export function remapLayerLinks(l: Layer, map: (id: string) => string | null | undefined): Layer {
  let out = l;
  forEachMaterial(l, (s) => {
    const id = s.mat.link;
    if (!id) return;
    const to = map(id);
    if (to === undefined || to === id) return;
    out = setIn(out, s.path, to === null ? withoutLink(s.mat) : { ...s.mat, link: to });
  });
  return out;
}

/**
 * `l` (a look's style just applied, a template's layer) with its link ids replaced by fresh ones,
 * so the same look on two layers links within each layer only. `names` gives the look's names of
 * its link ids; the returned `links` are the new ids that have a name, for Project.materialLinks.
 */
export function freshLinks(l: Layer, names: MaterialLinks = {}): { layer: Layer; links: MaterialLinks } {
  const links: MaterialLinks = {};
  const ids = new Map<string, string>();
  const layer = remapLayerLinks(l, (id) => {
    let to = ids.get(id);
    if (!to) {
      to = uid();
      ids.set(id, to);
      if (names[id]?.name) links[to] = { name: names[id].name };
    }
    return to;
  });
  return { layer, links };
}

/**
 * `l` with each link's materials made equal to the first of them in the layer (forEachMaterial
 * order), for pure recolourings (colourways) whose result must not depend on the store: the same
 * rule as the commit's (store/links.ts syncLinks), where the first changed material leads.
 */
export function unifyLayerLinks(l: Layer): Layer {
  const first = new Map<string, AnyMaterial>();
  let out = l;
  forEachMaterial(l, (s) => {
    if (!s.mat.link) return;
    const g = `${s.kind}:${s.mat.link}`;
    const lead = first.get(g);
    if (!lead) first.set(g, s.mat);
    else if (lead !== s.mat) out = setIn(out, s.path, { ...lead });
  });
  return out;
}

/** `links` added to the project's link names (none added: the same project). */
export function addLinkNames(project: Project, links: MaterialLinks): Project {
  if (!Object.keys(links).length) return project;
  return { ...project, materialLinks: { ...project.materialLinks, ...links } };
}

/** Names of the named links `l` uses (a look or a style clip records them). */
export function linkNamesOf(project: Project, l: Layer): MaterialLinks {
  const out: MaterialLinks = {};
  forEachMaterial(l, (s) => {
    const id = s.mat.link;
    const name = id ? project.materialLinks?.[id]?.name : undefined;
    if (id && name) out[id] = { name };
  });
  return out;
}

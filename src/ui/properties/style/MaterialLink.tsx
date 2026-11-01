import { useState } from 'react';
import { uid } from '../../../model/defaults';
import { forEachMaterial, linkedSlots, type AnyMaterial, type LinkKind } from '../../../model/links';
import type { TitleLayer } from '../../../model/parts';
import type { Material2D, Material3D, PartKey, Project } from '../../../model/types';
import { msg, type Msg, type Translate } from '../../../store/msg';
import { absPath, getIn, getRef, refList, updateIn } from '../../../store/paths';
import { useEditor, type PropRef, type Refs } from '../../../store/store';
import { Menu, type MenuItem } from '../../controls';
import { useT } from '../../i18n';
import { LinkIcon } from './icons';
import { fillCss, material3DCss, presetLabel } from './shared';
import { Swatch } from './widgets';

// Linked materials in the material headers (see src/model/links.ts): a chip "Gold ×4" (click to
// rename) and a menu to link to another material of the project, start a new link, unlink, or
// select everything using the link. Keeping the linked materials equal is the store's job.

const materialAt = (p: Project, r: PropRef) => getRef(p, r) as AnyMaterial | undefined;

const swatchOf = (kind: LinkKind, m: AnyMaterial) => (kind === '2d' ? fillCss((m as Material2D).fill) : material3DCss(m as Material3D));

/** A link's name: its own, else the material's preset (3D), else a generic one. */
function linkName(t: Translate, project: Project, id: string, mat: AnyMaterial): string {
  const name = project.materialLinks?.[id]?.name;
  if (name) return name;
  return 'preset' in mat && mat.preset !== 'custom' ? presetLabel(t, mat.preset) : t('Linked material');
}

/** The links of `kind` in the project: id, first material and number of materials, in layer order. */
function linksOf(project: Project, kind: LinkKind): { id: string; mat: AnyMaterial; count: number }[] {
  const out = new Map<string, { id: string; mat: AnyMaterial; count: number }>();
  for (const s of linkedSlots(project, undefined, kind)) {
    const e = out.get(s.link);
    if (e) e.count++;
    else out.set(s.link, { id: s.link, mat: s.mat, count: 1 });
  }
  return [...out.values()];
}

/** Every material at `refs` rewritten by `fn`, as one undo step (the commit mirrors linked ones). */
function editMaterials(refs: readonly PropRef[], fn: (m: AnyMaterial, p: Project) => AnyMaterial | null, label: Msg): void {
  useEditor.getState().edit(
    (p) => {
      let out = p;
      for (const r of refs) {
        const ap = absPath(out, r);
        const m = ap && (getIn(out, ap) as AnyMaterial | undefined);
        const next = m ? fn(m, p) : null;
        if (ap && next) out = updateIn(out, ap, () => next);
      }
      return out;
    },
    undefined,
    label,
  );
}

/**
 * Select what uses link `id`: its parts (one or several of one title), else its letters, or the
 * layers when it spans several (parts of different layers can't be selected together).
 */
function selectUsers(id: string, kind: LinkKind, name: string): void {
  const st = useEditor.getState();
  const slots = linkedSlots(st.project, id, kind);
  const layerIds = [...new Set(slots.map((s) => s.layerId))];
  if (layerIds.length > 1) {
    st.selectLayers(layerIds, layerIds.at(-1));
    st.notify(msg('“{name}” is used on {n} layers: they are selected', { name, n: layerIds.length }));
    return;
  }
  const layerId = layerIds[0];
  if (!layerId) return;
  const parts = [...new Set(slots.flatMap((s) => (s.part ? [s.part] : [])))];
  const chars = [...new Set(slots.flatMap((s) => (s.char !== undefined ? [s.char] : [])))];
  if (parts.length === 1) st.selectNode({ kind: 'part', layerId, part: parts[0] });
  else if (parts.length > 1) st.selectNode({ kind: 'parts', layerId, parts });
  else {
    st.selectNode({ kind: 'layer', layerId });
    st.selectChars(chars);
    return;
  }
  if (chars.length) st.notify(msg('“{name}” is also used by {n} letters (Letters section)', { name, n: chars.length }));
}

/**
 * Link chip and menu for the material(s) at `refp` (several: a multi-part edit), shown in the
 * material's header. `kind` says which links it can join (2D and 3D materials never link).
 */
export function MaterialLink({ refp, kind }: { refp: Refs; kind: LinkKind }) {
  const t = useT();
  const project = useEditor((s) => s.project);
  const [renaming, setRenaming] = useState(false);
  const refs = refList(refp);
  const mats = refs.map((r) => materialAt(project, r)).filter((m): m is AnyMaterial => !!m);
  if (!mats.length) return null;
  const shared = new Set(mats.map((m) => m.link ?? ''));
  const id = shared.size === 1 ? [...shared][0] : '';
  const links = linksOf(project, kind);
  const mine = links.find((l) => l.id === id);
  const name = id ? linkName(t, project, id, mats[0]) : '';

  const rename = (to: string) => {
    setRenaming(false);
    const next = to.trim();
    if (!id || next === name) return;
    useEditor.getState().edit(
      (p) => {
        const names = { ...p.materialLinks };
        if (next) names[id] = { name: next };
        else delete names[id];
        return { ...p, materialLinks: names };
      },
      undefined,
      msg('Rename material link “{name}”', { name: next || name }),
    );
  };

  const items: MenuItem[] = [
    ...links
      .filter((l) => l.id !== id)
      .map(
        (l): MenuItem => ({
          group: t('Link to'),
          label: (
            <span className="link-item">
              <Swatch css={swatchOf(kind, l.mat)} /> {linkName(t, project, l.id, l.mat)} ×{l.count}
            </span>
          ),
          hint: t('This material becomes that one; editing either changes all'),
          onClick: () => {
            const target = linkName(t, project, l.id, l.mat);
            editMaterials(refs, (_, p) => ({ ...(linkedSlots(p, l.id, kind)[0]?.mat ?? l.mat) }), msg('Link material to “{name}”', { name: target }));
          },
        }),
      ),
    {
      group: t('Link to'),
      label: refs.length > 1 ? t('New link from these {n}', { n: refs.length }) : t('New link from this'),
      hint: refs.length > 1 ? t('One material for all of them, as the first one is now') : t('Link other materials to it with Link to…'),
      onClick: () => {
        const nid = uid();
        editMaterials(refs, (_, p) => ({ ...(materialAt(p, refs[0]) ?? mats[0]), link: nid }), msg('New material link'));
      },
    },
    {
      label: t('Unlink'),
      hint: t('This material becomes its own; the others stay linked'),
      disabled: !mats.some((m) => m.link),
      onClick: () => editMaterials(refs, (m) => (m.link ? { ...m, link: undefined } : null), msg('Unlink material')),
    },
    {
      label: t('Select all using it'),
      disabled: !id,
      onClick: () => selectUsers(id, kind, name),
    },
  ];

  return (
    <span className="link-actions">
      {id &&
        (renaming ? (
          <input
            className="link-rename"
            autoFocus
            defaultValue={project.materialLinks?.[id]?.name ?? name}
            aria-label={t('Link name')}
            onFocus={(e) => e.currentTarget.select()}
            onBlur={(e) => rename(e.currentTarget.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') e.currentTarget.blur();
              if (e.key === 'Escape') setRenaming(false);
            }}
          />
        ) : (
          <button className="link-chip" title={t('Linked material: {n} materials share it. Click to rename', { n: mine?.count ?? 1 })} onClick={() => setRenaming(true)}>
            <LinkIcon /> {name} ×{mine?.count ?? 1}
          </button>
        ))}
      <Menu
        className="link-menu"
        label={id ? '▾' : <LinkIcon />}
        title={id ? t('Material link: link to…, unlink, select all using it') : t('Link this material to another one (edit once, change all)')}
        items={items}
      />
    </span>
  );
}

/** The link of `mat`, with its name and size, or null when unlinked. */
function linkTitle(t: Translate, project: Project, mat: AnyMaterial | undefined, kind: LinkKind): string | null {
  if (!mat?.link) return null;
  return t('Linked: {name} ×{n}', { name: linkName(t, project, mat.link, mat), n: linkedSlots(project, mat.link, kind).length });
}

/** The link of part `part` of `l` (a plate: its front, else its edge), with its name and size, or null. */
function partLink(t: Translate, project: Project, l: TitleLayer, part: PartKey): string | null {
  const found: { mat: AnyMaterial; kind: LinkKind }[] = [];
  forEachMaterial(l, (s) => {
    if (s.part === part && s.mat.link) found.push({ mat: s.mat, kind: s.kind });
  });
  return found[0] ? linkTitle(t, project, found[0].mat, found[0].kind) : null;
}

function LinkBadge({ title }: { title: string | null }) {
  return title ? (
    <span className="part-link" title={title} aria-label={title}>
      <LinkIcon />
    </span>
  ) : null;
}

/** Subtle link icon for a linked part (Layers part rows, Appearance rows); nothing when unlinked. */
export function PartLinkBadge({ layer, part }: { layer: TitleLayer; part: PartKey }) {
  const t = useT();
  const title = useEditor((s) => partLink(t, s.project, layer, part));
  return <LinkBadge title={title} />;
}

/** The same icon for the first linked one of `mats` (a letter's own materials in Letters); nothing when none is linked. */
export function MaterialLinkBadge({ mats, kind }: { mats: readonly (AnyMaterial | undefined)[]; kind: LinkKind }) {
  const t = useT();
  const mat = mats.find((m) => m?.link);
  const title = useEditor((s) => linkTitle(t, s.project, mat, kind));
  return <LinkBadge title={title} />;
}

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { BlendMode, Layer } from '../../model/types';
import { effectsOf } from '../../store/effects';
import { effectOwnerLabel } from '../../store/labels';
import { formatMsg } from '../../store/msg';
import { useEditor, type EffectOwner, type NodeRef } from '../../store/store';
import { ancestorsOf } from '../../store/tree';
import { NumberField } from '../controls';
import { useT } from '../i18n';
import { addGroupLayer, draggingFiles, importFiles } from '../layerActions';
import { AddEffectMenu, type MenuAnchor } from '../properties/AddEffectMenu';
import { oneShot } from '../util';
import { addMaskItems, adjustmentItems, newLayerItems } from './commands';
import { drag } from './dnd';
import { ContextMenu, type CtxEntry } from './LayerContextMenu';
import { EffectRow, HeadRow, LayerRow, PartRow, type RowUi } from './LayerRow';
import { buildRows, rowFocused, rowNode, sameNode, twirlOf, type PanelRow } from './rows';
import './layers.css';

// Photoshop-style Layers panel: the overview of the whole comp. Header (blend / opacity / flags
// of the selection), the layer tree with title style parts and effects under their twirls, and
// the bottom toolbar. Projects stay under ~100 rows, so the tree is a plain (unvirtualised) list.

/** Blend modes with their menu labels (PS wording; translated). */
const BLENDS: readonly { value: BlendMode; label: string }[] = [
  { value: 'normal', label: 'Normal' },
  { value: 'add', label: 'Add' },
  { value: 'screen', label: 'Screen' },
  { value: 'multiply', label: 'Multiply' },
  { value: 'overlay', label: 'Overlay' },
];

/** The effect stack(s) a node edits: a layer's own (also when one of its masks is focused), a part's, each of several selected parts', or the one an effect is in. */
function ownersOf(node: NodeRef | null, layers: readonly Layer[]): EffectOwner[] {
  if (!node) return [];
  if (node.kind === 'part' || node.kind === 'effect') return [{ layerId: node.layerId, part: node.part }];
  if (node.kind === 'parts') return node.parts.map((part) => ({ layerId: node.layerId, part }));
  return layers.some((x) => x.id === node.layerId) ? [{ layerId: node.layerId, part: null }] : [];
}

/** Delete / trash: the focused effect or mask, or the selected layers. A part can't be deleted here (its editor removes rims / bands). */
function deleteNode(node: NodeRef | null) {
  const st = useEditor.getState();
  if (node?.kind === 'effect') st.removeEffect({ layerId: node.layerId, part: node.part }, node.effectId);
  else if (node?.kind === 'mask') st.removeMask(node.layerId, node.maskId);
  else if (node?.kind !== 'part' && node?.kind !== 'parts' && st.selectedLayerIds.length) st.removeLayers(st.selectedLayerIds);
}

/** The Add mask button's glyph: PS's rectangle with a circle. */
const MASK_ICON = (
  <svg width="14" height="12" viewBox="0 0 14 12" aria-hidden>
    <rect x="0.5" y="0.5" width="13" height="11" rx="1" fill="none" stroke="currentColor" />
    <circle cx="7" cy="6" r="3.2" fill="currentColor" />
  </svg>
);

/** Duplicate: the focused effect (just above itself), or the selected layers. */
function duplicateNode(node: NodeRef | null) {
  const st = useEditor.getState();
  if (node?.kind === 'effect') {
    const owner = { layerId: node.layerId, part: node.part };
    const i = effectsOf(st.project, owner).findIndex((fx) => fx.id === node.effectId);
    st.moveEffect(owner, node.effectId, owner, i + 1, true);
  } else if (st.selectedLayerIds.length) st.duplicateLayers(st.selectedLayerIds);
}

/** Toolbar button opening a command menu above / below itself; a second click closes it. */
function MenuButton({ label, title, items, disabled, children }: { label: string; title: string; items: () => CtxEntry[]; disabled?: boolean; children: ReactNode }) {
  // The opening button goes with the anchor: the menu's outside-press close ignores it (the button toggles the menu itself).
  const [open, setOpen] = useState<{ anchor: MenuAnchor; trigger: HTMLButtonElement } | null>(null);
  return (
    <>
      <button
        className={`lp-tool ${open ? 'on' : ''}`}
        title={title}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={!!open}
        disabled={disabled}
        onClick={(e) => setOpen(open ? null : { anchor: e.currentTarget.getBoundingClientRect(), trigger: e.currentTarget })}
      >
        {children}
      </button>
      {open && <ContextMenu anchor={open.anchor} items={items()} label={label} trigger={open.trigger} onClose={() => setOpen(null)} />}
    </>
  );
}

function ToolButton({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button className="lp-tool" title={label} aria-label={label} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );
}

/** Blend / opacity / lock / solo / guide of the selected layers (the primary one's values shown), as PS's panel header. */
function Header({ layer, ids }: { layer: Layer | undefined; ids: readonly string[] }) {
  const t = useT();
  const set = (path: (string | number)[], value: unknown, coalesce: string) => {
    const st = useEditor.getState();
    for (const id of ids) st.setAt({ layerId: id, path }, value, coalesce);
  };
  const flag = (key: 'locked' | 'solo' | 'guide', label: string, glyph: string) => (
    <button
      className={`lp-flag-btn ${layer?.[key] ? 'on' : ''}`}
      title={label}
      aria-label={label}
      aria-pressed={!!layer?.[key]}
      disabled={!layer}
      onClick={() => layer && set([key], !layer[key], oneShot(`lp-${key}`))}
    >
      {glyph}
    </button>
  );
  return (
    <div className="lp-header">
      <div className="lp-header-row">
        <select
          className="lp-blend"
          value={layer?.blend ?? 'normal'}
          disabled={!layer}
          title={t('Blend mode')}
          aria-label={t('Blend mode')}
          onChange={(e) => set(['blend'], e.target.value as BlendMode, oneShot('lp-blend'))}
        >
          {BLENDS.map((b) => (
            <option key={b.value} value={b.value}>
              {t(b.label)}
            </option>
          ))}
        </select>
        <span className="lp-opacity" title={t('Layer opacity (drag to scrub)')}>
          <span className="lp-label">{t('Opacity')}</span>
          {layer ? (
            <NumberField id="lp-opacity" label={t('Opacity')} value={layer.transform.opacity} min={0} max={1} display={100} unit="%" clamp slider={false} onChange={(v, c) => set(['transform', 'opacity'], v, c)} />
          ) : (
            <span className="lp-muted">—</span>
          )}
        </span>
      </div>
      <div className="lp-header-row">
        <span className="lp-label">{t('Lock:')}</span>
        {flag('locked', t('Lock (no canvas selection / dragging)'), '🔒')}
        {flag('solo', t('Solo (show only soloed layers)'), 'S')}
        {flag('guide', t('Guide layer: visible in the editor, excluded from exports'), 'G')}
        {ids.length > 1 && (
          <span className="lp-muted lp-count" title={t('⇧-click: range · ⌘-click: add / remove · ⌘A: all · ⌘D / Esc: none · ⌘G: group')}>
            {t('{n} selected', { n: ids.length })}
          </span>
        )}
      </div>
    </div>
  );
}

export function LayersPanel() {
  const t = useT();
  const layers = useEditor((s) => s.project.layers);
  const expanded = useEditor((s) => s.view.expanded);
  const selectedIds = useEditor((s) => s.selectedLayerIds);
  const primaryId = useEditor((s) => s.selectedLayerId);
  const node = useEditor((s) => s.selectedNode);
  const rows = useMemo(() => buildRows(layers, expanded), [layers, expanded]);
  const byId = useMemo(() => new Map(layers.map((l) => [l.id, l])), [layers]);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ anchor: MenuAnchor; items: CtxEntry[]; label: string } | null>(null);
  const [fxMenu, setFxMenu] = useState<{ owner: EffectOwner | readonly EffectOwner[]; anchor: MenuAnchor } | null>(null);
  const [alt, setAlt] = useState(false);
  const [tailDrop, setTailDrop] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const treeRef = useRef<HTMLDivElement>(null);

  const ui = useMemo<RowUi>(
    () => ({
      rename: (id) => setRenaming(id),
      endRename: () => {
        setRenaming(null);
        rootRef.current?.focus();
      },
      addEffect: (owner, anchor) => setFxMenu({ owner, anchor }),
      openMenu: (anchor, items, label) => setMenu({ anchor, items, label }),
      twirl: (id, open, all) => {
        const st = useEditor.getState();
        const next = { ...st.view.expanded };
        if (all) for (const l of st.project.layers) if (twirlOf(l, next) !== null) next[l.id] = open;
        next[id] = open;
        st.setView({ expanded: next });
      },
    }),
    [],
  );

  // A node selected elsewhere (canvas, Properties breadcrumb) is twirled into view: its groups
  // open, and its layer when it is a part or an effect.
  useEffect(() => {
    if (!node) return;
    const st = useEditor.getState();
    const { layers: all } = st.project;
    const want: Layer[] = ancestorsOf(all, node.layerId);
    const own = all.find((l) => l.id === node.layerId);
    if ((node.kind === 'part' || node.kind === 'parts' || node.kind === 'effect') && own) want.push(own);
    const closed = want.filter((l) => twirlOf(l, st.view.expanded) === false);
    if (closed.length) st.setView({ expanded: { ...st.view.expanded, ...Object.fromEntries(closed.map((l) => [l.id, true])) } });
  }, [node]);

  // Keep the focused row (or mask chip) visible.
  useEffect(() => {
    treeRef.current?.querySelector('.lp-row.focus, .lp-mask.focus')?.scrollIntoView({ block: 'nearest' });
  }, [node, rows]);

  // ⌥ held: rows show where an ⌥-click toggles a clipping mask.
  useEffect(() => {
    const key = (e: globalThis.KeyboardEvent) => setAlt(e.altKey);
    const off = () => setAlt(false);
    window.addEventListener('keydown', key);
    window.addEventListener('keyup', key);
    window.addEventListener('blur', off);
    return () => {
      window.removeEventListener('keydown', key);
      window.removeEventListener('keyup', key);
      window.removeEventListener('blur', off);
    };
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    // Menus portaled out of the panel still bubble here through React; they handle their own keys.
    if (!rootRef.current?.contains(target) || target.closest('input, select, textarea')) return;
    if (target.closest('button') && (e.key === 'Enter' || e.key === ' ')) return;
    const st = useEditor.getState();
    const nodes = rows.map((r) => ({ r, n: rowNode(r) })).filter((x): x is { r: PanelRow; n: NodeRef } => x.n !== null);
    // A focused mask chip navigates as its layer's row, several selected parts as the last of them.
    const at: NodeRef | null = node?.kind === 'mask' ? { kind: 'layer', layerId: node.layerId } : node?.kind === 'parts' ? { kind: 'part', layerId: node.layerId, part: node.parts[node.parts.length - 1] } : node;
    const i = nodes.findIndex((x) => sameNode(x.n, at));
    const cur = nodes[i] as (typeof nodes)[number] | undefined;
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        // ⇧ extends the layer range, so it skips part / effect rows.
        const step = e.key === 'ArrowDown' ? 1 : -1;
        let j = i < 0 ? (step > 0 ? -1 : nodes.length) : i;
        do j += step;
        while (e.shiftKey && nodes[j] && nodes[j].n.kind !== 'layer');
        const next = nodes[j];
        if (next) st.selectNode(next.n, e.shiftKey ? { range: true } : undefined);
        break;
      }
      case 'ArrowRight':
        if (cur?.r.kind !== 'layer' || cur.r.open === null) break;
        if (!cur.r.open) ui.twirl(cur.r.layer.id, true, false);
        else if (nodes[i + 1]) st.selectNode(nodes[i + 1].n);
        break;
      case 'ArrowLeft': {
        if (node?.kind === 'mask') {
          st.selectNode({ kind: 'layer', layerId: node.layerId });
          break;
        }
        if (!cur) break;
        if (cur.r.kind === 'layer' && cur.r.open) {
          ui.twirl(cur.r.layer.id, false, false);
          break;
        }
        // Up to the parent node: mask → its layer, effect → its part or layer, part → layer, member → group.
        const n = cur.n;
        if (n.kind === 'effect' && n.part) st.selectNode({ kind: 'part', layerId: n.layerId, part: n.part });
        else if (n.kind !== 'layer') st.selectNode({ kind: 'layer', layerId: n.layerId });
        else {
          const parent = byId.get(n.layerId)?.parentId;
          if (parent) st.selectNode({ kind: 'layer', layerId: parent });
        }
        break;
      }
      case 'Delete':
      case 'Backspace':
        deleteNode(node);
        break;
      case 'F2':
      case 'Enter':
        if (node?.kind === 'layer') setRenaming(node.layerId);
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  const primary = primaryId ? byId.get(primaryId) : undefined;
  const fxOwners = ownersOf(node, layers);
  const fxLayer = fxOwners.length > 0 ? byId.get(fxOwners[0].layerId) : undefined;
  const fxTarget = !fxLayer ? null : fxOwners.length > 1 ? t('{n} parts', { n: fxOwners.length }) : formatMsg(effectOwnerLabel(fxLayer, fxOwners[0].part), t);
  const selSet = new Set(selectedIds);

  const renderRow = (r: PanelRow) => {
    const focused = rowFocused(rowNode(r), node);
    switch (r.kind) {
      case 'layer':
        return (
          <LayerRow
            key={r.layer.id}
            row={r}
            selected={selSet.has(r.layer.id)}
            focused={focused}
            focusedMask={node?.kind === 'mask' && node.layerId === r.layer.id ? node.maskId : null}
            renaming={renaming === r.layer.id}
            ui={ui}
          />
        );
      case 'part':
        return <PartRow key={`${r.layer.id}|${r.part}`} row={r} focused={focused} ui={ui} />;
      case 'effect': {
        const layer = byId.get(r.layerId);
        return layer && <EffectRow key={r.fx.id} row={r} layer={layer} focused={focused} ui={ui} />;
      }
      case 'head':
        return <HeadRow key={r.key} row={r} />;
    }
  };

  return (
    <div ref={rootRef} className={`lp ${alt ? 'alt' : ''}`} tabIndex={0} aria-label={t('Layers')} onKeyDown={onKeyDown}>
      <Header layer={primary} ids={selectedIds} />
      <div
        ref={treeRef}
        className="lp-tree"
        role="tree"
        aria-label={t('Layers')}
        aria-multiselectable
        onDragOver={(e) => {
          // Below the last row: the bottom of the stack, top level (layer rows or desktop files).
          const files = !drag.current && draggingFiles(e.dataTransfer);
          if ((drag.current?.kind !== 'layers' && !files) || e.target !== e.currentTarget) return setTailDrop(false);
          e.preventDefault();
          if (files) e.dataTransfer.dropEffect = 'copy';
          setTailDrop(true);
        }}
        onDragLeave={() => setTailDrop(false)}
        onDrop={(e) => {
          setTailDrop(false);
          if (e.target !== e.currentTarget) return;
          const p = drag.current;
          if (!p && draggingFiles(e.dataTransfer)) {
            e.preventDefault();
            return void importFiles([...e.dataTransfer.files], { dim: '2d', dest: { into: null, index: 0 } });
          }
          if (p?.kind !== 'layers') return;
          e.preventDefault();
          drag.current = null;
          useEditor.getState().moveLayers(p.ids, { into: null, index: 0 });
        }}
        onClick={(e) => {
          if (e.target === e.currentTarget) useEditor.getState().selectNode(null);
        }}
      >
        {rows.length === 0 && <div className="lp-empty">{t('No layers — use ⊕ below or pick a template.')}</div>}
        {rows.map(renderRow)}
        {tailDrop && <div className="lp-tail-drop" />}
      </div>
      <div className="lp-toolbar" role="toolbar" aria-label={t('Layer commands')}>
        <button
          className={`lp-tool lp-tool-fx ${fxMenu ? 'on' : ''}`}
          title={fxTarget ? t('Add an effect to {name}', { name: fxTarget }) : t('Add an effect to the selected layer, part or group')}
          aria-label={fxTarget ? t('Add effect to {name}', { name: fxTarget }) : t('Add effect')}
          aria-haspopup="menu"
          disabled={!fxTarget}
          // AddEffectMenu closes on an outside pointer-down; keep this button's own toggle.
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => setFxMenu(fxMenu || !fxTarget ? null : { owner: fxOwners, anchor: e.currentTarget.getBoundingClientRect() })}
        >
          fx ▾
        </button>
        <MenuButton label={t('Add mask')} title={t('Add a layer mask to the selected layer: vector shape, gradient or another layer')} items={() => (primaryId ? addMaskItems(t, primaryId) : [])} disabled={!primaryId}>
          {MASK_ICON} ▾
        </MenuButton>
        <MenuButton label={t('New fill or adjustment layer')} title={t('New adjustment layer above the selected layer (⌥-click an item: clipped to the layer below)')} items={() => adjustmentItems(t)}>
          ◐ ▾
        </MenuButton>
        <MenuButton label={t('New layer', undefined, { ctx: 'layers' })} title={t('New layer: 2D / 3D text, shape, generator (particles, speed lines…), SVG logo, image, 3D model, group, background')} items={() => newLayerItems(t)}>
          ⊕ ▾
        </MenuButton>
        <span className="lp-tool-sep" />
        <ToolButton
          label={selectedIds.length ? t('Group the selected layers (⌘G)') : t('New empty group')}
          onClick={() => {
            const st = useEditor.getState();
            if (st.selectedLayerIds.length) st.groupLayers(st.selectedLayerIds);
            else addGroupLayer();
          }}
        >
          📁
        </ToolButton>
        <ToolButton label={`${primary?.clip ? t('Release clipping mask') : t('Create clipping mask')} (⌥⌘G)`} disabled={!selectedIds.length} onClick={() => useEditor.getState().toggleClip()}>
          ↳
        </ToolButton>
        <ToolButton label={node?.kind === 'effect' ? t('Duplicate effect') : t('Duplicate layer (⌘J)')} disabled={!node || node.kind === 'part' || node.kind === 'parts'} onClick={() => duplicateNode(node)}>
          ⧉
        </ToolButton>
        <ToolButton
          label={node?.kind === 'effect' ? t('Delete effect') : node?.kind === 'mask' ? t('Delete mask') : t('Delete layer (Del)')}
          disabled={!node || node.kind === 'part' || node.kind === 'parts'}
          onClick={() => deleteNode(node)}
        >
          🗑
        </ToolButton>
      </div>
      {menu && <ContextMenu anchor={menu.anchor} items={menu.items} label={menu.label} onClose={() => setMenu(null)} />}
      {fxMenu && <AddEffectMenu owner={fxMenu.owner} anchor={fxMenu.anchor} onClose={() => setFxMenu(null)} />}
    </div>
  );
}

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type DragEvent, type MouseEvent, type ReactNode } from 'react';
import { isTitleLayer, partEffectsOf } from '../../model/parts';
import type { Layer, LayerMask } from '../../model/types';
import { formatMsg } from '../../store/msg';
import { maskLabel, partLabel } from '../../store/labels';
import { effectsOf } from '../../store/effects';
import { useEditor, type EffectOwner, type NodeRef } from '../../store/store';
import { childrenOf } from '../../store/tree';
import { AdjustmentIcon } from '../adjustIcons';
import { GeneratorIcon } from '../generatorIcons';
import { useT } from '../i18n';
import { draggingFiles, importFiles } from '../layerActions';
import { effectName } from '../util';
import { GLINT_PINNED, setGlintEnabled } from '../glint';
import type { MenuAnchor } from '../properties/AddEffectMenu';
import { partSwatch } from '../properties/parts';
import { canClip, effectMenu, glintMenu, layerMenu, maskMenu, partMenu, type PanelUi } from './commands';
import { drag, DRAG_MIME, dropPosAt, fxDropIndex, INDENT, layerDest, type DropPos } from './dnd';
import type { CtxEntry } from './LayerContextMenu';
import { partEnabled, partHasEye } from './parts';
import type { PanelRow } from './rows';
import { maskThumbId, subscribeThumb, thumbOf } from './thumbs';
import { PartLinkBadge } from '../properties/style/MaterialLink';

// The Layers panel's rows: layers (incl. groups, adjustments, generators, backgrounds), style parts, effects
// and the Style / Effects headings. Layout: eye · thumbnail · mask chips · name · badges · twirl.

/** What rows need from the panel besides the commands. */
export interface RowUi extends PanelUi {
  openMenu: (anchor: MenuAnchor, items: CtxEntry[], label: string) => void;
  /** Set a layer's twirl; `all`: every twirl in the panel (⌥-click, as in PS). */
  twirl: (layerId: string, open: boolean, all: boolean) => void;
  endRename: () => void;
}

/** Extra indent of a clipped row, px: room for its ↳ arrow. */
const CLIP_INDENT = 14;

/** Nesting indent between the eye column and the row's content (the eye column stays aligned, as in PS). */
function Indent({ depth, clipped = false, children }: { depth: number; clipped?: boolean; children?: ReactNode }) {
  return (
    <span className="lp-indent" style={{ width: depth * INDENT + (clipped ? CLIP_INDENT : 0) }}>
      {children}
    </span>
  );
}

const pointAnchor = (e: MouseEvent): MenuAnchor => ({ left: e.clientX, right: e.clientX, top: e.clientY, bottom: e.clientY });

/**
 * Groups a layer drop steps out of: the pointer's distance left of where the row's content starts
 * at its depth (the indent's start), in indent steps (PS: drag left to leave a group).
 */
function outLevels(e: DragEvent<HTMLElement>): number {
  const indent = e.currentTarget.querySelector('.lp-indent');
  if (!indent) return 0;
  const contentLeft = indent.getBoundingClientRect().left + indent.clientWidth;
  return e.clientX < contentLeft ? Math.ceil((contentLeft - e.clientX) / INDENT) : 0;
}

/** Row click: plain = this node alone, ⌘ = add / remove a layer or part, ⇧ = layer or part range (PS). */
function clickNode(node: NodeRef, e: MouseEvent) {
  const st = useEditor.getState();
  const multi = node.kind === 'layer' || node.kind === 'part';
  if (multi && e.shiftKey) st.selectNode(node, { range: true });
  else if (multi && (e.metaKey || e.ctrlKey)) st.selectNode(node, { additive: true });
  else st.selectNode(node);
}

function startFxDrag(e: DragEvent, owner: EffectOwner, ids: string[]) {
  e.stopPropagation();
  drag.current = { kind: 'fx', owner, ids };
  e.dataTransfer.setData(DRAG_MIME, ids.join(','));
  e.dataTransfer.effectAllowed = 'copyMove';
}

/** Accept a dragged effect block over the row (every layer, part and effect row takes effects); ⌥ copies. */
function fxOver(e: DragEvent): boolean {
  if (drag.current?.kind !== 'fx') return false;
  e.preventDefault();
  e.stopPropagation();
  e.dataTransfer.dropEffect = e.altKey ? 'copy' : 'move';
  return true;
}

function fxDrop(e: DragEvent, to: EffectOwner, gap?: number) {
  const p = drag.current;
  if (p?.kind !== 'fx') return;
  e.preventDefault();
  e.stopPropagation();
  const st = useEditor.getState();
  const index = fxDropIndex(st.project, p, to, gap, e.altKey);
  drag.current = null;
  if (index !== null) st.moveEffect(p.owner, p.ids, to, index, e.altKey);
}

const endDrag = () => {
  drag.current = null;
};

/** Draggable `fx` badge: dragging it moves every effect of `owner` (⌥ copies). */
function FxBadge({ owner, ids, title }: { owner: EffectOwner; ids: string[]; title: string }) {
  return (
    <span className="lp-badge lp-fx" title={title} draggable={ids.length > 0} onDragStart={(e) => startFxDrag(e, owner, ids)} onDragEnd={endDrag}>
      fx
    </span>
  );
}

function Eye({ on, title, onToggle }: { on: boolean; title: string; onToggle: (alt: boolean) => void }) {
  return (
    <button
      className={`lp-eye ${on ? 'on' : ''}`}
      title={title}
      aria-label={title}
      aria-pressed={on}
      onClick={(e) => {
        e.stopPropagation();
        onToggle(e.altKey);
      }}
    >
      {on ? '●' : '○'}
    </button>
  );
}

/** Thumbnail `id` (see thumbs.ts) drawn into a canvas at device pixels, never enlarged; `img` undefined until rendered. */
function useThumbCanvas(id: string) {
  const subscribe = useCallback((cb: () => void) => subscribeThumb(id, cb), [id]);
  const img = useSyncExternalStore(subscribe, () => thumbOf(id));
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c || !img) return;
    c.width = img.width;
    c.height = img.height;
    // Shown at that size, centred in the 24 px box.
    c.style.width = `${img.width / devicePixelRatio}px`;
    c.style.height = `${img.height / devicePixelRatio}px`;
    c.getContext('2d')?.putImageData(img, 0, 0);
  }, [img]);
  return { img, ref };
}

/** A layer's rendered thumbnail (engine.renderThumb, see thumbs.ts); `fallback` shows until there is a picture. */
function ThumbCanvas({ id, fallback }: { id: string; fallback?: ReactNode }) {
  const { img, ref } = useThumbCanvas(id);
  if (!img && fallback) return <span className="lp-thumb lp-thumb-icon">{fallback}</span>;
  return <span className="lp-thumb checker">{img && <canvas ref={ref} />}</span>;
}

/**
 * A mask chip (PS layer-mask thumbnail): the mask over the comp frame in greyscale (white =
 * shown), crossed out in red while disabled. Click selects the mask, ⇧-click shows / hides it,
 * ⌥-click toggles View mask; dragging it onto another chip of the layer reorders the masks.
 */
function MaskChip({ layer, mask, focused, ui }: { layer: Layer; mask: LayerMask; focused: boolean; ui: RowUi }) {
  const t = useT();
  const { img, ref } = useThumbCanvas(maskThumbId(layer.id, mask.id));
  const viewing = useEditor((s) => s.view.viewMask === layer.id);
  const [drop, setDrop] = useState<'before' | 'after' | null>(null);
  const name = formatMsg(maskLabel(layer, mask.id), t);
  const node: NodeRef = { kind: 'mask', layerId: layer.id, maskId: mask.id };
  const kind = mask.kind === 'shape' ? t('Vector mask') : mask.kind === 'gradient' ? t('Gradient mask') : t('Layer mask');
  const sideOf = (e: DragEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return e.clientX - r.left < r.width / 2 ? 'before' : 'after';
  };
  const ownChip = () => {
    const p = drag.current;
    return p?.kind === 'mask' && p.layerId === layer.id && p.maskId !== mask.id ? p : null;
  };
  return (
    <span
      className={['lp-thumb', 'lp-mask', focused && 'focus', !mask.enabled && 'off', viewing && 'viewing', drop && `drop-${drop}`].filter(Boolean).join(' ')}
      role="button"
      aria-pressed={focused}
      aria-label={`${name} · ${kind}`}
      title={t('{name} · {kind}\nClick: select · ⇧-click: disable / enable · ⌥-click: view mask', { name, kind })}
      draggable
      onDragStart={(e) => {
        e.stopPropagation();
        drag.current = { kind: 'mask', layerId: layer.id, maskId: mask.id };
        e.dataTransfer.setData(DRAG_MIME, mask.id);
        e.dataTransfer.effectAllowed = 'move';
      }}
      onDragEnd={endDrag}
      onDragOver={(e) => {
        if (!ownChip()) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'move';
        setDrop(sideOf(e));
      }}
      onDragLeave={() => setDrop(null)}
      onDrop={(e) => {
        setDrop(null);
        const p = ownChip();
        if (!p) return;
        e.preventDefault();
        e.stopPropagation();
        drag.current = null;
        const from = layer.masks.findIndex((m) => m.id === p.maskId);
        const to = layer.masks.indexOf(mask) + (sideOf(e) === 'after' ? 1 : 0);
        useEditor.getState().moveMask(layer.id, p.maskId, from < to ? to - 1 : to);
      }}
      onClick={(e) => {
        e.stopPropagation();
        const st = useEditor.getState();
        if (e.shiftKey) return st.setMaskEnabled(layer.id, mask.id, !mask.enabled);
        st.selectNode(node);
        if (e.altKey) st.setView({ viewMask: viewing ? null : layer.id });
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        useEditor.getState().selectNode(node);
        const anchor = pointAnchor(e);
        ui.openMenu(anchor, maskMenu(t, layer, mask, ui, anchor), name);
      }}
    >
      {img && <canvas ref={ref} />}
    </span>
  );
}

function Thumb({ layer }: { layer: Layer }) {
  if (layer.kind === 'generator') return <ThumbCanvas id={layer.id} fallback={<GeneratorIcon type={layer.generator.type} />} />;
  if (layer.kind === 'adjustment')
    return (
      <span className="lp-thumb lp-thumb-icon">
        <AdjustmentIcon type={layer.adjustment.type} />
      </span>
    );
  if (layer.kind === 'group')
    return (
      <span className="lp-thumb lp-thumb-icon" aria-hidden>
        📁
      </span>
    );
  return <ThumbCanvas id={layer.id} />;
}

function RenameInput({ layer, onDone }: { layer: Layer; onDone: () => void }) {
  const t = useT();
  return (
    <input
      className="lp-rename"
      autoFocus
      aria-label={t('Layer name')}
      title={t('Layer name')}
      defaultValue={layer.name}
      onFocus={(e) => e.currentTarget.select()}
      onClick={(e) => e.stopPropagation()}
      onBlur={(e) => {
        const v = e.target.value.trim();
        onDone();
        if (v && v !== layer.name) useEditor.getState().renameLayer(layer.id, v);
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          e.currentTarget.value = layer.name;
          e.currentTarget.blur();
        }
      }}
    />
  );
}

const KIND_BADGE: Partial<Record<Layer['kind'], string>> = { title2d: '2D', title3d: '3D' };

/** `focusedMask`: id of this layer's mask whose chip is the focused node, else null. */
export function LayerRow({
  row,
  selected,
  focused,
  focusedMask,
  renaming,
  ui,
}: {
  row: Extract<PanelRow, { kind: 'layer' }>;
  selected: boolean;
  focused: boolean;
  focusedMask: string | null;
  renaming: boolean;
  ui: RowUi;
}) {
  const t = useT();
  const { layer, depth, clipped, isBase, dimmed, open } = row;
  const [drop, setDrop] = useState<DropPos | 'fx' | null>(null);
  const [clipEdge, setClipEdge] = useState<'top' | 'bottom' | null>(null);
  const node: NodeRef = { kind: 'layer', layerId: layer.id };
  const title = isTitleLayer(layer) ? layer : null;
  const hasFx = layer.effects.length > 0 || (!!title && Object.values(title.partEffects).some((fx) => fx?.length));
  const fxOwner: EffectOwner = { layerId: layer.id, part: null };

  /** ⌥-click toggles the clip of the layer just above the line nearest the pointer: this one (lower half) or its upper sibling (upper half). */
  const clipTarget = (e: MouseEvent): Layer | null => {
    const r = e.currentTarget.getBoundingClientRect();
    const layers = useEditor.getState().project.layers;
    if (e.clientY - r.top >= r.height / 2) return canClip(layers, layer) ? layer : null;
    const sibs = childrenOf(layers, layer.parentId ?? null);
    return sibs[sibs.findIndex((s) => s.id === layer.id) + 1] ?? null;
  };

  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    const p = drag.current;
    if (p?.kind === 'fx') {
      if (fxOver(e)) setDrop('fx');
      return;
    }
    if (!p && draggingFiles(e.dataTransfer)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      return setDrop(dropPosAt(e.clientY, e.currentTarget.getBoundingClientRect(), layer.kind === 'group'));
    }
    if (p?.kind !== 'layers') return;
    const pos = dropPosAt(e.clientY, e.currentTarget.getBoundingClientRect(), layer.kind === 'group');
    if (!layerDest(useEditor.getState().project.layers, p.ids, layer, pos, !!open, outLevels(e))) return setDrop(null);
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDrop(pos);
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    setDrop(null);
    const p = drag.current;
    if (p?.kind === 'fx') return fxDrop(e, fxOwner);
    if (!p && draggingFiles(e.dataTransfer)) {
      e.preventDefault();
      const pos = dropPosAt(e.clientY, e.currentTarget.getBoundingClientRect(), layer.kind === 'group');
      const dest = layerDest(useEditor.getState().project.layers, [], layer, pos, !!open, outLevels(e)) ?? undefined;
      // Images and SVG become 2D layers here (the canvas drop offers 3D).
      return void importFiles([...e.dataTransfer.files], { dim: '2d', dest });
    }
    if (p?.kind !== 'layers') return;
    e.preventDefault();
    const pos = dropPosAt(e.clientY, e.currentTarget.getBoundingClientRect(), layer.kind === 'group');
    const st = useEditor.getState();
    const dest = layerDest(st.project.layers, p.ids, layer, pos, !!open, outLevels(e));
    // The dragged row may unmount (moved into a closed group) before its dragend.
    drag.current = null;
    if (dest) st.moveLayers(p.ids, dest);
  };

  const classes = [
    'lp-row',
    'lp-layer',
    `k-${layer.kind}`,
    selected && 'sel',
    focused && 'focus',
    dimmed && 'dimmed',
    layer.guide && 'guide',
    clipped && 'clipped',
    drop && `drop-${drop}`,
    clipEdge && `clip-${clipEdge}`,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={classes}
      role="treeitem"
      aria-level={depth + 1}
      aria-selected={selected}
      aria-expanded={open ?? undefined}
      aria-label={layer.name}
      draggable={!renaming}
      onDragStart={(e) => {
        const st = useEditor.getState();
        // PS: dragging an unselected layer selects it; dragging a selected one carries the whole selection.
        if (!st.selectedLayerIds.includes(layer.id)) st.selectNode(node);
        drag.current = { kind: 'layers', ids: useEditor.getState().selectedLayerIds };
        e.dataTransfer.setData(DRAG_MIME, layer.id);
        e.dataTransfer.effectAllowed = 'move';
      }}
      onDragEnd={endDrag}
      onDragOver={onDragOver}
      onDragLeave={() => setDrop(null)}
      onDrop={onDrop}
      onPointerMove={(e) => {
        if (!e.altKey) return setClipEdge(null);
        const r = e.currentTarget.getBoundingClientRect();
        setClipEdge(e.clientY - r.top < r.height / 2 ? 'top' : 'bottom');
      }}
      onPointerLeave={() => setClipEdge(null)}
      onClick={(e) => {
        if (e.altKey) {
          const target = clipTarget(e);
          if (target) useEditor.getState().toggleClip([target.id]);
          return;
        }
        clickNode(node, e);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        const st = useEditor.getState();
        if (!st.selectedLayerIds.includes(layer.id)) st.selectNode(node);
        const anchor = pointAnchor(e);
        ui.openMenu(anchor, layerMenu(t, layer, ui, anchor), layer.name);
      }}
    >
      <Eye
        on={layer.visible}
        title={layer.visible ? t('Visible (click to hide; ⌥-click: solo)') : t('Hidden (click to show; ⌥-click: solo)')}
        onToggle={(alt) => useEditor.getState().setAt({ layerId: layer.id, path: [alt ? 'solo' : 'visible'] }, alt ? !layer.solo : !layer.visible)}
      />
      <Indent depth={depth} clipped={clipped}>
        {clipped && (
          <span className="lp-clip-arrow" title={t('Clipped to the layer below')} aria-label={t('Clipped to the layer below')}>
            ↳
          </span>
        )}
      </Indent>
      <Thumb layer={layer} />
      {layer.masks.map((m) => (
        <MaskChip key={m.id} layer={layer} mask={m} focused={focusedMask === m.id} ui={ui} />
      ))}
      <span className="lp-name-col">
        {renaming ? (
          <RenameInput layer={layer} onDone={ui.endRename} />
        ) : (
          <span
            className={`lp-name ${isBase ? 'base' : ''}`}
            title={t('{name}\nDouble-click to rename', { name: layer.name })}
            onDoubleClick={(e) => {
              e.stopPropagation();
              ui.rename(layer.id);
            }}
          >
            {layer.name}
          </span>
        )}
      </span>
      {KIND_BADGE[layer.kind] && <span className={`lp-badge k-${layer.kind}`}>{KIND_BADGE[layer.kind]}</span>}
      {layer.kind === 'background' && <span className="lp-badge k-background">{t('BG')}</span>}
      {layer.solo && (
        <span className="lp-badge lp-flag" title={t('Solo (show only soloed layers)')}>
          S
        </span>
      )}
      {layer.guide && (
        <span className="lp-badge lp-flag" title={t('Guide layer: visible in the editor, excluded from exports')}>
          G
        </span>
      )}
      {layer.locked && (
        <span className="lp-lock" title={t('Locked')} aria-label={t('Locked')}>
          🔒
        </span>
      )}
      {hasFx && <FxBadge owner={{ layerId: layer.id, part: null }} ids={layer.effects.map((fx) => fx.id)} title={t('Has effects. Drag to move all layer effects to another layer, part or group (⌥: copy)')} />}
      {open === null ? (
        <span className="lp-twirl-space" />
      ) : (
        <button
          className="lp-twirl"
          aria-label={open ? t('Collapse {name}', { name: layer.name }) : t('Expand {name}', { name: layer.name })}
          title={t(
            layer.kind === 'group' ? 'Show / hide the group’s layers (⌥-click: all)' : title ? 'Show / hide style parts and effects (⌥-click: all)' : 'Show / hide effects (⌥-click: all)',
          )}
          onClick={(e) => {
            e.stopPropagation();
            ui.twirl(layer.id, !open, e.altKey);
          }}
        >
          {open ? '▾' : '▸'}
        </button>
      )}
    </div>
  );
}

export function PartRow({ row, focused, ui }: { row: Extract<PanelRow, { kind: 'part' }>; focused: boolean; ui: RowUi }) {
  const t = useT();
  const { layer, part, depth, dimmed } = row;
  const [drop, setDrop] = useState(false);
  const owner: EffectOwner = { layerId: layer.id, part };
  const node: NodeRef = { kind: 'part', layerId: layer.id, part };
  const name = formatMsg(partLabel(layer, part), t);
  const on = partEnabled(layer, part);
  const fx = partEffectsOf(layer, part);
  return (
    <div
      className={['lp-row', 'lp-part', focused && 'focus', (dimmed || !on) && 'dimmed', drop && 'drop-fx'].filter(Boolean).join(' ')}
      role="treeitem"
      aria-level={depth + 1}
      aria-selected={focused}
      aria-label={name}
      onClick={(e) => clickNode(node, e)}
      onContextMenu={(e) => {
        e.preventDefault();
        // As in a file manager: a part of the selection keeps it (Add effect then covers every selected part).
        if (!focused) useEditor.getState().selectNode(node);
        const anchor = pointAnchor(e);
        ui.openMenu(anchor, partMenu(t, layer, part, ui, anchor), name);
      }}
      onDragOver={(e) => fxOver(e) && setDrop(true)}
      onDragLeave={() => setDrop(false)}
      onDrop={(e) => {
        setDrop(false);
        fxDrop(e, owner);
      }}
    >
      {partHasEye(layer, part) ? (
        <Eye on={on} title={on ? t('Part shown (click to hide)') : t('Part hidden (click to show)')} onToggle={() => useEditor.getState().setPartEnabled(layer.id, part, !on)} />
      ) : (
        <span className="lp-eye-space" />
      )}
      <Indent depth={depth} />
      <span className="lp-swatch" style={{ background: partSwatch(layer, part) }} title={t('Colours of {part} (its fill or material)', { part: name })} />
      <PartLinkBadge layer={layer} part={part} />
      <span className="lp-name-col">
        <span className="lp-name">{name}</span>
      </span>
      {fx.length > 0 && <FxBadge owner={owner} ids={fx.map((x) => x.id)} title={t('Part effects. Drag to move them all to another layer, part or group (⌥: copy)')} />}
    </div>
  );
}

export function EffectRow({ row, layer, focused, ui }: { row: Extract<PanelRow, { kind: 'effect' }>; layer: Layer; focused: boolean; ui: RowUi }) {
  const t = useT();
  const { fx, part, depth, dimmed } = row;
  const [drop, setDrop] = useState<'above' | 'below' | null>(null);
  const owner: EffectOwner = { layerId: layer.id, part };
  const node: NodeRef = { kind: 'effect', layerId: layer.id, part, effectId: fx.id };
  const name = effectName(t, fx);
  /** Row half under the pointer. The list shows last-applied on top, so "above" is the higher array index. */
  const posAt = (e: DragEvent<HTMLElement>): 'above' | 'below' => {
    const r = e.currentTarget.getBoundingClientRect();
    return e.clientY - r.top < r.height / 2 ? 'above' : 'below';
  };
  return (
    <div
      className={['lp-row', 'lp-effect', focused && 'focus', dimmed && 'dimmed', drop && `drop-${drop}`].filter(Boolean).join(' ')}
      role="treeitem"
      aria-level={depth + 1}
      aria-selected={focused}
      aria-label={name}
      draggable
      onDragStart={(e) => {
        useEditor.getState().selectNode(node);
        startFxDrag(e, owner, [fx.id]);
      }}
      onDragEnd={endDrag}
      onDragOver={(e) => fxOver(e) && setDrop(posAt(e))}
      onDragLeave={() => setDrop(null)}
      onDrop={(e) => {
        setDrop(null);
        const i = effectsOf(useEditor.getState().project, owner).findIndex((x) => x.id === fx.id);
        fxDrop(e, owner, posAt(e) === 'above' ? i + 1 : i);
      }}
      onClick={(e) => clickNode(node, e)}
      onContextMenu={(e) => {
        e.preventDefault();
        useEditor.getState().selectNode(node);
        const anchor = pointAnchor(e);
        ui.openMenu(anchor, effectMenu(t, layer, owner, fx, ui, anchor), name);
      }}
    >
      <Eye on={fx.enabled} title={fx.enabled ? t('Effect on (click to turn off)') : t('Effect off (click to turn on)')} onToggle={() => useEditor.getState().setEffectEnabled(owner, fx.id, !fx.enabled)} />
      <Indent depth={depth} />
      <span className="lp-fx-icon" aria-hidden>
        ƒ
      </span>
      <span className="lp-name-col">
        <span className="lp-name">{name}</span>
      </span>
    </div>
  );
}

/** A 3D title's glint, pinned first under its Effects: its eye switches it on / off; no drag (it runs inside the 3D render, before every effect). */
export function GlintRow({ row, focused, ui }: { row: Extract<PanelRow, { kind: 'glint' }>; focused: boolean; ui: RowUi }) {
  const t = useT();
  const { layer, depth, dimmed } = row;
  const on = layer.style3d.glint.enabled;
  const node: NodeRef = { kind: 'glint', layerId: layer.id };
  const name = t('Glint');
  return (
    <div
      className={['lp-row', 'lp-effect', 'lp-glint', focused && 'focus', dimmed && 'dimmed'].filter(Boolean).join(' ')}
      role="treeitem"
      aria-level={depth + 1}
      aria-selected={focused}
      aria-label={name}
      title={t(GLINT_PINNED)}
      onClick={(e) => clickNode(node, e)}
      onContextMenu={(e) => {
        e.preventDefault();
        useEditor.getState().selectNode(node);
        const anchor = pointAnchor(e);
        ui.openMenu(anchor, glintMenu(t, layer, ui, anchor), name);
      }}
    >
      <Eye on={on} title={on ? t('Effect on (click to turn off)') : t('Effect off (click to turn on)')} onToggle={() => setGlintEnabled([layer.id], !on)} />
      <Indent depth={depth} />
      <span className="lp-fx-icon" aria-hidden>
        ✦
      </span>
      <span className="lp-name-col">
        <span className="lp-name">{name}</span>
      </span>
    </div>
  );
}

export function HeadRow({ row }: { row: Extract<PanelRow, { kind: 'head' }> }) {
  const t = useT();
  return (
    <div className={`lp-row lp-head ${row.dimmed ? 'dimmed' : ''}`} role="presentation">
      <span className="lp-eye-space" />
      <Indent depth={row.depth} />
      {row.label === 'Style' ? t('Style') : t('Effects', undefined, { ctx: 'layers' })}
    </div>
  );
}

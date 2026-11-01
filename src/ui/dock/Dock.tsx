import { useRef, type ComponentType, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { useT } from '../i18n';
import { HistoryPanel } from '../layers/HistoryPanel';
import { LayersPanel } from '../layers/LayersPanel';
import { LibraryPanel } from '../library/LibraryPanel';
import { PropertiesPanel } from '../properties/PropertiesPanel';
import { DockGroup } from './DockGroup';
import {
  clampLayersW,
  clampSplit,
  clampW,
  GROUPS,
  LAYERS_W_DEFAULT,
  LAYERS_W_MAX,
  LAYERS_W_MIN,
  selectTab,
  SPLIT_DEFAULT,
  SPLIT_MAX,
  SPLIT_MIN,
  SPLIT_STEP,
  useDock,
  useDockColumns,
  W_DEFAULT,
  W_MAX,
  W_MIN,
  W_STEP,
  type DockTabId,
  type GroupId,
} from './layout';
import './dock.css';

// The right dock (Photoshop's panel dock): two tab groups, [Properties | Library] and
// [Layers | History]. In a window at least COLUMNS_MIN_WINDOW wide they are two columns, Layers
// beside a full-height Properties, each with a resize handle on its left edge; narrower windows
// stack them with a splitter between. Widths, split, active tabs and collapse state are view
// settings remembered in localStorage, never in the project.

const PANELS: Record<DockTabId, ComponentType> = {
  properties: PropertiesPanel,
  library: LibraryPanel,
  layers: LayersPanel,
  history: HistoryPanel,
};

/**
 * Pointer drag on a resize handle: `onMove` gets the pointer's offset from the press, in CSS px.
 * The handle captures the pointer, so the drag survives leaving it.
 */
function dragFrom(e: ReactPointerEvent<HTMLElement>, onMove: (dx: number, dy: number) => void) {
  if (e.button !== 0) return;
  e.preventDefault();
  const el = e.currentTarget;
  el.setPointerCapture(e.pointerId);
  const x0 = e.clientX;
  const y0 = e.clientY;
  const move = (ev: PointerEvent) => onMove(ev.clientX - x0, ev.clientY - y0);
  const up = () => {
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up);
    el.removeEventListener('pointercancel', up);
  };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
}

/** Separator keys: `dir` -1 / +1 per arrow (Home / End: the limits). Handled keys don't reach the global shortcuts. */
function separatorKeys(e: KeyboardEvent, less: string, more: string, step: (dir: -1 | 1) => void, limit: (end: 'min' | 'max') => void, reset: () => void) {
  if (e.key === less) step(-1);
  else if (e.key === more) step(1);
  else if (e.key === 'Home') limit('min');
  else if (e.key === 'End') limit('max');
  else if (e.key === 'Enter') reset();
  else return;
  e.preventDefault();
  e.stopPropagation();
}

/**
 * Resize handle on a column's left edge: dragging left widens the column; ←/→ step, Home/End go
 * to the limits, Enter or a double-click restores the default.
 */
function WidthHandle({ label, title, value, min, max, def, set }: { label: string; title: string; value: number; min: number; max: number; def: number; set: (w: number) => void }) {
  return (
    <div
      className="dock-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      tabIndex={0}
      title={title}
      onDoubleClick={() => set(def)}
      onKeyDown={(e) =>
        separatorKeys(
          e,
          'ArrowRight',
          'ArrowLeft',
          (dir) => set(value + dir * W_STEP),
          (end) => set(end === 'min' ? min : max),
          () => set(def),
        )
      }
      onPointerDown={(e) => {
        const w0 = value;
        dragFrom(e, (dx) => set(w0 - dx));
      }}
    />
  );
}

export function Dock() {
  const { width, layersWidth, split, active, collapsed } = useDock();
  const columns = useDockColumns();
  const groupsRef = useRef<HTMLDivElement>(null);
  const t = useT();
  const bothOpen = !collapsed.top && !collapsed.bottom;
  const setWidth = (w: number) => useDock.setState({ width: clampW(w) });
  const setLayersWidth = (w: number) => useDock.setState({ layersWidth: clampLayersW(w) });
  const setSplit = (s: number) => useDock.setState({ split: clampSplit(s) });
  const group = (g: GroupId, style?: CSSProperties) => {
    const Panel = PANELS[active[g]];
    return (
      <DockGroup
        label={t(GROUPS[g].label)}
        tabs={GROUPS[g].tabs}
        active={active[g]}
        collapsed={collapsed[g]}
        style={style}
        onSelect={selectTab}
        onToggleCollapsed={() => useDock.setState((s) => ({ collapsed: { ...s.collapsed, [g]: !s.collapsed[g] } }))}
      >
        <Panel />
      </DockGroup>
    );
  };
  if (columns)
    // Layers | History beside a full-height Properties | Library, each column resized from its left
    // edge; a collapsed column keeps its tabs as a thin vertical strip.
    return (
      <aside className="dock columns" aria-label={t('Panels')}>
        <div className="dock-col" style={collapsed.bottom ? undefined : { width: layersWidth }}>
          {group('bottom')}
          {!collapsed.bottom && (
            <WidthHandle
              label={t('Resize the Layers column')}
              title={t('Drag to resize the Layers column (double-click: default width)')}
              value={layersWidth}
              min={LAYERS_W_MIN}
              max={LAYERS_W_MAX}
              def={LAYERS_W_DEFAULT}
              set={setLayersWidth}
            />
          )}
        </div>
        <div className="dock-col" style={collapsed.top ? undefined : { width }}>
          {group('top')}
          {!collapsed.top && (
            <WidthHandle
              label={t('Resize the Properties column')}
              title={t('Drag to resize the Properties column (double-click: default width)')}
              value={width}
              min={W_MIN}
              max={W_MAX}
              def={W_DEFAULT}
              set={setWidth}
            />
          )}
        </div>
      </aside>
    );
  return (
    <aside className="dock" style={{ width }} aria-label={t('Panels')}>
      <div className="dock-groups" ref={groupsRef}>
        {/* Open groups share the height by `split`; a collapsed one keeps just its tab strip. */}
        {group('top', collapsed.top ? undefined : { flex: bothOpen ? `${split} 1 0` : '1 1 0' })}
        {bothOpen && (
          <div
            className="dock-split"
            role="separator"
            aria-orientation="horizontal"
            aria-label={t('Resize the Properties / Layers groups')}
            aria-valuemin={SPLIT_MIN * 100}
            aria-valuemax={SPLIT_MAX * 100}
            aria-valuenow={Math.round(split * 100)}
            tabIndex={0}
            title={t('Drag to share the height between the groups (double-click: half and half)')}
            onDoubleClick={() => setSplit(SPLIT_DEFAULT)}
            onKeyDown={(e) =>
              separatorKeys(
                e,
                'ArrowUp',
                'ArrowDown',
                (dir) => setSplit(split + dir * SPLIT_STEP),
                (end) => setSplit(end === 'min' ? SPLIT_MIN : SPLIT_MAX),
                () => setSplit(SPLIT_DEFAULT),
              )
            }
            onPointerDown={(e) => {
              const h = groupsRef.current?.getBoundingClientRect().height ?? 0;
              if (h <= 0) return;
              const s0 = split;
              dragFrom(e, (_dx, dy) => setSplit(s0 + dy / h));
            }}
          />
        )}
        {group('bottom', collapsed.bottom ? undefined : { flex: bothOpen ? `${1 - split} 1 0` : '1 1 0' })}
      </div>
      <WidthHandle
        label={t('Resize the panel dock')}
        title={t('Drag to resize the panel dock (double-click: default width)')}
        value={width}
        min={W_MIN}
        max={W_MAX}
        def={W_DEFAULT}
        set={setWidth}
      />
    </aside>
  );
}

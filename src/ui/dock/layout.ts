import { useSyncExternalStore } from 'react';
import { create } from 'zustand';
import type { DockTab } from './DockGroup';

// Dock layout state: widths, split, active tabs and collapse state are view settings remembered
// in localStorage, never in the project.

export type DockTabId = 'properties' | 'library' | 'layers' | 'history';
export type GroupId = 'top' | 'bottom';

export const GROUPS: Record<GroupId, { label: string; tabs: readonly DockTab<DockTabId>[] }> = {
  top: {
    label: 'Properties and Library',
    tabs: [
      { id: 'properties', label: 'Properties', title: 'Properties of the selected layer, part or effect (the document when nothing is selected)' },
      { id: 'library', label: 'Library', title: 'Library: styles, looks and templates' },
    ],
  },
  bottom: {
    label: 'Layers and History',
    tabs: [
      { id: 'layers', label: 'Layers', title: 'Layers: the stack with each layer’s parts and effects' },
      { id: 'history', label: 'History', title: 'History: jump to any earlier or undone step' },
    ],
  },
};

interface DockLayout {
  /** Width of the Properties / Library group (the whole dock when stacked), CSS px. */
  width: number;
  /** Width of the Layers / History column beside it (two-column dock), CSS px. */
  layersWidth: number;
  /** Share (0..1) of the dock's height the top group gets while both groups are open and stacked. */
  split: number;
  active: Record<GroupId, DockTabId>;
  collapsed: Record<GroupId, boolean>;
}

/** localStorage key of the layout; v7 is the two-column dock, so a v6 layout keeps only its tabs and width. */
const STORAGE_KEY = 'pslot.dock.v7';
/** The v6 stacked dock's layout. */
const V6_KEY = 'pslot.dock.v6';
/** The v5 Layers / Library column width, superseded by the dock. */
const LEGACY_LEFT_W_KEY = 'pslot.leftPanelWidth';

/** From this window width up the groups sit side by side (Photoshop's two-column dock); narrower windows stack them. */
export const COLUMNS_MIN_WINDOW = 1280;

export const W_DEFAULT = 340;
/** The Library lays out in no less (LibraryPanel). */
export const W_MIN = 260;
export const W_MAX = 720;
export const LAYERS_W_DEFAULT = 248;
/** The Layers header (blend, opacity) and rows stay usable down to this. */
export const LAYERS_W_MIN = 200;
export const LAYERS_W_MAX = 480;
export const SPLIT_DEFAULT = 0.5;
export const SPLIT_MIN = 0.15;
export const SPLIT_MAX = 0.85;
/** Keyboard resize steps: CSS px for the widths, share of the height for the splitter. */
export const W_STEP = 16;
export const SPLIT_STEP = 0.05;

const DEFAULT_LAYOUT: DockLayout = {
  width: W_DEFAULT,
  layersWidth: LAYERS_W_DEFAULT,
  split: SPLIT_DEFAULT,
  active: { top: 'properties', bottom: 'layers' },
  collapsed: { top: false, bottom: false },
};

export const clampW = (w: number) => Math.round(Math.max(W_MIN, Math.min(W_MAX, w)));
export const clampLayersW = (w: number) => Math.round(Math.max(LAYERS_W_MIN, Math.min(LAYERS_W_MAX, w)));
export const clampSplit = (s: number) => Math.max(SPLIT_MIN, Math.min(SPLIT_MAX, s));

function readJson(key: string): Partial<Record<keyof DockLayout, unknown>> | null {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(key) ?? 'null');
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

/**
 * The stored layout, each field checked (a bad or missing field falls back to its default). A v6
 * layout migrates once: its width and active tabs carry over, the rest takes the new default.
 */
function loadLayout(): DockLayout {
  localStorage.removeItem(LEGACY_LEFT_W_KEY);
  const v6 = readJson(V6_KEY);
  localStorage.removeItem(V6_KEY);
  const r = readJson(STORAGE_KEY) ?? (v6 && { width: v6.width, active: v6.active });
  if (!r) return DEFAULT_LAYOUT;
  const rec = (v: unknown) => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
  const num = (v: unknown, clamp: (n: number) => number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? clamp(v) : d);
  const tab = (g: GroupId) => {
    const v = rec(r.active)[g];
    return GROUPS[g].tabs.find((x) => x.id === v)?.id ?? DEFAULT_LAYOUT.active[g];
  };
  const flag = (g: GroupId) => rec(r.collapsed)[g] === true;
  return {
    width: num(r.width, clampW, W_DEFAULT),
    layersWidth: num(r.layersWidth, clampLayersW, LAYERS_W_DEFAULT),
    split: num(r.split, clampSplit, SPLIT_DEFAULT),
    active: { top: tab('top'), bottom: tab('bottom') },
    collapsed: { top: flag('top'), bottom: flag('bottom') },
  };
}

export const useDock = create<DockLayout>(() => loadLayout());
useDock.subscribe((s) => localStorage.setItem(STORAGE_KEY, JSON.stringify(s)));

const columnsQuery = `(min-width: ${COLUMNS_MIN_WINDOW}px)`;

/** Whether the window is wide enough for the two-column dock (follows window resizes). */
export function useDockColumns(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mq = matchMedia(columnsQuery);
      mq.addEventListener('change', cb);
      return () => mq.removeEventListener('change', cb);
    },
    () => matchMedia(columnsQuery).matches,
  );
}

/** Activate tab `id` and expand its group. */
export function selectTab(id: DockTabId) {
  const g: GroupId = GROUPS.top.tabs.some((tab) => tab.id === id) ? 'top' : 'bottom';
  useDock.setState((s) => ({ active: { ...s.active, [g]: id }, collapsed: { ...s.collapsed, [g]: false } }));
}

/** Show dock tab `id` (expanding its group) and move keyboard focus into its panel. */
export function focusDockTab(id: DockTabId) {
  selectTab(id);
  // The panel mounts on the next commit.
  requestAnimationFrame(() => document.getElementById(`dock-panel-${id}`)?.focus());
}

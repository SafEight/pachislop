import { create } from 'zustand';
import { COLOURWAYS, type Colourway } from '../../presets/types';

// Library view settings remembered in localStorage, never in the project: the tile size, the
// folded sections and the looks / colourways applied last.

export type TileSize = 's' | 'm' | 'l';
const TILE_SIZES: readonly TileSize[] = ['s', 'm', 'l'];

/** A recently applied look (its preset id: factory or My Styles) or colourway. */
export type RecentItem = { type: 'look'; id: string } | { type: 'colourway'; id: Colourway };

interface LibraryPrefs {
  size: TileSize;
  /** Folded sections, by group name. */
  collapsed: Record<string, boolean>;
  /** Most recent first, distinct, at most RECENT_MAX. */
  recent: RecentItem[];
}

const STORAGE_KEY = 'pachislot-visuals.library';
const RECENT_MAX = 8;

const isRecent = (v: unknown): v is RecentItem => {
  if (!v || typeof v !== 'object') return false;
  const { type, id } = v as Record<string, unknown>;
  return (type === 'look' && typeof id === 'string') || (type === 'colourway' && COLOURWAYS.includes(id as Colourway));
};

/** The stored settings, each field checked (a bad or missing field falls back to its default). */
function load(): LibraryPrefs {
  let r: Record<string, unknown> = {};
  try {
    const v: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (v && typeof v === 'object') r = v as Record<string, unknown>;
  } catch {
    // Unreadable: the defaults.
  }
  const collapsed = r.collapsed && typeof r.collapsed === 'object' ? Object.entries(r.collapsed).filter(([, v]) => v === true) : [];
  return {
    size: TILE_SIZES.find((s) => s === r.size) ?? 'm',
    collapsed: Object.fromEntries(collapsed),
    recent: Array.isArray(r.recent) ? r.recent.filter(isRecent).slice(0, RECENT_MAX) : [],
  };
}

export const useLibraryPrefs = create<LibraryPrefs>(() => load());
useLibraryPrefs.subscribe((s) => localStorage.setItem(STORAGE_KEY, JSON.stringify(s)));

/** Puts `item` first in Recent (once). */
export function addRecent(item: RecentItem) {
  useLibraryPrefs.setState((s) => ({ recent: [item, ...s.recent.filter((r) => r.type !== item.type || r.id !== item.id)].slice(0, RECENT_MAX) }));
}

export function setCollapsed(group: string, collapsed: boolean) {
  useLibraryPrefs.setState((s) => ({ collapsed: { ...s.collapsed, [group]: collapsed } }));
}

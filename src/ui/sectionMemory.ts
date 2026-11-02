import { createContext, useCallback, useContext } from 'react';
import { create } from 'zustand';

// Remembered open state of every collapsible Section (controls.tsx), per node kind and section
// id, in localStorage.

/** localStorage key of the remembered section states (`scope/id` → open); v2 keys them per node kind. */
const SECTIONS_KEY = 'pachislot-visuals.sections.v2';
/** v1 remembered one state per id for every kind of node; superseded by v2. */
const LEGACY_SECTIONS_KEY = 'pachislot-visuals.sections';

function loadSections(): Record<string, boolean> {
  localStorage.removeItem(LEGACY_SECTIONS_KEY);
  try {
    const v: unknown = JSON.parse(localStorage.getItem(SECTIONS_KEY) ?? '{}');
    return v && typeof v === 'object' ? (v as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

/** Open state per `scope/id`; a missing key means the section's default. */
export const useSectionsOpen = create<Record<string, boolean>>(() => loadSections());
useSectionsOpen.subscribe((s) => localStorage.setItem(SECTIONS_KEY, JSON.stringify(s)));

/**
 * The kind of node the sections below belong to (Properties: `title2d`, `part:title3d:band`,
 * `effect:dropShadow`…). A section's open state is remembered per scope and id, so closing a
 * band's Side wall section closes it on every band but not on a rim.
 */
export const SectionScope = createContext('panel');

/**
 * True inside the hidden render that builds the Properties search index (PropertySearch): every
 * Section is open there, and views that only show something for a picked letter or in a list of
 * cards (effects, indexed on their own) render what the index needs instead.
 */
export const FindProbe = createContext(false);

/** Opens the section with `id` in the current SectionScope from code (e.g. when a tool needs it), and remembers that. */
export function useOpenSection(): (id: string) => void {
  const scope = useContext(SectionScope);
  return useCallback((id: string) => useSectionsOpen.setState({ [`${scope}/${id}`]: true }), [scope]);
}

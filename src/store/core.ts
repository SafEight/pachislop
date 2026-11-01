import type { StoreApi } from 'zustand';
import type { PartKey } from '../model/types';
import type { EditorState } from './store';

/**
 * What the store's slices share (see createEditorStore): the zustand accessors and the store's
 * private mutable state, kept out of EditorState so changing it notifies no subscriber.
 */
export interface Core {
  set: StoreApi<EditorState>['setState'];
  get: StoreApi<EditorState>['getState'];
  /** Last layer clicked plainly or with ⌘ in the Layers panel: where a ⇧-click range starts. */
  anchor: string | null;
  /** Last part row clicked plainly or with ⌘ (its layer and part): where a ⇧-click part range starts. */
  partAnchor: { layerId: string; part: PartKey } | null;
  /** The rename offer was accepted or dismissed for the current project. */
  renameSettled: boolean;
  /** Auto-named text layers whose text was cleared: they follow the text again once it is retyped (see setText). */
  namePending: Set<string>;
  /** setEachAt: the targets' values when gesture `key` began on targets `targets` (refKey), so every step of a scrub starts from them. */
  gestureBase: { key: string; targets: string; values: unknown[] } | null;
}

/** A slice creator: the EditorState actions `K`, built on the shared core. */
export type Slice<K extends keyof EditorState> = (core: Core) => Pick<EditorState, K>;

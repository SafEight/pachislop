import { sameValue } from '../model/equal';
import type { Project } from '../model/types';
import type { PropRef, Refs } from './store';

// Structural-sharing path updates: only objects along the path are copied, so unchanged
// subtrees keep their identity (renderers cache by reference).

export type Path = readonly (string | number)[];

export function getIn(obj: unknown, path: Path): unknown {
  let cur = obj;
  for (const k of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string | number, unknown>)[k];
  }
  return cur;
}

export function updateIn<T>(obj: T, path: Path, fn: (v: unknown) => unknown): T {
  if (path.length === 0) return fn(obj) as T;
  const [k, ...rest] = path;
  const src = obj as unknown as Record<string | number, unknown>;
  const next = updateIn(src[k], rest, fn);
  if (next === src[k]) return obj;
  if (Array.isArray(obj)) {
    const copy = obj.slice();
    copy[k as number] = next;
    return copy as T;
  }
  return { ...(obj as object), [k]: next } as T;
}

export const pathKey = (path: Path) => path.join('.');

export function absPath(project: Project, ref: PropRef): Path | null {
  if (ref.layerId === null) return ref.path;
  const i = project.layers.findIndex((l) => l.id === ref.layerId);
  return i < 0 ? null : ['layers', i, ...ref.path];
}

/** What getRef returns for several targets whose values differ (shown as “—”). */
export const MIXED: unique symbol = Symbol('mixed');
export type Mixed = typeof MIXED;

const isList = (r: Refs): r is readonly PropRef[] => Array.isArray(r);

/** The targets of `r`, as a list. */
export const refList = (r: Refs): readonly PropRef[] => (isList(r) ? r : [r]);

/** Whether `r` names more than one target. */
export const isMultiRef = (r: Refs): boolean => isList(r) && r.length > 1;

/**
 * The value at `ref`. Over several targets: their value when they all hold an equal one (the
 * first target's object, so selectors stay stable), else MIXED; undefined for none.
 */
export function getRef(project: Project, ref: Refs): unknown {
  if (!isList(ref)) {
    const p = absPath(project, ref);
    return p ? getIn(project, p) : undefined;
  }
  if (ref.length === 0) return undefined;
  const first = getRef(project, ref[0]);
  for (let i = 1; i < ref.length; i++) if (!sameValue(first, getRef(project, ref[i]))) return MIXED;
  return first;
}

/** The value at every target of `ref`, in order. */
export const getRefs = (project: Project, ref: Refs): unknown[] => refList(ref).map((r) => getRef(project, r));

/** Stable key of a target (or a list of targets): gesture ids, React keys. */
export const refKey = (ref: Refs): string => (isList(ref) ? ref.map(refKey).join('|') : `${ref.layerId ?? '#'}:${pathKey(ref.path)}`);

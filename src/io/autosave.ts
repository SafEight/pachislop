import { compensateV4CharScale } from './migrateText';
import { charScaleNote, collectBundle, installBundle, migrateProject, upgradeNote, type Bundle, type ProjectVersion } from './project';
import type { Project } from '../model/types';
import { errorMsg, msg, type Msg } from '../store/msg';

// Autosave: the project plus its referenced fonts/assets as a structured-clone record in
// IndexedDB (ArrayBuffers stored natively, no base64). Builtin fonts are stored by id only and
// lazy-load when first rendered. When there is no v10 autosave ('current-v10'), a v9, v8, v7, v6, v5 or v4 one
// ('current-v9', 'current-v8', 'current-v7', 'current-v6', 'current-v5', 'current-v4', newest first) is upgraded through `migrateProject` (a v4 one
// then through `compensateV4CharScale`); autosaves of v1–v3 ('current', 'current-v2',
// 'current-v3') can't be restored, so loading reports and deletes them.

const DB = 'pachislot-visuals';
const STORE = 'autosave';
const KEY = 'current-v10';
/** Autosaves of earlier versions that are upgraded, newest first, with the version they hold. */
const UPGRADED_KEYS = [
  { key: 'current-v9', version: 9 },
  { key: 'current-v8', version: 8 },
  { key: 'current-v7', version: 7 },
  { key: 'current-v6', version: 6 },
  { key: 'current-v5', version: 5 },
  { key: 'current-v4', version: 4 },
] as const;
const OLDER_KEYS = ['current', 'current-v2', 'current-v3'];

type Stored = Omit<Bundle, 'notes' | 'version'> & { savedAt: number };

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

export async function saveAutosave(project: Project): Promise<void> {
  const bundle: Stored = { ...collectBundle(project), savedAt: Date.now() };
  await tx('readwrite', (s) => s.put(bundle, KEY));
}

export type AutosaveRestore =
  /** `notes`: e.g. the autosave was a v5 project and has been upgraded. */
  | { kind: 'restored'; project: Project; errors: Msg[]; notes: Msg[] }
  /** An autosave from an older app version was found and discarded; `version` as recorded (or '?'). */
  | { kind: 'discarded'; version: string }
  | { kind: 'none' };

const versionOf = (b: unknown) => String((b as { project?: { version?: unknown } } | undefined)?.project?.version ?? '?');

/** Restores fonts/assets and returns the autosaved project (an older one upgraded); v1–v3 autosaves are deleted. */
export async function loadAutosave(): Promise<AutosaveRestore> {
  let older: string | null = null;
  for (const key of OLDER_KEYS) {
    const old: unknown = await tx('readonly', (s) => s.get(key));
    if (old === undefined) continue;
    older = versionOf(old);
    await tx('readwrite', (s) => s.delete(key));
  }
  let found: { key: string; version: ProjectVersion; b: Stored } | null = null;
  for (const { key, version } of [{ key: KEY, version: 10 } as const, ...UPGRADED_KEYS]) {
    const b = (await tx('readonly', (s) => s.get(key))) as Stored | undefined;
    if (!b) continue;
    if (!found) found = { key, version, b };
    // An earlier version's record stays until a newer autosave replaces it (deleted on the next load).
    else await tx('readwrite', (s) => s.delete(key));
  }
  if (!found) return older === null ? { kind: 'none' } : { kind: 'discarded', version: older };
  const { key, version, b } = found;
  let project: Project;
  try {
    project = migrateProject(b.project);
  } catch {
    await tx('readwrite', (s) => s.delete(key));
    return { kind: 'discarded', version: versionOf(b) };
  }
  // Fonts first: the v4 char-scale compensation measures with them.
  const errors = await installBundle(b);
  const compensated = await compensateV4CharScale(project, version === 4);
  const notes = version === 10 ? [] : [upgradeNote('The autosaved project', version), ...(compensated !== project ? [charScaleNote] : [])];
  return { kind: 'restored', project: compensated, errors, notes };
}

export async function clearAutosave(): Promise<void> {
  await tx('readwrite', (s) => s.delete(KEY));
}

/** Debounced autosave whenever `subscribe` reports a new project. Returns unsubscribe. */
export function startAutosave(
  subscribe: (cb: (p: Project) => void) => () => void,
  onError: (message: Msg) => void,
  delayMs = 800,
): () => void {
  let timer: number | undefined;
  let latest: Project | null = null;
  const flush = () => {
    timer = undefined;
    if (!latest) return;
    const p = latest;
    latest = null;
    saveAutosave(p).catch((e: unknown) => onError(msg('Autosave failed: {error}', { error: errorMsg(e) })));
  };
  const unsub = subscribe((p) => {
    latest = p;
    clearTimeout(timer);
    timer = window.setTimeout(flush, delayMs);
  });
  const onHide = () => flush();
  window.addEventListener('pagehide', onHide);
  return () => {
    unsub();
    window.removeEventListener('pagehide', onHide);
    clearTimeout(timer);
  };
}

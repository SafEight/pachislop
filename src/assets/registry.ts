import opentype from 'opentype.js';

// Binary assets (fonts, images, SVG, GLB, HDR) live here rather than in the Project JSON so
// the store stays light. Layers reference them by id. Project files embed them (see io).

export interface FontEntry {
  id: string; // also used as the CSS font-family name for Canvas2D
  name: string; // display name
  data: ArrayBuffer;
  font: opentype.Font; // parsed, for 3D glyph outlines
  builtin: boolean;
}

export interface AssetEntry {
  id: string;
  name: string;
  mime: string; // 'image/png', 'image/svg+xml', 'model/gltf-binary', 'image/vnd.radiance', ...
  data: ArrayBuffer;
}

const fonts = new Map<string, FontEntry>();
const assets = new Map<string, AssetEntry>();
const listeners = new Set<() => void>();
let version = 0;

const emit = () => {
  version++;
  listeners.forEach((l) => l());
};

/** For useSyncExternalStore: re-render UI when fonts/assets change. */
export const registry = {
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  getVersion: () => version,
};

export const DEFAULT_FONT_ID = 'dela-gothic-one';

export type FontCategory = 'gothic' | 'mincho' | 'brush' | 'pop' | 'display' | 'user';

/**
 * Bundled SIL OFL fonts in public/fonts, loaded on first use. `latinOnly` fonts have no kana or
 * kanji (おまかせ leaves them out: a random Latin face would turn 確定 into missing-glyph boxes).
 */
export const BUILTIN_FONTS: { id: string; name: string; file: string; category: FontCategory; latinOnly?: true }[] = [
  { id: 'dela-gothic-one', name: 'Dela Gothic One', file: 'DelaGothicOne-Regular.ttf', category: 'gothic' },
  { id: 'mplus1p-black', name: 'M PLUS 1p Black', file: 'MPLUS1p-Black.ttf', category: 'gothic' },
  { id: 'zen-kaku-gothic-black', name: 'Zen Kaku Gothic New Black', file: 'ZenKakuGothicNew-Black.ttf', category: 'gothic' },
  { id: 'zen-old-mincho-black', name: 'Zen Old Mincho Black', file: 'ZenOldMincho-Black.ttf', category: 'mincho' },
  { id: 'yuji-syuku', name: 'Yuji Syuku (brush)', file: 'YujiSyuku-Regular.ttf', category: 'brush' },
  { id: 'reggae-one', name: 'Reggae One', file: 'ReggaeOne-Regular.ttf', category: 'display' },
  { id: 'rocknroll-one', name: 'RocknRoll One', file: 'RocknRollOne-Regular.ttf', category: 'display' },
  { id: 'rampart-one', name: 'Rampart One', file: 'RampartOne-Regular.ttf', category: 'display' },
  { id: 'train-one', name: 'Train One', file: 'TrainOne-Regular.ttf', category: 'display' },
  // Static instance of the variable Playfair 2 Italic (wght 900, opsz 5, Latin subset, upright '+'); see THIRD_PARTY_NOTICES.md.
  { id: 'playfair-black-italic', name: 'Playfair Black Italic', file: 'Playfair-BlackItalic.ttf', category: 'display', latinOnly: true },
  { id: 'potta-one', name: 'Potta One', file: 'PottaOne-Regular.ttf', category: 'pop' },
  { id: 'mochiy-pop-one', name: 'Mochiy Pop One', file: 'MochiyPopOne-Regular.ttf', category: 'pop' },
];

export async function registerFont(
  id: string,
  name: string,
  data: ArrayBuffer,
  builtin = false,
): Promise<FontEntry> {
  const existing = fonts.get(id);
  if (existing) return existing;
  const font = opentype.parse(data.slice(0));
  // CSS registration is only for UI previews (font picker); rendering uses the outlines.
  const face = new FontFace(id, data.slice(0));
  await face.load();
  document.fonts.add(face);
  const entry: FontEntry = { id, name, data, font, builtin };
  fonts.set(id, entry);
  emit();
  return entry;
}

const pending = new Map<string, Promise<FontEntry | undefined>>();

/** Load a font by id (builtin fonts are fetched on demand). Resolves undefined for unknown ids. */
export function ensureFont(id: string): Promise<FontEntry | undefined> {
  const have = fonts.get(id);
  if (have) return Promise.resolve(have);
  let p = pending.get(id);
  if (!p) {
    const b = BUILTIN_FONTS.find((f) => f.id === id);
    p = b
      ? fetch(`${import.meta.env.BASE_URL}fonts/${b.file}`)
          .then((r) => r.arrayBuffer())
          .then((data) => registerFont(b.id, b.name, data, true))
      : Promise.resolve(undefined);
    pending.set(id, p);
  }
  return p;
}

/**
 * Loaded font or undefined. When undefined and the id is a builtin, loading starts and the
 * registry emits when done — renderers draw nothing for that layer until then.
 */
export function getFont(id: string): FontEntry | undefined {
  const f = fonts.get(id);
  if (!f) void ensureFont(id);
  return f;
}

export const listFonts = () => [...fonts.values()];

export async function loadBuiltinFonts(): Promise<void> {
  await ensureFont(DEFAULT_FONT_ID);
}

export function addAsset(entry: Omit<AssetEntry, 'id'> & { id?: string }): AssetEntry {
  const full: AssetEntry = { ...entry, id: entry.id ?? crypto.randomUUID() };
  assets.set(full.id, full);
  emit();
  return full;
}

export const getAsset = (id: string) => assets.get(id);
export const listAssets = () => [...assets.values()];

export function removeAsset(id: string) {
  assets.delete(id);
  emit();
}

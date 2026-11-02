import { parsePartKey, type TitleLayer } from '../../model/parts';
import type { PartKey } from '../../model/types';

// Display helpers for title style parts (Layers panel rows, Properties, canvas labels); the
// part's name is `partLabel` in store/labels.ts.

/** True where the part can be switched off (store.setPartEnabled): rims, bands and the 2D face. */
export function partHasEye(l: TitleLayer, key: PartKey): boolean {
  const { kind } = parsePartKey(key);
  return kind === 'rim' || kind === 'band' || (kind === 'face' && l.kind === 'title2d');
}

/** Whether the part draws: rim / band `enabled`, the 2D face unless `hideFace`; always for the rest. */
export function partEnabled(l: TitleLayer, key: PartKey): boolean {
  const { kind, id } = parsePartKey(key);
  if (l.kind === 'title2d') {
    if (kind === 'face') return !l.style.hideFace;
    return l.style.rims.find((r) => r.id === id)?.enabled ?? false;
  }
  if (kind === 'band') return l.style3d.bands.find((b) => b.id === id)?.enabled ?? false;
  return true;
}

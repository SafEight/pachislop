import { sameValue } from './equal';
import { withoutLink } from './links';
import type { Backplate3D, CharAdjust, Material3D, Title3DProps } from './types';

// Side materials follow their neighbour unless they have their own: the bevel and the side wall
// of a title, or the front and the edge of a plate, are one material in most looks. Absent
// `Title3DProps.side`, `Backplate3D.side` or `CharAdjust.side3d` = inherited:
// - the title's side shows its outermost band's material, the face's when it has no bands
//   (inflate mode too: it keeps its bands for Extrude);
// - a plate's edge shows that plate's front;
// - a letter's side: its own `side3d`, else the title's own `side`, else the letter's outermost
//   band (its own `bands3d` entry, else the title's band), else, without bands, the letter's face
//   (its own `face3d`, else the title's face).
// Every reader resolves sides here. An inherited side has no material of its own, so it has no
// link slot either (model/links.ts).

/** Index of the band an inherited title side shows (the outermost one), or null: the face. */
export const sideSource = (s: Pick<Title3DProps, 'bands'>): number | null => (s.bands.length ? s.bands.length - 1 : null);

/** The material the title's side shows when it has none of its own. */
export function sideNeighbour(s: Title3DProps): Material3D {
  const i = sideSource(s);
  return i === null ? s.face : s.bands[i].material;
}

/** The material the title's side walls show. */
export const sideMaterial = (s: Title3DProps): Material3D => s.side ?? sideNeighbour(s);

/** The material a plate's edge shows. */
export const plateSide = (p: Backplate3D): Material3D => p.side ?? p.face;

/** The material letter `a`'s side shows when the letter has none of its own (see the header). */
export function charSideNeighbour(s: Title3DProps, a: CharAdjust | undefined): Material3D {
  if (s.side) return s.side;
  const i = sideSource(s);
  return i === null ? (a?.face3d ?? s.face) : (a?.bands3d?.[i] ?? s.bands[i].material);
}

/** The material letter `a`'s side walls show. */
export const charSide = (s: Title3DProps, a: CharAdjust | undefined): Material3D => a?.side3d ?? charSideNeighbour(s, a);

/** Letter `a` of a title styled `s` with side `m` of its own, or inheriting when `m` is absent or deep-equals its neighbour. */
export function withCharSide(s: Title3DProps, a: CharAdjust, m: Material3D | undefined): CharAdjust {
  const { side3d: _, ...rest } = a;
  return m && !sameValue(m, charSideNeighbour(s, rest)) ? { ...rest, side3d: m } : rest;
}

/** `s` with every side (the title's, each plate's edge) that deep-equals its neighbour (link ids included) inheriting it: the same render. */
export function inheritSides(s: Title3DProps): Title3DProps {
  const backplates = s.backplates.map((p) => {
    if (!p.side || !sameValue(p.side, p.face)) return p;
    const { side: _, ...edgeless } = p;
    return edgeless;
  });
  const { side, ...rest } = s;
  return side && !sameValue(side, sideNeighbour(s)) ? { ...rest, side, backplates } : { ...rest, backplates };
}

/**
 * The letters of a title once styled `prev`, now `next` (`prev` with inheritSides applied): each
 * letter keeps the side it showed. A side that deep-equals the letter's new neighbour inherits;
 * a letter whose neighbour changed (it owns its outermost band or face, and the title's side
 * now inherits) gets an unlinked copy of the side it showed.
 */
export function inheritCharSides(prev: Title3DProps, next: Title3DProps, chars: Record<number, CharAdjust>): Record<number, CharAdjust> {
  const out: Record<number, CharAdjust> = {};
  for (const [k, a] of Object.entries(chars)) {
    const shown = charSide(prev, a);
    const { side3d: _, ...rest } = a;
    out[Number(k)] = sameValue(shown, charSideNeighbour(next, rest)) ? rest : { ...rest, side3d: a.side3d ?? withoutLink(shown) };
  }
  return out;
}

import { sameValue } from './equal';
import type { Band3D, CharAdjust, Material3D, Title3DProps } from './types';

// The 3D title model (Element 3D's Bevel Copies, in our words): the LETTER is one solid — a face,
// one bevel (`Title3DProps.bevel`, placed by `bevelPosition`) and a side wall — in one material,
// `face`; BANDS (`Title3DProps.bands`, innermost first) are whole extruded copies of the outline
// stacked behind it, each grown beyond the previous solid, each in one `material`. The letter and
// every band may give their side wall a material of its own (`side`); absent, it shows theirs.
// Per-letter overrides (CharAdjust): `face3d` = the letter's face and bevel, `side3d` = its side
// wall, `bands3d[i]` = band i behind that letter.
// Absent materials resolve here, and every reader goes through these helpers:
// - the title's side: its face;
// - a band's side wall: the band's material;
// - a letter's face: its own `face3d`, else the title's face;
// - a letter's side: its own `side3d`, else the title's own `side`, else the letter's face;
// - a letter's band i: its own `bands3d[i]` (the whole band behind that letter: front, bevel and
//   side wall), else the band's material, and the band's own `side` on its wall.
// An inherited side has no material of its own, so it has no link slot either (model/links.ts).

/** Share of the letter's bevel that lies outside the glyph outline (Title3DProps.bevelPosition). */
export const BEVEL_OUTSIDE_SHARE: Record<Title3DProps['bevelPosition'], number> = { outside: 1, center: 0.5, inside: 0 };

/** The material the title's side walls show. */
export const sideMaterial = (s: Pick<Title3DProps, 'face' | 'side'>): Material3D => s.side ?? s.face;

/** The material band `b`'s side wall shows. */
export const bandSide = (b: Band3D): Material3D => b.side ?? b.material;

/** Letter `a`'s face and bevel. */
export const charFace = (s: Title3DProps, a: CharAdjust | undefined): Material3D => a?.face3d ?? s.face;

/** The material letter `a`'s side shows when the letter has none of its own. */
export const charSideNeighbour = (s: Title3DProps, a: CharAdjust | undefined): Material3D => s.side ?? charFace(s, a);

/** The material letter `a`'s side walls show. */
export const charSide = (s: Title3DProps, a: CharAdjust | undefined): Material3D => a?.side3d ?? charSideNeighbour(s, a);

/** Band `i` behind letter `a`. */
export const charBand = (s: Title3DProps, a: CharAdjust | undefined, i: number): Material3D => a?.bands3d?.[i] ?? s.bands[i].material;

/** The side wall of band `i` behind letter `a`: the letter's own band i covers it too. */
export const charBandSide = (s: Title3DProps, a: CharAdjust | undefined, i: number): Material3D => a?.bands3d?.[i] ?? s.bands[i].side ?? s.bands[i].material;

/** Letter `a` of a title styled `s` with side `m` of its own, or inheriting when `m` is absent or deep-equals its neighbour. */
export function withCharSide(s: Title3DProps, a: CharAdjust, m: Material3D | undefined): CharAdjust {
  const { side3d: _, ...rest } = a;
  return m && !sameValue(m, charSideNeighbour(s, rest)) ? { ...rest, side3d: m } : rest;
}

/** `s` with every side (the title's, each band's) that deep-equals its neighbour (link ids included) inheriting it: the same render. */
export function inheritSides(s: Title3DProps): Title3DProps {
  const bands = s.bands.map((b) => {
    if (!b.side || !sameValue(b.side, b.material)) return b;
    const { side: _, ...edgeless } = b;
    return edgeless;
  });
  const { side, ...rest } = s;
  return side && !sameValue(side, s.face) ? { ...rest, side, bands } : { ...rest, bands };
}

/**
 * How far the letter's bevel reaches past the glyph outline, % of size: the letter's silhouette
 * sits this far out, and the bands grow from there. 0 in inflate mode, whose front has no bevel.
 */
export function letterOutside(p: Pick<Title3DProps, 'mode' | 'bevel' | 'bevelPosition'>): number {
  if (p.mode === 'inflate') return 0;
  return Math.max(0, p.bevel.width) * BEVEL_OUTSIDE_SHARE[p.bevelPosition];
}

/** How far the enabled bands grow beyond the letter's silhouette, % of size (their contour reach; hull / box bases reach further). */
export const bandsGrow = (p: Pick<Title3DProps, 'bands'>): number => p.bands.reduce((s, b) => s + (b.enabled ? Math.max(0, b.grow) : 0), 0);

/** Where a 3D material sits in a style: the letter's face (and bevel), its side, or band `index`'s material / side wall. */
export type Material3DRole = { part: 'face' } | { part: 'side' } | { part: 'band'; index: number; side: boolean };

/**
 * `s` with every material it holds (face, own side, each band's material and own side) replaced
 * by `fn`'s result, in that order; inherited sides stay inherited.
 */
export function mapMaterials3D(s: Title3DProps, fn: (m: Material3D, role: Material3DRole) => Material3D): Title3DProps {
  const face = fn(s.face, { part: 'face' });
  const side = s.side && fn(s.side, { part: 'side' });
  const bands = s.bands.map((b, index) => {
    const material = fn(b.material, { part: 'band', index, side: false });
    const own = b.side && fn(b.side, { part: 'band', index, side: true });
    return own ? { ...b, material, side: own } : { ...b, material };
  });
  return side ? { ...s, face, side, bands } : { ...s, face, bands };
}

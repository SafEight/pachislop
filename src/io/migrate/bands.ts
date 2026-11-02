import { BEVEL_OUTSIDE_SHARE, inheritSides, withCharSide } from '../../model/bands';
import { bevel3D, plateShape } from '../../model/defaults';
import { sameValue } from '../../model/equal';
import { withoutLink } from '../../model/links';
import type { Band3D, BevelProfile3D, BevelShape3D, CharAdjust, Material3D, PlateShape, Title3DProps } from '../../model/types';

// v10 → v11: the letter and its bands (model/bands.ts) replace the bevel RINGS (`bands`: rings of
// one bevel running from the face edge out to the side wall) and the BACKPLATES (solids stacked
// behind). Read by shape, not by version (a v4–v10 style has `backplates`), so user styles of any
// version convert the same way. What renders stays the same where the new model can say it:
// - backplates become bands, exactly (same id, geometry and materials; `zGap` = `offset`);
// - the first ring folds into the letter's bevel when it shows the face's material (links aside)
//   on every letter, otherwise the letter gets no bevel and the ring becomes a band too;
// - every other ring becomes a band seated where the previous solid's bevel ends (its offset slides
//   it forward through that solid's depth), grown by the ring's width, with the ring's profile as
//   its bevel, so the rings keep their order, widths and silhouette ('outside' rings exactly; for
//   'inside' / 'center' rings the letter's bevel takes the position whose silhouette comes
//   closest, and the bands behind are shrunk by what the rings now reach further out, so they keep
//   theirs);
// - depths are chosen so every solid ends where the old extrusion ended;
// - the side wall (the old `side`, else the outermost ring's material, else the face) becomes
//   the outermost converted band's side, or the letter's without converted bands;
// - in inflate mode and on orbs the rings never rendered: the rings past the letter's bevel
//   become bands switched off, and the side wall is the letter's.
// Part references follow (`part`): a folded ring is the face, a converted ring or plate its band,
// a side that moved onto a band that band. Letters keep their ring overrides on the converted
// bands (`char`); a letter's own side shows wherever the side wall went, if it can.

/** A bevel ring of a v4–v10 style. */
interface LegacyRing extends BevelShape3D {
  id: string;
  material: Material3D;
}

/** A backplate of a v4–v10 style. */
interface LegacyPlate {
  id: string;
  enabled: boolean;
  grow: number;
  join: 'miter' | 'round';
  fillCounters: boolean;
  plate: PlateShape;
  depth: number;
  zGap: number;
  bevel: BevelShape3D;
  face: Material3D;
  side?: Material3D;
}

/** A v4–v10 3D style (after the field filling of io/project.ts). */
export type LegacyStyle3D = Omit<Title3DProps, 'bands' | 'bevel'> & { bands: LegacyRing[]; backplates: LegacyPlate[] };

/** Whether `s` is a v4–v10 3D style (rings and backplates). */
export const isLegacyStyle3D = (s: unknown): s is LegacyStyle3D => !!s && typeof s === 'object' && 'backplates' in s;

export interface BandsConversion {
  style3d: Title3DProps;
  /** An old part (ring i: 'band', plate i: 'plate', the side wall) → the new one: 'face', 'side' or a band index. */
  part(old: 'side' | { kind: 'band' | 'plate'; index: number }): 'face' | 'side' | number;
  /** A letter's old overrides → new ones (`bands3d` re-indexed, `side3d` where the side wall went). */
  char(a: CharAdjust): CharAdjust;
}

/** z drop of a bevel profile at its outer end in units of its depth (engine/three/bevel.ts): 'inset' ends raised, 'tube' at its start height. */
const END_DROP: Record<BevelProfile3D, number> = { flat: 1, chamfer: 1, round: 1, cove: 1, step: 1, inset: -1, tube: 0 };

const sameMaterial = (a: Material3D, b: Material3D) => sameValue(withoutLink(a), withoutLink(b));
const shapeOf = (r: BevelShape3D): BevelShape3D => ({ width: r.width, depth: r.depth, profile: r.profile, segments: r.segments, curve: r.curve });
/** How far a bevel's end lies behind its start (the old extruder clamps sizes at 0). */
const dropOf = (b: BevelShape3D) => (b.width > 0 || b.depth > 0 ? Math.max(0, b.depth) * END_DROP[b.profile] : 0);

/**
 * The v11 style of a v4–v10 one (see the header). `orb`: it styles a 保留 orb (its rings never
 * rendered); `chars`: the letters' old overrides, which decide whether the first ring folds.
 */
export function convertBands(raw: LegacyStyle3D, opts: { orb?: boolean; chars?: readonly CharAdjust[] } = {}): BandsConversion {
  const { bands: rings, backplates: plates, side: oldSide, ...common } = raw;
  const n = rings.length;
  const chars = opts.chars ?? [];
  const inert = raw.mode === 'inflate' || !!opts.orb;
  const shownSide = oldSide ?? (n ? rings[n - 1].material : raw.face);
  const fold = n > 0 && sameMaterial(rings[0].material, raw.face) && chars.every((a) => sameMaterial(a.bands3d?.[0] ?? rings[0].material, a.face3d ?? raw.face));
  const start = fold ? 1 : 0;
  const width = (r: BevelShape3D) => Math.max(0, r.width);

  // z where each ring ends (the old wall top is the last), and the old back
  const zEnd: number[] = [];
  rings.forEach((r, k) => zEnd.push((k ? zEnd[k - 1] : 0) - dropOf(r)));
  const zLast = n ? zEnd[n - 1] : 0;
  const depth = Math.max(0, raw.depth);
  /** Depth of a solid whose bevel ends at `top`, reaching back to the old back (inert: the rings never set the wall top). */
  const backTo = (top: number) => (inert ? depth : Math.max(0, top - zLast + depth));

  // the letter: the folded ring's bevel, at the position whose silhouette comes closest
  const total = rings.reduce((s, r) => s + width(r), 0);
  const oldReach = total * BEVEL_OUTSIDE_SHARE[raw.bevelPosition];
  let bevelPosition = raw.bevelPosition;
  if (fold && !inert && width(rings[0]) > 0) {
    const reach = (pos: Title3DProps['bevelPosition']) => width(rings[0]) * BEVEL_OUTSIDE_SHARE[pos] + total - width(rings[0]);
    bevelPosition = (['outside', 'center', 'inside'] as const).reduce((best, pos) => (Math.abs(reach(pos) - oldReach) < Math.abs(reach(best) - oldReach) ? pos : best));
  }
  const bevel = fold ? shapeOf(rings[0]) : bevel3D(0, 0);
  const letterDepth = backTo(fold ? zEnd[0] : 0);

  // the rings past the letter's bevel, each seated where the previous solid's bevel ends
  const converted: Band3D[] = [];
  let prevDepth = letterDepth;
  for (let k = start; k < n; k++) {
    const r = rings[k];
    const band: Band3D = {
      id: r.id,
      enabled: !inert,
      grow: width(r),
      join: 'miter',
      fillCounters: false,
      shape: plateShape(),
      depth: backTo(zEnd[k]),
      offset: -prevDepth,
      bevel: shapeOf(r),
      material: r.material,
    };
    converted.push(band);
    prevDepth = band.depth;
  }
  const wallOnBand = !inert && converted.length > 0;
  if (wallOnBand) converted[converted.length - 1].side = shownSide;

  // the plates, shrunk by how much further out than before the converted rings now reach
  const newReach = inert ? 0 : (fold ? width(rings[0]) * BEVEL_OUTSIDE_SHARE[bevelPosition] : 0) + converted.reduce((s, b) => s + b.grow, 0);
  // (sums of the same widths in another order differ by rounding only)
  let excess = inert || Math.abs(newReach - oldReach) < 1e-9 ? 0 : newReach - oldReach;
  const plateBands = plates.map((p): Band3D => {
    let grow = p.grow;
    if (p.enabled && excess !== 0) {
      const take = Math.min(Math.max(0, grow), excess);
      grow -= take;
      excess -= take;
    }
    const flatBevel = width(p.bevel) <= 0;
    return {
      id: p.id,
      enabled: p.enabled,
      grow,
      join: p.join,
      fillCounters: p.fillCounters,
      shape: p.plate,
      // a bevel of width 0 was a straight riser in front of the wall: the wall now
      depth: flatBevel ? Math.max(0, p.depth + dropOf(p.bevel)) : p.depth,
      offset: p.zGap,
      bevel: flatBevel ? bevel3D(0, 0, p.bevel.profile) : p.bevel,
      material: p.face,
      ...(p.side ? { side: p.side } : {}),
    };
  });

  const style3d = inheritSides({
    ...common,
    depth: letterDepth,
    bevel,
    bevelPosition,
    ...(wallOnBand ? {} : { side: shownSide }),
    bands: [...converted, ...plateBands],
  });

  return {
    style3d,
    part(old) {
      if (old === 'side') return wallOnBand ? converted.length - 1 : 'side';
      if (old.kind === 'plate') return converted.length + old.index;
      return fold && old.index === 0 ? 'face' : old.index - start;
    },
    char(a) {
      const { bands3d: oldBands, side3d, ...rest } = a;
      const shown = side3d ?? oldSide ?? (n ? (oldBands?.[n - 1] ?? rings[n - 1].material) : (a.face3d ?? raw.face));
      const bands3d = converted.map((_, j) => oldBands?.[start + j] ?? null);
      while (bands3d.length && bands3d[bands3d.length - 1] === null) bands3d.pop();
      const out: CharAdjust = bands3d.length ? { ...rest, bands3d } : rest;
      // the letter's own wall shows only without converted bands (else it is inside them)
      return wallOnBand ? out : withCharSide(style3d, out, shown);
    },
  };
}

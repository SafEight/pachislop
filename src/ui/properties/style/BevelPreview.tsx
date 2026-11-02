import { useId } from 'react';
import { unitBevel } from '../../../engine/three/bevel';
import { curveFn } from '../../../engine/layer2d/contours';
import { BEVEL_OUTSIDE_SHARE, bandSide, sideMaterial } from '../../../model/bands';
import type { BevelShape3D, Material3D, Title3DProps } from '../../../model/types';
import type { Translate } from '../../../store/msg';
import { useT } from '../../i18n';
import { material3DCss, presetLabel } from './shared';

// Cross-section of the extruded title, cut through a stroke: the letter's face on the left at
// z = 0, its bevel outward to its side wall (or, in inflate mode, the inflate profile from the
// stroke's middle down to the outline), the side wall, then each enabled band stacked behind,
// innermost first. A dashed line marks the glyph outline: the letter's bevel sits outside,
// across or inside it per bevelPosition. Mirrors the engine (engine/three/title.ts, the rules in
// model/bands.ts): band k's edge is the letter's silhouette grown by the running sum of grows,
// its front at the previous solid's back + offset but never in front of 0.25 % behind where the
// previous solid's bevel ends, its bevel inward from its edge, its wall from the bevel's end.
// Colours are the materials (own side walls on the walls). Drawn in % of size with x outward
// and z growing downward (deeper).

const W = 200;
const H = 90;
const PAD = 6;
/** A band's front never comes nearer than this behind the previous solid's wall top, % of size (engine rule). */
const BAND_LEAD = 0.25;
/** Longest straight wall drawn, × the largest bevel width / depth. */
const WALL_MAX = 1.5;
/** Face stub width, × the largest bevel width / depth. */
const FACE_STUB = 0.5;
/** Break mark: zig-zag step / amplitude and the gap between its two lines, screen px. */
const ZIG_STEP = 4;
const ZIG_AMP = 1.5;
const BREAK_GAP = 4;
/** Samples along the inflate profile. */
const INFLATE_SAMPLES = 24;
/** (x outward, z depth below the face), % of size. */
type Pt = readonly [number, number];

interface Region {
  key: string;
  pts: Pt[];
  mat: Material3D;
  label: string;
}

interface Outline {
  key: string;
  pts: Pt[];
  active: boolean;
}

const pos = (v: number) => Math.max(0, v);

/** One bevel from (x0, z0) across `w` and down `d` (unit o scaled by width, h by depth). */
function bevelPoints(shape: BevelShape3D, x0: number, z0: number, w: number, d: number): Pt[] {
  return unitBevel(shape.profile, shape.segments, shape.curve)
    .flat()
    .map(({ o, h }): Pt => [x0 + w * o, z0 + d * h]);
}

/** Polygon closed down to `bottom` under a surface polyline (never above the surface itself). */
function column(surface: Pt[], bottom: number, x0 = surface[0][0]): Pt[] {
  const b = Math.max(bottom, ...surface.map((p) => p[1]));
  return [[x0, surface[0][1]], ...surface, [surface[surface.length - 1][0], b], [x0, b]];
}

/** A straight wall drawn shorter than it is: a break mark across its solid at depth `z`. */
interface Break {
  key: string;
  /** Wall x and the mark's depth, % of size (shown coordinates). */
  x: number;
  z: number;
  label: string;
}

/** The glyph outline's place in the section: x and the depth range of its dashed mark, % of size. */
interface Mark {
  x: number;
  z0: number;
  z1: number;
}

/** A solid's wall in the section: where its wall top and back really are and where they are drawn (a long wall is drawn shorter), % of size. */
interface Wall {
  top: number;
  back: number;
  shownTop: number;
  shownBack: number;
}

/** Where the real depth `z` (behind `w`'s wall top) is drawn: scaled along a shortened wall, 1:1 past its back. */
function shownZ(w: Wall, z: number): number {
  if (z >= w.back) return w.shownBack + (z - w.back);
  return w.shownTop + ((z - w.top) * (w.shownBack - w.shownTop)) / Math.max(w.back - w.top, 1e-9);
}

/**
 * Regions (back to front), surface outlines and wall breaks of the whole cross-section.
 * Real proportions would make a deep side wall dwarf a 1 % bevel, so every straight wall is
 * drawn at most WALL_MAX × the largest bevel extent (with a break mark), and the face is a
 * short stub.
 */
function crossSection(t: Translate, st: Title3DProps, activeBand: number, activeSide: boolean) {
  const inflate = st.mode === 'inflate';
  const bevel = inflate ? null : st.bevel;
  const bevelW = bevel ? pos(bevel.width) : 0;
  const bands = st.bands.map((b, i) => ({ b, i })).filter(({ b }) => b.enabled);
  const height = pos(st.inflate.height);
  const growTotal = bands.reduce((s, { b }) => s + pos(b.grow), 0);
  const shapes = [...(bevel && bevelW > 0 ? [bevel] : []), ...bands.map(({ b }) => b.bevel).filter((v) => v.width > 0)];
  // inflate: walls are drawn against a quarter of the rise, so a tall dome doesn't let deep
  // walls dwarf the bands
  const maxBevel = Math.max(inflate ? height / 4 : 0, ...shapes.flatMap((v) => [pos(v.width), pos(v.depth)]));
  // no bevel at all: scale walls against the band steps instead (or 1 % of size)
  const ref = maxBevel > 0 ? maxBevel : Math.max(growTotal, 1);
  const wallMax = WALL_MAX * ref;
  const faceW = Math.max(FACE_STUB * ref, 0.15 * bevelW);

  const breaks: Break[] = [];
  /** A wall of `len` from wall top `top` (drawn at `shownTop`); records a break when it is drawn shorter. */
  const wall = (key: string, label: string, x: number, top: number, shownTop: number, len: number): Wall => {
    const shown = Math.min(len, wallMax);
    if (len > wallMax) breaks.push({ key, x, z: shownTop + wallMax / 2, label: t('{part} shortened (really {depth} % deep)', { part: label, depth: +len.toFixed(2) }) });
    return { top, back: top + len, shownTop, shownBack: shownTop + shown };
  };

  // the letter: face stub (inflate: the profile from the stroke's middle, top at z = 0, out to
  // the outline; the stroke's half-width is drawn at 2.5 × the rise so the curve reads at any
  // height), its bevel, its side wall
  const profile = curveFn(st.inflate.profile);
  const halfW = 2.5 * height;
  const inflateFront: Pt[] = Array.from({ length: INFLATE_SAMPLES + 1 }, (_, k) => [(halfW * k) / INFLATE_SAMPLES, height * (1 - profile(1 - k / INFLATE_SAMPLES))]);
  const stub: Pt[] = inflate ? inflateFront : [[0, 0], [faceW, 0]];
  const [x0, z0] = stub[stub.length - 1];
  const front = bevel && bevelW > 0 ? [...stub, ...bevelPoints(bevel, x0, z0, bevelW, pos(bevel.depth))] : stub;
  const [sil, top] = front[front.length - 1];
  let prev = wall('wall', t('Side wall'), sil, top, top, pos(st.depth));
  const outlines: Outline[] = [
    { key: 'face', pts: front, active: false },
    { key: 'wall', pts: [[sil, prev.shownTop], [sil, prev.shownBack]], active: activeSide },
  ];
  // the glyph outline: the bevel's outside share lies beyond it (inflate fronts end on it)
  const glyph: Mark = { x: sil - bevelW * BEVEL_OUTSIDE_SHARE[st.bevelPosition], z0: Math.min(0, ...front.map((p) => p[1])), z1: prev.shownBack };
  const letter: Region[] = [
    { key: 'side', pts: [[0, prev.shownTop], [sil, prev.shownTop], [sil, prev.shownBack], [0, prev.shownBack]], mat: sideMaterial(st), label: t('Side wall') },
    { key: 'face', pts: column(front, prev.shownTop), mat: st.face, label: inflate ? t('Inflated face') : t('Face') },
  ];

  // the bands, innermost first
  const stack: Region[][] = [];
  let edge = sil;
  for (const { b, i } of bands) {
    edge += pos(b.grow);
    const n = i + 1;
    const zFront = Math.max(prev.back + b.offset, prev.top + BAND_LEAD);
    const shownFront = shownZ(prev, zFront);
    const bw = Math.min(pos(b.bevel.width), edge);
    const surface: Pt[] = [[0, shownFront], ...(bw > 0 ? bevelPoints(b.bevel, edge - bw, shownFront, bw, pos(b.bevel.depth)) : [[edge, shownFront] as Pt])];
    const drop = surface[surface.length - 1][1] - shownFront;
    prev = wall(`band${i}`, t('Band {n} side', { n }), edge, zFront + drop, shownFront + drop, pos(b.depth));
    stack.push([
      { key: `band${i}side`, pts: [[0, prev.shownTop], [edge, prev.shownTop], [edge, prev.shownBack], [0, prev.shownBack]], mat: bandSide(b), label: t('Band {n} side', { n }) },
      { key: `band${i}face`, pts: column(surface, prev.shownTop, 0), mat: b.material, label: t('Band {n} · {preset}', { n, preset: presetLabel(t, b.material.preset) }) },
    ]);
    outlines.push({ key: `band${i}`, pts: [...surface, [edge, prev.shownBack]], active: i === activeBand });
  }

  // deeper solids first so nearer ones cover them where a band slides forward
  const regions = [...stack.reverse().flat(), ...letter];
  // highlighted outlines last so they stay on top
  outlines.sort((a, b) => Number(a.active) - Number(b.active));
  return { regions, outlines, breaks, glyph };
}

/** Fit (x, z) % of size into the box, keeping the (wall-shortened) aspect ratio. */
function fitter(all: Pt[]) {
  let x0 = Infinity;
  let x1 = -Infinity;
  let z0 = Infinity;
  let z1 = -Infinity;
  for (const [x, z] of all) {
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
    z0 = Math.min(z0, z);
    z1 = Math.max(z1, z);
  }
  const sx = Math.max(x1 - x0, 1e-3);
  const sz = Math.max(z1 - z0, 1e-3);
  const s = Math.min((W - 2 * PAD) / sx, (H - 2 * PAD) / sz);
  const ox = (W - sx * s) / 2 - x0 * s;
  const oz = (H - sz * s) / 2 - z0 * s;
  const pt = ([x, z]: Pt): Pt => [ox + x * s, oz + z * s];
  return { pt, str: (pts: Pt[]) => pts.map((p) => pt(p).map((v) => v.toFixed(2)).join(',')).join(' ') };
}

/** Zig-zag from screen x `a` to `b` around screen y `y`. */
function zigzag(a: number, b: number, y: number): Pt[] {
  const out: Pt[] = [];
  for (let k = 0, xx = a; xx < b + ZIG_STEP; k++, xx += ZIG_STEP) out.push([Math.min(xx, b), y + (k % 2 ? ZIG_AMP : -ZIG_AMP)]);
  return out;
}

/** Double zig-zag break mark across a solid, from its left edge to just past its wall. */
function BreakMark({ b, pt }: { b: Break; pt: (p: Pt) => Pt }) {
  const [left, y] = pt([0, b.z]);
  const right = pt([b.x, b.z])[0] + 3;
  const top = zigzag(left, right, y - BREAK_GAP / 2);
  const bottom = zigzag(left, right, y + BREAK_GAP / 2);
  const line = (pts: Pt[]) => pts.map((p) => p.map((v) => v.toFixed(2)).join(',')).join(' ');
  return (
    <g>
      <title>{b.label}</title>
      <polygon points={line([...top, ...[...bottom].reverse()])} style={{ fill: 'var(--bg0)' }} />
      <polyline points={line(top)} fill="none" style={{ stroke: 'var(--muted)', strokeWidth: 1 }} />
      <polyline points={line(bottom)} fill="none" style={{ stroke: 'var(--muted)', strokeWidth: 1 }} />
    </g>
  );
}

/** SVG paint of a material: its gradient (top → bottom) or its preview colour. */
function paint(m: Material3D, id: string) {
  if (!m.gradient || m.gradient.stops.length < 2) return { fill: material3DCss(m), def: null };
  const stops = [...m.gradient.stops].sort((a, b) => a.pos - b.pos);
  return {
    fill: `url(#${id})`,
    def: (
      <linearGradient key={id} id={id} x1="0" y1="0" x2="0" y2="1">
        {stops.map((s, k) => (
          <stop key={k} offset={s.pos} stopColor={s.color} />
        ))}
      </linearGradient>
    ),
  };
}

/** Inline cross-section of the letter and its bands (face left, deeper = lower); the active band or the letter's side wall is outlined. */
export function BevelPreview({ st, activeBand = -1, activeSide = false }: { st: Title3DProps; activeBand?: number; activeSide?: boolean }) {
  const uid = useId().replace(/:/g, '');
  const t = useT();
  const { regions, outlines, breaks, glyph } = crossSection(t, st, activeBand, activeSide);
  const { pt, str: map } = fitter(regions.flatMap((r) => r.pts));
  const paints = regions.map((r) => paint(r.mat, `${uid}-${r.key}`));
  const n = st.bands.filter((b) => b.enabled).length;
  const label = n ? t('Cross-section: the letter and {bands}', { bands: t(n === 1 ? '{n} band' : '{n} bands', { n }) }) : t('Cross-section: the letter');
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${W} ${H}`}
      width={W}
      height={H}
      style={{ display: 'block', maxWidth: '100%', height: 'auto', margin: '2px 0 4px', background: 'var(--bg0)', border: '1px solid var(--line)', borderRadius: 3 }}
    >
      <title>{t('{label}. Cut through a stroke: face on the left, deeper is lower; the dashed line is the glyph outline.', { label })}</title>
      <defs>{paints.map((p) => p.def)}</defs>
      {regions.map((r, i) => (
        <polygon key={r.key} points={map(r.pts)} fill={paints[i].fill}>
          <title>{r.label}</title>
        </polygon>
      ))}
      {outlines.map((o) => (
        <polyline
          key={o.key}
          points={map(o.pts)}
          fill="none"
          strokeLinejoin="round"
          style={o.active ? { stroke: 'var(--accent2)', strokeWidth: 2.5 } : { stroke: 'rgba(255, 255, 255, 0.45)', strokeWidth: 1 }}
        />
      ))}
      <polyline points={map([[glyph.x, glyph.z0], [glyph.x, glyph.z1]])} fill="none" strokeDasharray="3 2" style={{ stroke: 'var(--text)', strokeWidth: 1 }}>
        <title>{t('Glyph outline')}</title>
      </polyline>
      {breaks.map((b) => (
        <BreakMark key={b.key} b={b} pt={pt} />
      ))}
    </svg>
  );
}

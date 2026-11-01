import { ensureFont } from '../assets/registry';
import type { CharAdjust, Layer, Project, TextSource, Transform } from '../model/types';
import { layoutText } from '../text/layout';

// v4 → v5 per-character scale compensation (async: it needs font metrics, so it runs after the
// bundle's fonts are installed, loading the builtin fonts it uses itself).
//
// v4 laid text out with every CharAdjust.scale = 1 and then scaled each glyph about its em-cell
// centre: advances, line breaks and the frame (the block's centring box) ignored the scale. v5
// lays the scaled glyph out at its own size, so the line reflows and the frame changes. In both,
// the glyph's outline relative to its em-cell centre is the same (v5 scales the cell, its advance
// and the glyph about that centre together; rotation and shear are applied about it too), so
// matching the centres restores v4's ink position and size exactly. The difference per glyph
// goes into its dx / dy; along each layer axis where every unscaled glyph moved by the same
// amount (the frame-centring shift — e.g. 約80% with 約 and % scaled, or the column centre of a
// vertical line with one bigger glyph), that common move goes into the layer's transform
// instead, so the other characters don't pick up offsets.
//
// Positions are compared BEFORE warp / distort: those map the frame, which v5 builds from the
// reflowed glyphs, so a warped or distorted layer keeps v4's glyph positions inside the frame
// but the envelope itself follows the v5 frame.

const NO_ADJUST: CharAdjust = { dx: 0, dy: 0, scale: 1, rotate: 0 };
/** Layer px below which a glyph shift counts as none, and two shifts as equal. */
const EPS = 1e-3;
const DEG = Math.PI / 180;

type TextLayer = Extract<Layer, { kind: 'title2d' | 'title3d' }> & { source: TextSource };

/** A scale that v5 lays out (it reads non-positive values as 1, like the neutral layout). */
const isScaled = (a: CharAdjust | undefined) => !!a && a.scale > 0 && a.scale !== 1;

/** % of size, rounded so stored values stay readable (1e-4 % of a 1000 px em = 0.001 px). */
const pct = (v: number) => Math.round(v * 1e4) / 1e4;

/**
 * Parent-space move of a layer whose layer-space content moves by (sx, sy) (y-up): through the
 * layer's scale and rotation — 2D: rotZ (clockwise on screen); 3D: the root's ZYX Euler
 * (rotX, rotY, −rotZ), see Layer3DRenderer — so the content stays put on screen.
 */
function parentShift(l: TextLayer, sx: number, sy: number): Pick<Transform, 'x' | 'y' | 'z'> {
  const t = l.transform;
  const c = -t.rotZ * DEG;
  if (l.kind === 'title2d') {
    const ax = t.scale * Math.cos(c);
    const ay = t.scale * Math.sin(c);
    return { x: ax * sx - ay * sy, y: ay * sx + ax * sy, z: 0 };
  }
  const a = t.rotX * DEG;
  const b = t.rotY * DEG;
  // X first, then Y, then Z.
  const y1 = sy * Math.cos(a);
  const z1 = sy * Math.sin(a);
  const x2 = sx * Math.cos(b) + z1 * Math.sin(b);
  const z2 = -sx * Math.sin(b) + z1 * Math.cos(b);
  return { x: t.scale * (x2 * Math.cos(c) - y1 * Math.sin(c)), y: t.scale * (x2 * Math.sin(c) + y1 * Math.cos(c)), z: t.scale * z2 };
}

async function compensateLayer(l: TextLayer): Promise<TextLayer> {
  const src = l.source;
  if (!Object.values(src.chars).some(isScaled)) return l;
  // An unavailable font can't be measured; the layer keeps the plain migration.
  const font = (await ensureFont(src.fontId).catch(() => undefined))?.font;
  if (!font) return l;

  const neutral: Record<number, CharAdjust> = {};
  for (const [k, a] of Object.entries(src.chars)) neutral[Number(k)] = { ...a, scale: 1 };
  const v4 = new Map(layoutText({ ...src, chars: neutral }, font).glyphs.map((g) => [g.index, g.center]));
  // Layer-space (y-up, pre-warp) move from the v5 centre to the v4 one, per glyph.
  const moves = layoutText(src, font).glyphs.map((g) => {
    const c = v4.get(g.index) ?? g.center;
    return { index: g.index, x: c.x - g.center.x, y: c.y - g.center.y };
  });
  if (!moves.length) return l;

  // The common move of the unscaled glyphs (all glyphs when every one is scaled), per layer axis.
  const plain = moves.filter((m) => !isScaled(src.chars[m.index]));
  const ref = plain.length ? plain : moves;
  const sx = ref.every((m) => Math.abs(m.x - ref[0].x) < EPS) && Math.abs(ref[0].x) >= EPS ? ref[0].x : 0;
  const sy = ref.every((m) => Math.abs(m.y - ref[0].y) < EPS) && Math.abs(ref[0].y) >= EPS ? ref[0].y : 0;
  const moved = sx !== 0 || sy !== 0;

  // Offsets are applied before shear (x += tan(shear)·y), so a y offset also moves x.
  const k = Math.tan(src.shear * DEG);
  const chars = { ...src.chars };
  let offset = false;
  for (const m of moves) {
    const x = m.x - sx;
    const y = m.y - sy;
    if (Math.abs(x) < EPS && Math.abs(y) < EPS) continue;
    const a = chars[m.index] ?? NO_ADJUST;
    chars[m.index] = { ...a, dx: pct(a.dx + ((x - k * y) / src.size) * 100), dy: pct(a.dy + (y / src.size) * 100) };
    offset = true;
  }
  if (!offset && !moved) return l;
  const shift = parentShift(l, sx, sy);
  const t = l.transform;
  const transform = moved ? { ...t, x: t.x + shift.x, y: t.y + shift.y, z: t.z + shift.z } : t;
  return { ...l, transform, source: { ...src, chars } };
}

/**
 * `project` (already migrated to v6) with v4 per-character scales compensated: every glyph of a
 * text layer with a scaled character keeps its v4 ink position and size (see the notes above).
 * `v4` false (the data was saved by v5 or v6) returns `project` unchanged; so does a v4 project with
 * nothing to compensate — callers detect a compensation by identity.
 */
export async function compensateV4CharScale(project: Project, v4: boolean): Promise<Project> {
  if (!v4) return project;
  let changed = false;
  const layers = await Promise.all(
    project.layers.map(async (l) => {
      if ((l.kind !== 'title2d' && l.kind !== 'title3d') || l.source.kind !== 'text') return l;
      const next = await compensateLayer(l as TextLayer);
      if (next !== l) changed = true;
      return next;
    }),
  );
  return changed ? { ...project, layers } : project;
}

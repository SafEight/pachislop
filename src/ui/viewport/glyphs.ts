import type { CharAdjust, Comp, Layer, TextSource } from '../../model/types';
import { cmdsBounds, mapCmds, type Bounds } from '../../text/layout';
import { flipCorners, glyphBoxes, glyphPoint3, layerView, type GlyphBox, type LayerView, type Pt } from './geometry';

// Per-glyph editing on the canvas: the selected glyphs' outlines and the gizmo frame in comp
// space (3D layers through the comp camera, dz / tilt applied like Geo3D), plus the shared
// CharAdjust helpers the Text tab uses too.

export const NO_ADJUST: CharAdjust = { dx: 0, dy: 0, scale: 1, rotate: 0 };

/** An adjustment that changes nothing (dropped from `chars` so the map only holds real tweaks). */
export const isNeutralAdjust = (a: CharAdjust) =>
  a.dx === 0 &&
  a.dy === 0 &&
  a.scale === 1 &&
  (a.hScale ?? 1) === 1 &&
  (a.vScale ?? 1) === 1 &&
  a.rotate === 0 &&
  !a.dz &&
  !a.tiltX &&
  !a.tiltY &&
  !a.face &&
  !a.face3d &&
  !a.bands3d &&
  !a.side3d;

/** `chars` with `fn` applied to each index in `indices` (neutral results are removed). */
export function mapAdjusts(chars: TextSource['chars'], indices: readonly number[], fn: (a: CharAdjust, i: number) => CharAdjust): TextSource['chars'] {
  const next = { ...chars };
  for (const i of indices) {
    const a = fn({ ...(chars[i] ?? NO_ADJUST) }, i);
    if (isNeutralAdjust(a)) delete next[i];
    else next[i] = a;
  }
  return next;
}

/** The characters of `indices` as a label: “激ア”. */
export const pickedText = (src: TextSource, indices: readonly number[]) => {
  const chars = Array.from(src.text);
  return `“${indices.map((i) => chars[i] ?? '').join('')}”`;
};

const DEG = Math.PI / 180;

/**
 * Glyph box before its own rotate (an oriented frame that turns with the glyph): the adjusted
 * outline mapped back through rotate⁻¹ about the glyph pivot. Scale / 長体 / 平体 are layout
 * (baked into the outline and the reflow), so the box already carries them.
 */
function unrotatedBox(g: GlyphBox, a: CharAdjust | undefined): Bounds {
  if (!a || a.rotate === 0) return g.box;
  const r = a.rotate * DEG; // inverse of the clockwise rotate = counter-clockwise in y-up
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const { x: cx, y: cy } = g.center;
  return cmdsBounds(mapCmds(g.cmds, ({ x, y }) => ({ x: cx + (x - cx) * cos - (y - cy) * sin, y: cy + (x - cx) * sin + (y - cy) * cos })));
}

export interface GlyphGizmoGeom {
  view: LayerView;
  /** All glyphs of the layer (for picking). */
  glyphs: GlyphBox[];
  /** Comp-space oriented box (TL, TR, BR, BL) of every glyph, as drawn (turns with the glyph; 3D: tilted / pushed front face). */
  polys: Map<number, Pt[]>;
  /** Selected glyphs present in the layout. */
  selected: GlyphBox[];
  /** Gizmo frame corners (comp space): the primary glyph's turned box, or the union of the picked boxes. */
  frame: Pt[] | null;
  /** Pivot of scale / rotate (comp space) and in layer space. */
  pivot: Pt | null;
  pivotL: Pt | null;
  /** Layer-space depth of the primary glyph's front face (move plane on 3D layers). */
  planeZ: number;
}

/** Comp-space corners (TL, TR, BR, BL on screen, through the layer's flip) of a layer-space box seen through the glyph's 3D adjustment. */
function glyphCorners(layer: Layer, view: LayerView, center: Pt, a: CharAdjust | undefined, b: Bounds, turn?: CharAdjust): Pt[] {
  const corners = flipCorners(b, view).map((p) => {
    if (!turn || turn.rotate === 0) return p;
    // Re-apply the glyph's own rotate (clockwise) about its pivot.
    const r = -turn.rotate * DEG;
    const u = p.x - center.x;
    const v = p.y - center.y;
    return { x: center.x + u * Math.cos(r) - v * Math.sin(r), y: center.y + u * Math.sin(r) + v * Math.cos(r) };
  });
  return corners.map((p) => {
    const q = glyphPoint3(layer, center, a, p, 0);
    return view.toComp(q.p, q.z);
  });
}

export function glyphGizmo(comp: Comp, layer: Layer, selectedChars: readonly number[]): GlyphGizmoGeom | null {
  if ((layer.kind !== 'title2d' && layer.kind !== 'title3d') || layer.source.kind !== 'text') return null;
  const src = layer.source;
  const view = layerView(comp, layer);
  const glyphs = glyphBoxes(layer);
  const polys = new Map<number, Pt[]>();
  for (const g of glyphs) {
    const a = src.chars[g.index];
    polys.set(g.index, glyphCorners(layer, view, g.center, a, unrotatedBox(g, a), a));
  }
  const picked = new Set(selectedChars);
  const selected = glyphs.filter((g) => picked.has(g.index));
  if (selected.length === 0) return { view, glyphs, polys, selected, frame: null, pivot: null, pivotL: null, planeZ: 0 };
  const primary = selected.find((g) => g.index === selectedChars[0]) ?? selected[0];
  const pa = src.chars[primary.index];
  let frame: Pt[];
  let pivotL: Pt;
  if (selected.length === 1) {
    pivotL = primary.center;
    frame = polys.get(primary.index)!;
  } else {
    const u = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    for (const g of selected) {
      u.x0 = Math.min(u.x0, g.box.x0);
      u.y0 = Math.min(u.y0, g.box.y0);
      u.x1 = Math.max(u.x1, g.box.x1);
      u.y1 = Math.max(u.y1, g.box.y1);
    }
    pivotL = { x: (u.x0 + u.x1) / 2, y: (u.y0 + u.y1) / 2 };
    frame = glyphCorners(layer, view, pivotL, pa, u);
  }
  const pz = glyphPoint3(layer, pivotL, pa, pivotL, 0);
  return { view, glyphs, polys, selected, frame, pivot: view.toComp(pz.p, pz.z), pivotL, planeZ: pz.z };
}

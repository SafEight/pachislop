import type { PreviewWindow } from '../../engine/Engine';
import { effectGather, effectReach } from '../../effects/registry';
import { drawnLayers, drawTree, isLeaf } from '../../engine/drawTree';
import { nodeDeps } from '../../engine/layerSource';
import { layerFillsComp } from '../../io/export';
import { isTitleLayer } from '../../model/parts';
import type { EffectInstance, Layer, Project } from '../../model/types';
import type { Bounds } from '../../text/layout';
import { boxCorners, layerSelectionBounds, layerView, ptsBounds, viewCorners } from './geometry';

// The sharp preview (Viewport): when the display's device pixels ask for more render px per comp
// px than the whole-comp preview has, the engine renders only a window of the whole render at
// that scale (Engine.render `window`). A window holds the very pixels of the whole render as
// long as everything they depend on lies inside it, so the window is the visible part of the
// comp grown until it contains:
// - for every top-level node drawing near the visible part: when it is window-local (2D titles,
//   groups and adjustment layers whose effects and mask feathers look a known distance back,
//   EffectDef.gather), that distance around the visible part; else the node WHOLE (its box with
//   its effects' reach), so what its effects and generators measure of it (ink boxes, highlight
//   grids, gradient boxes) and gather from it (the 3D glint, AO) is all there;
// - the layers those nodes read (follow targets, layer-mask and 'layer'-param sources), whole;
// - a margin of what the effects running over the whole frame's pixels gather (top-level
//   adjustment layers, backgrounds, full-frame generators); such an effect that may measure the
//   whole frame makes the window the whole comp.
// Then the scale comes down until the window fits the pixel budget.

/**
 * Largest window, render px: 3840 × 2160 (8.3 Mpx), a 4K frame. It is the size of the default
 * 1920 × 1080 comp at 2×, which 2× exports already render whole (the perf suite times one) and
 * which the window needs to show that comp at 100 % on a 2× display. Each pool target of the
 * window is a half-float RGBA colour + depth buffer, 12 B/px ≈ 100 MB at the budget; the pool
 * holds a handful (the composite, a node, its effect scratch), so this caps the window's GPU
 * memory near 1 GB, as a 2× export of the default comp does. Beyond it the scale drops (the
 * browser then magnifies the window a little), never the containment.
 */
export const WINDOW_BUDGET = 3840 * 2160;

/** Longest window side, render px (well inside every WebGL2 GPU's texture limit). */
const WINDOW_MAX_SIDE = 8192;

/**
 * The window's edges lie on multiples of this many render px of the whole render (from its
 * bottom-left corner, where the GL pyramids start), except at the whole render's own edges: the
 * power-of-two pyramids of glows, blurs and the 3D glint keep the whole render's texel grids,
 * as on the interactive cache's enlarged frames (WIDE_ALIGN).
 */
const ALIGN = 64;

/** Comp px added around every box and margin: antialiased edges and rounding. */
const PAD = 8;

/** Boxes of 3D layers grow by this share of their size per side: depth, perspective, bevels, glint streaks and the matte shadow reach past the z = 0 footprint. */
const PAD_3D = 0.5;

export interface SharpWindow {
  /** Render px per comp px of the window. */
  scale: number;
  /** The window, render px of the whole render at `scale` from its top-left corner. */
  window: PreviewWindow;
  /** The same rectangle in comp px from the comp's top-left corner (y down): where it sits on the stage, × the display scale. */
  place: { x: number; y: number; width: number; height: number };
}

const grow = (b: Bounds, m: number): Bounds => ({ x0: b.x0 - m, y0: b.y0 - m, x1: b.x1 + m, y1: b.y1 + m });
const union = (a: Bounds, b: Bounds): Bounds => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) });

/** Comp box of everything leaf `l` draws (its effects' reach included), or null when it has none (backgrounds, full-frame generators). */
function leafBox(project: Project, l: Layer): Bounds | null {
  const local = layerSelectionBounds(l, project.layers);
  if (!local) return null;
  if (l.kind !== 'title3d') return ptsBounds(boxCorners(l, local));
  const b = ptsBounds(viewCorners(layerView(project.comp, l), local));
  return grow(b, PAD_3D * Math.max(b.x1 - b.x0, b.y1 - b.y0));
}

/** Σ EffectDef.gather of the enabled effects of `list`; Infinity when one may depend on the whole layer. */
function gatherOf(list: readonly EffectInstance[] | undefined): number {
  let g = 0;
  for (const fx of list ?? []) {
    const e = effectGather(fx);
    if (e === null) return Infinity;
    g += e;
  }
  return g;
}

/**
 * How far back (comp px) the pixels of the node drawing `layers` look, summed along its stack, when
 * all of it is window-local: 2D titles and backgrounds (their style renders in a frame of their
 * own), groups and adjustment layers, with effects of known gather and feathered layer masks.
 * Infinity otherwise: 3D titles (AO and the glint gather on screen around a box that only
 * approximates their extent) and generators (laid out from the layers they read).
 */
function nodeGather(layers: readonly Layer[]): number {
  let g = 0;
  for (const l of layers) {
    if (l.kind === 'title3d' || l.kind === 'generator') return Infinity;
    g += gatherOf(l.effects);
    if (isTitleLayer(l)) g += Math.max(0, ...Object.values(l.partEffects).map(gatherOf));
    // the feather is a Gaussian of that radius (3σ): taps to ~1.33 ×
    for (const m of l.masks) if (m.enabled) g += 1.5 * Math.max(0, m.feather);
  }
  return g;
}

/**
 * The comp rect (comp px, origin comp centre, +y up) a window must cover so that its part
 * `visible` holds the whole render's pixels (see the top of this file), clipped to the comp.
 */
export function neededRect(project: Project, visible: Bounds): Bounds {
  const { width: cw, height: ch } = project.comp;
  const comp: Bounds = { x0: -cw / 2, y0: -ch / 2, x1: cw / 2, y1: ch / 2 };
  const top = drawTree(project, true);
  const boxes = new Map<Layer, Bounds | null>();
  const box = (l: Layer) => {
    let b = boxes.get(l);
    if (b === undefined) boxes.set(l, (b = isLeaf(l) ? leafBox(project, l) : null));
    return b;
  };
  // What the effects running over pixels that span the frame gather: the margin.
  let margin = 0;
  for (const n of top) {
    if (n.kind === 'adjust') margin += gatherOf(n.layer.effects);
    else if (drawnLayers([n]).some((l) => (isLeaf(l) && !box(l)) || layerFillsComp(l)))
      for (const l of drawnLayers([n])) {
        // a boxed leaf's effects stay in its box; a group's or an adjustment's run on its members' pixels
        if (isLeaf(l) && box(l)) continue;
        margin += gatherOf(l.effects);
        if (isTitleLayer(l)) for (const list of Object.values(l.partEffects)) margin += gatherOf(list);
      }
    if (!Number.isFinite(margin)) return comp;
  }
  const reach = grow(visible, margin + PAD);
  let need = reach;
  const add = (b: Bounds | null) => {
    if (b) need = union(need, grow(b, PAD));
  };
  for (const n of top) {
    if (n.kind === 'adjust') continue;
    const layers = drawnLayers([n]);
    let nodeBox: Bounds | null = null;
    for (const l of layers) {
      const b = box(l);
      if (b) nodeBox = nodeBox ? union(nodeBox, b) : b;
    }
    if (!nodeBox) continue;
    // groups' own effects draw past their members
    nodeBox = grow(nodeBox, layers.reduce((s, l) => (l.kind === 'group' ? s + l.effects.reduce((r, fx) => r + effectReach(fx), 0) : s), 0));
    const near = nodeBox.x0 < reach.x1 && nodeBox.x1 > reach.x0 && nodeBox.y0 < reach.y1 && nodeBox.y1 > reach.y0;
    // A node filling the frame from its ink (rays behind a title) needs that ink wherever the window is.
    const fills = layers.some(layerFillsComp);
    if (!near && !fills) continue;
    const g = fills ? Infinity : nodeGather(layers);
    if (Number.isFinite(g)) {
      // window-local: just its part within what the visible part gathers from
      const around = grow(reach, g);
      add({ x0: Math.max(nodeBox.x0, around.x0), y0: Math.max(nodeBox.y0, around.y0), x1: Math.min(nodeBox.x1, around.x1), y1: Math.min(nodeBox.y1, around.y1) });
    } else add(nodeBox);
    // the leaves its sources draw (their groups are listed too, for their visibility only)
    for (const l of nodeDeps(n, project).values()) if (l && isLeaf(l)) add(box(l));
  }
  return { x0: Math.max(comp.x0, need.x0), y0: Math.max(comp.y0, need.y0), x1: Math.min(comp.x1, need.x1), y1: Math.min(comp.y1, need.y1) };
}

/** `need` (comp px) as a window of the whole render at `scale`, aligned (see ALIGN). */
function windowAt(project: Project, need: Bounds, scale: number): { window: PreviewWindow; place: SharpWindow['place'] } {
  const { width: cw, height: ch } = project.comp;
  // Engine sizeFor: the whole render, its comp centre at its centre
  const fw = Math.max(1, Math.round(cw * scale));
  const fh = Math.max(1, Math.round(ch * scale));
  const down = (v: number, max: number) => Math.max(0, Math.min(max, Math.floor(v / ALIGN) * ALIGN));
  const up = (v: number, max: number) => Math.max(0, Math.min(max, Math.ceil(v / ALIGN) * ALIGN));
  // GL px from the bottom-left corner
  const x0 = down(fw / 2 + need.x0 * scale, fw);
  const x1 = Math.max(x0 + 1, up(fw / 2 + need.x1 * scale, fw));
  const y0 = down(fh / 2 + need.y0 * scale, fh);
  const y1 = Math.max(y0 + 1, up(fh / 2 + need.y1 * scale, fh));
  const window = { x: x0, y: fh - y1, width: x1 - x0, height: y1 - y0 };
  return {
    window,
    place: { x: (x0 - fw / 2) / scale + cw / 2, y: (window.y - fh / 2) / scale + ch / 2, width: window.width / scale, height: window.height / scale },
  };
}

/**
 * The window to render for showing `visible` (comp px, origin comp centre, +y up) at `sharp`
 * render px per comp px (the display's device pixels × preview resolution): the scale lowered
 * as far as WINDOW_BUDGET needs. Null when that is no sharper than `floor`, the scale of the
 * whole-comp preview, which then serves.
 */
export function previewWindow(project: Project, visible: Bounds, sharp: number, floor: number): SharpWindow | null {
  if (!(sharp > floor * 1.001)) return null;
  const need = neededRect(project, visible);
  let scale = sharp;
  for (let i = 0; i < 8 && scale > floor * 1.001; i++) {
    const at = windowAt(project, need, scale);
    const { width, height } = at.window;
    const over = Math.max(Math.sqrt((width * height) / WINDOW_BUDGET), Math.max(width, height) / WINDOW_MAX_SIDE);
    if (over <= 1) return { scale, ...at };
    // alignment can add a few px: aim a little lower
    scale /= over * 1.02;
  }
  return null;
}

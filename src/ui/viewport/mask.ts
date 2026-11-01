import type { GradientMask, Layer, LayerMask, Project, ShapeMask, ShapeSource } from '../../model/types';
import type { NodeRef } from '../../store/store';
import { fromComp, toComp, type LayerView, type Pt } from './geometry';

// Layer masks on the canvas: where a mask sits (its own space → comp) and the edits its handles
// make. A linked mask lives in its layer's flat placement (position, rotZ, scale and flip; 3D
// layers too, without their 3D turn), an unlinked or layer-source one in comp space. A shape
// mask's shape is placed at (x, y) and turned by `rotation` (clockwise) inside that space.

const DEG = Math.PI / 180;
const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
/** Wrap degrees into −180..180. */
const wrap = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180;

/** The selected mask node's layer and mask, when both exist. */
export function selectedMask(project: Project, node: NodeRef | null): { layer: Layer; mask: LayerMask } | null {
  if (node?.kind !== 'mask') return null;
  const layer = project.layers.find((l) => l.id === node.layerId);
  const mask = layer?.masks.find((m) => m.id === node.maskId);
  return layer && mask ? { layer, mask } : null;
}

/** The mask's own space ↔ comp (see the notes above), as a flat LayerView. */
export function maskView(layer: Layer, mask: LayerMask): LayerView {
  if (mask.kind === 'layer' || !mask.linked) return { is3D: false, flipX: false, flipY: false, toComp: (p) => p, fromComp: (p) => p };
  const { flipX, flipY } = layer.transform;
  return { is3D: false, flipX, flipY, toComp: (p) => toComp(layer, p), fromComp: (p) => fromComp(layer, p) };
}

/** Shape space (the shape's own outline, centred, y-up) ↔ comp. */
export function maskShapeView(layer: Layer, mask: ShapeMask): LayerView {
  const space = maskView(layer, mask);
  const a = mask.rotation * DEG;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  return {
    is3D: false,
    flipX: space.flipX,
    flipY: space.flipY,
    // R(−rotation) on the way out (clockwise on screen), R(rotation) back.
    toComp: (p) => space.toComp({ x: mask.x + p.x * cos + p.y * sin, y: mask.y - p.x * sin + p.y * cos }),
    fromComp: (q) => {
      const m = space.fromComp(q);
      if (!m) return null;
      const x = m.x - mask.x;
      const y = m.y - mask.y;
      return { x: x * cos - y * sin, y: x * sin + y * cos };
    },
  };
}

/**
 * Shape fields after a scale drag, from the pressed / current shape-space points `q0` / `q`
 * about the shape's origin: a corner scales evenly (`snap`: 5 % steps), a side handle stretches
 * the width ('x', aspect) or the height ('y', size, keeping the width).
 */
export function scaleShapeMask(src0: ShapeSource, axis: 'xy' | 'x' | 'y', q0: Pt, q: Pt, snap: boolean): Pick<ShapeSource, 'size' | 'aspect'> {
  if (axis === 'xy') {
    let f = Math.hypot(q.x, q.y) / (Math.hypot(q0.x, q0.y) || 1);
    if (snap) f = Math.max(0.05, Math.round(f * 20) / 20);
    return { size: r2(Math.max(1, src0.size * f)), aspect: src0.aspect };
  }
  const k = axis === 'x' ? q0.x : q0.y;
  if (Math.abs(k) < 1e-6) return { size: src0.size, aspect: src0.aspect };
  const f = Math.max(0.01, (axis === 'x' ? q.x : q.y) / k);
  if (axis === 'x') return { size: src0.size, aspect: r3(Math.max(0.01, src0.aspect * f)) };
  const size = r2(Math.max(1, src0.size * f));
  return { size, aspect: r3(Math.max(0.01, (src0.aspect * src0.size) / size)) };
}

/** Rotation after turning the shape from mask-space pointer `m0` to `m` about its origin (clockwise positive; `snap`: 15° steps). */
export function rotateShapeMask(mask0: ShapeMask, m0: Pt, m: Pt, snap: boolean): number {
  const a0 = Math.atan2(m0.y - mask0.y, m0.x - mask0.x);
  const a = Math.atan2(m.y - mask0.y, m.x - mask0.x);
  const rot = wrap(mask0.rotation - (a - a0) / DEG);
  return snap ? wrap(Math.round(rot / 15) * 15) : r1(rot);
}

/**
 * The fields that keep a shape / gradient mask where it is on the canvas when its `linked` flag
 * becomes `linked` (Photoshop's chain toggle never moves the mask): position, turn and size
 * carried through the layer's flat placement. One flip mirrors the shape: its turn reverses and
 * its handed fields (slant, a bubble's tail) mirror left ↔ right.
 */
export function relinkMask(layer: Layer, mask: ShapeMask | GradientMask, linked: boolean): Partial<ShapeMask> | Partial<GradientMask> {
  if (mask.linked === linked) return {};
  const t = layer.transform;
  const s = Math.abs(t.scale) || 1e-6;
  const k = linked ? 1 / s : s;
  const at = linked ? fromComp(layer, mask) : toComp(layer, mask);
  const mirrored = t.flipX !== t.flipY;
  if (mask.kind === 'gradient') {
    // CCW angle through the flip (its own inverse), then the clockwise rotZ.
    const flip = (a: number) => (mirrored ? (t.flipX ? 180 - a : -a) : t.flipX ? a + 180 : a);
    const angle = linked ? flip(mask.angle + t.rotZ) : flip(mask.angle) - t.rotZ;
    return { linked, x: r2(at.x), y: r2(at.y), angle: r1(wrap(angle)), length: r1(mask.length * k) };
  }
  // Clockwise turns: unlinked = rotZ + rot (+180 with both flips, a half turn); one flip: rotZ − rot (+180 for flipY), self-inverse in rot.
  const half = t.flipY ? 180 : 0;
  const rotation = mirrored ? t.rotZ - mask.rotation + half : linked ? mask.rotation - t.rotZ - half : mask.rotation + t.rotZ + half;
  const src = mask.source;
  const bubble = src.shape === 'speech' || src.shape === 'shout';
  const source = { ...src, size: r2(src.size * k), ...(mirrored ? { slant: -src.slant, tail: bubble ? { ...src.tail, x: -src.tail.x } : src.tail } : {}) };
  return { linked, x: r2(at.x), y: r2(at.y), rotation: r1(wrap(rotation)), source };
}

// ---------- gradient masks ----------

/**
 * Mask-space points of a gradient mask's line: `a` the start (opaque; the radial centre), `b`
 * the end (transparent), `mid` where it is half transparent, `inner` (radial) where the opaque
 * core ends. Linear: t runs a → b; radial: t runs from the inner edge out to `length`.
 */
export function gradientMaskLine(m: GradientMask): { a: Pt; b: Pt; mid: Pt; inner: Pt | null } {
  const dx = Math.cos(m.angle * DEG);
  const dy = Math.sin(m.angle * DEG);
  const at = (k: number): Pt => ({ x: m.x + dx * m.length * k, y: m.y + dy * m.length * k });
  const inner = m.shape === 'radial' ? m.inner : 0;
  return { a: at(0), b: at(1), mid: at(inner + m.mid * (1 - inner)), inner: m.shape === 'radial' ? at(inner) : null };
}

/** Start, angle and length of a line laid from mask-space `a` to `b`. */
export function gradientMaskFromLine(a: Pt, b: Pt): Pick<GradientMask, 'x' | 'y' | 'angle' | 'length'> {
  const angle = Math.atan2(b.y - a.y, b.x - a.x) / DEG;
  return { x: r2(a.x), y: r2(a.y), angle: r1(wrap(angle)), length: r1(Math.max(1, Math.hypot(b.x - a.x, b.y - a.y))) };
}

/** Mask-space `b` with the line from `a` turned to the nearest 15° as seen on the canvas (Shift), its length kept. */
export function snapOnCanvas(space: LayerView, a: Pt, b: Pt): Pt {
  const ac = space.toComp(a);
  const bc = space.toComp(b);
  const len = Math.hypot(bc.x - ac.x, bc.y - ac.y);
  const ang = Math.round(Math.atan2(bc.y - ac.y, bc.x - ac.x) / (15 * DEG)) * 15 * DEG;
  return space.fromComp({ x: ac.x + Math.cos(ang) * len, y: ac.y + Math.sin(ang) * len }) ?? b;
}

export type GradientMaskHandle = 'a' | 'b' | 'mid' | 'inner';

/**
 * Gradient mask fields after dragging a handle to mask-space `p`, from the gesture-start `m0`:
 * the start (linear: the end stays; radial: the centre moves, its radius stays), the end (angle
 * and length), the midpoint and the radial inner edge (along the line). `snap` (the mask's
 * space, Shift held) turns the line to 15° steps on the canvas.
 */
export function dragGradientMask(m0: GradientMask, which: GradientMaskHandle, p: Pt, snap: LayerView | null): Partial<GradientMask> {
  const line = gradientMaskLine(m0);
  switch (which) {
    case 'a':
      return m0.shape === 'radial' ? { x: r2(p.x), y: r2(p.y) } : gradientMaskFromLine(snap ? snapOnCanvas(snap, line.b, p) : p, line.b);
    case 'b': {
      const { angle, length } = gradientMaskFromLine(line.a, snap ? snapOnCanvas(snap, line.a, p) : p);
      return { angle, length };
    }
    case 'mid':
    case 'inner': {
      const t = ((p.x - m0.x) * Math.cos(m0.angle * DEG) + (p.y - m0.y) * Math.sin(m0.angle * DEG)) / Math.max(1e-6, m0.length);
      if (which === 'inner') return { inner: r3(clamp(t, 0, 0.99)) };
      const inner = m0.shape === 'radial' ? m0.inner : 0;
      return { mid: r3(clamp((t - inner) / Math.max(1e-6, 1 - inner), 0.01, 0.99)) };
    }
  }
}

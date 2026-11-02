import * as THREE from 'three';
import type { Comp, Layer, Transform } from '../../model/types';
import { useEditor } from '../../store/store';
import { oneShot } from '../util';
import { drag, press, type StageMap } from './drag';
import { compCamera, glyphPoint3, layerMatrix, type Pt } from './geometry';
import { snap, writeGlyphs, type TextLayer } from './glyphEdit';
import type { GlyphGizmoGeom } from './glyphs';
import { channelPlane, glyphRotation, layerRotation, trackball, type Channel, type RotationModel, type Vec3 } from './rotation3d';

// The shared 3D gizmo (Gizmo3D.tsx) of a 3D layer (Move tool) and of the picked glyphs of a 3D
// text (Per-letter tool): the same handles and gestures, through a target that says what is
// edited (the layer's transform / the glyphs' CharAdjust), where the pivot is, which way the
// move axes point and how its rotation channels compose (rotation3d.ts). Values share one
// convention: X / Y / Z move (+ right / up / toward the viewer) and rotation X / Y / Z (+ top
// toward the viewer / right side away / clockwise on screen): Transform x, y, z, rotX, rotY, rotZ
// and CharAdjust dx, dy, dz, tiltX, tiltY, rotate.
//
// On screen every direction is drawn as its true projection at the pivot, plus, as it turns
// toward the viewer and foreshortens, a growing share of its depth along the down-left diagonal
// (the front-view convention: an axis seen head-on is drawn there). The blend is continuous, so
// arrows and arcs turn smoothly with the object; an axis at least half across the view is drawn
// exactly as it points. Each rotation arc is the quarter of its gimbal ring between two of its
// frame's axes, drawn from those same arms.

export type Axis = Channel;
export type { Vec3 };

/** Free-rotate degrees per screen px of drag (the ring, ⌥-drag). */
const ROT_PER_PX = 0.4;
/** Shift snaps rotations to this many degrees. */
const ROT_SNAP = 15;
/** Screen length of a move arrow seen side-on, CSS px. */
export const ARM_PX = 70;
/** Radius of the rotation arcs seen face-on, CSS px. */
export const ARC_PX = 42;
/** Share of a head-on direction's depth (toward the viewer) drawn along the down-left diagonal. */
const DEPTH_SHARE = 0.5;
/** Projected length (share of the full arm) from which a direction is drawn as it truly points. */
const TRUE_FROM = 0.5;
const DIAG: Pt = { x: -Math.SQRT1_2, y: Math.SQRT1_2 };
/** Floor of an arrow's / arc's on-screen rate in the drag mapping, so a foreshortened handle never races. */
const MIN_ARM_PX = 24;
const MIN_ARC_RATE = 0.4 * ARC_PX;

const DEG = Math.PI / 180;
const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;
const wrap180 = (v: number) => ((((v + 180) % 360) + 360) % 360) - 180;

/** One gizmo gesture, as its History label names it. */
export type GizmoAction = 'Move X' | 'Move Y' | 'Move Z' | 'Move' | 'Rotate X' | 'Rotate Y' | 'Rotate Z' | 'Free rotate';
export const MOVE_ACTIONS = ['Move X', 'Move Y', 'Move Z'] as const;
export const ROTATE_ACTIONS = ['Rotate X', 'Rotate Y', 'Rotate Z'] as const;

/** The glyph labels of each action (`{chars}`: the picked characters). */
const GLYPH_LABELS: Record<GizmoAction, string> = {
  'Move X': 'Move X {chars}',
  'Move Y': 'Move Y {chars}',
  'Move Z': 'Move Z {chars}',
  Move: 'Move {chars}',
  'Rotate X': 'Rotate X {chars}',
  'Rotate Y': 'Rotate Y {chars}',
  'Rotate Z': 'Rotate Z {chars}',
  'Free rotate': 'Free rotate {chars}',
};

/** What the gizmo edits, as it was when made (gestures write from that state). */
export interface Gizmo3DTarget {
  /** Undo keys are made from it. */
  id: string;
  /** The pivot (gizmo centre), world space (comp px on z = 0). */
  origin: THREE.Vector3;
  /** World displacement per unit of the X / Y / Z move values. */
  axes: readonly [THREE.Vector3, THREE.Vector3, THREE.Vector3];
  /** How the rotation channels compose into an orientation. */
  rotation: RotationModel;
  /** Move values and rotations of the target (glyphs: the primary one). */
  pos: Vec3;
  rot: Vec3;
  unit: 'px' | '%';
  /** Shift step of the move values. */
  step: number;
  /** Write the gesture's result: `dPos` added to the move values, `dRot` to the rotations (values with a 0 delta stay as stored). */
  write(dPos: Vec3, dRot: Vec3, key: string, action: GizmoAction): void;
}

const UNIT = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)] as const;
/** No change. */
const NONE: Vec3 = [0, 0, 0];

/** A 3D layer's transform: comp axes about the layer's anchor. */
export function layerTarget(layer: Layer): Gizmo3DTarget {
  const t = layer.transform;
  return {
    id: layer.id,
    origin: new THREE.Vector3(t.x, t.y, t.z),
    axes: UNIT,
    rotation: layerRotation,
    pos: [t.x, t.y, t.z],
    rot: [t.rotX, t.rotY, t.rotZ],
    unit: 'px',
    step: 10,
    write(dPos, dRot, key, action) {
      const next: Transform = { ...t };
      if (dPos[0]) next.x = r2(t.x + dPos[0]);
      if (dPos[1]) next.y = r2(t.y + dPos[1]);
      if (dPos[2]) next.z = r2(t.z + dPos[2]);
      if (dRot[0]) next.rotX = r1(wrap180(t.rotX + dRot[0]));
      if (dRot[1]) next.rotY = r1(wrap180(t.rotY + dRot[1]));
      if (dRot[2]) next.rotZ = r1(wrap180(t.rotZ + dRot[2]));
      useEditor.getState().patchLayer(layer.id, { transform: next }, key, action);
    },
  };
}

/**
 * The picked glyphs of a 3D text: the layer's own axes (they turn with an orbited layer; Z
 * follows the oblique extrusion's skew), about the primary glyph's pivot on its front face.
 */
export function glyphTarget(layer: TextLayer, indices: readonly number[], gz: GlyphGizmoGeom): Gizmo3DTarget | null {
  if (layer.kind !== 'title3d' || !gz.pivotL || indices.length === 0) return null;
  const m = layerMatrix(layer);
  const m3 = new THREE.Matrix3().setFromMatrix4(m);
  // The layer's rotation and flip without its scale: the frame the glyph's tilts turn in.
  const s = Math.abs(layer.transform.scale) || 1e-6;
  const base = m3.clone().multiplyScalar(1 / s);
  const { x: kx, y: ky } = layer.style3d.skew;
  const chars0 = layer.source.chars;
  const a = chars0[indices[0]];
  const pz = glyphPoint3(layer, gz.pivotL, a, gz.pivotL, 0);
  const k = layer.source.size / 100;
  return {
    id: layer.id,
    origin: new THREE.Vector3(pz.p.x - kx * pz.z, pz.p.y - ky * pz.z, pz.z).applyMatrix4(m),
    axes: [new THREE.Vector3(k, 0, 0).applyMatrix3(m3), new THREE.Vector3(0, k, 0).applyMatrix3(m3), new THREE.Vector3(-kx * k, -ky * k, k).applyMatrix3(m3)],
    rotation: glyphRotation(base),
    pos: [a?.dx ?? 0, a?.dy ?? 0, a?.dz ?? 0],
    rot: [a?.tiltX ?? 0, a?.tiltY ?? 0, a?.rotate ?? 0],
    unit: '%',
    step: 5,
    write(dPos, dRot, key, action) {
      writeGlyphs(
        layer,
        chars0,
        [...indices],
        (c) => {
          const out = { ...c };
          if (dPos[0]) out.dx = r2(c.dx + dPos[0]);
          if (dPos[1]) out.dy = r2(c.dy + dPos[1]);
          if (dPos[2]) out.dz = r2((c.dz ?? 0) + dPos[2]);
          if (dRot[0]) out.tiltX = r1(wrap180((c.tiltX ?? 0) + dRot[0]));
          if (dRot[1]) out.tiltY = r1(wrap180((c.tiltY ?? 0) + dRot[1]));
          if (dRot[2]) out.rotate = r1(wrap180(c.rotate + dRot[2]));
          return out;
        },
        key,
        GLYPH_LABELS[action],
      );
    },
  };
}

/** A move arrow on screen: the drawn arrow from the centre (stage px), and the move-value change per px of drag along it. */
export interface GizmoArm {
  arm: Pt;
  /** Value change of a drag (gx, gy) screen px. */
  value(gx: number, gy: number): number;
}

/** A rotation arc on screen: the quarter ring c + cosθ·A + sinθ·B, θ 0→90° turning its channel positively. */
export interface GizmoArc {
  a: Pt;
  b: Pt;
}

/** The gizmo of a target on screen (stage px). */
export interface GizmoView {
  /** The pivot: stage px, and comp space. */
  c: Pt;
  at: Pt;
  arms: readonly [GizmoArm, GizmoArm, GizmoArm];
  arcs: readonly [GizmoArc, GizmoArc, GizmoArc];
  /** Move-value deltas of a drag by (gx, gy) screen px in the screen plane through the pivot. */
  plane(gx: number, gy: number): Vec3;
}

/** The comp camera's right / up axes (world unit vectors): the screen plane. */
function screenAxes(comp: Comp): { cam: THREE.PerspectiveCamera; right: THREE.Vector3; up: THREE.Vector3 } {
  const cam = compCamera(comp);
  return { cam, right: new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion), up: new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion) };
}

/** Where the gizmo of `target` sits and points on screen, or null (pivot behind the camera). */
export function gizmoView(comp: Comp, target: Gizmo3DTarget, stage: StageMap): GizmoView | null {
  const { cam, right, up } = screenAxes(comp);
  const hw = comp.width / 2;
  const hh = comp.height / 2;
  const v = new THREE.Vector3();
  const project = (w: THREE.Vector3): Pt | null => {
    v.copy(w).project(cam);
    return v.z > -1 && v.z < 1 ? { x: v.x * hw, y: v.y * hh } : null;
  };
  const at = project(target.origin);
  if (!at) return null;
  const c = stage.S(at);
  const q = new THREE.Vector3();
  /** Stage px per world unit along `dir` at the pivot (measured over about one world unit). */
  const rate = (dir: THREE.Vector3): Pt => {
    const h = 1 / (dir.length() || 1);
    const p = project(q.copy(target.origin).addScaledVector(dir, h));
    return p ? { x: ((p.x - at.x) / h) * stage.d, y: (-(p.y - at.y) / h) * stage.d } : { x: 0, y: 0 };
  };
  // Px per world unit across the view at the pivot: one scale for every direction, whatever the target's rotation.
  const ur = rate(right);
  const uu = rate(up);
  const k = Math.hypot(ur.x, ur.y) || 1e-9;
  const toViewer = cam.position.clone().sub(target.origin).normalize();
  /** The drawn arm of world unit direction `d`: its projection plus its depth share along the diagonal. */
  const drawn = (d: THREE.Vector3): Pt => {
    const p = rate(d);
    const fade = Math.max(0, 1 - Math.hypot(p.x, p.y) / k / TRUE_FROM) ** 2;
    const depth = DEPTH_SHARE * fade * d.dot(toViewer);
    return { x: ARM_PX * (p.x / k + depth * DIAG.x), y: ARM_PX * (p.y / k + depth * DIAG.y) };
  };
  const arm = (axis: THREE.Vector3): GizmoArm => {
    const len = axis.length() || 1e-9;
    const a = drawn(axis.clone().divideScalar(len));
    const n2 = Math.max(a.x * a.x + a.y * a.y, MIN_ARM_PX * MIN_ARM_PX);
    // Dragging the arrow's drawn length moves the target ARM_PX / k world units along the axis (exactly under the pointer for an axis across the view).
    return { arm: a, value: (gx, gy) => (((gx * a.x + gy * a.y) / n2) * (ARM_PX / k)) / len };
  };
  const arc = (i: Channel): GizmoArc => {
    const [a, b] = channelPlane(target.rotation, target.rot, i);
    return { a: drawn(a), b: drawn(b) };
  };
  const toValues = new THREE.Matrix4().makeBasis(target.axes[0], target.axes[1], target.axes[2]).invert();
  const det = ur.x * uu.y - ur.y * uu.x;
  return {
    c,
    at,
    arms: [arm(target.axes[0]), arm(target.axes[1]), arm(target.axes[2])],
    arcs: [arc(0), arc(1), arc(2)],
    plane(gx, gy) {
      if (Math.abs(det) < 1e-12) return [0, 0, 0];
      const a = (gx * uu.y - gy * uu.x) / det;
      const b = (ur.x * gy - ur.y * gx) / det;
      const w = right.clone().multiplyScalar(a).addScaledVector(up, b).applyMatrix4(toValues);
      return [w.x, w.y, w.z];
    },
  };
}

/** Drag an arrow (`axis`) or the centre square (null: the screen plane). Shift: the target's move steps. */
export function startGizmoMove(e: React.PointerEvent, target: Gizmo3DTarget, view: GizmoView, axis: Axis | null, onEnd: () => void) {
  const key = oneShot(`gizmo-move:${target.id}`);
  const sx = e.clientX;
  const sy = e.clientY;
  drag(
    e,
    (ev) => {
      const gx = ev.clientX - sx;
      const gy = ev.clientY - sy;
      let d: Vec3;
      if (axis === null) d = view.plane(gx, gy);
      else {
        const t = view.arms[axis].value(gx, gy);
        d = [axis === 0 ? t : 0, axis === 1 ? t : 0, axis === 2 ? t : 0];
      }
      if (ev.shiftKey) d = [snap(d[0], target.step), snap(d[1], target.step), snap(d[2], target.step)];
      target.write(d, NONE, key, axis === null ? 'Move' : MOVE_ACTIONS[axis]);
    },
    onEnd,
  );
}

/** A point of arc `arc` (stage px) at angle `th` (radians), on the ring of face-on radius ARC_PX. */
export const arcPoint = (c: Pt, arc: GizmoArc, th: number): Pt => {
  const r = ARC_PX / ARM_PX;
  return { x: c.x + r * (Math.cos(th) * arc.a.x + Math.sin(th) * arc.b.x), y: c.y + r * (Math.cos(th) * arc.a.y + Math.sin(th) * arc.b.y) };
};

/** The angle in [from, to] (radians) whose point of `arc` is nearest `p` (stage px), and its distance. */
function nearestOnArc(c: Pt, arc: GizmoArc, from: number, to: number, p: Pt): { th: number; dist: number } {
  let best = { th: from, dist: Infinity };
  for (let i = 0; i <= 60; i++) {
    const th = from + ((to - from) * i) / 60;
    const q = arcPoint(c, arc, th);
    const dist = Math.hypot(q.x - p.x, q.y - p.y);
    if (dist < best.dist) best = { th, dist };
  }
  return best;
}

/**
 * Drag a rotation arc: the angle turned is the angle swept along the ring (its whole ellipse on
 * screen, beyond the drawn quarter), so the object turns as far and the same way as the hand
 * goes, all the way round. Each move steps along the ring's tangent from the last angle, then
 * settles on the ring point nearest the pointer within ±45° of it (pointer near the ring), so the
 * angle never drifts from the hand. `toStage`: client px → stage px. Shift: 15° steps of the value.
 */
export function startGizmoRotate(e: React.PointerEvent, target: Gizmo3DTarget, view: GizmoView, axis: Axis, toStage: (x: number, y: number) => Pt, onEnd: () => void) {
  const key = oneShot(`gizmo-rot:${target.id}`);
  const { c } = view;
  const arc = view.arcs[axis];
  const r = ARC_PX / ARM_PX;
  const r0 = target.rot[axis];
  const o = toStage(0, 0);
  let th = nearestOnArc(c, arc, 0, Math.PI / 2, { x: e.clientX + o.x, y: e.clientY + o.y }).th;
  const th0 = th;
  let lx = e.clientX;
  let ly = e.clientY;
  drag(
    e,
    (ev) => {
      const tx = r * (-Math.sin(th) * arc.a.x + Math.cos(th) * arc.b.x);
      const ty = r * (-Math.sin(th) * arc.a.y + Math.cos(th) * arc.b.y);
      th += ((ev.clientX - lx) * tx + (ev.clientY - ly) * ty) / Math.max(tx * tx + ty * ty, MIN_ARC_RATE * MIN_ARC_RATE);
      lx = ev.clientX;
      ly = ev.clientY;
      const near = nearestOnArc(c, arc, th - Math.PI / 4, th + Math.PI / 4, { x: ev.clientX + o.x, y: ev.clientY + o.y });
      if (near.dist < ARC_PX * 0.6) th = near.th;
      let d = (th - th0) / DEG;
      if (ev.shiftKey) d = snap(r0 + d, ROT_SNAP) - r0;
      target.write(NONE, [axis === 0 ? d : 0, axis === 1 ? d : 0, axis === 2 ? d : 0], key, ROTATE_ACTIONS[axis]);
    },
    onEnd,
  );
}

/**
 * Free rotate (the ring, or ⌥-drag on the layer / glyph): a trackball. Dragging right turns the
 * object about the screen's up axis, down about its right axis (the front follows the pointer),
 * on top of its orientation at the press; the result is written back as the target's own
 * rotation channels, the solution nearest the previous one so no value flips. Shift: 15° steps
 * of the turn. A press without travel is `onClick`.
 */
export function startFreeRotate(e: React.PointerEvent, target: Gizmo3DTarget, comp: Comp, onClick?: () => void, onEnd?: () => void) {
  const key = oneShot(`gizmo-free:${target.id}`);
  const { right, up } = screenAxes(comp);
  const sx = e.clientX;
  const sy = e.clientY;
  const w0 = target.rotation.orient(target.rot);
  let prev = target.rot;
  press(e, {
    onClick,
    onDrag: (ev) => {
      let alpha = (ev.clientX - sx) * ROT_PER_PX;
      let beta = (ev.clientY - sy) * ROT_PER_PX;
      if (ev.shiftKey) {
        alpha = snap(alpha, ROT_SNAP);
        beta = snap(beta, ROT_SNAP);
      }
      prev = target.rotation.fromOrient(trackball(w0, right, up, alpha, beta), prev);
      target.write(NONE, [prev[0] - target.rot[0], prev[1] - target.rot[1], prev[2] - target.rot[2]], key, 'Free rotate');
    },
    onEnd,
  });
}

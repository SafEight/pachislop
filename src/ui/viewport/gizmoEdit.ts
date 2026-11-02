import * as THREE from 'three';
import type { Comp, Layer, Transform } from '../../model/types';
import { useEditor } from '../../store/store';
import { oneShot } from '../util';
import { drag, press, type StageMap } from './drag';
import { compCamera, glyphPoint3, layerMatrix, type Pt } from './geometry';
import { snap, writeGlyphs, type TextLayer } from './glyphEdit';
import type { GlyphGizmoGeom } from './glyphs';

// The shared 3D gizmo (Gizmo3D.tsx) of a 3D layer (Move tool) and of the picked glyphs of a 3D
// text (Per-letter tool): the same handles and gestures, through a target that says what is
// edited (the layer's transform / the glyphs' CharAdjust), where the pivot is and which way the
// axes point. Values share one convention: X / Y / Z move (+ right / up / toward the viewer) and
// rotation X / Y / Z (+ top toward the viewer / right side away / clockwise on screen):
// Transform x, y, z, rotX, rotY, rotZ and CharAdjust dx, dy, dz, tiltX, tiltY, rotate.

export type Axis = 0 | 1 | 2;
export type Vec3 = readonly [number, number, number];

/** Rotation degrees per screen px of drag (rotation arcs, the free-rotate ring, ⌥-drag). */
const ROT_PER_PX = 0.4;
/** Shift snaps rotations to this many degrees. */
const ROT_SNAP = 15;
/** Screen length of a move arrow seen side-on, CSS px. */
export const ARM_PX = 70;
/** An arrow shorter than this on screen (an axis seen head-on) is drawn on the fixed diagonal. */
const FORESHORTENED_PX = 20;
/** Length of an arrow drawn on the diagonal, CSS px. */
const DIAG_PX = 52;

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
  /** −1 where a rotation turns the other way on screen (glyphs of a mirrored layer). */
  turn: Vec3;
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
    turn: [1, 1, 1],
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

/** Largest glyph tilt (rotation X / Y), as in the Letters section. */
const TILT_MAX = 89;
const clampTilt = (v: number) => r1(Math.max(-TILT_MAX, Math.min(TILT_MAX, v)));

/**
 * The picked glyphs of a 3D text: the layer's own axes (they turn with an orbited layer; Z
 * follows the oblique extrusion's skew), about the primary glyph's pivot on its front face.
 */
export function glyphTarget(layer: TextLayer, indices: readonly number[], gz: GlyphGizmoGeom): Gizmo3DTarget | null {
  if (layer.kind !== 'title3d' || !gz.pivotL || indices.length === 0) return null;
  const m = layerMatrix(layer);
  const m3 = new THREE.Matrix3().setFromMatrix4(m);
  const { x: kx, y: ky } = layer.style3d.skew;
  const chars0 = layer.source.chars;
  const a = chars0[indices[0]];
  const pz = glyphPoint3(layer, gz.pivotL, a, gz.pivotL, 0);
  const k = layer.source.size / 100;
  const { flipX, flipY } = layer.transform;
  return {
    id: layer.id,
    origin: new THREE.Vector3(pz.p.x - kx * pz.z, pz.p.y - ky * pz.z, pz.z).applyMatrix4(m),
    axes: [new THREE.Vector3(k, 0, 0).applyMatrix3(m3), new THREE.Vector3(0, k, 0).applyMatrix3(m3), new THREE.Vector3(-kx * k, -ky * k, k).applyMatrix3(m3)],
    // The tilts and the rotate turn in layer space: a mirrored axis turns them the other way on screen.
    turn: [flipY ? -1 : 1, flipX ? -1 : 1, flipX !== flipY ? -1 : 1],
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
          if (dRot[0]) out.tiltX = clampTilt((c.tiltX ?? 0) + dRot[0]);
          if (dRot[1]) out.tiltY = clampTilt((c.tiltY ?? 0) + dRot[1]);
          if (dRot[2]) out.rotate = r1(wrap180(c.rotate + dRot[2]));
          return out;
        },
        key,
        GLYPH_LABELS[action],
      );
    },
  };
}

/** A move arrow on screen: `u` = stage px per unit of its value, `arm` = the drawn arrow from the centre; `diag`: seen head-on, drawn on the down-left diagonal. */
export interface GizmoArm {
  u: Pt;
  arm: Pt;
  diag: boolean;
}

/** The gizmo of a target on screen (stage px). */
export interface GizmoView {
  /** The pivot: stage px, and comp space. */
  c: Pt;
  at: Pt;
  arms: readonly [GizmoArm, GizmoArm, GizmoArm];
  /** Move-value deltas of a drag by (gx, gy) screen px in the screen plane through the pivot. */
  plane(gx: number, gy: number): Vec3;
}

/** Where the gizmo of `target` sits and points on screen, or null (pivot behind the camera, degenerate axes). */
export function gizmoView(comp: Comp, target: Gizmo3DTarget, stage: StageMap): GizmoView | null {
  const cam = compCamera(comp);
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
  /** Stage px per unit along world `dir` (measured over about one world unit). */
  const rate = (dir: THREE.Vector3): Pt | null => {
    const h = 1 / (dir.length() || 1);
    const p = project(q.copy(target.origin).addScaledVector(dir, h));
    return p && { x: ((p.x - at.x) / h) * stage.d, y: (-(p.y - at.y) / h) * stage.d };
  };
  const us = target.axes.map(rate);
  if (us.some((u) => !u)) return null;
  const rates = us as Pt[];
  // Px per value unit of the least foreshortened axis: the arrows' common scale.
  const k = Math.max(...rates.map((u) => Math.hypot(u.x, u.y)));
  if (!(k > 1e-9)) return null;
  const toViewer = cam.position.clone().sub(target.origin);
  const arm = (u: Pt, i: number): GizmoArm => {
    const a = { x: (u.x / k) * ARM_PX, y: (u.y / k) * ARM_PX };
    if (Math.hypot(a.x, a.y) >= FORESHORTENED_PX) return { u, arm: a, diag: false };
    // Seen head-on: the front-view convention, toward the viewer = down-left.
    const s = target.axes[i].dot(toViewer) < 0 ? -1 : 1;
    const dir = { x: -s * Math.SQRT1_2, y: s * Math.SQRT1_2 };
    return { u: { x: dir.x * k, y: dir.y * k }, arm: { x: dir.x * DIAG_PX, y: dir.y * DIAG_PX }, diag: true };
  };
  // The screen plane: the camera's right / up through the pivot, mapped back onto the move values.
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
  const ur = rate(right);
  const uu = rate(up);
  const toValues = new THREE.Matrix4().makeBasis(target.axes[0], target.axes[1], target.axes[2]).invert();
  const det = ur && uu ? ur.x * uu.y - ur.y * uu.x : 0;
  return {
    c,
    at,
    arms: [arm(rates[0], 0), arm(rates[1], 1), arm(rates[2], 2)],
    plane(gx, gy) {
      if (!ur || !uu || Math.abs(det) < 1e-12) return [0, 0, 0];
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
        const { u } = view.arms[axis];
        const t = (gx * u.x + gy * u.y) / (u.x * u.x + u.y * u.y);
        d = [axis === 0 ? t : 0, axis === 1 ? t : 0, axis === 2 ? t : 0];
      }
      if (ev.shiftKey) d = [snap(d[0], target.step), snap(d[1], target.step), snap(d[2], target.step)];
      target.write(d, NONE, key, axis === null ? 'Move' : MOVE_ACTIONS[axis]);
    },
    onEnd,
  );
}

/**
 * Drag a rotation arc: X follows vertical travel (down = top toward the viewer), Y horizontal
 * travel (right = the front turns right), Z the angle around the pivot `c` (client px). Shift:
 * 15° steps of the value.
 */
export function startGizmoRotate(e: React.PointerEvent, target: Gizmo3DTarget, axis: Axis, c: Pt, onEnd: () => void) {
  const key = oneShot(`gizmo-rot:${target.id}`);
  const sx = e.clientX;
  const sy = e.clientY;
  const r0 = target.rot[axis];
  let last = Math.atan2(sy - c.y, sx - c.x) / DEG;
  let turned = 0;
  drag(
    e,
    (ev) => {
      if (axis === 2) {
        const a = Math.atan2(ev.clientY - c.y, ev.clientX - c.x) / DEG;
        turned += wrap180(a - last);
        last = a;
      }
      let d = target.turn[axis] * (axis === 0 ? (ev.clientY - sy) * ROT_PER_PX : axis === 1 ? (ev.clientX - sx) * ROT_PER_PX : turned);
      if (ev.shiftKey) d = snap(r0 + d, ROT_SNAP) - r0;
      target.write(NONE, [axis === 0 ? d : 0, axis === 1 ? d : 0, axis === 2 ? d : 0], key, ROTATE_ACTIONS[axis]);
    },
    onEnd,
  );
}

/**
 * Free rotate (the ring, or ⌥-drag on the layer / glyph): rotation X and Y together, like a
 * trackball (the front follows the pointer). Shift: 15° steps. A press without travel is `onClick`.
 */
export function startFreeRotate(e: React.PointerEvent, target: Gizmo3DTarget, onClick?: () => void, onEnd?: () => void) {
  const key = oneShot(`gizmo-free:${target.id}`);
  const sx = e.clientX;
  const sy = e.clientY;
  const [x0, y0] = target.rot;
  press(e, {
    onClick,
    onDrag: (ev) => {
      let dx = target.turn[0] * (ev.clientY - sy) * ROT_PER_PX;
      let dy = target.turn[1] * (ev.clientX - sx) * ROT_PER_PX;
      if (ev.shiftKey) {
        dx = snap(x0 + dx, ROT_SNAP) - x0;
        dy = snap(y0 + dy, ROT_SNAP) - y0;
      }
      target.write(NONE, [dx, dy, 0], key, 'Free rotate');
    },
    onEnd,
  });
}

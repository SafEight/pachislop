import * as THREE from 'three';

// Rotation channels of the 3D gizmo as matrices: a layer's rotX / rotY / rotZ and a glyph's
// tiltX / tiltY / rotate, each an Euler composition (degrees), to world orientation and back.
// Pure (no editor state), so the trackball round trip is unit-tested.
//
// Layer (Layer3DRenderer / layerMatrix): R = Rz(−rotZ)·Ry(rotY)·Rx(rotX), three's 'ZYX' with
// (rotX, rotY, −rotZ): rotZ (clockwise on screen) is outermost, about the comp's Z.
// Glyph (Layer3DRenderer rigMatrix, glyphPoint3, the layout's rotate): G = Ry(tiltY)·Rx(tiltX)·
// Rz(−rotate), three's 'YXZ' with (tiltX, tiltY, −rotate), inside the layer: world = B·G with B
// the layer's rotation and flip. The rotate turns about the same pivot line as the tilts (the
// glyph centre, along z), so writing all three never moves the glyph.

export type Vec3 = readonly [number, number, number];
export type Channel = 0 | 1 | 2;

const DEG = Math.PI / 180;

/** A target's rotation channels [X, Y, Z] (degrees) ↔ its world orientation. */
export interface RotationModel {
  /** World orientation of channel values `rot` (orthonormal; improper on a mirrored layer). */
  orient(rot: Vec3): THREE.Matrix3;
  /** Channel values of world orientation `w`: of the two Euler solutions, the one nearest `near`, each channel unwrapped toward it. */
  fromOrient(w: THREE.Matrix3, near: Vec3): Vec3;
  /** Channels from outermost to innermost (a channel's axis turns with the channels outside it). */
  nesting: readonly [Channel, Channel, Channel];
}

const m4 = new THREE.Matrix4();
const euler = new THREE.Euler();

/** Three's Euler `order` of (x, y, z) radians as a Matrix3. */
function eulerMatrix(x: number, y: number, z: number, order: 'ZYX' | 'YXZ'): THREE.Matrix3 {
  return new THREE.Matrix3().setFromMatrix4(m4.makeRotationFromEuler(euler.set(x, y, z, order)));
}

/** Three's Euler angles (degrees, [x, y, z]) of rotation matrix `r`, and the other solution. */
function eulerSolutions(r: THREE.Matrix3, order: 'ZYX' | 'YXZ'): [Vec3, Vec3] {
  m4.setFromMatrix3(r);
  euler.setFromRotationMatrix(m4, order);
  const [x, y, z] = [euler.x / DEG, euler.y / DEG, euler.z / DEG];
  // Tait–Bryan Ra(α)·Rb(β)·Rc(γ) equals Ra(α+180)·Rb(180−β)·Rc(γ+180): the middle axis is y for ZYX, x for YXZ.
  return [[x, y, z], order === 'ZYX' ? [x + 180, 180 - y, z + 180] : [180 - x, y + 180, z + 180]];
}

/** `v` moved by whole turns to within 180° of `near`. */
const unwrapTo = (v: number, near: number) => v + 360 * Math.round((near - v) / 360);

/** Of `candidates`, unwrapped toward `near`, the one closest to it. */
export function nearestBranch(candidates: readonly Vec3[], near: Vec3): Vec3 {
  let best: Vec3 = candidates[0];
  let bestD = Infinity;
  for (const c of candidates) {
    const u: Vec3 = [unwrapTo(c[0], near[0]), unwrapTo(c[1], near[1]), unwrapTo(c[2], near[2])];
    const d = Math.abs(u[0] - near[0]) + Math.abs(u[1] - near[1]) + Math.abs(u[2] - near[2]);
    if (d < bestD) {
      bestD = d;
      best = u;
    }
  }
  return best;
}

/** A 3D layer's rotX / rotY / rotZ. */
export const layerRotation: RotationModel = {
  orient: ([x, y, z]) => eulerMatrix(x * DEG, y * DEG, -z * DEG, 'ZYX'),
  fromOrient(w, near) {
    const [a, b] = eulerSolutions(w, 'ZYX');
    return nearestBranch(
      [a, b].map((s): Vec3 => [s[0], s[1], -s[2]]),
      near,
    );
  },
  nesting: [2, 1, 0],
};

/** A glyph's tiltX / tiltY / rotate inside a layer whose rotation and flip are `base` (orthonormal). */
export function glyphRotation(base: THREE.Matrix3): RotationModel {
  const inv = base.clone().invert();
  return {
    orient: ([x, y, z]) => base.clone().multiply(eulerMatrix(x * DEG, y * DEG, -z * DEG, 'YXZ')),
    fromOrient(w, near) {
      const [a, b] = eulerSolutions(inv.clone().multiply(w), 'YXZ');
      return nearestBranch(
        [a, b].map((s): Vec3 => [s[0], s[1], -s[2]]),
        near,
      );
    },
    nesting: [1, 0, 2],
  };
}

/** The world axis (unit, right-handed) that channel `i` turns about: +1° on it turns +1° about this axis. */
export function channelAxis(model: RotationModel, rot: Vec3, i: Channel): THREE.Vector3 {
  const h = 0.01;
  const w0 = model.orient(rot);
  const w1 = model.orient([rot[0] + (i === 0 ? h : 0), rot[1] + (i === 1 ? h : 0), rot[2] + (i === 2 ? h : 0)]);
  // w1·w0ᵀ = I + h·[ω]× for the small turn (w0 orthonormal, so its inverse is its transpose).
  const e = w1.multiply(w0.transpose()).elements; // column-major
  return new THREE.Vector3(e[5] - e[7], e[6] - e[2], e[1] - e[3]).normalize();
}

/**
 * Two world directions spanning the plane channel `i` turns in, A→B turning positively about
 * its axis: the frame of the channels outside it (the gimbal ring), its other two axes.
 */
export function channelPlane(model: RotationModel, rot: Vec3, i: Channel): [THREE.Vector3, THREE.Vector3] {
  const inner = model.nesting.slice(model.nesting.indexOf(i));
  const frame = model.orient([inner.includes(0) ? 0 : rot[0], inner.includes(1) ? 0 : rot[1], inner.includes(2) ? 0 : rot[2]]);
  const col = (k: number) => new THREE.Vector3().setFromMatrix3Column(frame, k).normalize();
  const a = col((i + 1) % 3);
  const b = col((i + 2) % 3);
  return a.clone().cross(b).dot(channelAxis(model, rot, i)) >= 0 ? [a, b] : [b, a];
}

/**
 * Trackball: `w0` turned by `alpha` degrees about the screen's up axis then `beta` about its right
 * axis (world unit vectors), applied in world space (on the left).
 */
export function trackball(w0: THREE.Matrix3, right: THREE.Vector3, up: THREE.Vector3, alpha: number, beta: number): THREE.Matrix3 {
  const q = new THREE.Quaternion().setFromAxisAngle(up, alpha * DEG).multiply(new THREE.Quaternion().setFromAxisAngle(right, beta * DEG));
  return new THREE.Matrix3().setFromMatrix4(m4.makeRotationFromQuaternion(q)).multiply(w0);
}

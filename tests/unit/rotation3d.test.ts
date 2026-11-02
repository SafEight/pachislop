import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { arcPlane, glyphRotation, layerRotation, trackball, turnAbout, type Frame, type RotationModel, type Vec3 } from '../../src/ui/viewport/rotation3d';

const close = (a: THREE.Matrix3, b: THREE.Matrix3) => a.elements.forEach((v, i) => expect(v).toBeCloseTo(b.elements[i], 6));
const RIGHT = new THREE.Vector3(1, 0, 0);
const UP = new THREE.Vector3(0, 1, 0);
// A mirrored (flipX), turned layer: the frame a glyph's tilts turn in.
const mirrored = new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(0.7, -0.4, 0.3, 'ZYX'))).multiply(new THREE.Matrix3().set(-1, 0, 0, 0, 1, 0, 0, 0, 1));
const columns = (m: THREE.Matrix3): Frame => [0, 1, 2].map((i) => new THREE.Vector3().setFromMatrix3Column(m, i)) as unknown as Frame;
const COMP: Frame = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];
// Each target with its gizmo frame: the comp's axes for a layer, the layer's own axes for a glyph.
const models: [string, RotationModel, Frame][] = [
  ['layer', layerRotation, COMP],
  ['glyph on a mirrored layer', glyphRotation(mirrored), columns(mirrored)],
];
const poses: Vec3[] = [
  [0, 0, 0],
  [60, 40, 45],
  [-120, 75, 170],
  [179, -30, -179],
];

describe.each(models)('rotation channels of a %s', (_, model, frame) => {
  it.each(poses)('read back from their orientation (%d, %d, %d)', (...rot) => {
    const got = model.fromOrient(model.orient(rot), rot);
    got.forEach((v, i) => expect(v).toBeCloseTo(rot[i], 6));
  });

  it('a trackball drag written back as channels gives the dragged orientation', () => {
    for (const rot of poses) {
      const w = trackball(model.orient(rot), RIGHT, UP, 35, -50);
      close(model.orient(model.fromOrient(w, rot)), w);
    }
  });

  it('stays continuous through a long drag: no step jumps a value by more than the turn itself', () => {
    const rot0: Vec3 = [60, 40, 45];
    const w0 = model.orient(rot0);
    let prev = rot0;
    for (let px = 1; px <= 900; px++) {
      const next = model.fromOrient(trackball(w0, RIGHT, UP, px * 0.4, px * 0.15), prev);
      for (let i = 0; i < 3; i++) expect(Math.abs(next[i] - prev[i])).toBeLessThan(20);
      prev = next;
    }
  });

  it('an arc turns the object about its fixed frame axis, read back as channels', () => {
    for (const rot of poses)
      for (const i of [0, 1, 2] as const) {
        const { n } = arcPlane(frame, i);
        const w0 = model.orient(rot);
        const w = turnAbout(w0, n, 70);
        close(model.orient(model.fromOrient(w, rot)), w);
        // The turn is about n: n stays where it is, so the arc around it never moves.
        const q = w.clone().multiply(w0.clone().transpose());
        expect(n.clone().applyMatrix3(q).dot(n)).toBeCloseTo(1, 6);
      }
  });

  it('a full arc sweep stays continuous and comes back to the start', () => {
    for (const i of [0, 1, 2] as const) {
      const rot0: Vec3 = [60, 40, 45];
      const w0 = model.orient(rot0);
      const { n } = arcPlane(frame, i);
      let prev = rot0;
      for (let deg = 1; deg <= 360; deg++) {
        const next = model.fromOrient(turnAbout(w0, n, deg), prev);
        for (let k = 0; k < 3; k++) expect(Math.abs(next[k] - prev[k])).toBeLessThan(20);
        prev = next;
      }
      close(model.orient(prev), w0);
    }
  });

  it('arc geometry comes from the frame alone: A→B runs positively about n, the same at any rotation', () => {
    for (const i of [0, 1, 2] as const) {
      const { a, b, n } = arcPlane(frame, i);
      expect(a.dot(b)).toBeCloseTo(0, 6);
      expect(Math.abs(n.dot(frame[i]))).toBeCloseTo(1, 6);
      // A quarter turn about n carries A onto B: the object follows the pointer from A to B.
      expect(a.clone().applyMatrix3(turnAbout(new THREE.Matrix3(), n, 90)).dot(b)).toBeCloseTo(1, 6);
    }
  });
});

describe('a layer and a glyph on an unturned layer turn alike', () => {
  it('the same arc turn writes the same rotation values', () => {
    const glyph = glyphRotation(new THREE.Matrix3());
    for (const i of [0, 1, 2] as const) {
      const { n } = arcPlane(COMP, i);
      const w = turnAbout(new THREE.Matrix3(), n, 30);
      const want: Vec3 = [i === 0 ? 30 : 0, i === 1 ? 30 : 0, i === 2 ? -30 : 0]; // rotZ / rotate are clockwise-positive
      for (const model of [layerRotation, glyph]) model.fromOrient(w, [0, 0, 0]).forEach((v, k) => expect(v).toBeCloseTo(want[k], 6));
    }
  });
});

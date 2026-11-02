import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { ARM_PX, SCHEMATIC_ARMS, armTravel, compAxis, glyphRotation, layerRotation, moveValues, trackball, turnAbout, type RotationModel, type Vec3 } from '../../src/ui/viewport/rotation3d';

const close = (a: THREE.Matrix3, b: THREE.Matrix3) => a.elements.forEach((v, i) => expect(v).toBeCloseTo(b.elements[i], 6));
const RIGHT = new THREE.Vector3(1, 0, 0);
const UP = new THREE.Vector3(0, 1, 0);
// A mirrored (flipX), turned layer: the frame a glyph's tilts turn in.
const mirrored = new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(0.7, -0.4, 0.3, 'ZYX'))).multiply(new THREE.Matrix3().set(-1, 0, 0, 0, 1, 0, 0, 0, 1));
const models: [string, RotationModel][] = [
  ['layer', layerRotation],
  ['glyph on a turned, mirrored layer', glyphRotation(mirrored)],
];
const poses: Vec3[] = [
  [0, 0, 0],
  [60, 40, 45],
  [-120, 75, 170],
  [179, -30, -179],
];

describe.each(models)('rotation channels of a %s', (_, model) => {
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

  it('an arc turns the object about its comp axis, read back as channels', () => {
    for (const rot of poses)
      for (const i of [0, 1, 2] as const) {
        const n = compAxis(i);
        const w0 = model.orient(rot);
        const w = turnAbout(w0, n, 70);
        close(model.orient(model.fromOrient(w, rot)), w);
        // The turn is about n: n stays where it is.
        const q = w.clone().multiply(w0.clone().transpose());
        expect(n.clone().applyMatrix3(q).dot(n)).toBeCloseTo(1, 6);
      }
  });

  it('a full arc sweep stays continuous and comes back to the start', () => {
    for (const i of [0, 1, 2] as const) {
      const rot0: Vec3 = [60, 40, 45];
      const w0 = model.orient(rot0);
      const n = compAxis(i);
      let prev = rot0;
      for (let deg = 1; deg <= 360; deg++) {
        const next = model.fromOrient(turnAbout(w0, n, deg), prev);
        for (let k = 0; k < 3; k++) expect(Math.abs(next[k] - prev[k])).toBeLessThan(20);
        prev = next;
      }
      close(model.orient(prev), w0);
    }
  });
});

describe('the comp frame and the drawn schematic', () => {
  it('the arms are a constant schematic: X right, Y up, Z on the down-left diagonal', () => {
    expect(SCHEMATIC_ARMS[0]).toEqual({ x: ARM_PX, y: 0 });
    expect(SCHEMATIC_ARMS[1]).toEqual({ x: 0, y: -ARM_PX });
    expect(SCHEMATIC_ARMS[2].x).toBeCloseTo(-SCHEMATIC_ARMS[2].y, 9);
    expect(SCHEMATIC_ARMS[2].x).toBeLessThan(0);
  });

  it('drag travel along an arm maps to world distance at the pivot rate, Z at the X rate', () => {
    const k = 0.75; // screen px per world unit at the pivot
    expect(armTravel(0, 30, 0, k)).toBeCloseTo(40, 9);
    expect(armTravel(1, 0, -30, k)).toBeCloseTo(40, 9);
    // 30 px down-left along the diagonal: toward the viewer, at the same rate as X.
    expect(armTravel(2, -30 * Math.SQRT1_2, 30 * Math.SQRT1_2, k)).toBeCloseTo(40, 9);
    // Travel across an arm moves nothing along it.
    expect(armTravel(0, 0, 25, k)).toBeCloseTo(0, 9);
  });

  it('each arc runs from the next axis to the one after (cyclic), positively about its own', () => {
    for (const i of [0, 1, 2] as const) {
      const a = compAxis(((i + 1) % 3) as 0 | 1 | 2);
      const b = compAxis(((i + 2) % 3) as 0 | 1 | 2);
      // A quarter turn about the axis carries A onto B: the object follows the pointer along the drawn arc from A to B.
      expect(a.applyMatrix3(turnAbout(new THREE.Matrix3(), compAxis(i), 90)).dot(b)).toBeCloseTo(1, 6);
    }
  });

  it('a letter on a turned, mirrored layer turns about the comp Y axis: its tilts become L⁻¹·R·L·G0', () => {
    const glyph = glyphRotation(mirrored);
    const rot0: Vec3 = [20, -35, 10];
    const turned = glyph.fromOrient(turnAbout(glyph.orient(rot0), compAxis(1), 50), rot0);
    // In world: exactly the comp-Y turn of the letter.
    const ry = new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationY((50 * Math.PI) / 180));
    close(glyph.orient(turned), ry.clone().multiply(glyph.orient(rot0)));
    // Inside the layer: the turn conjugated by the layer's rotation and flip.
    const local = (rot: Vec3) => mirrored.clone().invert().multiply(glyph.orient(rot));
    close(local(turned), mirrored.clone().invert().multiply(ry).multiply(mirrored).multiply(local(rot0)));
  });

  it('a move along comp X becomes the letter values that move it straight along X', () => {
    // A letter's dx / dy / dz through a turned, mirrored, scaled layer with an oblique extrusion.
    const k = 2.4; // 1 % of a 160 px size × scale 1.5
    const m3 = mirrored.clone().multiplyScalar(1.5);
    const axes = [new THREE.Vector3(k, 0, 0).applyMatrix3(m3), new THREE.Vector3(0, k, 0).applyMatrix3(m3), new THREE.Vector3(-0.3 * k, 0.1 * k, k).applyMatrix3(m3)] as const;
    const v = moveValues(axes, new THREE.Vector3(10, 0, 0));
    const moved = axes[0].clone().multiplyScalar(v[0]).addScaledVector(axes[1], v[1]).addScaledVector(axes[2], v[2]);
    expect(moved.x).toBeCloseTo(10, 6);
    expect(moved.y).toBeCloseTo(0, 6);
    expect(moved.z).toBeCloseTo(0, 6);
    // On a turned layer that takes more than one of the letter's own values.
    expect(v.filter((x) => Math.abs(x) > 1e-6).length).toBeGreaterThan(1);
  });

  it('a layer and a letter on an unturned layer write the same rotation values for the same arc turn', () => {
    const glyph = glyphRotation(new THREE.Matrix3());
    for (const i of [0, 1, 2] as const) {
      const w = turnAbout(new THREE.Matrix3(), compAxis(i), 30);
      const want: Vec3 = [i === 0 ? 30 : 0, i === 1 ? 30 : 0, i === 2 ? -30 : 0]; // rotZ / rotate are clockwise-positive
      for (const model of [layerRotation, glyph]) model.fromOrient(w, [0, 0, 0]).forEach((v, k) => expect(v).toBeCloseTo(want[k], 6));
    }
  });
});

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { channelAxis, channelPlane, glyphRotation, layerRotation, trackball, type RotationModel, type Vec3 } from '../../src/ui/viewport/rotation3d';

const close = (a: THREE.Matrix3, b: THREE.Matrix3) => a.elements.forEach((v, i) => expect(v).toBeCloseTo(b.elements[i], 6));
const RIGHT = new THREE.Vector3(1, 0, 0);
const UP = new THREE.Vector3(0, 1, 0);
// A mirrored (flipX), turned layer: the frame a glyph's tilts turn in.
const mirrored = new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(0.7, -0.4, 0.3, 'ZYX'))).multiply(new THREE.Matrix3().set(-1, 0, 0, 0, 1, 0, 0, 0, 1));
const models: [string, RotationModel][] = [
  ['layer', layerRotation],
  ['glyph on a mirrored layer', glyphRotation(mirrored)],
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

  it('turns +1° of a channel as +1° about its axis, and its arc runs A→B the same way', () => {
    for (const rot of poses)
      for (const i of [0, 1, 2] as const) {
        const [a, b] = channelPlane(model, rot, i);
        expect(a.dot(b)).toBeCloseTo(0, 6);
        expect(a.clone().cross(b).dot(channelAxis(model, rot, i))).toBeCloseTo(1, 4);
        // The axis does not move as its own channel turns (a gimbal ring).
        const turned: Vec3 = [rot[0] + (i === 0 ? 50 : 0), rot[1] + (i === 1 ? 50 : 0), rot[2] + (i === 2 ? 50 : 0)];
        expect(channelAxis(model, turned, i).dot(channelAxis(model, rot, i))).toBeCloseTo(1, 4);
      }
  });
});

describe('the layer and a glyph on an unturned layer share their conventions', () => {
  it('each channel turns about the same world axis', () => {
    const glyph = glyphRotation(new THREE.Matrix3());
    for (const i of [0, 1, 2] as const) expect(channelAxis(glyph, [0, 0, 0], i).dot(channelAxis(layerRotation, [0, 0, 0], i))).toBeCloseTo(1, 6);
    // rotZ / rotate are clockwise on screen: about −Z.
    expect(channelAxis(layerRotation, [0, 0, 0], 2).z).toBeCloseTo(-1, 6);
  });
});

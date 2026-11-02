import { readFileSync } from 'node:fs';
import opentype from 'opentype.js';
import { describe, expect, it } from 'vitest';
import type { FontEntry } from '../../src/assets/registry';
import { offsetShapes, type Contour, type ShapeContours } from '../../src/engine/three/outline';
import { BEVEL_SLOT, buildTitle, textShapes } from '../../src/engine/three/title';
import { bevel3D, createTitle3DLayer } from '../../src/model/defaults';

// An outward bevel (extrude.ts extrudeOutward) fills the space between Clipper offset rings with
// earcut. Rings closer than the outline precision, or touching shapes, used to make earcut fill
// across the glyph: bevel triangles over the face and in its notches (the white wedges in a 虹
// Rainbow Paint "E" at 100 % zoom).

function font(file: string): FontEntry {
  const data = readFileSync(`public/fonts/${file}`);
  const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  return { id: file, name: file, data: buffer, font: opentype.parse(buffer), builtin: true };
}

const area = (c: Contour) => {
  let s = 0;
  for (let i = 0, j = c.length - 1; i < c.length; j = i++) s += c[j].x * c[i].y - c[i].x * c[j].y;
  return Math.abs(s) / 2;
};
const shapesArea = (shapes: ShapeContours[]) => shapes.reduce((s, sh) => s + area(sh.outer) - sh.holes.reduce((h, c) => h + area(c), 0), 0);

function inside(c: Contour, x: number, y: number): boolean {
  let r = false;
  for (let i = 0, j = c.length - 1; i < c.length; j = i++) {
    const a = c[i], b = c[j];
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) r = !r;
  }
  return r;
}

function edgeDistance(c: Contour, x: number, y: number): number {
  let best = Infinity;
  for (let i = 0, j = c.length - 1; i < c.length; j = i++) {
    const a = c[j], b = c[i];
    const ex = b.x - a.x, ey = b.y - a.y;
    const len2 = ex * ex + ey * ey;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - a.x) * ex + (y - a.y) * ey) / len2)) : 0;
    best = Math.min(best, Math.hypot(a.x + ex * t - x, a.y + ey * t - y));
  }
  return best;
}

/** A finely faceted round outward bevel on `text`, built at `outputScale`: bevel area vs the ring area, and bevel area over the face. */
function measure(file: string, text: string, size: number, outputScale: number) {
  const layer = createTitle3DLayer(text);
  if (layer.source.kind !== 'text') throw new Error('text layer expected');
  const source = { ...layer.source, text, size };
  const p = { ...layer.style3d, curveSegments: 10, bevel: { ...bevel3D(2.2, 2.2, 'round'), segments: 12 }, bevelPosition: 'outside' as const };
  const eps = Math.max(1e-4, size * 1e-4);
  const t = textShapes(source, layer, font(file), p.curveSegments, eps);
  const glyphs = t.parts.flatMap((part) => part.shapes);
  const geo = buildTitle(t, p, size, eps, new Map(), outputScale, false).main!.geometry;
  const pos = geo.getAttribute('position');
  let bands = 0;
  let overFace = 0;
  for (const g of geo.groups) {
    if (g.materialIndex !== BEVEL_SLOT) continue;
    for (let v = g.start; v < g.start + g.count; v += 3) {
      const ax = pos.getX(v + 1) - pos.getX(v), ay = pos.getY(v + 1) - pos.getY(v);
      const bx = pos.getX(v + 2) - pos.getX(v), by = pos.getY(v + 2) - pos.getY(v);
      const a = Math.abs(ax * by - ay * bx) / 2;
      bands += a;
      const cx = (pos.getX(v) + pos.getX(v + 1) + pos.getX(v + 2)) / 3;
      const cy = (pos.getY(v) + pos.getY(v + 1) + pos.getY(v + 2)) / 3;
      // centroid well inside a glyph (1 % of the size from its edges): the band covers the face
      const face = glyphs.some(
        (s) => inside(s.outer, cx, cy) && !s.holes.some((h) => inside(h, cx, cy)) && Math.min(edgeDistance(s.outer, cx, cy), ...s.holes.map((h) => edgeDistance(h, cx, cy))) > size * 0.01,
      );
      if (face) overFace += a;
    }
  }
  const reach = (p.bevel.width / 100) * size;
  const ring = shapesArea(offsetShapes(glyphs, reach, 'miter', false, eps)) - shapesArea(glyphs);
  return { bands, ring, overFace };
}

describe('outward bevel', () => {
  it.each([
    // a fine round profile at output scale 2 (100 % zoom on a 2× layer, a 2× export) puts rings
    // closer than the outline precision: the E's bevel crossed its face and notches
    ['DelaGothicOne-Regular.ttf', 'TEST', 200, 2],
    // two strokes of 激 touching on Clipper's grid just before they merge (at every scale)
    ['MPLUS1p-Black.ttf', '激', 160, 1],
  ] as const)('%s “%s” at size %i, output scale %d: the bevel fills exactly its ring', (file, text, size, scale) => {
    const { bands, ring, overFace } = measure(file, text, size, scale);
    expect(overFace).toBe(0);
    expect(Math.abs(bands - ring) / ring).toBeLessThan(0.005);
  });
});

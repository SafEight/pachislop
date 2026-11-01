import * as THREE from 'three';
import type { BevelShape3D } from '../../model/types';
import type { Bounds } from '../../text/layout';
import { unitBevel } from './bevel';
import { interiorPoint, offsetShapes, shapeContains, subtractContours, type Contour, type ShapeContours } from './outline';

// Ring-stack extruder. A solid is described by a PROFILE: a polyline in (offset, z) space
// walked from the front cap outward/down to the side wall, where `offset` is the signed
// distance from the input outline in the outline plane (+ = outward, − = inward). Every
// profile point becomes a ring (the outline moved by `offset` with per-vertex miter
// vectors); consecutive rings are joined by quad strips, the cap is the outline
// triangulated at the first ring, and the side wall runs from the last ring down to
// `zBack` where a flat back cap closes the solid.
//
// Rings are clamped per vertex: an offset never travels more than 45% of the way to the
// opposite side of the stroke / counter along its miter ray, so thin kanji strokes and
// tight counters never invert — bevels just get narrower there. The cap rings are then
// untangled (see `untangle`). Overlap between SEPARATE shapes is fine: the depth buffer
// shows their union.
//
// Outward bands (Title3DProps.bevelPosition 'outside' / 'center') can't be per-vertex rings:
// they would cross between touching glyphs and fold in notches and counters. `extrudeOutward`
// grows them as Clipper offsets of the whole glyph set instead (one ring per profile point,
// points closer than the outline precision sharing one; touching glyphs unioned, counters
// closing up) and fills each ring step as a triangulated annulus lifted to the two rings'
// heights; see there.
//
// All parts are written to a MeshBuilder by material slot; positions are layer space.

const MAX_MITER = 2; // same limit as Clipper's miter joins for backplates (outline.ts)
const CREASE_COS = Math.cos((32 * Math.PI) / 180);

export interface ProfilePoint {
  off: number;
  z: number;
  /** Analytic (radial, z) surface normal for smooth profiles; faceted from the polyline when omitted. */
  n?: [number, number];
}

/** One strip of the profile between two points, drawn with material slot `slot`. */
export interface ProfileSpan {
  slot: number;
  a: ProfilePoint;
  b: ProfilePoint;
}

export interface SolidSpec {
  /** Ring of the front cap. */
  cap: { off: number; z: number; slot: number };
  spans: ProfileSpan[];
  /** Side wall from the last span's end down to zBack, then the back cap. */
  wallSlot: number;
  backSlot: number;
  zBack: number;
  /** Stop at the last span (which ends on the outline): no wall, no back cap; outward bands continue (extrudeOutward). */
  open?: boolean;
}

export interface OutwardSpec {
  /** Profile from the outline (offset 0) outward: offsets never decrease; slots as in SolidSpec. */
  spans: ProfileSpan[];
  /** Side wall from the outermost ring down to zBack, then the back cap. */
  wallSlot: number;
  backSlot: number;
  zBack: number;
  /**
   * Finest ring step, layer px: a profile span is halved down to this wherever its two end rings
   * differ by more than the offset (glyphs merging, notches filling, counters closing).
   */
  step: number;
  /** Outline tolerance (outline.ts). */
  eps: number;
  /** Span-table entry of the bands around `component` (one shape of the outermost ring). */
  span: (component: ShapeContours) => number;
}

// ---------- bevel profiles ----------

/**
 * Append the spans of one bevel band running outward from (off0, z0) across `width` and
 * down `depth`, with the cross-section of `shape` (bevel.ts) at `segments` facets. Returns
 * the end point.
 */
export function bandSpans(
  out: ProfileSpan[],
  slot: number,
  off0: number,
  z0: number,
  width: number,
  depth: number,
  shape: Pick<BevelShape3D, 'profile' | 'curve'>,
  segments: number,
): { off: number; z: number } {
  const pieces = unitBevel(shape.profile, segments, shape.curve);
  // analytic normals need a non-degenerate scaled tangent
  const smooth = width > 1e-6 && depth > 1e-6;
  let end = { off: off0, z: z0 };
  for (const piece of pieces) {
    const pts: ProfilePoint[] = piece.map(({ o, h, t }) => ({
      off: off0 + width * o,
      z: z0 - depth * h,
      // tangent (w·do, −d·dh) in (radial, z) → outward normal (d·dh, w·do)
      n: t && smooth ? norm2([depth * t[1], width * t[0]]) : undefined,
    }));
    for (let k = 0; k < pts.length - 1; k++) {
      const a = pts[k];
      const b = pts[k + 1];
      if (Math.abs(b.off - a.off) < 1e-6 && Math.abs(b.z - a.z) < 1e-6) continue;
      out.push({ slot, a, b });
    }
    end = pts[pts.length - 1];
  }
  return { off: end.off, z: end.z };
}

// ---------- mesh builder ----------

/** Floats per stored vertex: position xyz, normal xyz, span index, z range (front, back). */
const STRIDE = 9;

/** Growable vertex store of one slot. */
class Buffers {
  data = new Float32Array(STRIDE * 1024);
  count = 0;
  x0 = Infinity;
  y0 = Infinity;
  x1 = -Infinity;
  y1 = -Infinity;
}

/**
 * Gradient span boxes (layer px, y-up) referenced by index from every vertex; they become
 * the `aSpanLine` / `aSpanChar` vec4 attributes that materials.ts reads for 'line' / 'char'
 * gradient spans.
 */
export interface SpanTable {
  line: Bounds[];
  char: Bounds[];
}

/**
 * Collects triangles per material slot and emits one grouped BufferGeometry. Every pushed
 * vertex records the current `span` (span-table index) and the current z range
 * (`zFront`, `zBack`, layer px): the front and back z of the solid it belongs to, which
 * becomes the `aZRange` attribute materials.ts reads for `gradientAxis: 'depth'` (compared
 * with the object-space `position.z`, which the skew shear and glyph rigs leave untouched).
 */
export class MeshBuilder {
  private readonly slots: Buffers[] = [];
  span = 0;
  zFront = 0;
  zBack = 0;

  push(slot: number, x: number, y: number, z: number, nx: number, ny: number, nz: number) {
    const b = (this.slots[slot] ??= new Buffers());
    if ((b.count + 1) * STRIDE > b.data.length) {
      const grown = new Float32Array(b.data.length * 2);
      grown.set(b.data);
      b.data = grown;
    }
    const o = b.count * STRIDE;
    const d = b.data;
    d[o] = x;
    d[o + 1] = y;
    d[o + 2] = z;
    d[o + 3] = nx;
    d[o + 4] = ny;
    d[o + 5] = nz;
    d[o + 6] = this.span;
    d[o + 7] = this.zFront;
    d[o + 8] = this.zBack;
    b.count++;
    if (x < b.x0) b.x0 = x;
    if (x > b.x1) b.x1 = x;
    if (y < b.y0) b.y0 = y;
    if (y > b.y1) b.y1 = y;
  }

  /**
   * Geometry with one group per non-empty slot (materialIndex = slot), the span attributes
   * resolved from `spans`, and the layer-space 2D bounds of every slot.
   */
  build(spans: SpanTable): { geometry: THREE.BufferGeometry; bounds: (THREE.Box2 | undefined)[] } {
    const geo = new THREE.BufferGeometry();
    let total = 0;
    for (const b of this.slots) if (b) total += b.count;
    const pos = new Float32Array(total * 3);
    const nrm = new Float32Array(total * 3);
    const spanLine = new Float32Array(total * 4);
    const spanChar = new Float32Array(total * 4);
    const zRange = new Float32Array(total * 2);
    const bounds: (THREE.Box2 | undefined)[] = [];
    let start = 0;
    this.slots.forEach((b, slot) => {
      if (!b.count) return;
      bounds[slot] = new THREE.Box2(new THREE.Vector2(b.x0, b.y0), new THREE.Vector2(b.x1, b.y1));
      geo.addGroup(start, b.count, slot);
      for (let i = 0, d = b.data; i < b.count; i++) {
        const s = i * STRIDE;
        const t = (start + i) * 3;
        pos[t] = d[s];
        pos[t + 1] = d[s + 1];
        pos[t + 2] = d[s + 2];
        nrm[t] = d[s + 3];
        nrm[t + 1] = d[s + 4];
        nrm[t + 2] = d[s + 5];
        const k = d[s + 6];
        const q = (start + i) * 4;
        const lb = spans.line[k];
        const cb = spans.char[k];
        spanLine[q] = lb.x0;
        spanLine[q + 1] = lb.y0;
        spanLine[q + 2] = lb.x1;
        spanLine[q + 3] = lb.y1;
        spanChar[q] = cb.x0;
        spanChar[q + 1] = cb.y0;
        spanChar[q + 2] = cb.x1;
        spanChar[q + 3] = cb.y1;
        zRange[(start + i) * 2] = d[s + 7];
        zRange[(start + i) * 2 + 1] = d[s + 8];
      }
      start += b.count;
    });
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    geo.setAttribute('aSpanLine', new THREE.BufferAttribute(spanLine, 4));
    geo.setAttribute('aSpanChar', new THREE.BufferAttribute(spanChar, 4));
    geo.setAttribute('aZRange', new THREE.BufferAttribute(zRange, 2));
    geo.computeBoundingBox();
    geo.computeBoundingSphere();
    return { geometry: geo, bounds };
  }
}

// ---------- rings ----------

interface Ring {
  pts: Contour;
  miter: THREE.Vector2[];
  smoothN: THREE.Vector2[];
  edgeN: THREE.Vector2[]; // normal of edge i → i+1
  crease: boolean[];
  /** Max inward / outward travel (in multiples of the miter vector) before the ring would cross the opposite side. */
  maxIn: number[];
  maxOut: number[];
}

function makeRing(pts: Contour): Ring {
  const n = pts.length;
  const edgeN: THREE.Vector2[] = [];
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    edgeN.push(new THREE.Vector2(dy / len, -dx / len)); // outward for normalised orientation
  }
  const miter: THREE.Vector2[] = [];
  const smoothN: THREE.Vector2[] = [];
  const crease: boolean[] = [];
  for (let i = 0; i < n; i++) {
    const n0 = edgeN[(i - 1 + n) % n];
    const n1 = edgeN[i];
    const bis = new THREE.Vector2().addVectors(n0, n1);
    crease.push(n0.dot(n1) < CREASE_COS);
    if (bis.lengthSq() < 1e-10) {
      // 180° spike: push along the incoming edge direction
      const dir = new THREE.Vector2(-n0.y, n0.x);
      smoothN.push(dir.clone());
      miter.push(dir.multiplyScalar(MAX_MITER));
      continue;
    }
    bis.normalize();
    smoothN.push(bis.clone());
    miter.push(bis.multiplyScalar(1 / Math.max(bis.dot(n0), 1 / MAX_MITER)));
  }
  return { pts, miter, smoothN, edgeN, crease, maxIn: [], maxOut: [] };
}

/** Distance along (dx, dy) from p to the nearest edge of the shape (excluding p's own edges). */
function rayHit(rings: Ring[], self: Ring, i: number, dx: number, dy: number): number {
  const p = self.pts[i];
  let best = Infinity;
  for (const q of rings) {
    const qn = q.pts.length;
    for (let k = 0; k < qn; k++) {
      if (q === self && (k === i || (k + 1) % qn === i)) continue; // adjacent edges
      const a = q.pts[k];
      const b = q.pts[(k + 1) % qn];
      const ex = b.x - a.x;
      const ey = b.y - a.y;
      const den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-12) continue;
      const wx = a.x - p.x;
      const wy = a.y - p.y;
      const t = (wx * ey - wy * ex) / den;
      const u = (wx * dy - wy * dx) / den;
      if (t > 1e-6 && u >= 0 && u <= 1 && t < best) best = t;
    }
  }
  return best;
}

/**
 * Per-vertex offset limits. Two events would fold a ring:
 *  - its miter ray reaching the opposite side of the stroke / counter → stop at 45% of it;
 *  - an edge collapsing to zero length (short edges between corners, e.g. little notches,
 *    or a tight concave curve) → both end vertices stop where the edge vanishes.
 */
function computeLimits(rings: Ring[], inward: boolean, outward: boolean) {
  for (const r of rings) {
    const n = r.pts.length;
    r.maxIn = new Array<number>(n).fill(Infinity);
    r.maxOut = new Array<number>(n).fill(Infinity);
    for (let i = 0; i < n; i++) {
      const m = r.miter[i];
      const ml = Math.hypot(m.x, m.y) || 1;
      if (inward) r.maxIn[i] = (0.45 * rayHit(rings, r, i, -m.x / ml, -m.y / ml)) / ml;
      if (outward) r.maxOut[i] = (0.45 * rayHit(rings, r, i, m.x / ml, m.y / ml)) / ml;
    }
    // edge i→j at offset d has (along-edge) length² |e|² + d·(Δm·e); it vanishes at d* = −|e|² / (Δm·e)
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ex = r.pts[j].x - r.pts[i].x;
      const ey = r.pts[j].y - r.pts[i].y;
      const k = (r.miter[j].x - r.miter[i].x) * ex + (r.miter[j].y - r.miter[i].y) * ey;
      if (Math.abs(k) < 1e-12) continue;
      const d = -(ex * ex + ey * ey) / k;
      if (d > 0 && outward) {
        r.maxOut[i] = Math.min(r.maxOut[i], d);
        r.maxOut[j] = Math.min(r.maxOut[j], d);
      } else if (d < 0 && inward) {
        r.maxIn[i] = Math.min(r.maxIn[i], -d);
        r.maxIn[j] = Math.min(r.maxIn[j], -d);
      }
    }
  }
}

/** Effective offset of ring vertex i (clamped to the local stroke / counter size). */
function eff(r: Ring, i: number, d: number): number {
  return d < 0 ? Math.max(d, -r.maxIn[i]) : Math.min(d, r.maxOut[i]);
}

/**
 * Whether segments ab and cd meet, touching and collinear overlap included: offset rings
 * often line up exactly (vertices pinned to the same outline coordinates), and a ring edge
 * running along or ending on another ring breaks ear clipping as surely as a crossing.
 */
function meets(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): boolean {
  const d1 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const d2 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
  if (d1 === 0 && d2 === 0) {
    // collinear: overlap of the projections on the longer axis
    const useX = Math.abs(bx - ax) >= Math.abs(by - ay);
    const [a0, a1] = useX ? [Math.min(ax, bx), Math.max(ax, bx)] : [Math.min(ay, by), Math.max(ay, by)];
    const [c0, c1] = useX ? [Math.min(cx, dx), Math.max(cx, dx)] : [Math.min(cy, dy), Math.max(cy, dy)];
    return a0 <= c1 && c0 <= a1;
  }
  const d3 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
  const d4 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
  return d1 * d2 <= 0 && d3 * d4 <= 0;
}

/** Rounds that halve a vertex's offset before offending vertices are pinned to the outline. */
const UNTANGLE_STEPS = 8;
/** Ring points closer than this (layer px) are the same point (edges collapsed by computeLimits). */
const SAME_PT = 1e-7;

/**
 * Tighten the per-vertex limits until the rings at offset `d` neither cross nor touch each
 * other or themselves. The ray limits keep each vertex short of the opposite side, but two
 * counters (or a counter and the outline) can still both grow into the stroke between them
 * where their long corner miters meet, or an unclamped edge between two corners can sweep
 * across a neighbour. Meeting cap rings break the cap's ear clipping: it then fills those
 * counters with face and the bevel underneath z-fights the face along the counter
 * outlines. Each round halves the offset of every vertex on a meeting edge; later rounds
 * pin them to the outline (clean Clipper output), and it stops once nothing moves.
 */
function untangle(rings: Ring[], d: number) {
  if (d === 0) return;
  type Edge = { r: Ring; i: number; j: number; x0: number; x1: number; y0: number; y1: number; ax: number; ay: number; bx: number; by: number };
  const edges: Edge[] = [];
  for (let round = 0; ; round++) {
    // edges at offset d, swept along x
    edges.length = 0;
    for (const r of rings) {
      const n = r.pts.length;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const ei = eff(r, i, d);
        const ej = eff(r, j, d);
        const ax = r.pts[i].x + r.miter[i].x * ei;
        const ay = r.pts[i].y + r.miter[i].y * ei;
        const bx = r.pts[j].x + r.miter[j].x * ej;
        const by = r.pts[j].y + r.miter[j].y * ej;
        if (Math.abs(ax - bx) < SAME_PT && Math.abs(ay - by) < SAME_PT) continue; // collapsed edge (computeLimits): a point
        edges.push({ r, i, j, x0: Math.min(ax, bx), x1: Math.max(ax, bx), y0: Math.min(ay, by), y1: Math.max(ay, by), ax, ay, bx, by });
      }
    }
    edges.sort((a, b) => a.x0 - b.x0);
    const bad = new Map<Ring, Set<number>>(); // vertices on meeting edges
    const mark = (e: Edge) => {
      let s = bad.get(e.r);
      if (!s) bad.set(e.r, (s = new Set()));
      s.add(e.i).add(e.j);
    };
    for (let s = 0; s < edges.length; s++) {
      const e = edges[s];
      for (let t = s + 1; t < edges.length && edges[t].x0 <= e.x1; t++) {
        const f = edges[t];
        if (f.y0 > e.y1 || f.y1 < e.y0) continue;
        if (e.r === f.r) {
          // neighbours share a vertex (also across a collapsed edge between them)
          if (e.i === f.j || e.j === f.i) continue;
          if ((Math.abs(e.ax - f.bx) < SAME_PT && Math.abs(e.ay - f.by) < SAME_PT) || (Math.abs(e.bx - f.ax) < SAME_PT && Math.abs(e.by - f.ay) < SAME_PT)) continue;
        }
        if (meets(e.ax, e.ay, e.bx, e.by, f.ax, f.ay, f.bx, f.by)) {
          mark(e);
          mark(f);
        }
      }
    }
    if (!bad.size) return;
    const pin = round >= UNTANGLE_STEPS;
    let moved = false;
    for (const [r, verts] of bad) {
      for (const k of verts) {
        const cur = Math.abs(eff(r, k, d));
        if (cur === 0) continue;
        moved = true;
        const limit = pin ? 0 : cur / 2;
        if (d < 0) r.maxIn[k] = limit;
        else r.maxOut[k] = limit;
      }
    }
    if (!moved) return;
  }
}

function norm2(v: [number, number]): [number, number] {
  const l = Math.hypot(v[0], v[1]) || 1;
  return [v[0] / l, v[1] / l];
}

// quad scratch: 4 corners × (x, y, z) positions and normals
const P = new Float64Array(12);
const N = new Float64Array(12);
const FRONT = [0, 1, 2, 0, 2, 3];
const FLIPPED = [0, 2, 1, 0, 3, 2];
const TRI_FRONT = [0, 1, 2];
const TRI_FLIPPED = [0, 2, 1];

/** The quad in P / N (corners 0..3) as two triangles, wound to face its normals. */
function emitQuad(builder: MeshBuilder, slot: number) {
  const ax = P[3] - P[0], ay = P[4] - P[1], az = P[5] - P[2];
  const bx = P[6] - P[0], by = P[7] - P[1], bz = P[8] - P[2];
  const cx = P[9] - P[0], cy = P[10] - P[1], cz = P[11] - P[2];
  // (a × b) + (b × c): area normal of the (possibly non-planar) quad
  const nx = ay * bz - az * by + (by * cz - bz * cy);
  const ny = az * bx - ax * bz + (bz * cx - bx * cz);
  const nz = ax * by - ay * bx + (bx * cy - by * cx);
  const ndot = nx * (N[0] + N[3] + N[6] + N[9]) + ny * (N[1] + N[4] + N[7] + N[10]) + nz * (N[2] + N[5] + N[8] + N[11]);
  for (const k of ndot >= 0 ? FRONT : FLIPPED) {
    const o = k * 3;
    builder.push(slot, P[o], P[o + 1], P[o + 2], N[o], N[o + 1], N[o + 2]);
  }
}

/** The triangle in P / N (corners 0..2), wound to face its normals. */
function emitTri(builder: MeshBuilder, slot: number) {
  const ax = P[3] - P[0], ay = P[4] - P[1], az = P[5] - P[2];
  const bx = P[6] - P[0], by = P[7] - P[1], bz = P[8] - P[2];
  const nx = ay * bz - az * by;
  const ny = az * bx - ax * bz;
  const nz = ax * by - ay * bx;
  const ndot = nx * (N[0] + N[3] + N[6]) + ny * (N[1] + N[4] + N[7]) + nz * (N[2] + N[5] + N[8]);
  for (const k of ndot >= 0 ? TRI_FRONT : TRI_FLIPPED) {
    const o = k * 3;
    builder.push(slot, P[o], P[o + 1], P[o + 2], N[o], N[o + 1], N[o + 2]);
  }
}

/**
 * Flat cap at `z` facing `nz` over a ring set (outer first, then its holes). Each cap is
 * triangulated on its OWN ring: an inset ring moves vertices by up to the band width, which
 * flips the long slivers of the outline's ear-clipping fan — those would be back-facing
 * (culled) and open cracks into the solid.
 */
function emitCap(builder: MeshBuilder, ring: THREE.Vector2[][], slot: number, z: number, nz: 1 | -1) {
  const tris = THREE.ShapeUtils.triangulateShape(ring[0], ring.slice(1));
  const pts = ring.flat(); // after triangulateShape, which may drop a closing duplicate
  for (const [ia, ib, ic] of tris) {
    const ccw = THREE.ShapeUtils.area([pts[ia], pts[ib], pts[ic]]) >= 0;
    const [i0, i1, i2] = ccw === nz > 0 ? [ia, ib, ic] : [ia, ic, ib];
    builder.push(slot, pts[i0].x, pts[i0].y, z, 0, 0, nz);
    builder.push(slot, pts[i1].x, pts[i1].y, z, 0, 0, nz);
    builder.push(slot, pts[i2].x, pts[i2].y, z, 0, 0, nz);
  }
}

/** Quad strips between profile points A and B along every ring (offsets clamped per vertex, see eff). */
function emitStrip(builder: MeshBuilder, rings: Ring[], slot: number, A: ProfilePoint, B: ProfilePoint) {
  const nf = norm2([A.z - B.z, B.off - A.off]); // faceted (radial, z)
  const nA = A.n ?? nf;
  const nB = B.n ?? nf;
  for (const r of rings) {
    const n = r.pts.length;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ni = r.crease[i] ? r.edgeN[i] : r.smoothN[i];
      const nj = r.crease[j] ? r.edgeN[i] : r.smoothN[j];
      const pi = r.pts[i], pj = r.pts[j], mi = r.miter[i], mj = r.miter[j];
      const iA = eff(r, i, A.off), jA = eff(r, j, A.off), iB = eff(r, i, B.off), jB = eff(r, j, B.off);
      P[0] = pi.x + mi.x * iA; P[1] = pi.y + mi.y * iA; P[2] = A.z;
      P[3] = pj.x + mj.x * jA; P[4] = pj.y + mj.y * jA; P[5] = A.z;
      P[6] = pj.x + mj.x * jB; P[7] = pj.y + mj.y * jB; P[8] = B.z;
      P[9] = pi.x + mi.x * iB; P[10] = pi.y + mi.y * iB; P[11] = B.z;
      N[0] = ni.x * nA[0]; N[1] = ni.y * nA[0]; N[2] = nA[1];
      N[3] = nj.x * nA[0]; N[4] = nj.y * nA[0]; N[5] = nA[1];
      N[6] = nj.x * nB[0]; N[7] = nj.y * nB[0]; N[8] = nB[1];
      N[9] = ni.x * nB[0]; N[10] = ni.y * nB[0]; N[11] = nB[1];
      emitQuad(builder, slot);
    }
  }
}

/** Extrude every shape per `spec` into the builder. */
export function extrudeSolid(builder: MeshBuilder, shapes: ShapeContours[], spec: SolidSpec) {
  const allOffs = [spec.cap.off, ...spec.spans.flatMap((s) => [s.a.off, s.b.off])];
  const needIn = allOffs.some((o) => o < 0);
  const needOut = allOffs.some((o) => o > 0);
  const last = spec.spans.length ? spec.spans[spec.spans.length - 1].b : { off: spec.cap.off, z: spec.cap.z };

  for (const shape of shapes) {
    const contours = [shape.outer, ...shape.holes];
    const rings = contours.map(makeRing);
    computeLimits(rings, needIn, needOut);
    untangle(rings, spec.cap.off);
    untangle(rings, last.off);

    // ---- caps: front at the cap ring, back at the wall ring ----
    const ringPts = (off: number) => {
      const out: THREE.Vector2[][] = [];
      for (const r of rings) {
        const c: THREE.Vector2[] = [];
        for (let i = 0; i < r.pts.length; i++) {
          const d = eff(r, i, off);
          c.push(new THREE.Vector2(r.pts[i].x + r.miter[i].x * d, r.pts[i].y + r.miter[i].y * d));
        }
        out.push(c);
      }
      return out;
    };
    emitCap(builder, ringPts(spec.cap.off), spec.cap.slot, spec.cap.z, 1);
    if (!spec.open) emitCap(builder, ringPts(last.off), spec.backSlot, spec.zBack, -1);

    // ---- profile strips + wall ----
    for (const s of spec.spans) emitStrip(builder, rings, s.slot, s.a, s.b);
    if (!spec.open && last.z - spec.zBack > 1e-4) {
      emitStrip(builder, rings, spec.wallSlot, { off: last.off, z: last.z, n: [1, 0] }, { off: last.off, z: spec.zBack, n: [1, 0] });
    }
  }
}

// ---------- outward bands ----------
//
// The bands outside the outline are a stack of RING SETS: the glyph set offset by every profile
// offset with Clipper (miter joins, the extruder's miter limit), so touching glyphs merge into
// one ring, notches fill and counters shrink until they close, with no folds. Consecutive ring
// sets need not match vertex for vertex (or even in topology), so the band between them is the
// region inside the outer set and outside the inner one, ear-clipped and lifted: inner-ring
// vertices at the inner height, outer-ring vertices at the outer one. Where the outline changes
// shape between two rings, the step is halved (down to OutwardSpec.step) so the valley between
// two merging glyphs follows the profile instead of bridging flat.

/** One ring set of the outward stack, with the ring data (normals, creases) of every contour. */
interface OutRing {
  shapes: ShapeContours[];
  /** Every contour as a ring: outers CCW, holes CW, so edge normals point the way the offset grows. */
  rings: Ring[];
  /** Whether rings[k] is an outer contour. */
  outer: boolean[];
}

function outRing(shapes: ShapeContours[]): OutRing {
  const rings: Ring[] = [];
  const outer: boolean[] = [];
  for (const s of shapes) {
    rings.push(makeRing(s.outer));
    outer.push(true);
    for (const h of s.holes) {
      rings.push(makeRing(h));
      outer.push(false);
    }
  }
  computeLimits(rings, false, false); // unclamped: every ring set is a clean offset already
  return { shapes, rings, outer };
}

/**
 * Whether every vertex of ring set `a` lies within `r` of ring set `b`'s edges, i.e. `b` is
 * `a` grown without a change of shape. Edges are bucketed on a grid of cells ≥ r, so each
 * vertex only checks its 3 × 3 neighbourhood.
 */
function within(a: OutRing, b: OutRing, r: number): boolean {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const ring of b.rings) {
    for (const p of ring.pts) {
      if (p.x < x0) x0 = p.x;
      if (p.x > x1) x1 = p.x;
      if (p.y < y0) y0 = p.y;
      if (p.y > y1) y1 = p.y;
    }
  }
  const h = Math.max(r, (x1 - x0) / 512, (y1 - y0) / 512, 1e-6);
  const cols = Math.floor((x1 - x0) / h) + 1;
  const segs: number[] = [];
  const grid = new Map<number, number[]>();
  for (const ring of b.rings) {
    const n = ring.pts.length;
    for (let i = 0; i < n; i++) {
      const p = ring.pts[i];
      const q = ring.pts[(i + 1) % n];
      const s = segs.length;
      segs.push(p.x, p.y, q.x, q.y);
      const i0 = Math.floor((Math.min(p.x, q.x) - x0) / h), i1 = Math.floor((Math.max(p.x, q.x) - x0) / h);
      const j0 = Math.floor((Math.min(p.y, q.y) - y0) / h), j1 = Math.floor((Math.max(p.y, q.y) - y0) / h);
      for (let j = j0; j <= j1; j++) {
        for (let k = i0; k <= i1; k++) {
          const cell = grid.get(j * cols + k);
          if (cell) cell.push(s);
          else grid.set(j * cols + k, [s]);
        }
      }
    }
  }
  const r2 = r * r;
  for (const ring of a.rings) {
    next: for (const p of ring.pts) {
      const ci = Math.floor((p.x - x0) / h);
      const cj = Math.floor((p.y - y0) / h);
      for (let j = cj - 1; j <= cj + 1; j++) {
        for (let k = ci - 1; k <= ci + 1; k++) {
          if (k < 0 || k >= cols) continue;
          for (const s of grid.get(j * cols + k) ?? []) {
            const ax = segs[s], ay = segs[s + 1];
            const ex = segs[s + 2] - ax, ey = segs[s + 3] - ay;
            const len2 = ex * ex + ey * ey;
            const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - ax) * ex + (p.y - ay) * ey) / len2)) : 0;
            const dx = ax + ex * t - p.x, dy = ay + ey * t - p.y;
            if (dx * dx + dy * dy <= r2) continue next;
          }
        }
      }
      return false;
    }
  }
  return true;
}

/** Even-odd point-in-polygon test against one contour. */
function insideContour(c: Contour, x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = c.length - 1; i < c.length; j = i++) {
    const a = c[i], b = c[j];
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function contourArea(c: Contour): number {
  let s = 0;
  for (let i = 0, j = c.length - 1; i < c.length; j = i++) s += c[j].x * c[i].y - c[i].x * c[j].y;
  return Math.abs(s) / 2;
}

/** In-plane normal of ring vertex i in a triangle centred at (cx, cy): at a crease, the normal of the edge on the triangle's side of the miter. */
function vertexNormal(r: Ring, i: number, cx: number, cy: number): THREE.Vector2 {
  if (!r.crease[i]) return r.smoothN[i];
  const n = r.pts.length;
  const h = (i - 1 + n) % n;
  const p = r.pts[i], q = r.pts[h], m = r.miter[i];
  const side = (x: number, y: number) => m.x * (y - p.y) - m.y * (x - p.x);
  return side(cx, cy) * side(q.x, q.y) > 0 ? r.edgeN[h] : r.edgeN[i];
}

interface AnnulusContour {
  ring: Ring;
  z: number;
  /** Profile normal (radial, z) at this ring. */
  n: [number, number];
  /** Inner (0) or outer (1) ring set, and whether the contour is an outer contour of it. */
  set: 0 | 1;
  outer: boolean;
  area: number;
  parent: AnnulusContour | null;
  children: AnnulusContour[];
}

/** A vertex of an annulus triangulation: its position and the ring vertex it takes z and normal from. */
interface AnnulusVertex {
  p: THREE.Vector2;
  o: AnnulusContour;
  i: number;
}

/** Sum of the triangles' areas. */
function trianglesArea(verts: AnnulusVertex[], tris: number[][]): number {
  let s = 0;
  for (const [ia, ib, ic] of tris) {
    const a = verts[ia].p, b = verts[ib].p, c = verts[ic].p;
    s += Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) / 2;
  }
  return s;
}

/** p moved onto the nearest edge of `contours`, with the closer end of that edge as its ring vertex. */
function nearestRingVertex(contours: AnnulusContour[], p: THREE.Vector2): AnnulusVertex {
  let best: AnnulusVertex = { p, o: contours[0], i: 0 };
  let bestD = Infinity;
  for (const o of contours) {
    const pts = o.ring.pts;
    for (let i = 0, n = pts.length; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      const ex = b.x - a.x, ey = b.y - a.y;
      const len2 = ex * ex + ey * ey;
      const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * ex + (p.y - a.y) * ey) / len2)) : 0;
      const x = a.x + ex * t, y = a.y + ey * t;
      const d = Math.hypot(x - p.x, y - p.y);
      if (d < bestD) {
        bestD = d;
        best = { p: new THREE.Vector2(x, y), o, i: t < 0.5 ? i : (i + 1) % n };
      }
    }
  }
  return best;
}

function emitAnnulusTris(builder: MeshBuilder, verts: AnnulusVertex[], tris: number[][], slot: number) {
  for (const tri of tris) {
    let cx = 0, cy = 0;
    for (const v of tri) {
      cx += verts[v].p.x / 3;
      cy += verts[v].p.y / 3;
    }
    for (let k = 0; k < 3; k++) {
      const { p, o, i } = verts[tri[k]];
      const d = vertexNormal(o.ring, i, cx, cy);
      P[k * 3] = p.x;
      P[k * 3 + 1] = p.y;
      P[k * 3 + 2] = o.z;
      N[k * 3] = d.x * o.n[0];
      N[k * 3 + 1] = d.y * o.n[0];
      N[k * 3 + 2] = o.n[1];
    }
    emitTri(builder, slot);
  }
}

/**
 * The band between ring sets `a` (inner, at z0 with profile normal n0) and `b` (outer, at z1
 * with n1): every region inside `b` and outside `a`. Contours of both sets are nested by
 * containment; the region just inside a contour (down to its children) is band when crossing
 * the contours above it leaves it inside `b` and outside `a`.
 */
function emitAnnulus(builder: MeshBuilder, a: OutRing, b: OutRing, slot: number, z0: number, z1: number, n0: [number, number], n1: [number, number], eps: number) {
  const all: AnnulusContour[] = [];
  const add = (set: OutRing, k: 0 | 1, z: number, n: [number, number]) =>
    set.rings.forEach((ring, i) => all.push({ ring, z, n, set: k, outer: set.outer[i], area: contourArea(ring.pts), parent: null, children: [] }));
  add(a, 0, z0, n0);
  add(b, 1, z1, n1);
  // the rings never cross, so one vertex decides containment; the parent is the smallest container
  for (const c of all) {
    const p = c.ring.pts[0];
    for (const d of all) {
      if (d !== c && d.area > c.area && (!c.parent || d.area < c.parent.area) && insideContour(d.ring.pts, p.x, p.y)) c.parent = d;
    }
  }
  for (const c of all) c.parent?.children.push(c);
  const inSet = (c: AnnulusContour | null, k: 0 | 1): boolean => (!c ? false : c.set === k ? c.outer : inSet(c.parent, k));

  for (const c of all) {
    if (!inSet(c, 1) || inSet(c, 0)) continue;
    const contours = [c, ...c.children];
    const arrays = contours.map((h) => [...h.ring.pts]); // triangulateShape may drop a closing duplicate in place
    const tris = THREE.ShapeUtils.triangulateShape(arrays[0], arrays.slice(1));
    const verts = arrays.flatMap((arr, k) => arr.map((p, i) => ({ p, o: contours[k], i })));
    const area = c.area - c.children.reduce((s, h) => s + h.area, 0);
    if (Math.abs(trianglesArea(verts, tris) - area) <= 1e-3 * area) {
      emitAnnulusTris(builder, verts, tris, slot);
      continue;
    }
    // Two contours touch (shapes about to merge, on Clipper's grid): earcut then misses part of
    // the region or fills across a child, i.e. over the face. Cut the region out with Clipper
    // and triangulate its clean pieces; every vertex takes z and normal from its nearest ring.
    for (const piece of subtractContours(c.ring.pts, c.children.map((h) => h.ring.pts), eps)) {
      const rings = [[...piece.outer], ...piece.holes.map((h) => [...h])];
      const pieceTris = THREE.ShapeUtils.triangulateShape(rings[0], rings.slice(1));
      emitAnnulusTris(builder, rings.flat().map((p) => nearestRingVertex(contours, p)), pieceTris, slot);
    }
  }
}

/**
 * Ring offsets of an outward profile: every profile offset → the ring it is drawn on. A ring
 * set is only exact to `tol` (outline simplification + Clipper's grid), so two rings closer
 * than that can cross, and earcut then fills the annulus between them across the face (fine
 * profiles at large output scales have spans of a few thousandths of a px). Offsets closer
 * than `tol` to the previous ring or to the outermost one join the nearest ring, which turns
 * their spans into risers; the innermost (the face edge) and outermost (the side wall) offsets
 * keep their own rings.
 */
function ringLevels(spans: ProfileSpan[], tol: number): (off: number) => number {
  const offs = [...new Set(spans.flatMap((s) => [s.a.off, s.b.off]))].sort((a, b) => a - b);
  const last = offs[offs.length - 1];
  const levels = [offs[0]];
  for (const o of offs) if (o - levels[levels.length - 1] >= tol && last - o >= tol) levels.push(o);
  if (last > offs[0]) levels.push(last);
  return (off) => levels.reduce((best, l) => (Math.abs(l - off) < Math.abs(best - off) ? l : best));
}

/**
 * Bands grown OUTWARD from `shapes` (their outline is offset 0; the face, and any inward part
 * of the profile, is extrudeSolid's with `open`), then the side wall from the outermost ring
 * down to zBack and the back cap. Shapes whose outermost rings merge share one band stack, so
 * touching glyphs neither z-fight nor interpenetrate; each such stack takes `spec.span` of its
 * outermost shape.
 */
export function extrudeOutward(builder: MeshBuilder, shapes: ShapeContours[], spec: OutwardSpec) {
  if (!shapes.length || !spec.spans.length) return;
  const last = spec.spans[spec.spans.length - 1].b;
  const marks = shapes.map(interiorPoint);
  const tol = 4 * spec.eps + 0.02; // simplification + Clipper's 0.01 px grid
  const level = ringLevels(spec.spans, tol);
  for (const component of offsetShapes(shapes, last.off, 'miter', false, spec.eps)) {
    const group = shapes.filter((_, k) => shapeContains(component, marks[k].x, marks[k].y));
    if (!group.length) continue;
    builder.span = spec.span(component);
    const rings = new Map<number, OutRing>([
      [0, outRing(group)],
      [last.off, outRing([component])],
    ]);
    const ringAt = (off: number): OutRing => {
      let r = rings.get(off);
      if (!r) rings.set(off, (r = outRing(offsetShapes(group, off, 'miter', false, spec.eps))));
      return r;
    };
    // ring offsets from o0 (excluded) to o1, halving steps whose rings differ in shape (never
    // below 2 · tol, so the halves stay ring-precision apart)
    const steps = (o0: number, o1: number, out: number[]) => {
      if (o1 - o0 > Math.max(spec.step, 2 * tol) && !within(ringAt(o0), ringAt(o1), MAX_MITER * (o1 - o0) * 1.05 + tol)) {
        const m = (o0 + o1) / 2;
        steps(o0, m, out);
        steps(m, o1, out);
      } else out.push(o1);
    };
    for (const { slot, a, b } of spec.spans) {
      // normals of the profile's own facet, wherever its ends were snapped to
      const nf = norm2([a.z - b.z, b.off - a.off]);
      const nA = a.n ?? nf;
      const nB = b.n ?? nf;
      const o0 = level(a.off);
      const o1 = level(b.off);
      if (o1 - o0 < 1e-9) {
        // a riser, or a span narrower than the ring precision: straight down (or up) along one ring
        emitStrip(builder, ringAt(o0).rings, slot, { off: 0, z: a.z, n: nA }, { off: 0, z: b.z, n: nB });
        continue;
      }
      const at = (off: number) => {
        const t = (off - o0) / (o1 - o0);
        return { z: a.z + (b.z - a.z) * t, n: norm2([nA[0] + (nB[0] - nA[0]) * t, nA[1] + (nB[1] - nA[1]) * t]) };
      };
      const offs = [o0];
      steps(o0, o1, offs);
      for (let k = 1; k < offs.length; k++) {
        const p0 = k === 1 ? { z: a.z, n: nA } : at(offs[k - 1]);
        const p1 = k === offs.length - 1 ? { z: b.z, n: nB } : at(offs[k]);
        emitAnnulus(builder, ringAt(offs[k - 1]), ringAt(offs[k]), slot, p0.z, p1.z, p0.n, p1.n, spec.eps);
      }
    }
    const outer = ringAt(last.off);
    if (last.z - spec.zBack > 1e-4) {
      emitStrip(builder, outer.rings, spec.wallSlot, { off: 0, z: last.z, n: [1, 0] }, { off: 0, z: spec.zBack, n: [1, 0] });
    }
    for (const s of outer.shapes) emitCap(builder, [[...s.outer], ...s.holes.map((h) => [...h])], spec.backSlot, spec.zBack, -1);
  }
}

// ---------- orb ----------

/** Cube faces of the orb: outward axis n and in-face axes u, v with u × v = n (CCW from outside). */
const CUBE_FACES: [n: number[], u: number[], v: number[]][] = [
  [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
  [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
  [[0, 1, 0], [0, 0, 1], [1, 0, 0]],
  [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
  [[0, 0, 1], [1, 0, 0], [0, 1, 0]],
  [[0, 0, -1], [0, 1, 0], [1, 0, 0]],
];

/**
 * Per-face grid of the orb's cube sphere keeping its silhouette within ⅛ render px of a true
 * ellipse for a radius of `radiusPx` render px: 24..128, in steps of 8 so zooming the preview
 * rarely rebuilds it.
 */
export function orbGridFor(radiusPx: number): number {
  // facet angle θ ≤ (π/2)/n near a face centre; sagitta ≈ r·θ²/8 ≤ ⅛  →  n ≥ (π/2)·√r
  const n = (Math.PI / 2) * Math.sqrt(Math.max(0, radiusPx));
  return Math.max(24, Math.min(128, 8 * Math.ceil(n / 8)));
}

/**
 * 保留 orb: a closed ellipsoid with radii (rx, ry, rz) centred at (0, 0, cz), all in `slot`.
 * Tessellated as a spherified cube (no poles, so no pole pinch; the six faces meet on exactly
 * shared vertices with analytic normals, so no seams), `grid` quads per face edge.
 */
export function extrudeOrb(builder: MeshBuilder, slot: number, rx: number, ry: number, rz: number, cz: number, grid: number) {
  const n = Math.max(1, Math.round(grid));
  const side = n + 1;
  const pos = new Float64Array(side * side * 3);
  const nrm = new Float64Array(side * side * 3);
  for (const [f, u, v] of CUBE_FACES) {
    for (let j = 0; j <= n; j++) {
      for (let i = 0; i <= n; i++) {
        const a = (2 * i) / n - 1;
        const b = (2 * j) / n - 1;
        const x = f[0] + a * u[0] + b * v[0];
        const y = f[1] + a * u[1] + b * v[1];
        const z = f[2] + a * u[2] + b * v[2];
        // spherified cube: far more even than normalising the cube point
        const x2 = x * x, y2 = y * y, z2 = z * z;
        const sx = x * Math.sqrt(Math.max(0, 1 - y2 / 2 - z2 / 2 + (y2 * z2) / 3));
        const sy = y * Math.sqrt(Math.max(0, 1 - z2 / 2 - x2 / 2 + (z2 * x2) / 3));
        const sz = z * Math.sqrt(Math.max(0, 1 - x2 / 2 - y2 / 2 + (x2 * y2) / 3));
        const k = (j * side + i) * 3;
        pos[k] = rx * sx;
        pos[k + 1] = ry * sy;
        pos[k + 2] = rz * sz + cz;
        // ellipsoid normal ∝ (x / rx², y / ry², z / rz²) at (rx·sx, ry·sy, rz·sz)
        const nx = sx / rx, ny = sy / ry, nz = sz / rz;
        const l = Math.hypot(nx, ny, nz) || 1;
        nrm[k] = nx / l;
        nrm[k + 1] = ny / l;
        nrm[k + 2] = nz / l;
      }
    }
    const put = (i: number, j: number) => {
      const k = (j * side + i) * 3;
      builder.push(slot, pos[k], pos[k + 1], pos[k + 2], nrm[k], nrm[k + 1], nrm[k + 2]);
    };
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        // split each quad along the diagonal that keeps the triangles closest to the surface
        // symmetric about the face centre (no directional facet pattern on the highlight)
        if ((i < n / 2) === (j < n / 2)) {
          put(i, j); put(i + 1, j); put(i + 1, j + 1);
          put(i, j); put(i + 1, j + 1); put(i, j + 1);
        } else {
          put(i, j); put(i + 1, j); put(i, j + 1);
          put(i + 1, j); put(i + 1, j + 1); put(i, j + 1);
        }
      }
    }
  }
}

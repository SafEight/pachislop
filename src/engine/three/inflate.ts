import * as THREE from 'three';
import type { MeshBuilder } from './extrude';
import type { Contour, ShapeContours } from './outline';

// Inflate mode (Title3DProps.mode 'inflate', Illustrator 3D Inflate / ぷっくり buttons): the
// front of every shape is a height field over its outline's distance field, the silhouette
// meets a straight side wall, and a flat back closes the solid.
//
// Front surface: a square grid of spacing `step` clipped EXACTLY to the outline. Cells fully
// inside are two triangles; a cell the outline passes through becomes the polygon(s) cell ∩
// shape, traced from the outline pieces inside the cell and the cell border between them,
// then ear-clipped. Every point where the outline crosses a grid line is ONE shared vertex:
// both cells beside it and the side wall use it, and the wall runs through every outline
// vertex and crossing, so the surface, the wall and neighbouring cells meet without cracks or
// T-junctions. Heights come from the exact distance of each grid node to the outline,
// relaxed a little so the medial-axis ridges round off. Normals are area-weighted vertex
// averages (smooth over the whole surface, creased only where it meets the wall), or, with
// Smoothness above 0, the exact slope of the profile along the distance gradient (the
// direction away from the nearest outline point), averaged over neighbours a few times so the
// medial-axis ridges round off: a mirror finish then shows no facet ripples at the grid step.
//
// Fields depend only on the outline and the grid step, so they are cached per shape: height,
// profile, depth and plate edits only re-emit the triangles.

/** Grid nodes across the largest inset (≈ half the widest stroke) at the estimated scale. */
const NODES_PER_INSET = 12;
/** Most grid nodes per title; larger titles get a coarser grid. */
const MAX_NODES = 200_000;
/** Finest grid step, render px (finer is invisible). */
const MIN_STEP_PX = 0.75;
/** Relaxation passes over the distance field (rounds the medial-axis ridges). */
const SMOOTH_PASSES = 2;
/** Wall normals: edges turning more than this stay creased (same rule as the extruder). */
const CREASE_COS = Math.cos((32 * Math.PI) / 180);
/** Grid phase as a fraction of the step: keeps outline vertices off the grid lines. */
const PHASE = 0.3183098861837907;
const DEGENERATE_RETRIES = 6;

/** A shape's front-surface mesh with its distance field (layer px, y-up). */
export interface InflateField {
  /** Vertex positions, interleaved x, y. */
  xy: number[];
  /** Distance of every vertex to the outline (0 on it), relaxed. */
  dist: Float64Array;
  /** Unit gradient of the exact distance per vertex, interleaved x, y: away from the nearest outline point (inward normal on the outline). */
  grad: Float64Array;
  /** Front triangles as vertex index triples, counter-clockwise seen from +z. */
  tris: number[];
  /** Outline contours with every grid crossing inserted (vertex indices): outer CCW first, then holes CW. */
  rings: number[][];
  /** Largest `dist`. */
  maxDist: number;
}

function contourArea(c: Contour): number {
  let a = 0;
  for (let i = 0, n = c.length; i < n; i++) {
    const p = c[i];
    const q = c[(i + 1) % n];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

function contourLength(c: Contour): number {
  let l = 0;
  for (let i = 0, n = c.length; i < n; i++) l += c[i].distanceTo(c[(i + 1) % n]);
  return l;
}

/** Output scale (output px per layer px) as the inflate grid sees it: the nearest power of two, so preview zooms rarely rebuild. */
export function inflateScale(outputScale: number): number {
  return 2 ** Math.round(Math.log2(Math.max(outputScale, 1e-6)));
}

/**
 * Grid step (layer px) for inflating `shapes` together. A shape's area / perimeter is about its
 * largest inset for strokes (and half of it for discs), so the widest shape gets ~12 × `detail`
 * nodes across its inset; capped by the node budget and the render resolution.
 */
export function inflateStep(shapes: ShapeContours[], outputScale: number, detail = 1): number {
  let area = 0;
  let scale = 0;
  for (const s of shapes) {
    const a = Math.abs(contourArea(s.outer)) - s.holes.reduce((t, h) => t + Math.abs(contourArea(h)), 0);
    const p = contourLength(s.outer) + s.holes.reduce((t, h) => t + contourLength(h), 0);
    if (a <= 0 || p <= 0) continue;
    area += a;
    scale = Math.max(scale, (1.5 * a) / p);
  }
  if (area <= 0) return 1;
  return Math.max(scale / (NODES_PER_INSET * detail), Math.sqrt(area / MAX_NODES), MIN_STEP_PX / Math.max(outputScale, 1e-6));
}

const fieldCache = new WeakMap<ShapeContours, { step: number; field: InflateField }>();

/** The inflate field of a normalised shape at grid spacing `step` (cached per shape object). */
export function inflateField(shape: ShapeContours, step: number): InflateField {
  const hit = fieldCache.get(shape);
  if (hit && hit.step === step) return hit.field;
  let field: InflateField | null = null;
  // a crossing exactly on a grid node or an outline vertex exactly on a grid line has no
  // well-defined cell: shift the grid and try again
  for (let k = 0; k < DEGENERATE_RETRIES && !field; k++) field = buildField(shape, step, PHASE + k * 0.1372);
  field ??= { xy: [], dist: new Float64Array(0), grad: new Float64Array(0), tris: [], rings: [], maxDist: 0 };
  fieldCache.set(shape, { step, field });
  return field;
}

/** One outline piece inside a cell: from the crossing it enters by to the one it leaves by. */
interface Piece {
  pts: number[];
  /** Cell-border parameter of the entry / exit crossing (0..4, CCW from the bottom-left corner). */
  sIn: number;
  sOut: number;
}

function buildField(shape: ShapeContours, h: number, phase: number): InflateField | null {
  const contours = [shape.outer, ...shape.holes];
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
  for (const c of contours) {
    for (const p of c) {
      if (p.x < bx0) bx0 = p.x;
      if (p.x > bx1) bx1 = p.x;
      if (p.y < by0) by0 = p.y;
      if (p.y > by1) by1 = p.y;
    }
  }
  const x0 = bx0 - h * phase;
  const y0 = by0 - h * phase;
  const nx = Math.floor((bx1 - x0) / h) + 2;
  const ny = Math.floor((by1 - y0) / h) + 2;
  const X = (i: number) => x0 + i * h;
  const Y = (j: number) => y0 + j * h;
  const offLine = (v: number, o: number) => {
    const f = (v - o) / h;
    return Math.abs(f - Math.round(f)) > 1e-7;
  };
  for (const c of contours) for (const p of c) if (!offLine(p.x, x0) || !offLine(p.y, y0)) return null;

  // ---- vertices: outline points and crossings first (dist 0), grid nodes after ----
  const xy: number[] = [];
  /** Per vertex: crossing kind (0 = on vertical line `line`, 1 = on horizontal line), −1 = outline vertex, −2 = grid node. */
  const kind: number[] = [];
  const line: number[] = [];
  const addVertex = (x: number, y: number, k: number, l: number) => {
    xy.push(x, y);
    kind.push(k);
    line.push(l);
    return kind.length - 1;
  };
  /** Crossings on each horizontal grid line (x values): node inside / outside by parity. */
  const rowCross: number[][] = Array.from({ length: ny }, () => []);
  const rings: number[][] = [];
  const crossings: { t: number; k: number; l: number; x: number; y: number }[] = [];
  for (const c of contours) {
    const ring: number[] = [];
    for (let e = 0, n = c.length; e < n; e++) {
      const a = c[e];
      const b = c[(e + 1) % n];
      ring.push(addVertex(a.x, a.y, -1, -1));
      crossings.length = 0;
      if (a.x !== b.x) {
        const lo = Math.ceil((Math.min(a.x, b.x) - x0) / h);
        const hi = Math.floor((Math.max(a.x, b.x) - x0) / h);
        for (let i = lo; i <= hi; i++) {
          const t = (X(i) - a.x) / (b.x - a.x);
          if (t <= 0 || t >= 1) continue;
          crossings.push({ t, k: 0, l: i, x: X(i), y: a.y + t * (b.y - a.y) });
        }
      }
      if (a.y !== b.y) {
        const lo = Math.ceil((Math.min(a.y, b.y) - y0) / h);
        const hi = Math.floor((Math.max(a.y, b.y) - y0) / h);
        for (let j = lo; j <= hi; j++) {
          const t = (Y(j) - a.y) / (b.y - a.y);
          if (t <= 0 || t >= 1) continue;
          crossings.push({ t, k: 1, l: j, x: a.x + t * (b.x - a.x), y: Y(j) });
        }
      }
      crossings.sort((p, q) => p.t - q.t);
      for (let q = 0; q < crossings.length; q++) {
        const cr = crossings[q];
        if (q > 0 && cr.t - crossings[q - 1].t < 1e-12) return null; // through a grid node
        ring.push(addVertex(cr.x, cr.y, cr.k, cr.l));
        if (cr.k === 1) rowCross[cr.l].push(cr.x);
      }
    }
    rings.push(ring);
  }
  const boundaryCount = kind.length;
  for (const r of rowCross) r.sort((a, b) => a - b);

  // ---- outline pieces per cell (cell id = row · nx + column) ----
  const pieces = new Map<number, Piece[]>();
  const fulls = new Map<number, number[][]>();
  /** Cell-border parameter of crossing vertex v on cell (ci, cj); NaN if it is not on that cell. */
  const borderS = (v: number, ci: number, cj: number) => {
    const x = xy[2 * v];
    const y = xy[2 * v + 1];
    if (kind[v] === 0) {
      if (line[v] === ci) return 3 + (Y(cj + 1) - y) / h;
      if (line[v] === ci + 1) return 1 + (y - Y(cj)) / h;
    } else if (kind[v] === 1) {
      if (line[v] === cj) return (x - X(ci)) / h;
      if (line[v] === cj + 1) return 2 + (X(ci + 1) - x) / h;
    }
    return NaN;
  };
  for (const ring of rings) {
    const n = ring.length;
    const start = ring.findIndex((v) => kind[v] >= 0);
    const mid = (k: number) => {
      const a = ring[k % n];
      const b = ring[(k + 1) % n];
      return Math.floor(((xy[2 * a + 1] + xy[2 * b + 1]) / 2 - y0) / h) * nx + Math.floor(((xy[2 * a] + xy[2 * b]) / 2 - x0) / h);
    };
    if (start < 0) {
      const cell = mid(0);
      const list = fulls.get(cell);
      if (list) list.push(ring);
      else fulls.set(cell, [ring]);
      continue;
    }
    let k = start;
    do {
      const cell = mid(k);
      const pts = [ring[k]];
      let m = k + 1;
      while (kind[ring[m % n]] < 0) pts.push(ring[m++ % n]);
      pts.push(ring[m % n]);
      const ci = cell % nx;
      const cj = (cell - ci) / nx;
      const sIn = borderS(pts[0], ci, cj);
      const sOut = borderS(pts[pts.length - 1], ci, cj);
      if (Number.isNaN(sIn) || Number.isNaN(sOut)) return null;
      const list = pieces.get(cell);
      if (list) list.push({ pts, sIn, sOut });
      else pieces.set(cell, [{ pts, sIn, sOut }]);
      k = m % n;
    } while (k !== start);
  }

  // ---- grid nodes ----
  const nodeVertex = new Int32Array(nx * ny).fill(-1);
  const node = (i: number, j: number) => {
    const id = j * nx + i;
    let v = nodeVertex[id];
    if (v < 0) nodeVertex[id] = v = addVertex(X(i), Y(j), -2, -1);
    return v;
  };
  const nodeInside = (i: number, j: number) => {
    const row = rowCross[j];
    const x = X(i);
    let lo = 0;
    let hi = row.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (row[m] < x) lo = m + 1;
      else hi = m;
    }
    return (lo & 1) === 1;
  };

  // ---- triangles ----
  const tris: number[] = [];
  const tri = (a: number, b: number, c: number) => {
    const ax = xy[2 * a], ay = xy[2 * a + 1];
    const cross = (xy[2 * b] - ax) * (xy[2 * c + 1] - ay) - (xy[2 * b + 1] - ay) * (xy[2 * c] - ax);
    if (cross > 0) tris.push(a, b, c);
    else if (cross < 0) tris.push(a, c, b);
  };
  const vec = (v: number) => new THREE.Vector2(xy[2 * v], xy[2 * v + 1]);
  const polyArea = (poly: number[]) => {
    let s = 0;
    for (let i = 0, n = poly.length; i < n; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % n];
      s += xy[2 * a] * xy[2 * b + 1] - xy[2 * b] * xy[2 * a + 1];
    }
    return s / 2;
  };
  const polyContains = (poly: number[], x: number, y: number) => {
    let inside = false;
    for (let i = 0, n = poly.length, j = n - 1; i < n; j = i++) {
      const ax = xy[2 * poly[i]], ay = xy[2 * poly[i] + 1];
      const bx = xy[2 * poly[j]], by = xy[2 * poly[j] + 1];
      if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside;
    }
    return inside;
  };
  for (let cj = 0; cj < ny - 1; cj++) {
    for (let ci = 0; ci < nx - 1; ci++) {
      const cell = cj * nx + ci;
      const list = pieces.get(cell);
      const full = fulls.get(cell);
      const polys: number[][] = [];
      if (!list) {
        if (!nodeInside(ci, cj)) {
          if (!full) continue;
        } else if (!full) {
          // whole cell inside: alternate the diagonal so the facets have no common direction
          const a = node(ci, cj), b = node(ci + 1, cj), c = node(ci + 1, cj + 1), d = node(ci, cj + 1);
          if ((ci + cj) & 1) {
            tri(a, b, c);
            tri(a, c, d);
          } else {
            tri(a, b, d);
            tri(b, c, d);
          }
          continue;
        } else polys.push([node(ci, cj), node(ci + 1, cj), node(ci + 1, cj + 1), node(ci, cj + 1)]);
      } else {
        // trace cell ∩ shape: an outline piece, then CCW along the border (picking up corners)
        // to the next piece's entry, until back at the first piece
        const corner = (c: number) => (c === 0 ? node(ci, cj) : c === 1 ? node(ci + 1, cj) : c === 2 ? node(ci + 1, cj + 1) : node(ci, cj + 1));
        const used = new Uint8Array(list.length);
        for (let p0 = 0; p0 < list.length; p0++) {
          if (used[p0]) continue;
          const poly: number[] = [];
          let p = p0;
          for (;;) {
            used[p] = 1;
            poly.push(...list[p].pts);
            const s = list[p].sOut;
            let next = -1;
            let gap = Infinity;
            for (let q = 0; q < list.length; q++) {
              let d = list[q].sIn - s;
              if (d <= 0) d += 4;
              if (d < gap) {
                gap = d;
                next = q;
              }
            }
            for (let k = 1; k <= 4; k++) {
              const c = Math.floor(s) + k;
              if (c - s >= gap) break;
              poly.push(corner(c % 4));
            }
            if (next === p0) break;
            if (used[next]) return null;
            p = next;
          }
          polys.push(poly);
        }
      }
      // contours wholly inside the cell: islands are polygons of their own, holes go into the
      // smallest polygon around them
      const holes: number[][][] = polys.map(() => []);
      for (const f of full ?? []) {
        if (polyArea(f) > 0) {
          polys.push(f);
          holes.push([]);
        }
      }
      for (const f of full ?? []) {
        if (polyArea(f) > 0) continue;
        const x = xy[2 * f[0]], y = xy[2 * f[0] + 1];
        let best = -1;
        let bestArea = Infinity;
        polys.forEach((poly, k) => {
          const a = polyArea(poly);
          if (a < bestArea && polyContains(poly, x, y)) {
            best = k;
            bestArea = a;
          }
        });
        if (best >= 0) holes[best].push(f);
      }
      polys.forEach((poly, k) => {
        const ids = [...poly, ...holes[k].flat()];
        const faces = THREE.ShapeUtils.triangulateShape(poly.map(vec), holes[k].map((hl) => hl.map(vec)));
        for (const [a, b, c] of faces) tri(ids[a], ids[b], ids[c]);
      });
    }
  }

  // ---- distance of the grid nodes to the outline ----
  const dist = new Float64Array(kind.length);
  const segs: number[] = []; // ax, ay, bx, by
  for (const c of contours) for (let i = 0, n = c.length; i < n; i++) segs.push(c[i].x, c[i].y, c[(i + 1) % n].x, c[(i + 1) % n].y);
  const bucket = Math.max(4 * h, 1e-6);
  const bw = Math.max(1, Math.ceil((bx1 - bx0) / bucket) + 1);
  const bh = Math.max(1, Math.ceil((by1 - by0) / bucket) + 1);
  const buckets: number[][] = Array.from({ length: bw * bh }, () => []);
  const bClamp = (v: number, n: number) => Math.min(n - 1, Math.max(0, Math.floor(v)));
  for (let s = 0; s < segs.length; s += 4) {
    const i0 = bClamp((Math.min(segs[s], segs[s + 2]) - bx0) / bucket, bw);
    const i1 = bClamp((Math.max(segs[s], segs[s + 2]) - bx0) / bucket, bw);
    const j0 = bClamp((Math.min(segs[s + 1], segs[s + 3]) - by0) / bucket, bh);
    const j1 = bClamp((Math.max(segs[s + 1], segs[s + 3]) - by0) / bucket, bh);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) buckets[j * bw + i].push(s);
  }
  const segDist2 = (s: number, px: number, py: number) => {
    const ax = segs[s], ay = segs[s + 1];
    const ex = segs[s + 2] - ax, ey = segs[s + 3] - ay;
    const l2 = ex * ex + ey * ey;
    const t = l2 > 0 ? Math.min(1, Math.max(0, ((px - ax) * ex + (py - ay) * ey) / l2)) : 0;
    const dx = ax + t * ex - px, dy = ay + t * ey - py;
    return dx * dx + dy * dy;
  };
  const maxRing = Math.max(bw, bh);
  /** Exact distance gradient: away from the nearest outline point (Smoothness shading). */
  const grad = new Float64Array(kind.length * 2);
  for (let v = boundaryCount; v < kind.length; v++) {
    const px = xy[2 * v], py = xy[2 * v + 1];
    const bi = bClamp((px - bx0) / bucket, bw);
    const bj = bClamp((py - by0) / bucket, bh);
    let best = Infinity;
    let bs = -1;
    for (let r = 0; r <= maxRing; r++) {
      for (let j = bj - r; j <= bj + r; j++) {
        if (j < 0 || j >= bh) continue;
        const edge = j === bj - r || j === bj + r;
        for (let i = bi - r; i <= bi + r; i += edge ? 1 : 2 * r) {
          if (i < 0 || i >= bw) continue;
          for (const s of buckets[j * bw + i]) {
            const d = segDist2(s, px, py);
            if (d < best) {
              best = d;
              bs = s;
            }
          }
        }
      }
      if (best <= r * bucket * r * bucket) break;
    }
    dist[v] = Math.sqrt(best);
    if (bs >= 0 && best > 0) {
      const ax = segs[bs], ay = segs[bs + 1];
      const ex = segs[bs + 2] - ax, ey = segs[bs + 3] - ay;
      const l2 = ex * ex + ey * ey;
      const t = l2 > 0 ? Math.min(1, Math.max(0, ((px - ax) * ex + (py - ay) * ey) / l2)) : 0;
      grad[2 * v] = (px - ax - t * ex) / dist[v];
      grad[2 * v + 1] = (py - ay - t * ey) / dist[v];
    }
  }
  // on the outline: the inward normal, averaged over the two edges (outer rings run CCW and
  // holes CW, so the shape is on the left of every edge)
  for (const ring of rings) {
    const k = ring.length;
    for (let i = 0; i < k; i++) {
      const p = ring[(i - 1 + k) % k], v = ring[i], q = ring[(i + 1) % k];
      const dx1 = xy[2 * v] - xy[2 * p], dy1 = xy[2 * v + 1] - xy[2 * p + 1];
      const dx2 = xy[2 * q] - xy[2 * v], dy2 = xy[2 * q + 1] - xy[2 * v + 1];
      const l1 = Math.hypot(dx1, dy1) || 1, l2 = Math.hypot(dx2, dy2) || 1;
      const gx = -dy1 / l1 - dy2 / l2, gy = dx1 / l1 + dx2 / l2;
      const l = Math.hypot(gx, gy) || 1;
      grad[2 * v] = gx / l;
      grad[2 * v + 1] = gy / l;
    }
  }

  // ---- relax the field (outline fixed at 0): rounds the ridges along the medial axis ----
  const sum = new Float64Array(kind.length);
  const cnt = new Float64Array(kind.length);
  for (let pass = 0; pass < SMOOTH_PASSES; pass++) {
    sum.fill(0);
    cnt.fill(0);
    for (let t = 0; t < tris.length; t += 3) {
      for (let e = 0; e < 3; e++) {
        const a = tris[t + e];
        const b = tris[t + ((e + 1) % 3)];
        sum[a] += dist[b];
        cnt[a]++;
        sum[b] += dist[a];
        cnt[b]++;
      }
    }
    for (let v = boundaryCount; v < kind.length; v++) if (cnt[v]) dist[v] = 0.5 * dist[v] + (0.5 * sum[v]) / cnt[v];
  }
  let maxDist = 0;
  for (let v = boundaryCount; v < kind.length; v++) if (dist[v] > maxDist) maxDist = dist[v];
  return { xy, dist, grad, tris, rings, maxDist };
}

export interface InflateSpec {
  faceSlot: number;
  wallSlot: number;
  backSlot: number;
  /** Rise of the surface above its silhouette at full profile (layer px). */
  height: number;
  /** Height profile: distance from the edge / `maxDist` (0..1) → 0..1. */
  profile: (t: number) => number;
  /** Distance that maps to the top of the profile (shared by all shapes of a title). */
  maxDist: number;
  /** z of the flat back. */
  zBack: number;
  /** Title3DProps.inflate.smoothness (0..100): 0 = mesh normals, else exact normals with ⌈smoothness / 10⌉ ridge-rounding passes. */
  smoothness: number;
}

/** z of the silhouette (and the wall top): the profile at the edge, with the profile's top at z = 0. */
export function inflateWallTop(height: number, profile: (t: number) => number): number {
  return height * (profile(0) - 1);
}

/** Emit the solid of one inflate field: front surface, side wall and flat back. */
export function emitInflate(builder: MeshBuilder, f: InflateField, spec: InflateSpec) {
  const nv = f.dist.length;
  if (!nv) return;
  const { xy, tris } = f;
  const m = spec.maxDist > 0 ? spec.maxDist : 1;
  const z = new Float64Array(nv);
  for (let v = 0; v < nv; v++) z[v] = spec.height * (spec.profile(Math.min(1, f.dist[v] / m)) - 1);
  const wallTop = inflateWallTop(spec.height, spec.profile);

  const n = new Float64Array(nv * 3);
  if (spec.smoothness > 0) {
    // exact normals: the profile's slope along the distance gradient (z rises inward)
    const eps = 1e-3;
    for (let v = 0; v < nv; v++) {
      const t = f.dist[v] / m;
      let slope = 0;
      if (t < 1) {
        const t0 = Math.max(0, t - eps), t1 = Math.min(1, t + eps);
        slope = (spec.height * (spec.profile(t1) - spec.profile(t0))) / ((t1 - t0) * m);
      }
      const nx = -slope * f.grad[2 * v], ny = -slope * f.grad[2 * v + 1];
      const l = Math.hypot(nx, ny, 1);
      n[3 * v] = nx / l;
      n[3 * v + 1] = ny / l;
      n[3 * v + 2] = 1 / l;
    }
    // the gradient flips across the medial axis: average with the neighbours (outline fixed)
    const acc = new Float64Array(nv * 3);
    for (let pass = 0, passes = Math.ceil(spec.smoothness / 10); pass < passes; pass++) {
      acc.set(n);
      for (let t = 0; t < tris.length; t += 3) {
        for (let e = 0; e < 3; e++) {
          const a = tris[t + e], b = tris[t + ((e + 1) % 3)];
          acc[3 * a] += n[3 * b];
          acc[3 * a + 1] += n[3 * b + 1];
          acc[3 * a + 2] += n[3 * b + 2];
          acc[3 * b] += n[3 * a];
          acc[3 * b + 1] += n[3 * a + 1];
          acc[3 * b + 2] += n[3 * a + 2];
        }
      }
      for (let v = 0; v < nv; v++) {
        if (f.dist[v] <= 0) continue;
        const l = Math.hypot(acc[3 * v], acc[3 * v + 1], acc[3 * v + 2]) || 1;
        n[3 * v] = acc[3 * v] / l;
        n[3 * v + 1] = acc[3 * v + 1] / l;
        n[3 * v + 2] = acc[3 * v + 2] / l;
      }
    }
  } else {
    // area-weighted vertex normals over the surface
    for (let t = 0; t < tris.length; t += 3) {
      const a = tris[t], b = tris[t + 1], c = tris[t + 2];
      const ux = xy[2 * b] - xy[2 * a], uy = xy[2 * b + 1] - xy[2 * a + 1], uz = z[b] - z[a];
      const vx = xy[2 * c] - xy[2 * a], vy = xy[2 * c + 1] - xy[2 * a + 1], vz = z[c] - z[a];
      const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
      for (const k of [a, b, c]) {
        n[3 * k] += cx;
        n[3 * k + 1] += cy;
        n[3 * k + 2] += cz;
      }
    }
    for (let v = 0; v < nv; v++) {
      const l = Math.hypot(n[3 * v], n[3 * v + 1], n[3 * v + 2]) || 1;
      n[3 * v] /= l;
      n[3 * v + 1] /= l;
      n[3 * v + 2] /= l;
    }
  }
  for (const v of tris) builder.push(spec.faceSlot, xy[2 * v], xy[2 * v + 1], z[v], n[3 * v], n[3 * v + 1], n[3 * v + 2]);

  // wall: through every outline vertex and crossing, smooth across shallow turns
  const zb = spec.zBack;
  if (wallTop - zb > 1e-4) {
    for (const ring of f.rings) {
      const pts = ring.filter((v, i) => {
        const w = ring[(i + 1) % ring.length];
        return Math.abs(xy[2 * v] - xy[2 * w]) > 1e-9 || Math.abs(xy[2 * v + 1] - xy[2 * w + 1]) > 1e-9;
      });
      const k = pts.length;
      if (k < 3) continue;
      const en: [number, number][] = []; // outward normal of edge i → i+1
      for (let i = 0; i < k; i++) {
        const a = pts[i], b = pts[(i + 1) % k];
        const dx = xy[2 * b] - xy[2 * a], dy = xy[2 * b + 1] - xy[2 * a + 1];
        const l = Math.hypot(dx, dy) || 1;
        en.push([dy / l, -dx / l]);
      }
      const vn = (i: number, e: number): [number, number] => {
        const p = en[(i - 1 + k) % k], q = en[i % k];
        if (p[0] * q[0] + p[1] * q[1] < CREASE_COS) return en[e];
        const sx = p[0] + q[0], sy = p[1] + q[1];
        const l = Math.hypot(sx, sy) || 1;
        return [sx / l, sy / l];
      };
      for (let i = 0; i < k; i++) {
        const j = (i + 1) % k;
        const a = pts[i], b = pts[j];
        const na = vn(i, i), nb = vn(j, i);
        const ax = xy[2 * a], ay = xy[2 * a + 1], bx = xy[2 * b], by = xy[2 * b + 1];
        builder.push(spec.wallSlot, ax, ay, wallTop, na[0], na[1], 0);
        builder.push(spec.wallSlot, ax, ay, zb, na[0], na[1], 0);
        builder.push(spec.wallSlot, bx, by, zb, nb[0], nb[1], 0);
        builder.push(spec.wallSlot, ax, ay, wallTop, na[0], na[1], 0);
        builder.push(spec.wallSlot, bx, by, zb, nb[0], nb[1], 0);
        builder.push(spec.wallSlot, bx, by, wallTop, nb[0], nb[1], 0);
      }
    }
  }

  // back: the same rings, facing −z
  if (!f.rings.length) return;
  const vec = (v: number) => new THREE.Vector2(xy[2 * v], xy[2 * v + 1]);
  const outer = f.rings[0].map(vec);
  const holes = f.rings.slice(1).map((r) => r.map(vec));
  const all = [...outer, ...holes.flat()];
  for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(outer, holes)) {
    const ccw = THREE.ShapeUtils.area([all[a], all[b], all[c]]) >= 0;
    for (const v of ccw ? [a, c, b] : [a, b, c]) builder.push(spec.backSlot, all[v].x, all[v].y, zb, 0, 0, -1);
  }
}

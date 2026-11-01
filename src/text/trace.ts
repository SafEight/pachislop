import type { ImageTrace } from '../model/types';
import type { PathCmd } from './layout';

// Image alpha → outline (ImageSource.trace), for 3D extrusion / inflate of a transparent PNG
// (Element 3D-style "extrude a logo"). Output is LAYER SPACE like every other outline: y-up,
// centred on the origin, the image fitted so its larger side is `size` (exactly where the 2D
// image renderer draws it, so a face image projected over the same box registers).
//
// 1. Alpha is read once per (image, sample count) into a grid padded by one transparent
//    sample all round, so every contour closes. The longer side gets SAMPLES_PER_PX samples per
//    layer px of `size`, capped at MAX_SAMPLES and never above the image's own pixels; the
//    canvas downscale averages coverage, so soft and antialiased edges keep sub-sample detail.
// 2. Marching squares at `threshold` with linear interpolation along each cell edge (sub-sample
//    edge positions); saddles are split by the cell's mean. The walk keeps the inside on the
//    left as the image is seen, so outer contours come out counter-clockwise, holes clockwise
//    and islands inside holes counter-clockwise again — the normalised orientation of
//    engine/three/outline.ts, so its non-zero union keeps every nesting level.
// 3. Loops below `despeckle` (% of size², either orientation) are dropped. Nesting is
//    monotone in area (a hole is smaller than its island, an island than its hole), so
//    dropping a speck also drops everything inside it.
// 4. Smoothing (`smooth`, % of size = the tolerance): closed Douglas–Peucker, then Chaikin
//    corner cutting on the vertices that sample a curve. A DP vertex on a curve of radius R
//    has deflection θ ≈ L / R and segment length L ≈ √(8 R tol), so θ · L ≤ 8 tol; a vertex
//    whose θ · min(adjacent lengths) is well above that joins two long straight runs and is a
//    real corner: it is kept sharp. smooth = 0 only drops collinear runs (sub-sample tolerance).
//    Both steps depend on the loop's points only, never on where the edge walk started or
//    which way it ran (simplifyClosed); every loop then starts at its first vertex in (x, y)
//    order, so the commands are canonical too.
//
// Traces are computed in unit space (fitted larger side = 1; tolerance and despeckle are % of
// size) and cached per (image, sample count, trace); the layer-space commands are that trace
// scaled by `size`, cached per (image, size, trace). Above SAMPLES_PER_PX × size = MAX_SAMPLES
// the sample count no longer depends on the size, so resizing reuses the trace.

/** Most alpha samples along the image's longer side. */
const MAX_SAMPLES = 1024;
/** Alpha samples per layer px of the fitted size (headroom for 2× exports) below the cap. */
const SAMPLES_PER_PX = 2;
/** Least simplify tolerance, in samples: collinear runs go, every pixel step stays. */
const MIN_TOLERANCE = 0.3;
/** A vertex is a corner when its deflection × shorter adjacent segment exceeds this × tolerance (curves stay ≤ 8). */
const CORNER_K = 12;
const CHAIKIN_PASSES = 2;
/** Cached results per image (oldest dropped first). */
const CACHE_PER_IMAGE = 24;

export type TraceImage = ImageBitmap | HTMLImageElement;

const dims = (img: TraceImage): [number, number] =>
  'naturalWidth' in img ? [img.naturalWidth, img.naturalHeight] : [img.width, img.height];

/** Half extents of `img` fitted so its larger side is `size` (layer px), as the 2D image renderer places it. */
export function imageFit(img: TraceImage, size: number): { hw: number; hh: number } {
  const [w, h] = dims(img);
  const k = size / Math.max(w, h, 1);
  return { hw: (w * k) / 2, hh: (h * k) / 2 };
}

interface AlphaGrid {
  /** Sample counts (unpadded). */
  sw: number;
  sh: number;
  /** (sw + 2) × (sh + 2) alpha, row-major, top row first, one transparent sample of padding all round. */
  a: Uint8Array;
}

interface ImageCache {
  grids: Map<number, AlphaGrid>;
  /** Unit-space loops (x, y interleaved) per `n|trace` key. */
  unit: Map<string, number[][]>;
  /** Layer-space commands per `size|trace` key. */
  cmds: Map<string, PathCmd[]>;
}

const caches = new WeakMap<TraceImage, ImageCache>();

function remember<K, V>(map: Map<K, V>, key: K, value: V): V {
  if (map.size >= CACHE_PER_IMAGE) map.delete(map.keys().next().value as K);
  map.set(key, value);
  return value;
}

function alphaGrid(img: TraceImage, cache: ImageCache, n: number): AlphaGrid {
  const hit = cache.grids.get(n);
  if (hit) return hit;
  const [w, h] = dims(img);
  const k = n / Math.max(w, h, 1);
  const sw = Math.max(1, Math.round(w * k));
  const sh = Math.max(1, Math.round(h * k));
  const ctx = new OffscreenCanvas(sw, sh).getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, sw, sh);
  const data = ctx.getImageData(0, 0, sw, sh).data;
  const gw = sw + 2;
  const a = new Uint8Array(gw * (sh + 2));
  for (let y = 0; y < sh; y++) {
    const row = (y + 1) * gw + 1;
    for (let x = 0; x < sw; x++) a[row + x] = data[(y * sw + x) * 4 + 3];
  }
  if (cache.grids.size >= 4) cache.grids.delete(cache.grids.keys().next().value as number);
  const grid = { sw, sh, a };
  cache.grids.set(n, grid);
  return grid;
}

/**
 * Marching squares at alpha `t` → closed loops in unit space (x, y interleaved, y-up, centred,
 * larger side 1), outer loops counter-clockwise, holes clockwise.
 */
function marchingSquares({ sw, sh, a }: AlphaGrid, t: number, ux: number, uy: number): number[][] {
  const gw = sw + 2;
  const gh = sh + 2;
  // edge ids: 2·p = horizontal edge from grid point p to p + 1, 2·p + 1 = vertical edge from p to p + gw
  const next = new Int32Array(gw * gh * 2).fill(-1);
  for (let cy = 0; cy < gh - 1; cy++) {
    for (let cx = 0; cx < gw - 1; cx++) {
      const p = cy * gw + cx;
      const tl = a[p] >= t ? 8 : 0;
      const tr = a[p + 1] >= t ? 4 : 0;
      const br = a[p + gw + 1] >= t ? 2 : 0;
      const bl = a[p + gw] >= t ? 1 : 0;
      const code = tl | tr | br | bl;
      if (code === 0 || code === 15) continue;
      const T = 2 * p;
      const L = 2 * p + 1;
      const B = 2 * (p + gw);
      const R = 2 * (p + 1) + 1;
      // inside on the LEFT of travel as drawn (image rows run down, so this is the screen's
      // left too): counter-clockwise around islands, clockwise around holes, once y is flipped
      switch (code) {
        case 8: next[L] = T; break;
        case 4: next[T] = R; break;
        case 2: next[R] = B; break;
        case 1: next[B] = L; break;
        case 7: next[T] = L; break;
        case 11: next[R] = T; break;
        case 13: next[B] = R; break;
        case 14: next[L] = B; break;
        case 12: next[L] = R; break;
        case 6: next[T] = B; break;
        case 3: next[R] = L; break;
        case 9: next[B] = T; break;
        case 10: // tl + br inside
          if (a[p] + a[p + 1] + a[p + gw] + a[p + gw + 1] >= 4 * t) {
            next[R] = T;
            next[L] = B;
          } else {
            next[L] = T;
            next[R] = B;
          }
          break;
        case 5: // tr + bl inside
          if (a[p] + a[p + 1] + a[p + gw] + a[p + gw + 1] >= 4 * t) {
            next[T] = L;
            next[B] = R;
          } else {
            next[T] = R;
            next[B] = L;
          }
          break;
      }
    }
  }
  // grid point (x, y) is sample (x − 1, y − 1), centred at image u = (x − 0.5) / sw
  const fx = ux / sw;
  const fy = uy / sh;
  const loops: number[][] = [];
  for (let start = 0; start < next.length; start++) {
    if (next[start] < 0) continue;
    const pts: number[] = [];
    let e = start;
    while (next[e] >= 0) {
      const p = e >> 1;
      const x = p % gw;
      const y = (p - x) / gw;
      const a0 = a[p];
      let gx = x;
      let gy = y;
      if (e & 1) gy += (t - a0) / (a[p + gw] - a0);
      else gx += (t - a0) / (a[p + 1] - a0);
      const px = (gx - 0.5) * fx - ux / 2;
      const py = uy / 2 - (gy - 0.5) * fy;
      // a sample exactly at the threshold puts the crossings of its edges on it: one vertex
      if (pts.length === 0 || px !== pts[pts.length - 2] || py !== pts[pts.length - 1]) pts.push(px, py);
      const n = next[e];
      next[e] = -1;
      e = n;
    }
    if (pts.length > 2 && pts[0] === pts[pts.length - 2] && pts[1] === pts[pts.length - 1]) pts.length -= 2;
    if (pts.length >= 6) loops.push(pts);
  }
  return loops;
}

function signedArea(p: number[]): number {
  let s = 0;
  for (let i = 0, n = p.length, j = n - 2; i < n; j = i, i += 2) s += p[j] * p[i + 1] - p[i] * p[j + 1];
  return s / 2;
}

/**
 * Whether vertex i of `p` comes before vertex j in (x, y) order. Every choice the simplifier
 * makes between vertices goes by this order, never by index, so the result depends on the
 * loop's points alone: not on where the edge walk started nor which way it ran.
 */
const before = (p: number[], i: number, j: number) => p[2 * i] < p[2 * j] || (p[2 * i] === p[2 * j] && p[2 * i + 1] < p[2 * j + 1]);

/** Squared distance from vertex i of `p` to the segment between vertices a and b, bit-identical for (a, b) and (b, a). */
function segDist2(p: number[], i: number, a: number, b: number): number {
  if (before(p, b, a)) [a, b] = [b, a];
  const ax = p[2 * a];
  const ay = p[2 * a + 1];
  const px = p[2 * i] - ax;
  const py = p[2 * i + 1] - ay;
  const dx = p[2 * b] - ax;
  const dy = p[2 * b + 1] - ay;
  const l2 = dx * dx + dy * dy;
  const s = l2 > 0 ? Math.max(0, Math.min(1, (px * dx + py * dy) / l2)) : 0;
  const ex = px - s * dx;
  const ey = py - s * dy;
  return ex * ex + ey * ey;
}

/**
 * Douglas–Peucker on a closed loop without consecutive duplicates. The loop is split at its
 * first vertex in (x, y) order and the vertex farthest from it (both on the convex hull, so
 * any simplification keeps them near), each chain is simplified with ties going to the first
 * vertex in that order, and an anchor that ends up on a straight run (every original vertex
 * between its kept neighbours within `tol` of their chord) is let go: the kept set is the
 * same for every start vertex and both walk directions, and no vertex is pinned for being
 * where the walk began.
 */
function simplifyClosed(p: number[], tol: number): number[] {
  const n = p.length / 2;
  if (n < 4) return p;
  let a = 0;
  for (let i = 1; i < n; i++) if (before(p, i, a)) a = i;
  let b = a;
  let best = -1;
  for (let i = 0; i < n; i++) {
    const d = (p[2 * i] - p[2 * a]) ** 2 + (p[2 * i + 1] - p[2 * a + 1]) ** 2;
    if (d > best || (d === best && before(p, i, b))) {
      best = d;
      b = i;
    }
  }
  const tol2 = tol * tol;
  const keep = new Uint8Array(n);
  keep[a] = 1;
  keep[b] = 1;
  // positions along the loop from a (position k = vertex (a + k) % n; n = a again)
  const mid = (b - a + n) % n;
  const stack = [0, mid, mid, n];
  while (stack.length) {
    const j = stack.pop()!;
    const i = stack.pop()!;
    if (j - i < 2) continue;
    const vi = (a + i) % n;
    const vj = (a + j) % n;
    let dmax = -1;
    let k = -1;
    for (let m = i + 1; m < j; m++) {
      const v = (a + m) % n;
      const d = segDist2(p, v, vi, vj);
      if (d > dmax || (d === dmax && before(p, v, (a + k) % n))) {
        dmax = d;
        k = m;
      }
    }
    if (dmax > tol2) {
      keep[(a + k) % n] = 1;
      stack.push(i, k, k, j);
    }
  }
  let kept = 0;
  for (let i = 0; i < n; i++) kept += keep[i];
  for (const v of [a, b]) {
    if (kept <= 3) break;
    let u = v;
    do u = (u + n - 1) % n;
    while (!keep[u]);
    let w = v;
    do w = (w + 1) % n;
    while (!keep[w]);
    let straight = true;
    for (let m = (u + 1) % n; straight && m !== w; m = (m + 1) % n) straight = segDist2(p, m, u, w) <= tol2;
    if (straight) {
      keep[v] = 0;
      kept--;
    }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(p[2 * i], p[2 * i + 1]);
  return out;
}

/** Chaikin corner cutting of a closed loop, except at its real corners (see header). */
function smoothClosed(p: number[], tol: number): number[] {
  const n = p.length / 2;
  let corner = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const a = ((i + n - 1) % n) * 2;
    const c = ((i + 1) % n) * 2;
    const v = i * 2;
    const e1x = p[v] - p[a];
    const e1y = p[v + 1] - p[a + 1];
    const e2x = p[c] - p[v];
    const e2y = p[c + 1] - p[v + 1];
    const l1 = Math.hypot(e1x, e1y);
    const l2 = Math.hypot(e2x, e2y);
    if (l1 < 1e-12 || l2 < 1e-12) {
      corner[i] = 1;
      continue;
    }
    const theta = Math.acos(Math.max(-1, Math.min(1, (e1x * e2x + e1y * e2y) / (l1 * l2))));
    corner[i] = theta * Math.min(l1, l2) > CORNER_K * tol ? 1 : 0;
  }
  let pts = p;
  for (let pass = 0; pass < CHAIKIN_PASSES; pass++) {
    const m = pts.length / 2;
    const out: number[] = [];
    const oc: number[] = [];
    for (let i = 0; i < m; i++) {
      const v = i * 2;
      if (corner[i]) {
        out.push(pts[v], pts[v + 1]);
        oc.push(1);
        continue;
      }
      const a = ((i + m - 1) % m) * 2;
      const c = ((i + 1) % m) * 2;
      out.push(0.75 * pts[v] + 0.25 * pts[a], 0.75 * pts[v + 1] + 0.25 * pts[a + 1]);
      out.push(0.75 * pts[v] + 0.25 * pts[c], 0.75 * pts[v + 1] + 0.25 * pts[c + 1]);
      oc.push(0, 0);
    }
    pts = out;
    corner = Uint8Array.from(oc);
  }
  return pts;
}

function unitTrace(img: TraceImage, cache: ImageCache, n: number, trace: ImageTrace): number[][] {
  const key = `${n}|${trace.threshold}|${trace.smooth}|${trace.despeckle}`;
  const hit = cache.unit.get(key);
  if (hit) return hit;
  const [w, h] = dims(img);
  const m = Math.max(w, h, 1);
  const t = Math.min(255, Math.max(1, trace.threshold));
  const minArea = Math.max(0, trace.despeckle) / 100;
  const smooth = Math.max(0, trace.smooth) / 100;
  const tol = Math.max(smooth, MIN_TOLERANCE / n);
  const out: number[][] = [];
  for (const loop of marchingSquares(alphaGrid(img, cache, n), t, w / m, h / m)) {
    const area = signedArea(loop);
    if (Math.abs(area) < minArea) continue;
    let p = simplifyClosed(loop, tol);
    if (smooth > 0 && p.length >= 6) p = smoothClosed(p, tol);
    // a loop that collapsed or flipped while simplifying is a sliver: drop it
    if (p.length < 6 || Math.sign(signedArea(p)) !== Math.sign(area)) continue;
    // start every loop at its first vertex in (x, y) order: the commands don't depend on the walk either
    let s = 0;
    for (let i = 1; i < p.length / 2; i++) if (before(p, i, s)) s = i;
    out.push(s ? [...p.slice(2 * s), ...p.slice(0, 2 * s)] : p);
  }
  return remember(cache.unit, key, out);
}

/**
 * The outline of `img`'s alpha at `trace.threshold` in layer space (y-up, centred, larger side
 * = `size`): closed M / L / Z contours, outer counter-clockwise, holes clockwise (see header).
 * Memoized per (image, size, trace); the only side effect is the first pixel read of the image.
 */
export function traceImage(img: TraceImage, size: number, trace: ImageTrace): PathCmd[] {
  let cache = caches.get(img);
  if (!cache) caches.set(img, (cache = { grids: new Map(), unit: new Map(), cmds: new Map() }));
  const key = `${size}|${trace.threshold}|${trace.smooth}|${trace.despeckle}`;
  const hit = cache.cmds.get(key);
  if (hit) return hit;
  const [w, h] = dims(img);
  const n = Math.max(1, Math.min(MAX_SAMPLES, Math.max(w, h), Math.ceil(size * SAMPLES_PER_PX)));
  const cmds: PathCmd[] = [];
  if (w > 0 && h > 0 && size > 0) {
    for (const p of unitTrace(img, cache, n, trace)) {
      for (let i = 0; i < p.length; i += 2) cmds.push({ type: i ? 'L' : 'M', x: p[i] * size, y: p[i + 1] * size });
      cmds.push({ type: 'Z' });
    }
  }
  return remember(cache.cmds, key, cmds);
}

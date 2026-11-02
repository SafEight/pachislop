import * as THREE from 'three';
import type { EffectContext, EffectDef, EffectParams } from '../../engine/contracts';
import { centreX, centreY } from '../../engine/frame';
import { B, bool, C, col, DEG, drawObject, N, num, readGrid, rng, S, sel } from './common';

// Shatter (ガラス割れ / 破片, AE Shatter): the layer's pixels are cut into pieces (glass spokes and
// rings around the impact, Voronoi cells or triangles) and the pieces inside the blast radius are
// thrown outward and turned. Each piece keeps its texture; its cut edges catch a thin highlight.
// Pieces are built on the CPU in comp px (laid out over the ink box of the layer's own pixels,
// ctx.content, so an earlier glow or sparkles don't stretch the layout, read from a comp-fixed
// grid), so they cut the same way at every render scale, then drawn as textured triangle fans;
// the outer pieces reach the frame, so every pixel of the stack so far is cut.

/** Flat polygon [x0, y0, x1, y1, …], comp px (origin comp centre, +y up). */
type Poly = number[];

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Box snap, comp px: the layout only changes when the ink grows past a 32 px step. */
const SNAP = 32;
/** A coordinate far outside any comp: outer cells reach it, then the frame clips them. */
const FAR = 1e5;

/**
 * Box the pieces are laid out over, comp px: the cells of the layer's own pixels (ctx.content)
 * at least half covered (fringe and soft shadows resample differently at each render scale,
 * solid ink does not), any ink at all when nothing is that solid, padded by two cells and
 * snapped outward to SNAP. Null for an empty layer.
 */
function inkBox(ctx: EffectContext): Box | null {
  const g = readGrid(ctx, ctx.content, 8, 'shatter');
  const c = g.cellComp;
  for (const min of [0.5, 0.004]) {
    let gx0 = Infinity;
    let gy0 = Infinity;
    let gx1 = -Infinity;
    let gy1 = -Infinity;
    for (let y = 0; y < g.h; y++)
      for (let x = 0; x < g.w; x++) {
        if (g.alpha[y * g.w + x] < min) continue;
        gx0 = Math.min(gx0, x);
        gy0 = Math.min(gy0, y);
        gx1 = Math.max(gx1, x + 1);
        gy1 = Math.max(gy1, y + 1);
      }
    if (gx0 > gx1) continue;
    return {
      x0: Math.floor((g.x0 + (gx0 - 2) * c) / SNAP) * SNAP,
      y0: Math.floor((g.y0 + (gy0 - 2) * c) / SNAP) * SNAP,
      x1: Math.ceil((g.x0 + (gx1 + 2) * c) / SNAP) * SNAP,
      y1: Math.ceil((g.y0 + (gy1 + 2) * c) / SNAP) * SNAP,
    };
  }
  return null;
}

// ---------- polygon helpers ----------

function area(p: Poly) {
  let a = 0;
  const n = p.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += p[2 * i] * p[2 * j + 1] - p[2 * j] * p[2 * i + 1];
  }
  return a / 2;
}

/** Area centroid (vertex mean for degenerate polygons). */
function centroid(p: Poly): [number, number] {
  const n = p.length / 2;
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const k = p[2 * i] * p[2 * j + 1] - p[2 * j] * p[2 * i + 1];
    a += k;
    cx += (p[2 * i] + p[2 * j]) * k;
    cy += (p[2 * i + 1] + p[2 * j + 1]) * k;
  }
  if (Math.abs(a) < 1e-9) {
    for (let i = 0; i < n; i++) {
      cx += p[2 * i];
      cy += p[2 * i + 1];
    }
    return [cx / n, cy / n];
  }
  return [cx / (3 * a), cy / (3 * a)];
}

/** Counter-clockwise copy of `p` without repeated points. */
function ccw(p: Poly): Poly {
  const out: Poly = [];
  const n = p.length / 2;
  for (let i = 0; i < n; i++) {
    const x = p[2 * i];
    const y = p[2 * i + 1];
    const m = out.length;
    if (m >= 2 && Math.abs(out[m - 2] - x) < 1e-6 && Math.abs(out[m - 1] - y) < 1e-6) continue;
    out.push(x, y);
  }
  while (out.length >= 4 && Math.abs(out[0] - out[out.length - 2]) < 1e-6 && Math.abs(out[1] - out[out.length - 1]) < 1e-6) out.length -= 2;
  if (area(out) >= 0) return out;
  const r: Poly = [];
  for (let i = out.length / 2 - 1; i >= 0; i--) r.push(out[2 * i], out[2 * i + 1]);
  return r;
}

/** Keep the part of `p` where nx·x + ny·y ≤ d (Sutherland–Hodgman). */
function clip(p: Poly, nx: number, ny: number, d: number): Poly {
  const out: Poly = [];
  const n = p.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = p[2 * i];
    const ay = p[2 * i + 1];
    const bx = p[2 * j];
    const by = p[2 * j + 1];
    const da = nx * ax + ny * ay - d;
    const db = nx * bx + ny * by - d;
    if (da <= 0) out.push(ax, ay);
    if ((da < 0 && db > 0) || (da > 0 && db < 0)) {
      const t = da / (da - db);
      out.push(ax + (bx - ax) * t, ay + (by - ay) * t);
    }
  }
  return out;
}

/** Move every edge of the CCW polygon `p` inward by `g` (mitred corners); null if it vanishes. */
function inset(p: Poly, g: number): Poly | null {
  if (g <= 0) return p;
  const n = p.length / 2;
  const out: Poly = [];
  for (let i = 0; i < n; i++) {
    const h = (i + n - 1) % n;
    const j = (i + 1) % n;
    let ax = p[2 * i] - p[2 * h];
    let ay = p[2 * i + 1] - p[2 * h + 1];
    let bx = p[2 * j] - p[2 * i];
    let by = p[2 * j + 1] - p[2 * i + 1];
    const la = Math.hypot(ax, ay) || 1;
    const lb = Math.hypot(bx, by) || 1;
    ax /= la;
    ay /= la;
    bx /= lb;
    by /= lb;
    // Left normals point inward on a CCW polygon; the mitre is (n1 + n2) / (1 + n1·n2).
    const k = Math.max(0.2, 1 + (-ay * -by + ax * bx));
    out.push(p[2 * i] + (g * (-ay - by)) / k, p[2 * i + 1] + (g * (ax + bx)) / k);
  }
  return area(out) > 0.5 ? out : null;
}

// ---------- partitions ----------

// Each partition tiles the whole plane (outer cells reach FAR) but lays its pieces out over the
// ink box only, so pixels outside the box still belong to some piece; buildPieces clips the
// cells to the render frame.

/**
 * Glass: kinked spokes from the impact crossed by chord rings, denser toward the impact. An impact
 * outside the box fans its spokes over just the angle the box covers, rings starting at the box,
 * and the rest of the circle is a few large wedges.
 */
function glassCells(r: () => number, b: Box, ix: number, iy: number, pieces: number): Poly[] {
  const K = Math.min(40, Math.max(5, Math.round(Math.sqrt(pieces * 0.9))));
  const M = Math.max(1, Math.round(pieces / K));
  const inside = ix > b.x0 && ix < b.x1 && iy > b.y0 && iy < b.y1;
  const corners = [
    [b.x0, b.y0],
    [b.x1, b.y0],
    [b.x0, b.y1],
    [b.x1, b.y1],
  ];
  let rc = 1;
  for (const [x, y] of corners) rc = Math.max(rc, Math.hypot(x - ix, y - iy));
  const rNear = inside ? 0 : Math.hypot(Math.max(b.x0 - ix, 0, ix - b.x1), Math.max(b.y0 - iy, 0, iy - b.y1));
  const base: number[] = [];
  let sp: number;
  if (inside) {
    sp = (2 * Math.PI) / K;
    const start = r() * 2 * Math.PI;
    for (let k = 0; k < K; k++) base.push(start + (k + (r() - 0.5) * 0.5) * sp);
  } else {
    // Corner angles relative to the direction of the box centre (all within ±90°).
    const toC = Math.atan2((b.y0 + b.y1) / 2 - iy, (b.x0 + b.x1) / 2 - ix);
    let lo = 0;
    let hi = 0;
    for (const [x, y] of corners) {
      const d = Math.atan2(y - iy, x - ix) - toC;
      const w = Math.atan2(Math.sin(d), Math.cos(d));
      lo = Math.min(lo, w);
      hi = Math.max(hi, w);
    }
    lo -= 0.02;
    hi += 0.02;
    sp = (hi - lo) / (K - 1);
    for (let k = 0; k < K; k++) base.push(toC + lo + (k + (k > 0 && k < K - 1 ? (r() - 0.5) * 0.5 : 0)) * sp);
  }
  const rad = [rNear]; // rad[0] only bounds ring 1's jitter; the innermost cells meet at the impact
  for (let j = 1; j < M; j++) rad.push(rNear + (rc - rNear) * ((j + (r() - 0.5) * 0.5) / M) ** 1.5);
  rad.push(FAR);
  // P[k][j]: crossing of spoke k and ring j (j ≥ 1), jittered so spokes kink and rings wobble.
  const P: [number, number][][] = [];
  for (let k = 0; k < K; k++) {
    const row: [number, number][] = [[ix, iy]];
    // The two edge spokes of a fan stay straight so they keep bounding the box.
    const straight = !inside && (k === 0 || k === K - 1);
    for (let j = 1; j <= M; j++) {
      const outer = j === M;
      const kink = (r() - 0.5) * 0.2 * sp;
      const a = base[k] + (outer || straight ? 0 : kink);
      const rr = outer ? rad[j] : rad[j] + (r() - 0.5) * 0.35 * (rad[j] - rad[j - 1]);
      row.push([ix + Math.cos(a) * rr, iy + Math.sin(a) * rr]);
    }
    P.push(row);
  }
  const cells: Poly[] = [];
  for (let k = 0; k < (inside ? K : K - 1); k++) {
    const A = P[k];
    const Bk = P[(k + 1) % K];
    cells.push([ix, iy, ...A[1], ...Bk[1]]);
    for (let j = 1; j < M; j++) {
      const q = [...A[j], ...A[j + 1], ...Bk[j + 1], ...Bk[j]];
      // Some ring cells crack once more along a diagonal.
      if (r() < 0.25) cells.push([q[0], q[1], q[2], q[3], q[4], q[5]], [q[0], q[1], q[4], q[5], q[6], q[7]]);
      else cells.push(q);
    }
  }
  if (!inside) {
    // The rest of the circle around a fan, in wedges under 60° so each stays convex.
    const a0 = base[K - 1];
    const span = base[0] + 2 * Math.PI - a0;
    const n = Math.ceil(span / (Math.PI / 3));
    for (let k = 0; k < n; k++) {
      const u = a0 + (span * k) / n;
      const v = a0 + (span * (k + 1)) / n;
      cells.push([ix, iy, ix + Math.cos(u) * FAR, iy + Math.sin(u) * FAR, ix + Math.cos(v) * FAR, iy + Math.sin(v) * FAR]);
    }
  }
  return cells;
}

/** Voronoi cells of jittered-grid seeds over the box. */
function voronoiCells(r: () => number, b: Box, pieces: number): Poly[] {
  const bw = b.x1 - b.x0;
  const bh = b.y1 - b.y0;
  const cols = Math.max(1, Math.round(Math.sqrt((pieces * bw) / bh)));
  const rows = Math.max(1, Math.round(pieces / cols));
  const cw = bw / cols;
  const ch = bh / rows;
  const seeds: [number, number][] = [];
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < cols; i++) seeds.push([b.x0 + (i + 0.5 + (r() - 0.5) * 0.9) * cw, b.y0 + (j + 0.5 + (r() - 0.5) * 0.9) * ch]);
  return seeds.map(([sx, sy], si) => {
    const others = seeds
      .map(([x, y], k) => ({ x, y, d: k === si ? Infinity : Math.hypot(x - sx, y - sy) }))
      .filter((o) => o.d < Infinity)
      .sort((u, v) => u.d - v.d);
    let cell: Poly = [-FAR, -FAR, FAR, -FAR, FAR, FAR, -FAR, FAR];
    for (const o of others) {
      // A neighbour farther than twice the cell's reach cannot cut it any more.
      let reach = 0;
      for (let i = 0; i < cell.length; i += 2) reach = Math.max(reach, Math.hypot(cell[i] - sx, cell[i + 1] - sy));
      if (o.d > 2 * reach) break;
      const nx = (o.x - sx) / o.d;
      const ny = (o.y - sy) / o.d;
      cell = clip(cell, nx, ny, nx * (sx + o.x) * 0.5 + ny * (sy + o.y) * 0.5);
      if (cell.length < 6) break;
    }
    return cell;
  });
}

/** Jittered grid over the box split into triangles along random diagonals, plus a FAR border ring. */
function triangleCells(r: () => number, b: Box, pieces: number): Poly[] {
  const bw = b.x1 - b.x0;
  const bh = b.y1 - b.y0;
  const cols = Math.max(1, Math.round(Math.sqrt(((pieces / 2) * bw) / bh)));
  const rows = Math.max(1, Math.round(pieces / 2 / cols));
  const cw = bw / cols;
  const ch = bh / rows;
  // Grid indices −1 and cols + 1 (rows + 1) sit at ∓FAR; box-edge points slide only along their edge.
  const coord = (i: number, n: number, lo: number, step: number, jitter: number) =>
    i < 0 ? -FAR : i > n ? FAR : lo + i * step + (i > 0 && i < n ? jitter : 0);
  const pt: [number, number][] = [];
  for (let j = -1; j <= rows + 1; j++)
    for (let i = -1; i <= cols + 1; i++) {
      const jx = (r() - 0.5) * 0.7 * cw;
      const jy = (r() - 0.5) * 0.7 * ch;
      pt.push([coord(i, cols, b.x0, cw, jx), coord(j, rows, b.y0, ch, jy)]);
    }
  const at = (i: number, j: number) => pt[(j + 1) * (cols + 3) + i + 1];
  const cells: Poly[] = [];
  for (let j = -1; j <= rows; j++)
    for (let i = -1; i <= cols; i++) {
      const a = at(i, j);
      const bb = at(i + 1, j);
      const c = at(i + 1, j + 1);
      const d = at(i, j + 1);
      if (r() < 0.5) cells.push([...a, ...bb, ...c], [...a, ...c, ...d]);
      else cells.push([...a, ...bb, ...d], [...bb, ...c, ...d]);
    }
  return cells;
}

// ---------- pieces ----------

interface Piece {
  poly: Poly; // inset outline, comp px, CCW
  cx: number; // rotation centre (the uninset centroid)
  cy: number;
  tx: number; // displacement, comp px
  ty: number;
  rot: number; // radians, CCW
  hi: number; // edge highlight multiplier
}

/** Pieces over `box`, cut from cells clipped to `frame` (the whole render, RenderFrame, in comp px). */
function buildPieces(box: Box, frame: Box, p: EffectParams): Piece[] {
  const r = rng(N(p, 'seed') * 7.13 + 1);
  const pieces = Math.min(400, Math.max(10, Math.round(N(p, 'pieces'))));
  const ix = N(p, 'x');
  const iy = N(p, 'y');
  const kind = S(p, 'pattern');
  const cells =
    kind === 'voronoi' ? voronoiCells(r, box, pieces) : kind === 'triangles' ? triangleCells(r, box, pieces) : glassCells(r, box, ix, iy, pieces);
  const radius = Math.max(1e-3, N(p, 'radius'));
  const strength = B(p, 'cracksOnly') ? 0 : N(p, 'strength');
  const rotMax = B(p, 'cracksOnly') ? 0 : N(p, 'rotation') * DEG;
  const lost = N(p, 'lost') / 100;
  const half = Math.max(0, N(p, 'gap')) / 2;
  const out: Piece[] = [];
  for (const cell of cells) {
    // Draw the per-piece randoms first so a piece's fate does not depend on its neighbours' shapes.
    const r1 = r();
    const r2 = r();
    const r3 = r();
    const r4 = r();
    const r5 = r();
    const poly = ccw(clip(clip(clip(clip(cell, -1, 0, -frame.x0), 1, 0, frame.x1), 0, -1, -frame.y0), 0, 1, frame.y1));
    if (poly.length < 6 || area(poly) < 1) continue;
    const [cx, cy] = centroid(poly);
    let dx = cx - ix;
    let dy = cy - iy;
    const dist = Math.hypot(dx, dy);
    if (dist > 1e-3) {
      dx /= dist;
      dy /= dist;
    } else {
      dx = Math.cos(r5 * 2 * Math.PI);
      dy = Math.sin(r5 * 2 * Math.PI);
    }
    const f0 = Math.max(0, 1 - dist / radius);
    const f = f0 * f0 * (3 - 2 * f0);
    // Lost pieces are the ones blown out of the frame, most often right at the impact (up to
    // 2.5 × the percentage there, none past the blast radius): the hole opens where it hit.
    if (r1 < lost * 2.5 * f) continue;
    const push = strength * f * (0.6 + 0.8 * r2);
    const side = strength * f * (r3 - 0.5) * 0.5;
    const inner = inset(poly, half);
    if (!inner) continue;
    out.push({
      poly: inner,
      cx,
      cy,
      tx: dx * push - dy * side,
      ty: dy * push + dx * side,
      rot: (2 * r4 - 1) * rotMax * f,
      hi: 0.55 + 0.45 * r5,
    });
  }
  // Pieces that moved most are drawn last, over the ones still in place.
  return out.sort((a, b) => Math.hypot(a.tx, a.ty) - Math.hypot(b.tx, b.ty));
}

// ---------- drawing ----------

const pieceVert = /* glsl */ `
in vec2 aSrc; in float aEdge; in float aHi; out vec2 vSrc; out float vEdge; out float vHi; uniform vec2 uRes;
void main() { vSrc = aSrc; vEdge = aEdge; vHi = aHi; gl_Position = vec4(position.xy / uRes * 2.0 - 1.0, 0.0, 1.0); }`;

// vEdge: distance to the piece's cut edge in render px. The outermost pixel fades for
// anti-aliasing; a thin band inside it lights up, only where the piece holds ink.
const pieceFrag = /* glsl */ `
uniform sampler2D tSrc; uniform vec3 uHiCol; uniform float uHiAmt, uHiW;
in vec2 vSrc; in float vEdge; in float vHi; out vec4 o;
void main() {
  vec4 s = texture(tSrc, vSrc);
  float cov = clamp(vEdge + 0.5, 0.0, 1.0);
  // A sharp bright line right at the cut plus a softer sheen a few px into the piece.
  float h = 0.8 * exp(-vEdge / uHiW) + 0.3 * exp(-vEdge / (4.0 * uHiW));
  o = vec4(s.rgb + uHiCol * (h * uHiAmt * vHi * s.a * 1.6), s.a) * cov;
}`;

const meshes = new WeakMap<object, { mesh: THREE.Mesh; geo: THREE.BufferGeometry; cap: number }>();

/** Triangle mesh with room for `nVerts` vertices, one per kit. */
function pieceMesh(kit: object, nVerts: number) {
  let st = meshes.get(kit);
  if (!st || st.cap < nVerts) {
    st?.geo.dispose();
    const cap = Math.max(4096, 2 ** Math.ceil(Math.log2(nVerts)));
    const geo = new THREE.BufferGeometry();
    const attr = (size: number) => new THREE.BufferAttribute(new Float32Array(cap * size), size).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', attr(3));
    geo.setAttribute('aSrc', attr(2));
    geo.setAttribute('aEdge', attr(1));
    geo.setAttribute('aHi', attr(1));
    const mat =
      st?.mesh.material instanceof THREE.ShaderMaterial
        ? st.mesh.material
        : new THREE.ShaderMaterial({
            glslVersion: THREE.GLSL3,
            vertexShader: pieceVert,
            fragmentShader: pieceFrag,
            uniforms: {
              uRes: { value: new THREE.Vector2() },
              tSrc: { value: null },
              uHiCol: { value: new THREE.Color() },
              uHiAmt: { value: 0 },
              uHiW: { value: 1 },
            },
            depthTest: false,
            depthWrite: false,
            transparent: true,
            blending: THREE.CustomBlending,
            blendEquation: THREE.AddEquation,
            blendSrc: THREE.OneFactor,
            blendDst: THREE.OneMinusSrcAlphaFactor,
            blendSrcAlpha: THREE.OneFactor,
            blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
          });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    st = { mesh, geo, cap };
    meshes.set(kit, st);
  }
  return st;
}

function drawPieces(ctx: EffectContext, input: THREE.Texture, pieces: Piece[], p: EffectParams, target: THREE.WebGLRenderTarget) {
  let nVerts = 0;
  for (const pc of pieces) nVerts += (pc.poly.length / 2) * 3;
  const st = pieceMesh(ctx.kit, nVerts);
  const P = (st.geo.getAttribute('position') as THREE.BufferAttribute).array as Float32Array;
  const U = (st.geo.getAttribute('aSrc') as THREE.BufferAttribute).array as Float32Array;
  const E = (st.geo.getAttribute('aEdge') as THREE.BufferAttribute).array as Float32Array;
  const H = (st.geo.getAttribute('aHi') as THREE.BufferAttribute).array as Float32Array;
  const { width: W, height: Hh, pxScale: s } = ctx;
  // comp px → target px (the comp centre at (cx0, cy0)), and → target uv
  const cx0 = centreX(ctx.frame);
  const cy0 = centreY(ctx.frame);
  let v = 0;
  const put = (pc: Piece, x: number, y: number, edge: number, cos: number, sin: number) => {
    const rx = x - pc.cx;
    const ry = y - pc.cy;
    P[v * 3] = cx0 + (pc.cx + cos * rx - sin * ry + pc.tx) * s;
    P[v * 3 + 1] = cy0 + (pc.cy + sin * rx + cos * ry + pc.ty) * s;
    P[v * 3 + 2] = 0;
    U[v * 2] = (cx0 + x * s) / W;
    U[v * 2 + 1] = (cy0 + y * s) / Hh;
    E[v] = edge * s;
    H[v] = pc.hi;
    v++;
  };
  for (const pc of pieces) {
    const cos = Math.cos(pc.rot);
    const sin = Math.sin(pc.rot);
    const [mx, my] = centroid(pc.poly);
    const n = pc.poly.length / 2;
    // Fan from the centroid: the distance to a triangle's outer edge is affine across it, so
    // it interpolates exactly from the corner values (0 on the edge).
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ax = pc.poly[2 * i];
      const ay = pc.poly[2 * i + 1];
      const bx = pc.poly[2 * j];
      const by = pc.poly[2 * j + 1];
      const l = Math.hypot(bx - ax, by - ay) || 1;
      const dm = Math.abs((bx - ax) * (my - ay) - (by - ay) * (mx - ax)) / l;
      put(pc, mx, my, dm, cos, sin);
      put(pc, ax, ay, 0, cos, sin);
      put(pc, bx, by, 0, cos, sin);
    }
  }
  for (const name of ['position', 'aSrc', 'aEdge', 'aHi']) (st.geo.getAttribute(name) as THREE.BufferAttribute).needsUpdate = true;
  st.geo.setDrawRange(0, v);
  const u = (st.mesh.material as THREE.ShaderMaterial).uniforms;
  u.uRes.value.set(W, Hh);
  u.tSrc.value = input;
  u.uHiCol.value.copy(C(p, 'edgeColor'));
  u.uHiAmt.value = N(p, 'edgeHighlight') / 100;
  u.uHiW.value = Math.max(0.6, s);
  drawObject(ctx, st.mesh, target);
}

const MOVING = { key: 'cracksOnly', value: false };

const shatter: EffectDef = {
  type: 'shatter',
  label: 'Shatter',
  category: 'Distort',
  description:
    'AE Shatter-style ガラス割れ: cuts the layer into glass shards, Voronoi cells or triangles and blasts the pieces near the impact point outward, with a thin highlight on every cut edge. Cracks only keeps the pieces in place.',
  params: [
    sel('pattern', 'Pattern', 'glass', [
      ['glass', 'Glass (radial + rings)'],
      ['voronoi', 'Voronoi'],
      ['triangles', 'Triangles'],
    ]),
    num('pieces', 'Pieces', 60, 10, 400, undefined, 1),
    num('x', 'Impact X', 0, -4000, 4000, 'px'),
    num('y', 'Impact Y', 0, -4000, 4000, 'px'),
    num('radius', 'Blast radius', 300, 0, 4000, 'px'),
    { ...num('strength', 'Strength', 80, 0, 1000, 'px'), when: MOVING },
    { ...num('rotation', 'Rotation random', 25, 0, 180, 'deg'), when: MOVING },
    num('gap', 'Gap', 1, 0, 40, 'px', 0.5),
    col('edgeColor', 'Edge colour', '#ffffff'),
    num('edgeHighlight', 'Edge highlight', 100, 0, 300, '%'),
    num('lost', 'Lost pieces', 10, 0, 100, '%'),
    bool('cracksOnly', 'Cracks only', false),
    num('seed', 'Seed', 1, 0, 999, undefined, 1),
  ],
  handles: [{ x: 'x', y: 'y', label: 'Impact point' }],
  // Farthest push (≈ 1.42 × strength with the sideways scatter) plus a turned piece's corner
  // swing, taking pieces near the impact as at most half the blast radius across.
  reach: (p) =>
    B(p, 'cracksOnly') ? 0 : 1.45 * N(p, 'strength') + 0.5 * N(p, 'radius') * Math.min(1, N(p, 'rotation') * DEG),
  apply(ctx, input, output, p) {
    const box = inkBox(ctx);
    // The whole frame (not just this target, a window of it), comp px: the outer pieces reach its edges.
    const hw = ctx.frame.width / ctx.pxScale / 2;
    const hh = ctx.frame.height / ctx.pxScale / 2;
    const pieces = box ? buildPieces(box, { x0: -hw, y0: -hh, x1: hw, y1: hh }, p) : [];
    if (pieces.length === 0) {
      ctx.kit.copy(input, output);
      return;
    }
    drawPieces(ctx, input, pieces, p, output);
  },
};

export const SHATTER_EFFECTS: EffectDef[] = [shatter];

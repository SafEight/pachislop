import * as THREE from 'three';
import type { EffectParams, GeneratorDef, PassContext } from '../../engine/contracts';
import { blur } from '../../effects/lib';
import { C, col, common, DEG, drawObject, hash, HEAD, material, N, num, readGrid, rng, S, sel } from '../../effects/b/common';
import { clearTarget, drawFollowed, followed, followParam } from '../common';

// Electric arcs crawling over and shooting out from the edges of the followed layer's own
// pixels, with branching bolts and their own two-scale glow, drawn as light: a companion above
// the layer set to Add.

interface Edge {
  x: number; // render px
  y: number;
  nx: number; // outward normal
  ny: number;
}

/** Cell size of the lightning edge grid, comp px. */
const EDGE_CELL = 6;

/**
 * Edge cells of the followed layer's alpha grid with outward normals, in render px of the WHOLE
 * frame (origin at its bottom-left, not the target's): the arcs are laid out there, so a preview
 * window walks the very same edge cells as the whole render; drawBolts maps them to the target.
 */
function findEdges(ctx: PassContext, content: THREE.Texture): Edge[] {
  const g = readGrid(ctx, content, EDGE_CELL, 'lightning');
  const { w, h, alpha, cell } = g;
  // Cell (0, 0)'s corner in whole-frame px: readGrid's px0 / py0 on a whole frame.
  const px0 = ctx.frame.width / 2 - (-g.x0 / g.cellComp) * cell;
  const py0 = ctx.frame.height / 2 - (-g.y0 / g.cellComp) * cell;
  const at = (x: number, y: number) => alpha[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];
  const edges: Edge[] = [];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (at(x, y) < 0.5) continue;
      if (at(x - 1, y) >= 0.5 && at(x + 1, y) >= 0.5 && at(x, y - 1) >= 0.5 && at(x, y + 1) >= 0.5) continue;
      // Sobel gradient of coverage; outward = −gradient.
      const gx =
        at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1);
      const gy =
        at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1);
      const l = Math.hypot(gx, gy);
      if (l < 1e-4) continue;
      edges.push({ x: px0 + (x + 0.5) * cell, y: py0 + (y + 0.5) * cell, nx: -gx / l, ny: -gy / l });
    }
  return edges;
}

interface Seg {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  w: number; // core width multiplier
  i: number; // intensity
}

/** Midpoint-displacement bolt from a to b, appended to `out`, with random branches. */
function bolt(
  out: Seg[],
  r: () => number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  jag: number,
  bulge: number,
  width: number,
  inten: number,
  depth: number,
  branchProb: number,
) {
  let pts = [ax, ay, bx, by];
  const len = Math.hypot(bx - ax, by - ay);
  if (len < 1) return;
  const px = -(by - ay) / len;
  const py = (bx - ax) / len;
  let amp = jag * len * 0.35;
  for (let lvl = 0; lvl < depth; lvl++) {
    const next: number[] = [];
    for (let i = 0; i < pts.length - 2; i += 2) {
      const x0 = pts[i];
      const y0 = pts[i + 1];
      const x1 = pts[i + 2];
      const y1 = pts[i + 3];
      const off = (r() - 0.5) * 2 * amp + (lvl === 0 ? bulge * len : 0);
      next.push(x0, y0, (x0 + x1) / 2 + px * off, (y0 + y1) / 2 + py * off);
    }
    next.push(pts[pts.length - 2], pts[pts.length - 1]);
    pts = next;
    amp *= 0.55;
  }
  const n = pts.length / 2;
  for (let i = 0; i < n - 1; i++) {
    // Slight taper towards the end of the bolt.
    const f = 1 - (0.5 * i) / n;
    out.push({ ax: pts[i * 2], ay: pts[i * 2 + 1], bx: pts[i * 2 + 2], by: pts[i * 2 + 3], w: width * f, i: inten });
    if (branchProb > 0 && i > 1 && i < n - 3 && r() < branchProb) {
      const dx = bx - ax;
      const dy = by - ay;
      const rot = (r() < 0.5 ? -1 : 1) * (0.35 + r() * 0.5);
      const c = Math.cos(rot);
      const s = Math.sin(rot);
      const bl = (0.25 + r() * 0.3) * (1 - i / n);
      const sx = pts[i * 2];
      const sy = pts[i * 2 + 1];
      bolt(out, r, sx, sy, sx + (dx * c - dy * s) * bl, sy + (dx * s + dy * c) * bl, jag, 0, width * 0.55, inten * 0.7, Math.max(2, depth - 2), 0);
    }
  }
}

const lineVert = /* glsl */ `
in float aAcross; in float aInt; out float vA; out float vI; uniform vec2 uRes, uOff;
void main() { vA = aAcross; vI = aInt; gl_Position = vec4((position.xy - uOff) / uRes * 2.0 - 1.0, 0.0, 1.0); }`;
const lineFrag = /* glsl */ `
in float vA; in float vI; out vec4 o;
void main() { float c = vI * exp(-vA * vA * 2.2); o = vec4(c); }`;

const boltState = new WeakMap<object, { mesh: THREE.Mesh; geo: THREE.BufferGeometry; cap: number }>();

function boltMesh(kit: object, nSegs: number) {
  let st = boltState.get(kit);
  if (!st || st.cap < nSegs) {
    st?.geo.dispose();
    const cap = Math.max(1024, 2 ** Math.ceil(Math.log2(nSegs)));
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(cap * 4 * 3), 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aAcross', new THREE.BufferAttribute(new Float32Array(cap * 4), 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aInt', new THREE.BufferAttribute(new Float32Array(cap * 4), 1).setUsage(THREE.DynamicDrawUsage));
    const idx = new Uint32Array(cap * 6);
    for (let i = 0; i < cap; i++) idx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4 + 2, i * 4 + 1, i * 4 + 3], i * 6);
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    const mat =
      st?.mesh.material instanceof THREE.ShaderMaterial
        ? st.mesh.material
        : new THREE.ShaderMaterial({
            glslVersion: THREE.GLSL3,
            vertexShader: lineVert,
            fragmentShader: lineFrag,
            uniforms: { uRes: { value: new THREE.Vector2() }, uOff: { value: new THREE.Vector2() } },
            depthTest: false,
            depthWrite: false,
            transparent: true,
            blending: THREE.CustomBlending,
            blendEquation: THREE.MaxEquation,
            blendSrc: THREE.OneFactor,
            blendDst: THREE.OneFactor,
          });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    st = { mesh, geo, cap };
    boltState.set(kit, st);
  }
  return st;
}

/** Draw `segs` (whole-frame px, see findEdges) into `target` (cleared first). */
function drawBolts(ctx: PassContext, segs: Seg[], coreW: number, target: THREE.WebGLRenderTarget) {
  const st = boltMesh(ctx.kit, segs.length);
  const pos = st.geo.getAttribute('position') as THREE.BufferAttribute;
  const across = st.geo.getAttribute('aAcross') as THREE.BufferAttribute;
  const inten = st.geo.getAttribute('aInt') as THREE.BufferAttribute;
  const P = pos.array as Float32Array;
  const A = across.array as Float32Array;
  const I = inten.array as Float32Array;
  segs.forEach((s, k) => {
    const dx = s.bx - s.ax;
    const dy = s.by - s.ay;
    const l = Math.hypot(dx, dy) || 1;
    const ux = dx / l;
    const uy = dy / l;
    const hw = Math.max(0.7, coreW * s.w) * 1.6; // quad half width; profile reaches ~0 at |across|=1.6
    const nx = -uy * hw;
    const ny = ux * hw;
    // Extend each segment by half its width so joints have no gaps (MAX blending avoids doubling).
    const ax = s.ax - ux * hw * 0.5;
    const ay = s.ay - uy * hw * 0.5;
    const bx = s.bx + ux * hw * 0.5;
    const by = s.by + uy * hw * 0.5;
    P.set([ax + nx, ay + ny, 0, ax - nx, ay - ny, 0, bx + nx, by + ny, 0, bx - nx, by - ny, 0], k * 12);
    A.set([1.6, -1.6, 1.6, -1.6], k * 4);
    I.fill(s.i, k * 4, k * 4 + 4);
  });
  pos.needsUpdate = true;
  across.needsUpdate = true;
  inten.needsUpdate = true;
  st.geo.setDrawRange(0, segs.length * 6);
  const u = (st.mesh.material as THREE.ShaderMaterial).uniforms;
  u.uRes.value.set(ctx.width, ctx.height);
  // Whole-frame px → target px: the target's bottom-left sits at (frame.x, frame.y).
  u.uOff.value.set(ctx.frame.x, ctx.frame.y);
  drawObject(ctx, st.mesh, target);
}

// The bolts' own glow: a tight and a wide Gaussian of the core in the glow colour, around a
// core whitened toward the centre.
const composeFrag = /* glsl */ `
uniform sampler2D tCore, tG1, tG2; uniform vec3 uCol; uniform float uIntensity, uGlow;
void main() {
  float c = texture(tCore, vUv).r, g1 = texture(tG1, vUv).r, g2 = texture(tG2, vUv).r;
  vec3 light = c * mix(uCol, vec3(1.0), 0.8) * 1.6 + (g1 * 5.0 + g2 * 4.0) * uCol * uGlow;
  o = lightPremul(light * uIntensity);
}`;

function lightningBolts(ctx: PassContext, edges: Edge[], p: EffectParams): Seg[] {
  const count = Math.round(N(p, 'count'));
  const len = N(p, 'length') * ctx.pxScale;
  const jag = N(p, 'jaggedness') / 100;
  const seed = N(p, 'seed');
  const mode = S(p, 'mode');
  const branches = N(p, 'branches') / 100;
  const segs: Seg[] = [];
  const nearest = (x: number, y: number) => {
    let best = edges[0];
    let bd = Infinity;
    for (const f of edges) {
      const d = (f.x - x) ** 2 + (f.y - y) ** 2;
      if (d < bd) {
        bd = d;
        best = f;
      }
    }
    return best;
  };
  // Pick start points by position (not list index) so bolts land in the same place at any preview scale.
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const e of edges) {
    x0 = Math.min(x0, e.x);
    y0 = Math.min(y0, e.y);
    x1 = Math.max(x1, e.x);
    y1 = Math.max(y1, e.y);
  }
  for (let i = 0; i < count; i++) {
    const r = rng(hash(seed, i, 0.5) * 1e6 + i);
    const e = nearest(x0 + r() * (x1 - x0), y0 + r() * (y1 - y0));
    const crawl = mode === 'crawl' || (mode === 'mixed' && r() < 0.45);
    if (crawl) {
      // Arc to another edge point roughly `len` away along the edge, bulging outward.
      const tx = -e.ny;
      const ty = e.nx;
      const sign = r() < 0.5 ? -1 : 1;
      const want = len * (0.5 + 0.5 * r());
      const best = nearest(e.x + tx * sign * want + e.nx * want * 0.2, e.y + ty * sign * want + e.ny * want * 0.2);
      if (best === e) continue;
      // Bulge toward the outside of the shape (perpendicular sign from the edge normal).
      const dx = best.x - e.x;
      const dy = best.y - e.y;
      const side = Math.sign(-dy * (e.nx + best.nx) + dx * (e.ny + best.ny)) || 1;
      bolt(segs, r, e.x, e.y, best.x, best.y, jag, 0.22 * side, 1, 1, 6, branches * 0.12);
    } else {
      const ang = (r() - 0.5) * 75 * DEG;
      const c = Math.cos(ang);
      const s = Math.sin(ang);
      const dx = e.nx * c - e.ny * s;
      const dy = e.nx * s + e.ny * c;
      const l = len * (0.55 + 0.45 * r());
      bolt(segs, r, e.x, e.y, e.x + dx * l, e.y + dy * l, jag, 0, 1, 1, 6, branches * 0.2);
    }
  }
  return segs;
}

/**
 * Electrify (along edge): arcs that walk the alpha edge from cell to cell, hovering just outside
 * it. They wrinkle at two scales (a slow random walk of the offset from the edge, midpoint jag
 * between the steps) and fork outward at random steps.
 */
function edgeArcs(ctx: PassContext, edges: Edge[], p: EffectParams): Seg[] {
  const cell = EDGE_CELL * ctx.pxScale;
  const step = 2 * cell;
  const arcs = Math.round(N(p, 'arcs'));
  const len = N(p, 'length') * ctx.pxScale;
  const wrinkle = N(p, 'wrinkle') / 100;
  const forkP = (N(p, 'branchiness') / 100) * 0.3;
  const seed = N(p, 'seed');
  const grid = new Map<number, Edge>();
  for (const e of edges) grid.set(Math.floor(e.x / cell) + Math.floor(e.y / cell) * 65536, e);
  // Start points by position, as for the other modes.
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const e of edges) {
    x0 = Math.min(x0, e.x);
    y0 = Math.min(y0, e.y);
    x1 = Math.max(x1, e.x);
    y1 = Math.max(y1, e.y);
  }
  const segs: Seg[] = [];
  for (let i = 0; i < arcs; i++) {
    const r = rng(hash(seed, i, 0.25) * 1e6 + i);
    const qx = x0 + r() * (x1 - x0);
    const qy = y0 + r() * (y1 - y0);
    let e = edges[0];
    let ed = Infinity;
    for (const f of edges) {
      const d = (f.x - qx) ** 2 + (f.y - qy) ** 2;
      if (d < ed) {
        ed = d;
        e = f;
      }
    }
    const sign = r() < 0.5 ? -1 : 1;
    let tx = -e.ny * sign;
    let ty = e.nx * sign;
    const steps = Math.max(2, Math.round((len * (0.5 + 0.5 * r())) / step));
    const inten = 0.7 + 0.3 * r();
    let off = r() * wrinkle * step * 0.75;
    let pts = [e.x + e.nx * off, e.y + e.ny * off];
    for (let s = 0; s < steps; s++) {
      // Next edge cell nearest one step ahead, never behind.
      const wx = e.x + tx * step;
      const wy = e.y + ty * step;
      const gx = Math.floor(wx / cell);
      const gy = Math.floor(wy / cell);
      let next: Edge | undefined;
      let nd = Infinity;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) {
          const f = grid.get(gx + dx + (gy + dy) * 65536);
          if (!f || f === e || (f.x - e.x) * tx + (f.y - e.y) * ty <= 0) continue;
          const d = (f.x - wx) ** 2 + (f.y - wy) ** 2;
          if (d < nd) {
            nd = d;
            next = f;
          }
        }
      if (!next) break;
      // New heading: the step just taken, nudged toward the new cell's tangent.
      const hx = next.x - e.x;
      const hy = next.y - e.y;
      const hl = Math.hypot(hx, hy) || 1;
      const ts = -next.ny * hx + next.nx * hy < 0 ? -1 : 1;
      tx = hx / hl - next.ny * ts;
      ty = hy / hl + next.nx * ts;
      const tl = Math.hypot(tx, ty) || 1;
      tx /= tl;
      ty /= tl;
      e = next;
      off = Math.min(Math.max(off + (r() - 0.5) * wrinkle * step * 0.6, 0), wrinkle * step * 1.5);
      const px = e.x + e.nx * off;
      const py = e.y + e.ny * off;
      pts.push(px, py);
      if (r() < forkP) {
        const a = (r() - 0.5) * 80 * DEG;
        const c = Math.cos(a);
        const sn = Math.sin(a);
        const l = step * (1 + 3 * r()) * (0.5 + wrinkle);
        bolt(segs, r, px, py, px + (e.nx * c - e.ny * sn) * l, py + (e.nx * sn + e.ny * c) * l, 0.8 * wrinkle, 0, 0.6, inten * 0.75, 4, 0);
      }
    }
    if (pts.length < 4) continue;
    // Midpoint jag between the steps, halving per level.
    let amp = wrinkle * step * 0.3;
    for (let lvl = 0; lvl < 2; lvl++) {
      const fine = [pts[0], pts[1]];
      for (let k = 0; k + 3 < pts.length; k += 2) {
        const ax = pts[k];
        const ay = pts[k + 1];
        const bx = pts[k + 2];
        const by = pts[k + 3];
        const l = Math.hypot(bx - ax, by - ay) || 1;
        const o = (r() - 0.5) * 2 * amp;
        fine.push((ax + bx) / 2 - ((by - ay) / l) * o, (ay + by) / 2 + ((bx - ax) / l) * o, bx, by);
      }
      pts = fine;
      amp *= 0.5;
    }
    // One continuous arc, thinning toward both ends.
    const n = pts.length / 2 - 1;
    for (let k = 0; k < n; k++)
      segs.push({
        ax: pts[2 * k],
        ay: pts[2 * k + 1],
        bx: pts[2 * k + 2],
        by: pts[2 * k + 3],
        w: 1 - 0.5 * Math.abs((2 * (k + 0.5)) / n - 1),
        i: inten,
      });
  }
  return segs;
}

const BOLTS = { key: 'mode', value: ['mixed', 'outward', 'crawl'] };
const ELECTRIFY = { key: 'mode', value: 'edge' };

export const lightning: GeneratorDef = {
  type: 'lightning',
  label: 'Lightning',
  category: 'Energy',
  description:
    'Electric arcs crawling over and shooting out from the edges of the layer it follows, with branching bolts and glow; Along edge (Electrify) runs many arcs hugging the whole outline.',
  follow: 'required',
  params: [
    followParam(),
    sel('mode', 'Arcs', 'mixed', [
      ['mixed', 'Mixed'],
      ['outward', 'Shoot outward'],
      ['crawl', 'Crawl along edge'],
      ['edge', 'Along edge (Electrify)'],
    ]),
    { ...num('count', 'Bolt count', 12, 1, 40, undefined, 1), when: BOLTS },
    { ...num('arcs', 'Arc count', 24, 1, 60, undefined, 1), when: ELECTRIFY },
    num('length', 'Bolt length', 240, 10, 800, 'px'),
    { ...num('jaggedness', 'Jaggedness', 55, 0, 150, '%'), when: BOLTS },
    { ...num('branches', 'Branching', 60, 0, 100, '%'), when: BOLTS },
    { ...num('wrinkle', 'Wrinkle', 60, 0, 150, '%'), when: ELECTRIFY },
    { ...num('branchiness', 'Branchiness', 40, 0, 100, '%'), when: ELECTRIFY },
    num('coreWidth', 'Core width', 3.5, 0.5, 12, 'px', 0.1),
    { ...num('glowSize', 'Glow size', 18, 0, 80, 'px'), when: BOLTS },
    { ...num('glowWidth', 'Glow width', 16, 0, 80, 'px'), when: ELECTRIFY },
    num('glow', 'Glow strength', 100, 0, 300, '%'),
    col('color', 'Glow colour', '#4fd8ff'),
    num('intensity', 'Intensity', 100, 0, 300, '%'),
    num('seed', 'Seed', 1, 0, 999, undefined, 1),
  ],
  presets: [
    { id: 'bolts', label: 'Lightning bolts', params: {}, blend: 'add', place: 'above' },
    {
      id: 'electricBlue',
      label: 'Electric blue',
      params: { mode: 'outward', count: 9, length: 170, jaggedness: 60, branches: 60, coreWidth: 2.2, glowSize: 12, glow: 110, color: '#5fd8ff', intensity: 105, seed: 4 },
      blend: 'add',
      place: 'above',
    },
    { id: 'electrify', label: 'Electrify (along edge)', params: { mode: 'edge', seed: 3 }, blend: 'add', place: 'above' },
  ],
  bounds: () => ({ x0: 0, y0: 0, x1: 0, y1: 0 }),
  followReach: (p) => {
    if (S(p, 'mode') === 'edge') {
      // Offset walk (≤ 1.5 w steps) + jag (≤ 0.45 w steps); forks up to 4 (0.5 + w) steps long
      // with their own jitter (≤ 0.62 w of that); a step is 2 cells = 12 comp px.
      const w = N(p, 'wrinkle') / 100;
      const step = 2 * EDGE_CELL;
      return step * 1.95 * w + 4 * step * (0.5 + w) * (1 + 0.62 * w) + 1.6 * N(p, 'glowWidth') + N(p, 'coreWidth');
    }
    // bolt length + midpoint jitter (≤ 0.8 × jag of a chord; crawl chords reach ~2× length) + wide glow blur
    return N(p, 'length') * (1 + 1.6 * (N(p, 'jaggedness') / 100)) + 1.6 * N(p, 'glowSize') + N(p, 'coreWidth');
  },
  render(ctx, target, p) {
    const content = ctx.layerContent(followed(p));
    if (!content) return clearTarget(ctx, target);
    drawFollowed(ctx, target, (out) => {
      const edges = findEdges(ctx, content);
      if (edges.length === 0) return clearTarget(ctx, out);
      const edge = S(p, 'mode') === 'edge';
      const segs = edge ? edgeArcs(ctx, edges, p) : lightningBolts(ctx, edges, p);
      const core = ctx.kit.acquire();
      drawBolts(ctx, segs, N(p, 'coreWidth') * ctx.pxScale * 0.5, core);
      const gs = N(p, edge ? 'glowWidth' : 'glowSize') * ctx.pxScale;
      const g1 = blur(ctx, core.texture, gs * 0.35, 'gen-lt1');
      const g2 = blur(ctx, core.texture, gs * 1.6, 'gen-lt2');
      const m = material(ctx.kit, 'gen-lightning', {
        uniforms: {
          tCore: { value: null },
          tG1: { value: null },
          tG2: { value: null },
          uCol: { value: new THREE.Color() },
          uIntensity: { value: 1 },
          uGlow: { value: 1 },
        },
        fragmentShader: HEAD + composeFrag,
      });
      common(m, ctx);
      const u = m.uniforms;
      u.tCore.value = core.texture;
      u.tG1.value = g1.texture;
      u.tG2.value = g2.texture;
      u.uCol.value.copy(C(p, 'color'));
      u.uIntensity.value = N(p, 'intensity') / 100;
      u.uGlow.value = N(p, 'glow') / 100;
      ctx.kit.run(m, out);
      ctx.kit.release(core);
    });
  },
};

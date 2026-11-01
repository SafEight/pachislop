import * as THREE from 'three';
import type { GeneratorDef, PassContext } from '../engine/contracts';
import type { PassKit } from '../engine/passkit';
import { NOISE_GLSL } from '../effects/lib';
import { C, col, common, DEG, drawObject, gridDistance, hash, HEAD, material, N, num, readGrid, rng, S, sel } from '../effects/b/common';
import { clearTarget, drawFollowed, followed, followParam } from './common';

// 墨飛沫 (ink splatter): seeded ink drops, satellite droplets and drag streaks thrown off the
// silhouette of the layer it follows (its own pixels, not a glow or shadow on it), as behind
// brush-lettered titles: a companion below that layer, or above it to spatter over it.

/** One ink primitive: a round cone from `a` (radius ra) to `b` (radius rb), render px, y up. */
interface Blot {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  ra: number;
  rb: number;
  seed: number;
}

const blotVert = /* glsl */ `
in vec2 iA; in vec2 iB; in vec2 iR; in float iSeed;
out vec2 vP; flat out vec2 vA; flat out vec2 vB; flat out vec2 vR; flat out float vSeed;
uniform vec2 uRes;
void main() {
  vA = iA; vB = iB; vR = iR; vSeed = iSeed;
  vec2 ab = iB - iA;
  float len = length(ab);
  vec2 u = len > 1e-3 ? ab / len : vec2(1.0, 0.0);
  vec2 v = vec2(-u.y, u.x);
  // Bounding quad of the cone plus room for the ragged edge and the antialiasing pixel.
  float R = max(iR.x, iR.y) * 1.3 + 1.5;
  vec2 c = 0.5 * (iA + iB);
  vP = c + u * position.x * (0.5 * len + R) + v * position.y * R;
  gl_Position = vec4(vP / uRes * 2.0 - 1.0, 0.0, 1.0);
}`;

const blotFrag = /* glsl */ `
in vec2 vP; flat in vec2 vA; flat in vec2 vB; flat in vec2 vR; flat in float vSeed;
out vec4 o;
${NOISE_GLSL}
void main() {
  vec2 ab = vB - vA;
  float t = clamp(dot(vP - vA, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0);
  float r = mix(vR.x, vR.y, t);
  float d = length(vP - (vA + ab * t)) - r;
  // Ragged rim at the scale of the drop, so big blots wobble and tiny droplets stay round.
  float s = max(vR.y, 1.0);
  float n = vnoise((vP - vB) / s * 2.2 + vSeed * 17.0) + 0.5 * vnoise((vP - vB) / s * 5.0 + vSeed * 5.0) - 0.75;
  d -= n * 0.45 * r;
  // Antialias over one pixel of d's true slope: the ragged rim steepens d to ~2× per px.
  float cov = clamp(0.5 - d / max(length(vec2(dFdx(d), dFdy(d))), 1e-3), 0.0, 1.0);
  o = vec4(cov);
}`;

const blotState = new WeakMap<PassKit, { mesh: THREE.Mesh; geo: THREE.InstancedBufferGeometry; cap: number }>();

function blotMesh(kit: PassKit, n: number) {
  let st = blotState.get(kit);
  if (!st || st.cap < n) {
    st?.geo.dispose();
    const cap = Math.max(512, 2 ** Math.ceil(Math.log2(n)));
    const quad = new THREE.PlaneGeometry(2, 2);
    const geo = new THREE.InstancedBufferGeometry();
    geo.setIndex(quad.getIndex());
    geo.setAttribute('position', quad.getAttribute('position'));
    const ia = (k: string, size: number) =>
      geo.setAttribute(k, new THREE.InstancedBufferAttribute(new Float32Array(cap * size), size).setUsage(THREE.DynamicDrawUsage));
    ia('iA', 2);
    ia('iB', 2);
    ia('iR', 2);
    ia('iSeed', 1);
    const mat =
      st?.mesh.material instanceof THREE.ShaderMaterial
        ? st.mesh.material
        : new THREE.ShaderMaterial({
            glslVersion: THREE.GLSL3,
            vertexShader: blotVert,
            fragmentShader: blotFrag,
            uniforms: { uRes: { value: new THREE.Vector2() } },
            depthTest: false,
            depthWrite: false,
            transparent: true,
            // Coverage union: premultiplied "over" of white coverage.
            blending: THREE.CustomBlending,
            blendSrc: THREE.OneFactor,
            blendDst: THREE.OneMinusSrcAlphaFactor,
            blendSrcAlpha: THREE.OneFactor,
            blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
          });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    st = { mesh, geo, cap };
    blotState.set(kit, st);
  }
  return st;
}

/** Rasterize ink coverage of `blots` into `target` (cleared first). */
function drawBlots(ctx: PassContext, blots: Blot[], target: THREE.WebGLRenderTarget) {
  const st = blotMesh(ctx.kit, blots.length);
  const g = st.geo;
  const A = g.getAttribute('iA') as THREE.InstancedBufferAttribute;
  const Bv = g.getAttribute('iB') as THREE.InstancedBufferAttribute;
  const R = g.getAttribute('iR') as THREE.InstancedBufferAttribute;
  const Sd = g.getAttribute('iSeed') as THREE.InstancedBufferAttribute;
  blots.forEach((b, i) => {
    A.setXY(i, b.ax, b.ay);
    Bv.setXY(i, b.bx, b.by);
    R.setXY(i, b.ra, b.rb);
    Sd.setX(i, b.seed);
  });
  for (const a of [A, Bv, R, Sd]) a.needsUpdate = true;
  g.instanceCount = blots.length;
  (st.mesh.material as THREE.ShaderMaterial).uniforms.uRes.value.set(ctx.width, ctx.height);
  drawObject(ctx, st.mesh, target);
}

const inkFrag = /* glsl */ `
uniform sampler2D tInk; uniform vec3 uCol;
void main() {
  float a = clamp(texture(tInk, vUv).a, 0.0, 1.0);
  o = vec4(uCol * a, a);
}`;

/** Most main drops at Amount 100%. */
const MAX_DROPS = 80;

export const inkSplatter: GeneratorDef = {
  type: 'inkSplatter',
  label: 'Ink Splatter',
  category: 'Particles',
  description:
    '墨飛沫: seeded ink drops thrown off the silhouette of the layer it follows, with satellite droplets and drag streaks; below that layer, or above it to spatter over it. ' +
    'Black by default; set the colour to red for 赤 titles.',
  follow: 'required',
  params: [
    followParam(),
    num('amount', 'Amount', 45, 0, 100, '%'),
    num('spread', 'Spread', 150, 0, 1500, 'px'),
    num('size', 'Drop size', 22, 1, 300, 'px'),
    num('satellites', 'Satellite droplets', 60, 0, 200, '%'),
    num('streaks', 'Streaks', 35, 0, 100, '%'),
    num('streakLength', 'Streak length', 110, 0, 1500, 'px'),
    sel('direction', 'Streak direction', 'radial', [
      ['radial', 'Away from the centre'],
      ['directional', 'One direction'],
    ]),
    { ...num('angle', 'Streak angle', -10, -180, 180, 'deg'), when: { key: 'direction', value: 'directional' } },
    col('color', 'Ink colour', '#0b0907'),
    num('seed', 'Seed', 1, 0, 999, undefined, 1),
  ],
  presets: [
    { id: 'black', label: '墨 behind', params: {}, place: 'below' },
    { id: 'red', label: '赤 ink', params: { color: '#b0000c' }, place: 'below' },
    { id: 'over', label: '墨 spattered over', params: { amount: 30, spread: 120, size: 14 }, place: 'above' },
    { id: 'swept', label: 'Swept streaks', params: { streaks: 80, streakLength: 220, direction: 'directional' }, place: 'below' },
  ],
  directions: [
    { angle: 'angle', length: 'streakLength', label: 'Streaks', convention: 'ccwFromRight', when: { key: 'direction', value: 'directional' } },
  ],
  bounds: () => ({ x0: 0, y0: 0, x1: 0, y1: 0 }),
  // Furthest ink: a drop at the spread limit, its streak head and the satellites thrown past it.
  followReach: (p) => N(p, 'spread') + N(p, 'streakLength') + 3.5 * N(p, 'size'),
  render(ctx, target, p) {
    const content = ctx.layerContent(followed(p));
    if (!content) return clearTarget(ctx, target);
    drawFollowed(ctx, target, (out) => {
      const k = ctx.pxScale;
      const seed = N(p, 'seed');
      const spread = Math.max(1, N(p, 'spread'));
      const size = N(p, 'size');
      const g = readGrid(ctx, content, 8, 'inkSplatter');
      const dist = gridDistance(g);
      const cell = g.cellComp;
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      // comp px about the comp centre: the same at every canvas size and render scale
      for (let y = 0; y < g.h; y++)
        for (let x = 0; x < g.w; x++)
          if (g.alpha[y * g.w + x] >= 0.5) {
            x0 = Math.min(x0, g.x0 + x * cell);
            y0 = Math.min(y0, g.y0 + y * cell);
            x1 = Math.max(x1, g.x0 + (x + 1) * cell);
            y1 = Math.max(y1, g.y0 + (y + 1) * cell);
          }
      const count = Math.round((N(p, 'amount') / 100) * MAX_DROPS);
      if (x0 > x1 || count === 0) return clearTarget(ctx, out);
      const cx = 0.5 * (x0 + x1);
      const cy = 0.5 * (y0 + y1);
      const fixedDir = N(p, 'angle') * DEG;
      const radial = S(p, 'direction') !== 'directional';
      const streakShare = N(p, 'streaks') / 100;
      const streakLen = N(p, 'streakLength');
      const satAmount = N(p, 'satellites') / 100;
      const blots: Blot[] = [];
      // comp px → render px
      const ox = ctx.width / 2;
      const oy = ctx.height / 2;
      const push = (ax: number, ay: number, bx: number, by: number, ra: number, rb: number, s: number) =>
        blots.push({ ax: ax * k + ox, ay: ay * k + oy, bx: bx * k + ox, by: by * k + oy, ra: ra * k, rb: rb * k, seed: s });
      const r = rng(seed * 977 + 3);
      let placed = 0;
      for (let tries = 0; placed < count && tries < count * 60; tries++) {
        const px = x0 - spread + r() * (x1 - x0 + 2 * spread);
        const py = y0 - spread + r() * (y1 - y0 + 2 * spread);
        const gx = Math.floor((px - g.x0) / cell);
        const gy = Math.floor((py - g.y0) / cell);
        const d = gx >= 0 && gy >= 0 && gx < g.w && gy < g.h ? dist[gy * g.w + gx] * cell : Infinity;
        if (d > spread) continue;
        // Dense and heavy at the edge, thinning out with distance; few drops land on the letters.
        const near = 1 - d / spread;
        if (hash(seed, tries, 0) > (d === 0 ? 0.25 : near ** 1.2)) continue;
        placed++;
        // Everything below is keyed by the try, so a cell flipping between render scales changes
        // only this drop instead of re-rolling every one after it.
        const h = (n: number) => hash(seed, tries, n);
        const rad = size * (0.2 + 0.8 * h(1) ** 2) * (0.45 + 0.55 * near);
        const base = radial ? Math.atan2(py - cy, px - cx) : fixedDir;
        const dir = base + (h(2) - 0.5) * (radial ? 0.5 : 0.3);
        const ux = Math.cos(dir);
        const uy = Math.sin(dir);
        let hx = px;
        let hy = py;
        if (h(3) < streakShare && streakLen > 0) {
          // Drag streak: thin tail at the landing point, the drop's bulk piled up at the far end.
          const len = streakLen * (0.35 + 0.65 * h(4)) * (0.5 + 0.5 * near);
          hx = px + ux * len;
          hy = py + uy * len;
          push(px, py, hx, hy, Math.max(0.6, rad * 0.22), rad * 0.95, h(5));
        } else push(px, py, px, py, rad, rad, h(5));
        // Satellites: a few droplets around the drop, thrown further along its direction.
        const sats = Math.round(satAmount * (1 + 5 * h(6)) * (0.4 + 0.6 * near));
        for (let j = 0; j < sats; j++) {
          const hs = (n: number) => hash(seed, tries, 10 + j * 4 + n);
          const a = dir + (hs(0) - 0.5) * 2.4;
          const far = rad * (1.4 + 2.2 * hs(1) ** 1.5);
          const sr = Math.max(0.6, rad * (0.06 + 0.2 * hs(2) ** 2));
          const sx = hx + Math.cos(a) * far;
          const sy = hy + Math.sin(a) * far;
          push(sx, sy, sx, sy, sr, sr, hs(3));
        }
      }
      const ink = ctx.kit.acquire();
      drawBlots(ctx, blots, ink);
      const m = material(ctx.kit, 'gen-ink', {
        uniforms: { tInk: { value: null }, uCol: { value: new THREE.Color() } },
        fragmentShader: HEAD + inkFrag,
      });
      common(m, ctx);
      m.uniforms.tInk.value = ink.texture;
      m.uniforms.uCol.value.copy(C(p, 'color'));
      ctx.kit.run(m, out);
      ctx.kit.release(ink);
    });
  },
};

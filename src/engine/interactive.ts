import * as THREE from 'three';
import { followTarget, generatorFillsComp, getGenerator } from '../generators/registry';
import type { Comp, Layer, Project } from '../model/types';
import type { ChildDrawer, Compositor } from './compositor';
import { drawnLayers, holds3D, isLeaf, type DrawNode, type LeafLayer } from './drawTree';
import { isolation, nodeDeps } from './layerSource';
import { PassKit } from './passkit';
import type { Surface, Surfaces } from './surface';

const DEG = Math.PI / 180;

/**
 * Render px per preview px of top-level nodes holding a 3D layer that must be re-rendered while
 * interactive: 3D content (and its effects) is GPU-bound, a quarter of the pixels is the
 * cheapest lever, and the release render restores full resolution.
 */
const INTERACTIVE_SCALE = 0.5;

/** Enlarged frames (InteractiveCache.wideSurface): margin per side, share of the frame's longer side. */
const WIDE_MARGIN = 0.25;
/**
 * The margin is a whole number of these render px, so the power-of-two pyramids of glows, blurs
 * and the 3D glint keep their texel grids where they sit on the comp-size frame.
 */
const WIDE_ALIGN = 64;
/** Largest enlarged frame, render px (a half-float RGBA target per node: 8 B each, ≤ 64 MiB). */
const WIDE_MAX_PX = 8 << 20;

/** Texels of a cached target's outer ring each fragment of the edge pass reads (see InteractiveCache.litEdges). */
const EDGE_CHUNK = 256;
/**
 * Largest premultiplied linear value (any channel) a cached target's edge texel may hold and
 * still count as empty: fainter light (the far tail of a wide glow) cut at the edge leaves a
 * seam of about 3 of 255 sRGB levels over black, under one over mid grey, in a draft frame.
 */
const EDGE_MIN = 1e-3;
/** litEdges bits: the comp edge (y-up) along which a cached target holds light. */
const LEFT = 1;
const RIGHT = 2;
const BOTTOM = 4;
const TOP = 8;
/** The edge bit of each channel of the edge pass (EDGE_FRAG). */
const EDGE_BITS = [BOTTOM, TOP, LEFT, RIGHT];

/**
 * Per fragment x: the largest channel of EDGE_CHUNK texels of tSrc's outer ring, walked bottom
 * row, top row, left column, right column, per edge (r = bottom, g = top, b = left, a = right).
 */
const EDGE_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform int uChunk;
in vec2 vUv;
out vec4 o;
void main() {
  ivec2 sz = textureSize(tSrc, 0);
  int i0 = int(gl_FragCoord.x) * uChunk;
  int i1 = min(i0 + uChunk, 2 * (sz.x + sz.y));
  vec4 m = vec4(0.0);
  for (int i = i0; i < i1; i++) {
    int e = i < sz.x ? 0 : i < 2 * sz.x ? 1 : i < 2 * sz.x + sz.y ? 2 : 3;
    ivec2 q = e == 0 ? ivec2(i, 0)
      : e == 1 ? ivec2(i - sz.x, sz.y - 1)
      : e == 2 ? ivec2(0, i - 2 * sz.x)
      : ivec2(sz.x - 1, i - 2 * sz.x - sz.y);
    vec4 c = texelFetch(tSrc, q, 0);
    m = max(m, max(max(c.r, c.g), max(c.b, c.a)) * vec4(equal(ivec4(e), ivec4(0, 1, 2, 3))));
  }
  o = m;
}`;

/** Where a layer's content sits on screen: origin and a fixed local axis, comp px (centre origin, y-up). */
interface Placement {
  ox: number;
  oy: number;
  ax: number;
  ay: number;
}

/** Screen-plane similarity p ↦ k·p + t (complex k = rotation × scale), comp px. */
interface Similarity {
  kr: number;
  ki: number;
  tx: number;
  ty: number;
}

const NO_MOVE: Similarity = { kr: 1, ki: 0, tx: 0, ty: 0 };

/** Post-effects pixels of one node with its clip group (before its own blend / opacity), kept for interactive reuse. */
interface NodeCache {
  /** Pool target of `kit` (held out of the pool until dropped). */
  rt: THREE.WebGLRenderTarget;
  kit: PassKit;
  /** `kit.generation` when rendered: a resize wipes pooled pixels. */
  generation: number;
  /** Comp object and preview scale the pixels were rendered with. */
  comp: Comp;
  scale: number;
  /**
   * Comp px the target spans around the comp centre: the comp's size, or more on an enlarged
   * frame (wideSurface).
   */
  fw: number;
  fh: number;
  /** drawnLayers([node]) as rendered. */
  layers: Layer[];
  /** Placement of each leaf in `layers` as rendered (null for groups and adjustments). */
  places: (Placement | null)[];
  /**
   * Layers read through 'layer' params or layer masks by the drawn layers, with what decides
   * their alpha (sourceDeps), as rendered: any change of them re-renders the node, and so does
   * any move.
   */
  deps: Map<string, Layer | undefined>;
  /**
   * The edges of the target along which the pixels hold light, LEFT | RIGHT | BOTTOM | TOP (see
   * InteractiveCache.litEdges): undefined until a move first asks.
   */
  litEdges?: number;
}

/** The project and preview scale of the frame, for reuse checks of cached group children. */
interface ChildReuse {
  project: Project;
  scale: number;
}

/** Fields that only affect how a node is composited into its parent (or nothing at all), never its pixels. */
const COMPOSITE_ONLY: Record<string, true> = { transform: true, blend: true, name: true, locked: true, visible: true, solo: true, guide: true, collapsed: true };
/** Inside a node, a member's blend and opacity shape the node's pixels. */
const MEMBER_COMPOSITE_ONLY: Record<string, true> = { transform: true, name: true, locked: true, visible: true, solo: true, guide: true, collapsed: true };

/**
 * Same pixels up to a screen-plane move: every field outside `ignore` is the same object
 * (the store never mutates, so unchanged sub-objects keep their identity), and the transform
 * differs at most in x / y / rotZ / scale (+ opacity when `ignore` has `blend`). A flip change
 * mirrors the pixels, which no similarity does: it re-renders.
 */
function sameContent(a: Layer, b: Layer, ignore: Record<string, true>): boolean {
  if (a === b) return true;
  if (a.kind !== b.kind) return false;
  const ra = a as unknown as Record<string, unknown>;
  const rb = b as unknown as Record<string, unknown>;
  for (const k in ra) if (!ignore[k] && ra[k] !== rb[k]) return false;
  for (const k in rb) if (!(k in ra)) return false;
  const ta = a.transform;
  const tb = b.transform;
  return ta.z === tb.z && ta.rotX === tb.rotX && ta.rotY === tb.rotY && ta.flipX === tb.flipX && ta.flipY === tb.flipY && (ignore.blend || ta.opacity === tb.opacity);
}

/** The similarity taking placement `from` to `to`, or null when `from` is degenerate (scale 0). */
function similarityBetween(from: Placement, to: Placement): Similarity | null {
  const n = from.ax * from.ax + from.ay * from.ay;
  if (!(n > 1e-12)) return null;
  // k = to.a / from.a (complex division)
  const kr = (to.ax * from.ax + to.ay * from.ay) / n;
  const ki = (to.ay * from.ax - to.ax * from.ay) / n;
  return { kr, ki, tx: to.ox - (kr * from.ox - ki * from.oy), ty: to.oy - (ki * from.ox + kr * from.oy) };
}

/** Group `groupId` holds layer `l` (at any depth). */
function ancestorsHas(byId: ReadonlyMap<string, Layer>, l: Layer, groupId: string): boolean {
  for (let p = l.parentId; p !== undefined; p = byId.get(p)?.parentId) if (p === groupId) return true;
  return false;
}

const samePlace = (a: Layer['transform'], b: Layer['transform']) => a.x === b.x && a.y === b.y && a.rotZ === b.rotZ && a.scale === b.scale;

const sameSimilarity = (a: Similarity, b: Similarity) =>
  Math.abs(a.kr - b.kr) < 1e-6 && Math.abs(a.ki - b.ki) < 1e-6 && Math.abs(a.tx - b.tx) < 1e-3 && Math.abs(a.ty - b.ty) < 1e-3;

/**
 * The enabled masks of the drawn layers `now` (`was` as cached, same masks) still fit the cached
 * pixels drawn moved by `move`: a linked mask follows its layer's x / y / rotZ / scale, which must
 * then have moved by `move` (a group's too, though its members carry the pixels); an unlinked
 * or layer mask stays in comp space, so nothing may move.
 */
function masksFollow(was: readonly Layer[], now: readonly Layer[], move: Similarity, riding: ReadonlySet<string>): boolean {
  // where a linked mask sits: the layer's own x / y / rotZ / scale (no camera, see masks.ts)
  const at = ({ x, y, rotZ, scale }: Layer['transform']): Placement => ({ ox: x, oy: y, ax: scale * Math.cos(-rotZ * DEG), ay: scale * Math.sin(-rotZ * DEG) });
  for (let i = 0; i < now.length; i++) {
    const l = now[i];
    let linked = false;
    for (const m of l.masks) {
      if (!m.enabled) continue;
      if (m.linked && m.kind !== 'layer') linked = true;
      else if (!(m.kind === 'layer' && riding.has(m.layerId)) && !sameSimilarity(move, NO_MOVE)) return false;
    }
    if (!linked) continue;
    const k = similarityBetween(at(was[i].transform), at(l.transform));
    if (!k || !sameSimilarity(k, move)) return false;
  }
  return true;
}

/**
 * Destination uv → source uv for drawing a bitmap spanning `sw`×`sh` comp px around the comp
 * centre, moved by `s`, onto a target spanning `dw`×`dh`; written into `out` (row-major in,
 * column-major out by three).
 */
function sourceUvMatrix(s: Similarity, dw: number, dh: number, sw: number, sh: number, out: THREE.Matrix3): THREE.Matrix3 {
  // inverse similarity: p ↦ k⁻¹·(p − t)
  const n = s.kr * s.kr + s.ki * s.ki;
  const a = s.kr / n;
  const b = -s.ki / n;
  const cx = -(a * s.tx - b * s.ty);
  const cy = -(b * s.tx + a * s.ty);
  // uv ↔ comp px: p = (uv − ½)·size
  return out.set(
    (a * dw) / sw,
    (-b * dh) / sw,
    0.5 - (0.5 * a * dw) / sw + (0.5 * b * dh) / sw + cx / sw,
    (b * dw) / sh,
    (a * dh) / sh,
    0.5 - (0.5 * b * dw) / sh - (0.5 * a * dh) / sh + cy / sh,
    0,
    0,
    1,
  );
}

/**
 * Interactive reuse of preview pixels (see Engine.setInteractive): each top-level node's pixels
 * from the last preview render, the pixels of a top-level group's re-rendered children while
 * interactive, the reduced-scale draft surface of nodes holding 3D, and enlarged frames for
 * moved nodes whose light crosses the comp edge.
 */
export class InteractiveCache {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly compositor: Compositor;
  private readonly surfaces: Surfaces;
  /** Pool for top-level nodes re-rendered at INTERACTIVE_SCALE (created on first use). */
  private lowKit: PassKit | null = null;
  /**
   * Pools of the enlarged frames (wideSurface) at the preview scale and at INTERACTIVE_SCALE,
   * created on first use and freed when interaction ends; their camera, so the engine's stays
   * aimed at the comp.
   */
  private wideKit: PassKit | null = null;
  private wideLowKit: PassKit | null = null;
  private readonly wideCamera = new THREE.PerspectiveCamera();
  /** Per top-level node id: its pixels from the last preview render. */
  private readonly cache = new Map<string, NodeCache>();
  /**
   * While interactive, per id of a direct child of a top-level group re-rendered this drag: its
   * pixels, so moving or editing one member re-composites the group from its siblings' pixels.
   */
  private readonly childCache = new Map<string, NodeCache>();
  private readonly projected = new THREE.Vector3();
  /** Scratch source-uv matrix of cached draws (blendOnto copies it into the uniform). */
  private readonly uv = new THREE.Matrix3();
  /** litEdges()'s pass, its target (one texel per EDGE_CHUNK ring texels) and readback (created on first use). */
  private edgeMat: THREE.ShaderMaterial | null = null;
  private edgeRT: THREE.WebGLRenderTarget | null = null;
  private edgePx = new Float32Array(0);

  /** `camera`: the one Surfaces aims, for placing 3D leaves on screen. */
  constructor(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera, compositor: Compositor, surfaces: Surfaces) {
    this.renderer = renderer;
    this.camera = camera;
    this.compositor = compositor;
    this.surfaces = surfaces;
  }

  /**
   * Preview compositing of the top level onto `acc` (returns the new acc): every leaf / group
   * node's pixels are cached, and reused moved while `interactive` (see Engine.setInteractive).
   * A move that would show where the comp edge cut a node's light renders that node once on an
   * enlarged frame (wideSurface), which later moves reuse while it still covers the comp.
   */
  drawCached(top: DrawNode[], acc: THREE.WebGLRenderTarget, full: Surface, project: Project, scale: number, interactive: boolean): THREE.WebGLRenderTarget {
    const { kit } = full;
    const { comp } = project;
    if (!interactive) this.dropEntries(this.childCache);
    const reuse: ChildReuse | null = interactive ? { project, scale } : null;
    const drawChildren: ChildDrawer | null = reuse ? (children, buf, s) => this.drawChildrenCached(children, buf, s, reuse) : null;
    let low: Surface | null = null;
    const drawn = new Set<string>();
    for (const n of top) {
      if (n.kind === 'adjust') {
        acc = this.compositor.adjustOnto(acc, n.layer, full, null);
        continue;
      }
      const { layer } = n;
      drawn.add(layer.id);
      let entry = this.cache.get(layer.id);
      let move = interactive ? this.reusable(n, entry, project, scale) : null;
      if (!move || !entry || this.revealsCut(entry, move, comp.width, comp.height)) {
        // only a move, but it would show the cut: render on an enlarged frame for the next ones too
        const widen = move !== null && entry !== undefined && this.enlargeable(n);
        this.dropEntry(this.cache, layer.id);
        const base = interactive && holds3D([n]) ? (low ??= this.lowSurface(full)) : full;
        const s = (widen && this.wideSurface(base)) || base;
        const pixels = this.compositor.renderUnit(n, s, n.kind === 'group' ? drawChildren : null);
        entry = this.cacheEntry(n, pixels, s, project, scale);
        this.cache.set(layer.id, entry);
        move = NO_MOVE;
      }
      acc = this.compositor.blendOnto(kit, acc, entry.rt.texture, layer.transform.opacity, layer.blend, this.uvFor(entry, move, comp.width, comp.height), null);
    }
    for (const id of [...this.cache.keys()]) if (!drawn.has(id)) this.dropEntry(this.cache, id);
    if (interactive) {
      const live = new Set<string>();
      for (const n of top) if (n.kind === 'group') for (const c of n.children) live.add(c.layer.id);
      for (const id of [...this.childCache.keys()]) if (!live.has(id)) this.dropEntry(this.childCache, id);
    } else {
      // every node rendered at comp size again: the enlarged frames' pools go
      this.wideKit?.dispose();
      this.wideLowKit?.dispose();
      this.wideKit = this.wideLowKit = null;
    }
    return acc;
  }

  /** The INTERACTIVE_SCALE surface of `full` (its pool created on first use), supersample 1. */
  private lowSurface(full: Surface): Surface {
    const lowKit = (this.lowKit ??= new PassKit(this.renderer));
    const lw = Math.max(1, Math.round(full.width * INTERACTIVE_SCALE));
    const lh = Math.max(1, Math.round(full.height * INTERACTIVE_SCALE));
    lowKit.setSize(lw, lh);
    const { project } = full.ctx;
    const lowProject = project.comp.supersample === 1 ? project : { ...project, comp: { ...project.comp, supersample: 1 as const } };
    const scale = full.scale * INTERACTIVE_SCALE;
    return this.surfaces.withSource(
      {
        kit: lowKit,
        width: lw,
        height: lh,
        scale,
        renderers: full.renderers,
        ctx: { ...full.ctx, kit: lowKit, project: lowProject, width: lw, height: lh, pxScale: scale },
      },
      project.comp,
    );
  }

  /**
   * `base` (the preview or the INTERACTIVE_SCALE surface) on an enlarged frame: WIDE_MARGIN of its
   * longer side added on every side, in whole WIDE_ALIGN px, the comp at its centre on the same
   * pixels and with the same 3D projection (the camera's field of view widened, as exports
   * enlarge their canvas); within the GPU's texture size and WIDE_MAX_PX. Null when no margin fits.
   */
  private wideSurface(base: Surface): Surface | null {
    const { width: w, height: h } = base;
    const max = this.renderer.capabilities.maxTextureSize;
    let m = Math.ceil((WIDE_MARGIN * Math.max(w, h)) / WIDE_ALIGN) * WIDE_ALIGN;
    while (m > 0 && (w + 2 * m > max || h + 2 * m > max || (w + 2 * m) * (h + 2 * m) > WIDE_MAX_PX)) m -= WIDE_ALIGN;
    if (m <= 0) return null;
    const { project } = base.ctx;
    const { comp } = project;
    // comp px per render px as on `base`, whose comp spans its w × h px
    const width = (comp.width * (w + 2 * m)) / w;
    const height = (comp.height * (h + 2 * m)) / h;
    const fov = (2 * Math.atan((height / comp.height) * Math.tan((Math.min(170, Math.max(1, comp.camera.fov)) * DEG) / 2))) / DEG;
    if (!(fov < 170)) return null;
    const kit = base.kit === this.lowKit ? (this.wideLowKit ??= new PassKit(this.renderer)) : (this.wideKit ??= new PassKit(this.renderer));
    const wide: Project = { ...project, comp: { ...comp, width, height, camera: { ...comp.camera, fov } } };
    return this.surfaces.surface(wide, kit, base.scale, w + 2 * m, h + 2 * m, base.ctx.draft, base.renderers, this.wideCamera);
  }

  /**
   * Every layer `n` draws renders the same pixels inside the comp on an enlarged frame: not a
   * background or a full-frame generator, which fill (and lay out over) whatever frame they get.
   */
  private enlargeable(n: DrawNode): boolean {
    return drawnLayers([n]).every(
      (l) => l.kind !== 'background' && !(l.kind === 'generator' && (!getGenerator(l.generator.type) || generatorFillsComp(l.generator))),
    );
  }

  /** Source uv for drawing `entry` moved by `move` onto a target spanning `dw`×`dh` comp px (this.uv). */
  private uvFor(entry: NodeCache, move: Similarity, dw: number, dh: number): THREE.Matrix3 {
    if (entry.fw === dw && entry.fh === dh && sameSimilarity(move, NO_MOVE)) return this.uv.identity();
    return sourceUvMatrix(move, dw, dh, entry.fw, entry.fh, this.uv);
  }

  /** `s`: the surface `rt` was rendered on (its comp extent is the entry's frame). */
  private cacheEntry(n: DrawNode, rt: THREE.WebGLRenderTarget, s: Surface, project: Project, scale: number): NodeCache {
    const { comp } = project;
    const layers = drawnLayers([n]);
    const places = layers.map((l) => (isLeaf(l) ? this.placement(l, comp) : null));
    const frame = s.ctx.project.comp;
    return { rt, kit: s.kit, generation: s.kit.generation, comp, scale, fw: frame.width, fh: frame.height, layers, places, deps: nodeDeps(n, project) };
  }

  /**
   * The move that turns the cached pixels `entry` of node `n` into its current look, or null when
   * it has to be rendered: nothing cached at this size / comp, the drawn layers or their content
   * changed (beyond `n`'s own blend / opacity), the leaves moved differently, their masks don't
   * follow the move (masksFollow), or a layer its generators or layer masks read changed or it
   * moved at all (see NodeCache.deps). Whether the moved pixels still cover the target is
   * revealsCut's.
   */
  private reusable(n: DrawNode, entry: NodeCache | undefined, project: Project, scale: number): Similarity | null {
    if (!entry || entry.kit.generation !== entry.generation || entry.comp !== project.comp || entry.scale !== scale) return null;
    const now = drawnLayers([n]);
    if (now.length !== entry.layers.length) return null;
    const inNode = new Set(now.map((l) => l.id));
    /** Layers the node's follow generators follow: they must move with the node (checked below). */
    const followers: string[] = [];
    let move: Similarity | null = null;
    for (let i = 0; i < now.length; i++) {
      const l = now[i];
      const was = entry.layers[i];
      if (was.id !== l.id || !sameContent(was, l, l === n.layer ? COMPOSITE_ONLY : MEMBER_COMPOSITE_ONLY)) return null;
      const from = entry.places[i];
      if (!from || !isLeaf(l)) continue;
      // A generator following a layer drawn in this node draws where that layer is: it moves with
      // it, as long as its own offset stays.
      if (l.kind === 'generator' && followTarget(l.generator)) {
        if (!samePlace(was.transform, l.transform)) return null;
        followers.push(followTarget(l.generator));
        continue;
      }
      const m = similarityBetween(from, this.placement(l, project.comp));
      if (!m || (move && !sameSimilarity(move, m))) return null;
      move = m;
    }
    // Source layers the drawn ones read (follow targets, layer-mask sources): those drawn in this
    // node were checked above; one inside the node that is not drawn (a hidden mask source) rides
    // along when its content is the same and it made the same move; the others must stay.
    const { byId } = isolation(project);
    const riding = new Set<string>();
    const outside: string[] = [];
    for (const [id, was] of entry.deps) {
      if (inNode.has(id)) continue;
      const l = byId.get(id);
      if (l === was) {
        outside.push(id);
        continue;
      }
      if (!l || !was || !isLeaf(l) || !isLeaf(was) || !ancestorsHas(byId, l, n.layer.id) || !sameContent(was, l, MEMBER_COMPOSITE_ONLY)) return null;
      const m = similarityBetween(this.placement(was, project.comp), this.placement(l, project.comp));
      if (!m || !sameSimilarity(m, move ?? NO_MOVE)) return null;
      riding.add(id);
    }
    if (outside.length && move && !sameSimilarity(move, NO_MOVE)) return null;
    // A follow generator moves with the layer it follows, when that is drawn here or rides along.
    if (followers.some((id) => !inNode.has(id) && !riding.has(id) && !(outside.includes(id) && sameSimilarity(move ?? NO_MOVE, NO_MOVE)))) return null;
    if (!masksFollow(entry.layers, now, move ?? NO_MOVE, riding)) return null;
    return move ?? NO_MOVE;
  }

  /**
   * `entry` drawn moved by `move` onto a target spanning `dw`×`dh` comp px would show where its
   * own frame cut its light: whatever the node drew past a lit edge of its target (a glint's
   * rays, a glow, a flare) is missing there, so the moved bitmap would end in that straight cut
   * (turned with the move) instead of the light beyond it. That happens when a corner of the
   * target, mapped back into the cached frame, lies past a lit edge; past an unlit one there
   * was nothing to keep.
   */
  private revealsCut(entry: NodeCache, move: Similarity, dw: number, dh: number): boolean {
    if (entry.fw >= dw && entry.fh >= dh && sameSimilarity(move, NO_MOVE)) return false;
    const lit = this.litEdges(entry);
    if (!lit) return false;
    // inverse similarity: p ↦ k⁻¹·(p − t)
    const n = move.kr * move.kr + move.ki * move.ki;
    const a = move.kr / n;
    const b = -move.ki / n;
    const hw = entry.fw / 2 + 1e-3;
    const hh = entry.fh / 2 + 1e-3;
    for (const sx of [-0.5, 0.5])
      for (const sy of [-0.5, 0.5]) {
        const x = sx * dw - move.tx;
        const y = sy * dh - move.ty;
        const qx = a * x - b * y;
        const qy = b * x + a * y;
        if ((lit & LEFT && qx < -hw) || (lit & RIGHT && qx > hw) || (lit & BOTTOM && qy < -hh) || (lit & TOP && qy > hh)) return true;
      }
    return false;
  }

  /**
   * The edges of `entry`'s target along which its pixels hold light (any channel above
   * EDGE_MIN), as LEFT | RIGHT | BOTTOM | TOP. Measured once per entry: one pass over the
   * target's outer ring and a small readback.
   */
  private litEdges(entry: NodeCache): number {
    if (entry.litEdges !== undefined) return entry.litEdges;
    const { rt, kit } = entry;
    const n = Math.ceil((2 * (rt.width + rt.height)) / EDGE_CHUNK);
    this.edgeMat ??= kit.shader({ uniforms: { tSrc: { value: null }, uChunk: { value: EDGE_CHUNK } }, fragmentShader: EDGE_FRAG });
    if (!this.edgeRT) {
      this.edgeRT = new THREE.WebGLRenderTarget(n, 1, { type: THREE.FloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false });
    } else if (this.edgeRT.width !== n) this.edgeRT.setSize(n, 1);
    if (this.edgePx.length < n * 4) this.edgePx = new Float32Array(n * 4);
    this.edgeMat.uniforms.tSrc.value = rt.texture;
    kit.run(this.edgeMat, this.edgeRT);
    this.renderer.readRenderTargetPixels(this.edgeRT, 0, 0, n, 1, this.edgePx);
    let lit = 0;
    for (let i = 0; i < n * 4; i++) if (this.edgePx[i] > EDGE_MIN) lit |= EDGE_BITS[i % 4];
    entry.litEdges = lit;
    return lit;
  }

  /**
   * Placement of a leaf's content on screen (comp px, centre origin, y-up): the layer position
   * and its local +x axis (positive rotZ turns clockwise on screen). 3D layers go through the
   * comp camera, so a move in depth-free x / y reads as the matching screen move; generators are
   * flat like 2D titles (rotX / rotY ignored, see GeneratorRenderer); background layers fill the
   * comp whatever their transform.
   */
  private placement(layer: LeafLayer, comp: Comp): Placement {
    const t = layer.transform;
    const r = -t.rotZ * DEG;
    const ax = t.scale * Math.cos(r);
    const ay = t.scale * Math.sin(r);
    switch (layer.kind) {
      case 'background':
        return { ox: 0, oy: 0, ax: 1, ay: 0 };
      case 'title2d':
      case 'generator':
        return { ox: t.x, oy: t.y, ax, ay };
      case 'title3d': {
        // project the origin and a point 100 layer px along the rotated local x axis
        const p = this.projected.set(t.x, t.y, t.z).project(this.camera);
        const ox = (p.x * comp.width) / 2;
        const oy = (p.y * comp.height) / 2;
        const q = this.projected.set(t.x + 100 * ax, t.y + 100 * ay, t.z).project(this.camera);
        return { ox, oy, ax: ((q.x * comp.width) / 2 - ox) / 100, ay: ((q.y * comp.height) / 2 - oy) / 100 };
      }
    }
  }

  /**
   * A group's children onto `acc` while interactive: each child's pixels come from childCache
   * (drawn moved) when only a screen move or its blend / opacity changed and the move shows no
   * cut (revealsCut), else it renders on the group's surface `s` and is cached.
   */
  private drawChildrenCached(children: readonly DrawNode[], acc: THREE.WebGLRenderTarget, s: Surface, reuse: ChildReuse): THREE.WebGLRenderTarget {
    const frame = s.ctx.project.comp;
    for (const c of children) {
      if (c.kind === 'adjust') {
        acc = this.compositor.adjustOnto(acc, c.layer, s, null);
        continue;
      }
      const id = c.layer.id;
      let entry = this.childCache.get(id);
      let move = entry && entry.kit === s.kit ? this.reusable(c, entry, reuse.project, reuse.scale) : null;
      if (!move || !entry || this.revealsCut(entry, move, frame.width, frame.height)) {
        this.dropEntry(this.childCache, id);
        entry = this.cacheEntry(c, this.compositor.renderUnit(c, s, null), s, reuse.project, reuse.scale);
        this.childCache.set(id, entry);
        move = NO_MOVE;
      }
      acc = this.compositor.blendOnto(s.kit, acc, entry.rt.texture, c.layer.transform.opacity, c.layer.blend, this.uvFor(entry, move, frame.width, frame.height), null);
    }
    return acc;
  }

  private dropEntry(map: Map<string, NodeCache>, id: string) {
    const entry = map.get(id);
    if (!entry) return;
    entry.kit.release(entry.rt);
    map.delete(id);
  }

  private dropEntries(map: Map<string, NodeCache>) {
    for (const id of [...map.keys()]) this.dropEntry(map, id);
  }

  /** Release every cached node's pixels to its pool. */
  drop() {
    this.dropEntries(this.cache);
    this.dropEntries(this.childCache);
  }

  dispose() {
    this.drop();
    this.lowKit?.dispose();
    this.wideKit?.dispose();
    this.wideLowKit?.dispose();
    this.edgeMat?.dispose();
    this.edgeRT?.dispose();
  }
}

import * as THREE from 'three';
import { SVGLoader } from 'three/examples/jsm/loaders/SVGLoader.js';
import {
  ClipType,
  EndType,
  FillRule,
  JoinType,
  PolyTreeD,
  booleanOpDWithPolyTree,
  inflatePathsD,
  simplifyPathD,
  type PathD,
  type PathsD,
  type PolyPathD,
} from 'clipper2-ts';
import type { PathCmd } from '../../text/layout';

// 2D outline plumbing for the extruder. Everything is y-up in layer (comp px) space.
//
// Normalised orientation used throughout: outer contours CCW (positive signed area),
// holes CW. With that convention the filled region is always on the LEFT of travel and
// the outward (away-from-fill) normal of an edge with direction d is (d.y, -d.x).
//
// Polygon booleans and offsets go through Clipper2, so overlapping glyph contours,
// overlapping characters (negative tracking, per-character nudges) and grown backplate
// outlines always come out as clean, non-overlapping outer + hole sets.

export type Contour = THREE.Vector2[];

export interface ShapeContours {
  outer: Contour;
  holes: Contour[];
}

/** Clipper works on a fixed decimal grid; 0.01 px is far below anything visible. */
const PRECISION = 2;
/** Sharpest corner a miter join keeps before it is squared off (multiple of the offset). */
const MITER_LIMIT = 2;
/**
 * Vertices closer than this × eps to the line through their neighbours are dropped from every
 * clean outline: weighted glyphs, closed plate bases and round-joined plates come out of
 * Clipper as dense polylines, and the extruder's limits are quadratic in the vertex count.
 */
const SIMPLIFY_EPS = 2;

function signedArea(c: Contour): number {
  let a = 0;
  for (let i = 0, n = c.length; i < n; i++) {
    const p = c[i];
    const q = c[(i + 1) % n];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

/** Remove consecutive near-duplicates (incl. a closing duplicate). */
function cleanContour(c: Contour, eps: number): Contour {
  const out: Contour = [];
  for (const p of c) {
    const last = out[out.length - 1];
    if (!last || last.distanceToSquared(p) > eps * eps) out.push(p);
  }
  while (out.length > 1 && out[0].distanceToSquared(out[out.length - 1]) <= eps * eps) out.pop();
  return out;
}

const toPath = (c: Contour): PathD => c.map((p) => ({ x: p.x, y: p.y }));

/** A Clipper output ring as a clean contour (near-collinear vertices dropped, see SIMPLIFY_EPS). */
const cleanRing = (poly: PathD | null, eps: number): Contour =>
  cleanContour(simplifyPathD(poly ?? [], SIMPLIFY_EPS * eps, true).map((p) => new THREE.Vector2(p.x, p.y)), eps);

function collect(node: PolyPathD, out: ShapeContours[], eps: number) {
  for (let i = 0; i < node.count; i++) {
    const outerNode = node.child(i);
    const outer = cleanRing(outerNode.poly, eps);
    if (outer.length >= 3) {
      if (signedArea(outer) < 0) outer.reverse();
      const holes: Contour[] = [];
      for (let k = 0; k < outerNode.count; k++) {
        const holeNode = outerNode.child(k);
        const hole = cleanRing(holeNode.poly, eps);
        if (hole.length >= 3) {
          if (signedArea(hole) > 0) hole.reverse();
          holes.push(hole);
        }
        collect(holeNode, out, eps); // islands inside the hole
      }
      out.push({ outer, holes });
    }
  }
}

function union(paths: PathsD, rule: FillRule, eps: number): ShapeContours[] {
  if (!paths.length) return [];
  const tree = new PolyTreeD();
  booleanOpDWithPolyTree(ClipType.Union, paths, null, tree, rule, PRECISION);
  const out: ShapeContours[] = [];
  collect(tree, out, eps);
  return out;
}

const shapesToPaths = (shapes: ShapeContours[], withHoles = true): PathsD =>
  shapes.flatMap((s) => [toPath(s.outer), ...(withHoles ? s.holes.map(toPath) : [])]);

/** Any closed contours (any winding convention) → clean outer/hole shapes under the fill rule. */
export function normalizeContours(raw: Contour[], evenOdd: boolean, eps: number): ShapeContours[] {
  return union(raw.filter((c) => c.length >= 3).map(toPath), evenOdd ? FillRule.EvenOdd : FillRule.NonZero, eps);
}

/** Union of already-normalised shape sets. */
function unionShapes(shapes: ShapeContours[], eps: number): ShapeContours[] {
  return union(shapesToPaths(shapes), FillRule.NonZero, eps);
}

/** Non-zero winding number of (x, y) against any-orientation contours. */
function winding(contours: Contour[], x: number, y: number): number {
  let w = 0;
  for (const c of contours) {
    for (let i = 0, n = c.length; i < n; i++) {
      const a = c[i];
      const b = c[(i + 1) % n];
      const cross = (b.x - a.x) * (y - a.y) - (x - a.x) * (b.y - a.y);
      if (a.y <= y) {
        if (b.y > y && cross > 0) w++;
      } else if (b.y <= y && cross < 0) w--;
    }
  }
  return w;
}

/**
 * A point strictly inside a normalised shape: just inside the middle of its longest outer
 * edge (fill is on the left of travel, outer CCW).
 */
export function interiorPoint({ outer }: ShapeContours): THREE.Vector2 {
  let best = 0;
  let bestLen = -1;
  for (let i = 0, n = outer.length; i < n; i++) {
    const len = outer[i].distanceToSquared(outer[(i + 1) % n]);
    if (len > bestLen) {
      bestLen = len;
      best = i;
    }
  }
  const a = outer[best];
  const b = outer[(best + 1) % outer.length];
  const len = Math.sqrt(bestLen) || 1;
  // inward normal = (-d.y, d.x)
  const step = Math.min(0.05, len * 0.25);
  return new THREE.Vector2((a.x + b.x) / 2 - ((b.y - a.y) / len) * step, (a.y + b.y) / 2 + ((b.x - a.x) / len) * step);
}

/** Whether (x, y) lies in the filled region of a normalised shape. */
export function shapeContains(shape: ShapeContours, x: number, y: number): boolean {
  return winding([shape.outer, ...shape.holes], x, y) !== 0;
}

/**
 * For every normalised shape, the index of the LAST source group (e.g. glyph) whose raw
 * contours contain it, or -1. Shapes are unions of groups, so a point just inside the shape's
 * longest outer edge lies inside the group that edge came from.
 */
export function shapeOwners(shapes: ShapeContours[], groups: Contour[][]): number[] {
  return shapes.map((shape) => {
    const { x, y } = interiorPoint(shape);
    for (let g = groups.length - 1; g >= 0; g--) if (winding(groups[g], x, y) !== 0) return g;
    return -1;
  });
}

/**
 * Grow (delta > 0) or shrink the silhouette by `delta` px with miter (sharp, limited) or
 * round joins. `fillCounters` drops the holes first, so counters become solid.
 */
export function offsetShapes(
  shapes: ShapeContours[],
  delta: number,
  join: 'miter' | 'round',
  fillCounters: boolean,
  eps: number,
): ShapeContours[] {
  const paths = shapesToPaths(shapes, !fillCounters);
  if (!paths.length) return [];
  const grown =
    Math.abs(delta) < 1e-6
      ? paths
      : inflatePathsD(paths, delta, join === 'round' ? JoinType.Round : JoinType.Miter, EndType.Polygon, MITER_LIMIT, PRECISION);
  return union(grown, FillRule.NonZero, eps);
}

/**
 * `outer` minus `holes` (any orientation), for a region whose contours touch or overlap, which
 * earcut can't triangulate: the contours are pulled one Clipper grid step into the region
 * first, so touching ones merge, then cut as clean shapes. Their vertices are a grid step off
 * the input contours; callers project them back.
 */
export function subtractContours(outer: Contour, holes: Contour[], eps: number): ShapeContours[] {
  const ccw = (c: Contour) => toPath(signedArea(c) < 0 ? [...c].reverse() : c);
  const grid = 10 ** -PRECISION;
  const subject = inflatePathsD([ccw(outer)], -grid, JoinType.Miter, EndType.Polygon, MITER_LIMIT, PRECISION);
  const clip = inflatePathsD(holes.map(ccw), grid, JoinType.Miter, EndType.Polygon, MITER_LIMIT, PRECISION);
  const tree = new PolyTreeD();
  booleanOpDWithPolyTree(ClipType.Difference, subject, clip, tree, FillRule.NonZero, PRECISION);
  const out: ShapeContours[] = [];
  collect(tree, out, eps);
  return out;
}

// ---------- path commands ----------

/** Flatten layout path commands (layer space, y-up) into closed contours. */
export function cmdsContours(cmds: PathCmd[], curveSegments: number): Contour[] {
  const out: Contour[] = [];
  let cur: Contour = [];
  let px = 0;
  let py = 0;
  const segs = Math.max(1, Math.round(curveSegments));
  for (const cmd of cmds) {
    switch (cmd.type) {
      case 'M':
        if (cur.length) out.push(cur);
        cur = [new THREE.Vector2(cmd.x, cmd.y)];
        px = cmd.x;
        py = cmd.y;
        break;
      case 'L':
        cur.push(new THREE.Vector2(cmd.x, cmd.y));
        px = cmd.x;
        py = cmd.y;
        break;
      case 'Q':
        for (let s = 1; s <= segs; s++) {
          const t = s / segs;
          const u = 1 - t;
          cur.push(new THREE.Vector2(u * u * px + 2 * u * t * cmd.x1 + t * t * cmd.x, u * u * py + 2 * u * t * cmd.y1 + t * t * cmd.y));
        }
        px = cmd.x;
        py = cmd.y;
        break;
      case 'C':
        for (let s = 1; s <= segs; s++) {
          const t = s / segs;
          const u = 1 - t;
          const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
          cur.push(
            new THREE.Vector2(a * px + b * cmd.x1 + c * cmd.x2 + d * cmd.x, a * py + b * cmd.y1 + c * cmd.y2 + d * cmd.y),
          );
        }
        px = cmd.x;
        py = cmd.y;
        break;
      case 'Z':
        if (cur.length) out.push(cur);
        cur = [];
        break;
    }
  }
  if (cur.length) out.push(cur);
  return out;
}

// ---------- SVG ----------

/**
 * Parse SVG text into extrudable shapes (y-up, original SVG units). Filled paths honour the
 * SVG fill-rule (nonzero / evenodd); stroke-only paths become their stroke outline (miter
 * joins, butt caps) so thin line-art logos extrude too. Everything is unioned. SVG colours
 * are ignored — the layer's 3D materials are used.
 */
export function svgShapes(svgText: string, curveSegments: number, eps: number): ShapeContours[] {
  const data = new SVGLoader().parse(svgText);
  const parts: ShapeContours[] = [];
  const divisions = Math.max(1, Math.round(curveSegments));
  const flip = (v: THREE.Vector2) => new THREE.Vector2(v.x, -v.y);
  for (const path of data.paths) {
    const style = (path.userData?.style ?? {}) as { fill?: string; fillRule?: string; stroke?: string; strokeWidth?: number };
    const hasFill = style.fill !== undefined && style.fill !== 'none' && style.fill !== 'transparent';
    const hasStroke = style.stroke !== undefined && style.stroke !== 'none' && (style.strokeWidth ?? 1) > 0;
    if (hasFill) {
      const raw = path.subPaths.map((sub) => cleanContour(sub.getPoints(divisions).map(flip), eps));
      parts.push(...normalizeContours(raw, style.fillRule === 'evenodd', eps));
    } else if (hasStroke) {
      const closed: PathsD = [];
      const open: PathsD = [];
      for (const sub of path.subPaths) {
        const pts = cleanContour(sub.getPoints(divisions).map(flip), eps);
        if (pts.length < 2) continue;
        const isClosed = sub.autoClose || sub.getPoint(0).distanceTo(sub.getPoint(1)) < eps * 4;
        (isClosed ? closed : open).push(toPath(pts));
      }
      const hw = (style.strokeWidth ?? 1) / 2;
      const outline = [
        ...(closed.length ? inflatePathsD(closed, hw, JoinType.Miter, EndType.Joined, MITER_LIMIT, PRECISION) : []),
        ...(open.length ? inflatePathsD(open, hw, JoinType.Miter, EndType.Butt, MITER_LIMIT, PRECISION) : []),
      ];
      parts.push(...union(outline, FillRule.NonZero, eps));
    }
  }
  return unionShapes(parts, eps);
}

export function shapesBounds(shapes: ShapeContours[]): THREE.Box2 {
  const b = new THREE.Box2();
  for (const s of shapes) for (const p of s.outer) b.expandByPoint(p);
  return b;
}

/** (p + (dx, dy)) * s for every point. */
export function transformShapes(shapes: ShapeContours[], dx: number, dy: number, s: number): ShapeContours[] {
  const f = (c: Contour) => c.map((p) => new THREE.Vector2((p.x + dx) * s, (p.y + dy) * s));
  return shapes.map((sh) => ({ outer: f(sh.outer), holes: sh.holes.map(f) }));
}

import * as THREE from 'three';
import { SVGLoader } from 'three/examples/jsm/loaders/SVGLoader.js';
import { getAsset, getFont } from '../../assets/registry';
import type { ImageSource, ShapeSource, SvgSource, TextSource, Title2DLayer } from '../../model/types';
import { distortIsIdentity } from '../../text/distort';
import { outlinedShapeCmds, outlinedTextLayout } from '../../text/ink';
import { cmdsBounds, glyphSpanBoxes, mapCmds, type Bounds, type PathCmd } from '../../text/layout';
import { warpIsIdentity } from '../../text/warp';
import { decodeImage, getBitmap } from './images';

// Source → drawable 2D geometry for the title renderer. Everything is in LAYER SPACE
// (comp px, y-up, centred on the origin). Paths stay as curves (Path2D) so Canvas2D can
// fill/stroke them at any resolution; the stroke of a path with lineWidth 2g unioned with
// its fill is exactly the outline grown by g with the chosen join (that is how rims are made).
// Text and shape outlines come from src/text/ink.ts with the layer's outline operations
// (warp → distort → weight) already applied.

export interface FillGroup {
  /** Every contour, drawn with `rule`. */
  all: Path2D;
  /** Only the outer contours, all oriented the same way: filling it with 'nonzero' gives the
   * shape with its counters (holes) filled. */
  outer: Path2D;
  rule: CanvasFillRule;
}

export interface StrokeItem {
  path: Path2D;
  width: number;
  join: CanvasLineJoin;
  cap: CanvasLineCap;
}

export type Geometry =
  | {
      kind: 'path';
      bounds: Bounds;
      groups: FillGroup[];
      strokes: StrokeItem[];
      /** Every outline command in layer space (one stable array per geometry): the input of plateBaseCmds. */
      cmds: PathCmd[];
      /** Faux-italic shear of the source (degrees), added to slanted plate boxes. */
      shear: number;
      /** Text sources: the source character index (TextSource.chars key) of each group. */
      chars?: number[];
      /** Text sources: per group, its ink box and its line's box (outlined, layer space) for Fill.span. */
      spans?: { char: Bounds[]; line: Bounds[] };
    }
  | {
      kind: 'image';
      bounds: Bounds;
      bitmap: ImageBitmap;
      /** Convex hull of the opaque pixels (layer space): the outline hull / box plates grow from. */
      hull: PathCmd[];
    };

/** The layer fields geometry depends on: the source and its outline operations. */
export type GeometryInput = Pick<Title2DLayer, 'source' | 'warp' | 'distort' | 'weight'>;

// ---------- contours ----------

function splitContours(cmds: PathCmd[]): PathCmd[][] {
  const out: PathCmd[][] = [];
  let cur: PathCmd[] | null = null;
  for (const c of cmds) {
    if (c.type === 'M') {
      cur = [c];
      out.push(cur);
    } else if (cur) cur.push(c);
  }
  return out.filter((c) => c.some((k) => k.type !== 'M' && k.type !== 'Z'));
}

/** Polyline approximation (x,y pairs) for winding tests only. */
function flatten(contour: PathCmd[]): number[] {
  const pts: number[] = [];
  let x = 0;
  let y = 0;
  const N = 6;
  for (const c of contour) {
    if (c.type === 'Z') continue;
    if (c.type === 'M' || c.type === 'L') {
      pts.push(c.x, c.y);
    } else if (c.type === 'Q') {
      for (let i = 1; i <= N; i++) {
        const t = i / N;
        const u = 1 - t;
        pts.push(u * u * x + 2 * u * t * c.x1 + t * t * c.x, u * u * y + 2 * u * t * c.y1 + t * t * c.y);
      }
    } else if (c.type === 'C') {
      for (let i = 1; i <= N; i++) {
        const t = i / N;
        const u = 1 - t;
        const a = u * u * u;
        const b = 3 * u * u * t;
        const d = 3 * u * t * t;
        const e = t * t * t;
        pts.push(a * x + b * c.x1 + d * c.x2 + e * c.x, a * y + b * c.y1 + d * c.y2 + e * c.y);
      }
    }
    x = c.x;
    y = c.y;
  }
  return pts;
}

function signedArea(p: number[]): number {
  let a = 0;
  const n = p.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) a += p[j * 2] * p[i * 2 + 1] - p[i * 2] * p[j * 2 + 1];
  return a / 2;
}

/** Winding number of polygon `p` around (x, y). */
function winding(x: number, y: number, p: number[]): number {
  let w = 0;
  const n = p.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const x0 = p[j * 2];
    const y0 = p[j * 2 + 1];
    const x1 = p[i * 2];
    const y1 = p[i * 2 + 1];
    if (y0 <= y) {
      if (y1 > y && (x1 - x0) * (y - y0) - (x - x0) * (y1 - y0) > 0) w++;
    } else if (y1 <= y && (x1 - x0) * (y - y0) - (x - x0) * (y1 - y0) < 0) w--;
  }
  return w;
}

function reverseContour(contour: PathCmd[]): PathCmd[] {
  // Collect segments as (start, cmd) and emit them backwards.
  const segs: { from: { x: number; y: number }; cmd: PathCmd }[] = [];
  let cur = { x: 0, y: 0 };
  let start = cur;
  for (const c of contour) {
    if (c.type === 'Z') continue;
    if (c.type === 'M') {
      cur = start = { x: c.x, y: c.y };
      continue;
    }
    segs.push({ from: cur, cmd: c });
    cur = { x: c.x, y: c.y };
  }
  const out: PathCmd[] = [{ type: 'M', x: start.x, y: start.y }];
  if (cur.x !== start.x || cur.y !== start.y) out.push({ type: 'L', x: cur.x, y: cur.y });
  for (let i = segs.length - 1; i >= 0; i--) {
    const { from, cmd } = segs[i];
    if (cmd.type === 'L' || cmd.type === 'M') out.push({ type: 'L', x: from.x, y: from.y });
    else if (cmd.type === 'Q') out.push({ type: 'Q', x1: cmd.x1, y1: cmd.y1, x: from.x, y: from.y });
    else if (cmd.type === 'C') out.push({ type: 'C', x1: cmd.x2, y1: cmd.y2, x2: cmd.x1, y2: cmd.y1, x: from.x, y: from.y });
  }
  out.push({ type: 'Z' });
  return out;
}

function appendCmds(path: Path2D, cmds: PathCmd[], close = true) {
  let open = false;
  for (const c of cmds) {
    switch (c.type) {
      case 'M':
        if (open && close) path.closePath();
        path.moveTo(c.x, c.y);
        open = true;
        break;
      case 'L':
        path.lineTo(c.x, c.y);
        break;
      case 'Q':
        path.quadraticCurveTo(c.x1, c.y1, c.x, c.y);
        break;
      case 'C':
        path.bezierCurveTo(c.x1, c.y1, c.x2, c.y2, c.x, c.y);
        break;
      case 'Z':
        path.closePath();
        open = false;
        break;
    }
  }
  if (open && close) path.closePath();
}

/**
 * Build a fill group: `all` = the contours as given; `outer` = only contours that bound the
 * filled region from the outside (some point of the contour lies outside the fill of all the
 * other contours under `rule`), each re-oriented counter-clockwise so a 'nonzero' fill of
 * `outer` is the shape with every counter filled. Overlapping strokes (common in CJK fonts)
 * stay outer because part of them lies outside the others.
 */
export function fillGroup(cmds: PathCmd[], rule: CanvasFillRule): FillGroup {
  const contours = splitContours(cmds);
  const polys = contours.map(flatten);
  const all = new Path2D();
  appendCmds(all, cmds);
  const outer = new Path2D();
  contours.forEach((contour, i) => {
    const p = polys[i];
    const n = p.length / 2;
    const step = Math.max(1, Math.floor(n / 12));
    let isOuter = false;
    for (let k = 0; k < n && !isOuter; k += step) {
      const x = p[k * 2];
      const y = p[k * 2 + 1];
      let w = 0;
      for (let j = 0; j < polys.length; j++) if (j !== i) w += winding(x, y, polys[j]);
      const inside = rule === 'evenodd' ? (w & 1) !== 0 : w !== 0;
      if (!inside) isOuter = true;
    }
    if (!isOuter) return;
    appendCmds(outer, signedArea(p) < 0 ? reverseContour(contour) : contour);
  });
  return { all, outer, rule };
}

// ---------- sources ----------

type Ops = Pick<Title2DLayer, 'warp' | 'distort' | 'weight'>;

function textGeometry(src: TextSource, ops: Ops): Geometry | null {
  const layout = outlinedTextLayout(src, ops);
  if (!layout || layout.glyphs.length === 0) return null;
  const cmds = layout.glyphs.flatMap((g) => g.cmds);
  return {
    kind: 'path',
    bounds: cmdsBounds(cmds),
    groups: layout.glyphs.map((g) => fillGroup(g.cmds, 'nonzero')),
    strokes: [],
    cmds,
    shear: src.shear,
    chars: layout.glyphs.map((g) => g.index),
    spans: { char: glyphSpanBoxes(layout, 'char'), line: glyphSpanBoxes(layout, 'line') },
  };
}

/** Parametric shape: one non-zero group (ribbon tails overlap the band). */
function shapeGeometry(src: ShapeSource, ops: Ops): Geometry | null {
  const cmds = outlinedShapeCmds(src, ops);
  if (cmds.length === 0) return null;
  return { kind: 'path', bounds: cmdsBounds(cmds), groups: [fillGroup(cmds, 'nonzero')], strokes: [], cmds, shear: 0 };
}

/** SVG curves → PathCmd (y-down SVG units). Arcs and splines are flattened. */
function svgPathCmds(sub: THREE.Path): PathCmd[] {
  const out: PathCmd[] = [];
  let started = false;
  const start = (v: THREE.Vector2) => {
    if (!started) {
      out.push({ type: 'M', x: v.x, y: v.y });
      started = true;
    }
  };
  for (const curve of sub.curves) {
    if (curve instanceof THREE.LineCurve) {
      start(curve.v1);
      out.push({ type: 'L', x: curve.v2.x, y: curve.v2.y });
    } else if (curve instanceof THREE.QuadraticBezierCurve) {
      start(curve.v0);
      out.push({ type: 'Q', x1: curve.v1.x, y1: curve.v1.y, x: curve.v2.x, y: curve.v2.y });
    } else if (curve instanceof THREE.CubicBezierCurve) {
      start(curve.v0);
      out.push({ type: 'C', x1: curve.v1.x, y1: curve.v1.y, x2: curve.v2.x, y2: curve.v2.y, x: curve.v3.x, y: curve.v3.y });
    } else {
      const pts = curve.getPoints(48) as THREE.Vector2[];
      if (pts.length === 0) continue;
      start(pts[0]);
      for (let i = 1; i < pts.length; i++) out.push({ type: 'L', x: pts[i].x, y: pts[i].y });
    }
  }
  return out;
}

const svgCache = new Map<string, { fills: { cmds: PathCmd[]; rule: CanvasFillRule }[]; strokes: { cmds: PathCmd[]; closed: boolean[]; width: number; join: CanvasLineJoin; cap: CanvasLineCap }[] }>();

function parseSvg(assetId: string, text: string) {
  const hit = svgCache.get(assetId);
  if (hit) return hit;
  const data = new SVGLoader().parse(text);
  const fills: { cmds: PathCmd[]; rule: CanvasFillRule }[] = [];
  const strokes: { cmds: PathCmd[]; closed: boolean[]; width: number; join: CanvasLineJoin; cap: CanvasLineCap }[] = [];
  for (const sp of data.paths) {
    const style = (sp.userData?.style ?? {}) as Record<string, string | number | undefined>;
    const cmds: PathCmd[] = [];
    const closed: boolean[] = [];
    for (const sub of sp.subPaths) {
      const c = svgPathCmds(sub);
      if (c.length < 2) continue;
      cmds.push(...c);
      closed.push(sub.autoClose);
    }
    if (cmds.length === 0) continue;
    const fill = String(style.fill ?? '#000');
    if (fill !== 'none' && fill !== 'transparent') {
      fills.push({ cmds, rule: style.fillRule === 'evenodd' ? 'evenodd' : 'nonzero' });
    }
    const stroke = String(style.stroke ?? 'none');
    const width = Number(style.strokeWidth ?? 1);
    if (stroke !== 'none' && stroke !== 'transparent' && width > 0) {
      const j = String(style.strokeLineJoin ?? 'miter');
      const c = String(style.strokeLineCap ?? 'butt');
      strokes.push({
        cmds,
        closed,
        width,
        join: j === 'round' ? 'round' : j === 'bevel' ? 'bevel' : 'miter',
        cap: c === 'round' ? 'round' : c === 'square' ? 'square' : 'butt',
      });
    }
  }
  const parsed = { fills, strokes };
  svgCache.set(assetId, parsed);
  return parsed;
}

function svgGeometry(src: SvgSource): Geometry | null {
  const asset = getAsset(src.assetId);
  if (!asset) return null;
  const parsed = parseSvg(asset.id, new TextDecoder().decode(asset.data));
  // Fit: larger side of the ink bounds (stroke widths included) = size, centred, y flipped.
  const b: Bounds = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const f of parsed.fills) cmdsBounds(f.cmds, b);
  for (const s of parsed.strokes) {
    const sb = cmdsBounds(s.cmds);
    const h = s.width / 2;
    b.x0 = Math.min(b.x0, sb.x0 - h);
    b.y0 = Math.min(b.y0, sb.y0 - h);
    b.x1 = Math.max(b.x1, sb.x1 + h);
    b.y1 = Math.max(b.y1, sb.y1 + h);
  }
  if (!Number.isFinite(b.x0)) return null;
  const span = Math.max(b.x1 - b.x0, b.y1 - b.y0, 1e-6);
  const k = src.size / span;
  const cx = (b.x0 + b.x1) / 2;
  const cy = (b.y0 + b.y1) / 2;
  const fit = (cmds: PathCmd[]) => mapCmds(cmds, ({ x, y }) => ({ x: (x - cx) * k, y: -(y - cy) * k }));
  const hw = ((b.x1 - b.x0) * k) / 2;
  const hh = ((b.y1 - b.y0) * k) / 2;
  const fills = parsed.fills.map((f) => ({ cmds: fit(f.cmds), rule: f.rule }));
  const strokes = parsed.strokes.map((s) => ({ ...s, cmds: fit(s.cmds) }));
  return {
    kind: 'path',
    bounds: { x0: -hw, y0: -hh, x1: hw, y1: hh },
    groups: fills.map((f) => fillGroup(f.cmds, f.rule)),
    strokes: strokes.map((s) => {
      const path = new Path2D();
      // Open subpaths must stay open for the stroke; split by subpath.
      const parts = splitContours(s.cmds);
      parts.forEach((part, i) => appendCmds(path, part, s.closed[i] ?? false));
      return { path, width: s.width * k, join: s.join, cap: s.cap };
    }),
    // Stroke centre lines join the plate input so hull / box plates enclose them.
    cmds: [...fills.flatMap((f) => f.cmds), ...strokes.flatMap((s) => s.cmds)],
    shear: 0,
  };
}

// ---------- images ----------

/** Convex hull (Andrew's monotone chain, counter-clockwise) of an image's opaque pixels, in 0..1 image units (y down). */
const hullCache = new Map<string, { x: number; y: number }[]>();

function imageHull(assetId: string, bmp: ImageBitmap): { x: number; y: number }[] {
  const hit = hullCache.get(assetId);
  if (hit) return hit;
  // A ≤256 px proxy is plenty for a plate outline.
  const k = Math.min(1, 256 / Math.max(bmp.width, bmp.height, 1));
  const w = Math.max(1, Math.round(bmp.width * k));
  const h = Math.max(1, Math.round(bmp.height * k));
  const c = new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true })!;
  c.drawImage(bmp, 0, 0, w, h);
  const data = c.getImageData(0, 0, w, h).data;
  // Row extremes are enough: every hull vertex is a leftmost or rightmost opaque pixel of a row.
  const pts: { x: number; y: number }[] = [];
  for (let y = 0; y < h; y++) {
    let x0 = -1;
    let x1 = -1;
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] < 128) continue;
      if (x0 < 0) x0 = x;
      x1 = x;
    }
    if (x0 < 0) continue;
    pts.push({ x: x0, y }, { x: x0, y: y + 1 }, { x: x1 + 1, y }, { x: x1 + 1, y: y + 1 });
  }
  if (pts.length === 0) pts.push({ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h });
  pts.sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: { x: number; y: number }[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: { x: number; y: number }[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  const hull = [...lower.slice(0, -1), ...upper.slice(0, -1)].map((p) => ({ x: p.x / w, y: p.y / h }));
  hullCache.set(assetId, hull);
  return hull;
}

function imageGeometry(src: ImageSource): Geometry | null {
  const bmp = getBitmap(src.assetId);
  if (!bmp) {
    void decodeImage(src.assetId);
    return null;
  }
  const k = src.size / Math.max(bmp.width, bmp.height, 1);
  const hw = (bmp.width * k) / 2;
  const hh = (bmp.height * k) / 2;
  const hull: PathCmd[] = imageHull(src.assetId, bmp).map((p, i) => ({ type: i ? 'L' : 'M', x: -hw + p.x * 2 * hw, y: hh - p.y * 2 * hh }));
  hull.push({ type: 'Z' });
  return { kind: 'image', bounds: { x0: -hw, y0: -hh, x1: hw, y1: hh }, bitmap: bmp, hull };
}

/** Per-character transforms only: face overrides change shading, never the outlines. */
function charsKey(chars: TextSource['chars']): string {
  return Object.entries(chars)
    .map(([i, c]) => `${i}:${c.dx},${c.dy},${c.scale},${c.hScale ?? 1},${c.vScale ?? 1},${c.rotate}`)
    .join(';');
}

function opsKey(ops: Ops): string {
  const w = ops.warp;
  const warp = warpIsIdentity(w) ? '-' : `${w.style},${w.bend},${w.horizontal},${w.vertical}`;
  return `${warp}|${distortIsIdentity(ops.distort) ? '-' : JSON.stringify(ops.distort)}|${ops.weight}`;
}

/**
 * Cache key that changes whenever the geometry of the layer's source would change (incl. load
 * state). The outline operations apply to text and shape sources only.
 */
export function geometryKey(layer: GeometryInput): string {
  const src = layer.source;
  switch (src.kind) {
    case 'text': {
      const { chars, ...rest } = src;
      return `t|${getFont(src.fontId) ? 1 : 0}|${JSON.stringify(rest)}|${charsKey(chars)}|${opsKey(layer)}`;
    }
    case 'shape':
      return `h|${JSON.stringify(src)}|${opsKey(layer)}`;
    case 'svg':
      return `s|${getAsset(src.assetId) ? 1 : 0}|${src.assetId}|${src.size}`;
    case 'image':
      return `i|${getBitmap(src.assetId) ? 1 : 0}|${src.assetId}|${src.size}`;
  }
}

/** Geometry for a layer's source, or null while its font/asset is unavailable (draw nothing). */
export function buildGeometry(layer: GeometryInput): Geometry | null {
  const src = layer.source;
  switch (src.kind) {
    case 'text':
      return textGeometry(src, layer);
    case 'shape':
      return shapeGeometry(src, layer);
    case 'svg':
      return svgGeometry(src);
    case 'image':
      return imageGeometry(src);
  }
}

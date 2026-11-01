import * as THREE from 'three';
import type { FontEntry } from '../../assets/registry';
import { curveFn } from '../layer2d/contours';
import type { CharAdjust, ImageSource, PlateShape, ShapeSource, TextSource, Title3DProps } from '../../model/types';
import { cmdsBounds, glyphSpanBoxes, type Bounds, type PathCmd } from '../../text/layout';
import { outlinedShapeCmds, outlinedTextLayout, type OutlineOpsOf } from '../../text/ink';
import { traceImage } from '../../text/trace';
import { plateBaseCmds } from '../../text/plate';
import { BEVEL_OUTSIDE_SHARE, effectiveSegments } from './bevel';
import { bandSpans, extrudeOrb, extrudeOutward, extrudeSolid, MeshBuilder, orbGridFor, type ProfilePoint, type ProfileSpan, type SpanTable } from './extrude';
import { emitInflate, inflateField, inflateScale, inflateStep, inflateWallTop } from './inflate';
import {
  cmdsContours,
  interiorPoint,
  normalizeContours,
  offsetShapes,
  shapeContains,
  shapeOwners,
  shapesBounds,
  svgShapes,
  transformShapes,
  type ShapeContours,
} from './outline';

// Title outlines → solids for the 3D layer (Layer3DRenderer.ts holds the conventions).
//
// Outlines come from src/text/ink.ts AFTER the layer's warp → distort → weight, so パース
// corners and face weight reach the bevels, walls and plates exactly as in 2D.
//
// Text is split into extrusion PARTS:
//   * every glyph with a 3D adjust (CharAdjust dz / tiltX / tiltY) is its own part, extruded
//     alone so the renderer can move and tilt it as a rigid solid (an object matrix: dragging
//     dz / tilt never rebuilds geometry);
//   * the other glyphs are unioned (overlapping glyphs merge into one clean outline, so rims
//     run continuously across touching strokes) and each resulting shape is a part.
// Backplates grow from `plateBaseCmds` (src/text/plate.ts, shared with the 2D rims): the
// unrigged glyphs share one stack whose 'contour' base is their union and whose 'hull' / 'box'
// base spans the WHOLE title (rigged glyphs included, so a 北斗 slab stays one piece); every
// rigged glyph also carries its own stack on a per-glyph contour base (the plate's `close`
// kept), built into its mesh so the plate moves and tilts with the letter. Bands reaching past
// the outline ('outside' / 'center') push every base out to the outermost band edge first, so
// a plate's grow stays measured from the visible silhouette.
//
// Front of a solid: 'extrude' = a flat face and the bevel bands (extrude.ts), placed by
// Title3DProps.bevelPosition: 'inside' insets the face by the total band width and the last
// band ends on the outline; 'outside' keeps the full glyph as the face and grows the bands
// outward (extrudeOutward: one band stack per group of touching glyphs); 'center' is half each
// way. 'inflate' = a height field over the outline's distance field (inflate.ts), bands
// ignored. Both put the top of the front at z = 0.
//
// Material slots: a BLOCK is [face, band 1..n, side] (n = bands.length). The layer's block is
// slots 0..n+1; per-character overrides (CharAdjust face3d / bands3d / side3d) get a block of
// their own (`charSlots` = its first slot), so a white 元祖 can lose the gold bands too. A
// shape's block is its owner glyph's (see shapeOwners); rims of merged glyphs follow the owner.
//
// Span attributes (materials.ts 'line' / 'char' gradients): span table entry 0 is the layer
// bounds, entry 1 + g glyph g's boxes. A part made of one glyph uses that glyph's entry. A
// shape made of several glyphs (overlapping glyphs merged, or a shared backplate) uses ONE
// entry, the union of its glyphs' boxes: per-vertex boxes would be interpolated across the
// long cap triangles that span several letters and smear the gradient, so merged letters read
// as one. Outward bands use their entry grown by the band reach (a band gradient spans the
// band), and so does entry 0 (the layer's visible silhouette).
//
// Depth attribute (aZRange, MeshBuilder): every solid records its own front and back z.

/**
 * z lift of a rigged glyph's plate stack (fraction of size): keeps its coplanar plate faces in
 * front of the shared stack's where the two overlap at tiny tilts (≈ 1 px at a 380 px size,
 * a few depth-buffer steps at the comp camera's distance).
 */
const RIG_PLATE_LIFT = 0.0025;

/** Per-glyph 3D adjust as a rigid transform: pivot (layer px, the glyph's em-cell centre) + the CharAdjust fields. */
export interface GlyphRig {
  /** TextSource.chars key. */
  char: number;
  pivot: { x: number; y: number };
}

interface TitlePart {
  shapes: ShapeContours[];
  /** TextSource.chars key of each shape's glyph (material block override), or -1. */
  owners: number[];
  /** Span-table index of every vertex. */
  span: number;
  rig?: GlyphRig;
  /** Rigged glyph: its outline commands (base of its own plate stack). */
  cmds?: PathCmd[];
}

/** A point inside one glyph piece and that glyph's span-table index. */
interface GlyphMark {
  x: number;
  y: number;
  span: number;
}

/** Extrudable outlines of a title source (independent of the extrusion parameters). */
export interface TitleShapes {
  parts: TitlePart[];
  /** What the shared backplate stack grows from with a plain contour base: the silhouette minus rigged glyphs. */
  outline: ShapeContours[];
  /** Commands of `outline` (stable array: plateBaseCmds memoizes on its identity). */
  outlineCmds: PathCmd[];
  /** Commands of the whole title, rigged glyphs included: the base of 'hull' / 'box' plates. */
  allCmds: PathCmd[];
  /** Text shear (degrees), added to a box plate's slant. */
  shear: number;
  spans: SpanTable;
  /** One mark per unrigged glyph piece (text only): which glyphs a shared plate shape covers. */
  marks: GlyphMark[];
  /** 保留 orb (shape 'orb'): ellipsoid radii and centre in the outline plane; no parts then. */
  orb: { rx: number; ry: number; cx: number; cy: number } | null;
}

/** Whether a CharAdjust moves its glyph in 3D (dz / tilt). */
export function hasRig(a: CharAdjust | undefined): boolean {
  return !!a && (!!a.dz || !!a.tiltX || !!a.tiltY);
}

/** Whether a CharAdjust gives its glyph a material block of its own (face, bands or side). */
export function hasMaterialOverride(a: CharAdjust | undefined): boolean {
  return !!a && (!!a.face3d || !!a.bands3d || !!a.side3d);
}

const boundsOf = (b: THREE.Box2): Bounds => ({ x0: b.min.x, y0: b.min.y, x1: b.max.x, y1: b.max.y });

/**
 * Span-table entry covering the entries `indices` (their line and char boxes unioned, appended
 * to `spans`); a single index is returned as is, none = the layer entry.
 */
function unionSpan(spans: SpanTable, indices: number[]): number {
  if (indices.length <= 1) return indices[0] ?? 0;
  const join = (boxes: Bounds[]): Bounds => {
    const b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    for (const k of indices) {
      b.x0 = Math.min(b.x0, boxes[k].x0);
      b.y0 = Math.min(b.y0, boxes[k].y0);
      b.x1 = Math.max(b.x1, boxes[k].x1);
      b.y1 = Math.max(b.y1, boxes[k].y1);
    }
    return b;
  };
  spans.line.push(join(spans.line));
  spans.char.push(join(spans.char));
  return spans.line.length - 1;
}

/** Span entries of the marks inside `shape`, ascending, without repeats. */
function marksIn(marks: GlyphMark[], shape: ShapeContours): number[] {
  const out = new Set<number>();
  for (const m of marks) if (shapeContains(shape, m.x, m.y)) out.add(m.span);
  return [...out].sort((a, b) => a - b);
}

/**
 * A band profile cut where it crosses the glyph outline (offset 0): the inward part for the
 * ring-stack extruder, the outward part for extrudeOutward. Offsets within 1e-9 px of the
 * outline snap onto it, so both halves meet on the outline's own vertices.
 */
function splitAtOutline(spans: ProfileSpan[]): [inner: ProfileSpan[], outer: ProfileSpan[]] {
  const snap = (q: ProfilePoint): ProfilePoint => (q.off !== 0 && Math.abs(q.off) < 1e-9 ? { ...q, off: 0 } : q);
  const inner: ProfileSpan[] = [];
  const outer: ProfileSpan[] = [];
  for (const s of spans) {
    const a = snap(s.a);
    const b = snap(s.b);
    if (b.off <= 0) inner.push({ slot: s.slot, a, b });
    else if (a.off >= 0) outer.push({ slot: s.slot, a, b });
    else {
      const k = -a.off / (b.off - a.off);
      let n: [number, number] | undefined;
      if (a.n && b.n) {
        const nx = a.n[0] + (b.n[0] - a.n[0]) * k;
        const nz = a.n[1] + (b.n[1] - a.n[1]) * k;
        const l = Math.hypot(nx, nz) || 1;
        n = [nx / l, nz / l];
      }
      const m: ProfilePoint = { off: 0, z: a.z + (b.z - a.z) * k, n };
      inner.push({ slot: s.slot, a, b: m });
      outer.push({ slot: s.slot, a: m, b });
    }
  }
  return [inner, outer];
}

/** Polygonal commands of normalised shapes (SVG logos have no source commands). */
function shapesCmds(shapes: ShapeContours[]): PathCmd[] {
  const out: PathCmd[] = [];
  for (const s of shapes) {
    for (const c of [s.outer, ...s.holes]) {
      c.forEach((p, i) => out.push({ type: i ? 'L' : 'M', x: p.x, y: p.y }));
      out.push({ type: 'Z' });
    }
  }
  return out;
}

/** Non-text outline (shape, SVG, traced image): one part, every span = the layer bounds. */
export function flatShapes(outline: ShapeContours[], cmds: PathCmd[] = shapesCmds(outline), orb: TitleShapes['orb'] = null): TitleShapes {
  const b = boundsOf(shapesBounds(outline));
  return {
    parts: orb ? [] : [{ shapes: outline, owners: outline.map(() => -1), span: 0 }],
    outline,
    outlineCmds: cmds,
    allCmds: cmds,
    shear: 0,
    spans: { line: [b], char: [b] },
    marks: [],
    orb,
  };
}

/** Text → outlined layer-space parts (layout shared with the 2D renderer and the editor). */
export function textShapes(src: TextSource, ops: OutlineOpsOf, font: FontEntry, curveSegments: number, eps: number): TitleShapes {
  const lay = outlinedTextLayout(src, ops, font.font)!;
  const groups = lay.glyphs.map((g) => cmdsContours(g.cmds, curveSegments));
  const layer = lay.bounds;
  const spans: SpanTable = {
    line: [layer, ...glyphSpanBoxes(lay, 'line')],
    char: [layer, ...glyphSpanBoxes(lay, 'char')],
  };
  const rigged = lay.glyphs.map((g) => hasRig(src.chars[g.index]));
  const pieces = groups.map((c) => normalizeContours(c, false, eps));
  const parts: TitlePart[] = [];

  // unrigged glyphs: union (also the shared plates' outline), each resulting shape spans the
  // glyphs it is made of
  const flatIdx = lay.glyphs.map((_, g) => g).filter((g) => !rigged[g]);
  const flatGroups = flatIdx.map((g) => groups[g]);
  const flat = normalizeContours(flatGroups.flat(), false, eps);
  const marks = flatIdx.flatMap((g) => pieces[g].map((s) => ({ ...interiorPoint(s), span: 1 + g })));
  const owners = shapeOwners(flat, flatGroups);
  flat.forEach((shape, s) => {
    parts.push({
      shapes: [shape],
      owners: [owners[s] < 0 ? -1 : lay.glyphs[flatIdx[owners[s]]].index],
      span: unionSpan(spans, marksIn(marks, shape)),
    });
  });

  // rigged glyphs: one part each, pivoting on the glyph's em-cell centre
  lay.glyphs.forEach((glyph, g) => {
    const shapes = pieces[g];
    if (!rigged[g] || !shapes.length) return;
    parts.push({ shapes, owners: shapes.map(() => glyph.index), span: 1 + g, rig: { char: glyph.index, pivot: glyph.center }, cmds: glyph.cmds });
  });
  const allCmds = lay.glyphs.flatMap((g) => g.cmds);
  const outlineCmds = flatIdx.length === lay.glyphs.length ? allCmds : flatIdx.flatMap((g) => lay.glyphs[g].cmds);
  return { parts, outline: flat, outlineCmds, allCmds, shear: src.shear, spans, marks, orb: null };
}

/** Parametric shape → outlined layer-space outline (ops over the shape's own bounds, as in 2D). */
export function shapeShapes(src: ShapeSource, ops: OutlineOpsOf, curveSegments: number, eps: number): TitleShapes {
  const cmds = outlinedShapeCmds(src, ops);
  const outline = normalizeContours(cmdsContours(cmds, curveSegments), false, eps);
  if (src.shape !== 'orb' || !outline.length) return flatShapes(outline, cmds);
  // the orb's ellipsoid fills the (outlined) silhouette's bounds
  const b = cmdsBounds(cmds);
  return flatShapes(outline, cmds, { rx: (b.x1 - b.x0) / 2, ry: (b.y1 - b.y0) / 2, cx: (b.x0 + b.x1) / 2, cy: (b.y0 + b.y1) / 2 });
}

/** SVG text → outline fitted so its larger side is `size`, centred. */
export function svgTitleShapes(text: string, size: number, curveSegments: number): TitleShapes {
  const shapes = svgShapes(text, curveSegments, 1e-3);
  const b = shapesBounds(shapes);
  if (b.isEmpty()) return flatShapes([]);
  const sz = b.getSize(new THREE.Vector2());
  const c = b.getCenter(new THREE.Vector2());
  return flatShapes(transformShapes(shapes, -c.x, -c.y, size / Math.max(sz.x, sz.y, 1e-6)));
}

/**
 * Image → its traced alpha outline (src/text/trace.ts), fitted and centred exactly like the 2D
 * image, so a face image projected over the same box registers with the silhouette. The traced
 * commands are the plate base, so hull / box / close plates follow the same outline.
 */
export function imageTitleShapes(img: ImageBitmap, src: ImageSource, curveSegments: number, eps: number): TitleShapes {
  const cmds = traceImage(img, src.size, src.trace);
  return flatShapes(normalizeContours(cmdsContours(cmds, curveSegments), false, eps), cmds);
}

export interface BuiltGeometry {
  geometry: THREE.BufferGeometry;
  /** Layer-space 2D bounds of every material slot in this geometry. */
  bounds: (THREE.Box2 | undefined)[];
}

export interface TitleGeometry {
  /** Unrigged glyphs / shapes and all backplates (sheared by the oblique skew). */
  main: BuiltGeometry | null;
  /** One per rigged glyph, built in flat layer space; the renderer applies its rigid transform. */
  rigged: (BuiltGeometry & { rig: GlyphRig })[];
  /** The orb body (not an extrusion: never sheared). */
  orb: BuiltGeometry | null;
  /** z of the rigid-transform pivot of rigged glyphs: mid-depth of the main solid. */
  pivotZ: number;
}

/**
 * Build the whole title (main solid + backplates, or orb + backplates). Dimensions are % of
 * `size`. `charSlots` maps a char index to the first slot of its material block (per-character
 * override, see header). `outputScale` = output px per layer px, used to add bevel facets, orb
 * tessellation and inflate grid detail on large exports; `draft` (a drag in progress) halves
 * the inflate grid detail.
 */
export function buildTitle(
  t: TitleShapes,
  p: Title3DProps,
  size: number,
  eps: number,
  charSlots: Map<number, number>,
  outputScale: number,
  draft: boolean,
): TitleGeometry {
  const px = (v: number) => (Math.max(0, v) / 100) * size;
  const sideSlot = p.bands.length + 1;
  const main = new MeshBuilder();
  const rigged: TitleGeometry['rigged'] = [];
  let orb: BuiltGeometry | null = null;
  // plates append union entries: work on a copy so rebuilds don't grow the cached table
  const table: SpanTable = { line: [...t.spans.line], char: [...t.spans.char] };
  /** Rigged glyph builders: their plate stacks are added once the main solid's depth is known. */
  const riggedParts: { part: TitlePart; rig: GlyphRig; builder: MeshBuilder }[] = [];
  const bandsWidth = p.bands.reduce((s, b) => s + px(b.width), 0);
  /** How far the bands reach past the glyph outline (the orb and inflate ignore the bands). */
  const outW = t.orb || p.mode === 'inflate' ? 0 : bandsWidth * BEVEL_OUTSIDE_SHARE[p.bevelPosition];
  const grown = (b: Bounds): Bounds => ({ x0: b.x0 - outW, y0: b.y0 - outW, x1: b.x1 + outW, y1: b.y1 + outW });
  if (outW > 0) {
    table.line[0] = grown(table.line[0]);
    table.char[0] = grown(table.char[0]);
  }
  const grownSpans = new Map<number, number>();
  /** Span entry `k` grown by the band reach (appended once; entry 0 is grown in place): the entry of outward bands. */
  const grownSpan = (k: number): number => {
    let g = k ? grownSpans.get(k) : 0;
    if (g === undefined) {
      table.line.push(grown(table.line[k]));
      table.char.push(grown(table.char[k]));
      grownSpans.set(k, (g = table.line.length - 1));
    }
    return g;
  };

  let wallTop: number;
  let zBack: number;
  if (t.orb) {
    // the orb: front pole at z = 0, its equator is where backplates start; bands don't apply
    const { rx, ry, cx, cy } = t.orb;
    const rz = ry;
    const ob = new MeshBuilder();
    ob.zBack = -2 * rz;
    extrudeOrb(ob, 0, rx, ry, rz, -rz, orbGridFor(Math.max(rx, ry) * outputScale));
    orb = ob.build(table);
    orb.geometry.translate(cx, cy, 0);
    orb.bounds = orb.bounds.map((b) => b?.translate(new THREE.Vector2(cx, cy)));
    wallTop = -rz;
    zBack = -rz;
  } else {
    /** Parts by material block (parts are built independently, so splitting by block is exact). */
    const blocks = (part: TitlePart) => {
      const byBlock = new Map<number, ShapeContours[]>();
      part.shapes.forEach((s, i) => {
        const base = charSlots.get(part.owners[i]) ?? 0;
        const list = byBlock.get(base);
        if (list) list.push(s);
        else byBlock.set(base, [s]);
      });
      return byBlock;
    };
    const builderOf = (part: TitlePart) => {
      if (!part.rig) return main;
      const builder = new MeshBuilder();
      riggedParts.push({ part, rig: part.rig, builder });
      return builder;
    };

    if (p.mode === 'inflate') {
      // inflate: one distance-field height map per shape, all normalised by the title's largest
      // inset so equal strokes rise equally and thinner ones stay lower (a real balloon)
      const height = px(p.inflate.height);
      const profile = curveFn(p.inflate.profile);
      wallTop = inflateWallTop(height, profile);
      zBack = wallTop - px(p.depth);
      // the output scale only matters in powers of two, so zooming the preview rarely rebuilds
      const step = inflateStep(
        t.parts.flatMap((part) => part.shapes),
        inflateScale(outputScale),
        Math.min(4, Math.max(1, p.inflate.detail)),
      ) * (draft ? 2 : 1);
      const fields = t.parts.map((part) => part.shapes.map((s) => inflateField(s, step)));
      const maxDist = Math.max(0, ...fields.flat().map((f) => f.maxDist));
      t.parts.forEach((part, k) => {
        const builder = builderOf(part);
        builder.span = part.span;
        builder.zFront = 0;
        builder.zBack = zBack;
        fields[k].forEach((field, i) => {
          const base = charSlots.get(part.owners[i]) ?? 0;
          const side = base + sideSlot;
          emitInflate(builder, field, { faceSlot: base, wallSlot: side, backSlot: side, height, profile, maxDist, zBack, smoothness: p.inflate.smoothness });
        });
      });
    } else {
      // extrude: the face at z = 0 and the bands from its edge out to the side wall, starting
      // outW − bandsWidth from the glyph outline (see header). Inward offsets clamp per vertex
      // (extrude.ts), so thin strokes narrow the bevel instead of inverting it.
      const spans: ProfileSpan[] = [];
      let cur = { off: outW - bandsWidth, z: 0 };
      p.bands.forEach((b, i) => {
        cur = bandSpans(spans, 1 + i, cur.off, cur.z, px(b.width), px(b.depth), b, effectiveSegments(b, outputScale));
      });
      wallTop = cur.z;
      zBack = wallTop - px(p.depth);
      const zTop = Math.max(0, ...spans.flatMap((s) => [s.a.z, s.b.z]));
      const slotted = (list: ProfileSpan[], base: number) => (base ? list.map((s) => ({ ...s, slot: s.slot + base })) : list);
      if (outW <= 0) {
        for (const part of t.parts) {
          const builder = builderOf(part);
          builder.span = part.span;
          builder.zFront = zTop;
          builder.zBack = zBack;
          for (const [base, shapes] of blocks(part)) {
            const side = base + sideSlot;
            extrudeSolid(builder, shapes, { cap: { off: -bandsWidth, z: 0, slot: base }, spans: slotted(spans, base), wallSlot: side, backSlot: side, zBack });
          }
        }
      } else {
        // the face (and the inward half of 'center') per part; the outward bands per group of
        // touching glyphs, so their rings merge instead of crossing
        const [inner, outer] = splitAtOutline(spans);
        const ringStep = (draft ? 2 : 1) / inflateScale(outputScale); // ≈ 1 output px (power-of-two scale: see geometryKey)
        const outward = (builder: MeshBuilder, shapes: ShapeContours[], base: number, span: (component: ShapeContours) => number) => {
          builder.zFront = zTop;
          builder.zBack = zBack;
          const side = base + sideSlot;
          extrudeOutward(builder, shapes, { spans: slotted(outer, base), wallSlot: side, backSlot: side, zBack, step: ringStep, eps, span });
        };
        const flat = new Map<number, ShapeContours[]>();
        for (const part of t.parts) {
          const builder = builderOf(part);
          for (const [base, shapes] of blocks(part)) {
            builder.span = part.span;
            builder.zFront = zTop;
            builder.zBack = zBack;
            const side = base + sideSlot;
            extrudeSolid(builder, shapes, { cap: { off: outW - bandsWidth, z: 0, slot: base }, spans: slotted(inner, base), wallSlot: side, backSlot: side, zBack, open: true });
            if (part.rig) outward(builder, shapes, base, () => grownSpan(part.span));
            else {
              const list = flat.get(base);
              if (list) list.push(...shapes);
              else flat.set(base, [...shapes]);
            }
          }
        }
        // unrigged glyphs share band stacks per material block (blocks of touching glyphs with
        // different overrides still overlap: the depth buffer shows their union)
        for (const [base, shapes] of flat) outward(main, shapes, base, (c) => grownSpan(unionSpan(table, marksIn(t.marks, c))));
      }
    }
  }
  const pivotZ = zBack / 2;

  /**
   * Base outline of a plate: `cmds` reshaped by PlateShape (plate.ts); `shapes` are the
   * normalised `cmds` outline, reused when the base is the outline itself.
   */
  const plateBase = (cmds: PathCmd[], shapes: ShapeContours[], shape: PlateShape): ShapeContours[] => {
    const base = plateBaseCmds(cmds, shape, size, t.shear);
    return base === cmds ? shapes : normalizeContours(cmdsContours(base, p.curveSegments), false, eps);
  };
  /** An outline pushed out to the outermost band edge (the ring extrudeOutward ends on), as commands and shapes. */
  const banded = (cmds: PathCmd[], shapes: ShapeContours[]): [PathCmd[], ShapeContours[]] => {
    if (outW <= 0) return [cmds, shapes];
    const out = offsetShapes(shapes, outW, 'miter', false, eps);
    return [shapesCmds(out), out];
  };

  // backplates: a base outline grown by the cumulative grow, stacked behind. A negative zGap
  // sinks a plate into the previous solid, but never past that solid's wall top, so a plate
  // can't cover the letters in front of it. `base` picks each plate's base outline, `span` each
  // plate shape's span entry; `lift` moves the whole stack toward the viewer.
  const plates = (builder: MeshBuilder, base: (shape: PlateShape) => ShapeContours[], span: (shape: ShapeContours) => number, lift: number) => {
    let top = wallTop;
    let back = zBack;
    let grow = 0;
    let slot = sideSlot + 1;
    for (const bp of p.backplates) {
      if (!bp.enabled) continue;
      grow += px(bp.grow);
      const faceSlot = slot;
      const plateSide = slot + 1;
      slot += 2;
      const zFront = Math.min(back - (bp.zGap / 100) * size, top);
      const bw = px(bp.bevel.width);
      const plateSpans: ProfileSpan[] = [];
      const end = bandSpans(plateSpans, faceSlot, -bw, zFront + lift, bw, px(bp.bevel.depth), bp.bevel, effectiveSegments(bp.bevel, outputScale));
      top = end.z - lift;
      back = top - px(bp.depth);
      builder.zFront = zFront + lift;
      builder.zBack = back + lift;
      const spec = { cap: { off: -bw, z: zFront + lift, slot: faceSlot }, spans: plateSpans, wallSlot: plateSide, backSlot: plateSide, zBack: back + lift };
      const baseShapes = base(bp.plate);
      const merged = offsetShapes(baseShapes, grow, bp.join, bp.fillCounters, eps);
      if (bp.join === 'round' && baseShapes.length > 1) {
        // Round plates grow from each separate letter (island) on its own and overlap in depth,
        // as Eye Candy's per-letter distance rims do: where neighbours meet, their tubes cross in
        // a crease. Growing their union instead leaves a sharp notch and a sliver where the
        // grown outlines meet, which a rounded bevel can't follow (it pinches open there). Each
        // piece keeps the span of the merged plate shape it lies in, so a gradient still spans
        // the letters it backs.
        for (const island of baseShapes)
          for (const shape of offsetShapes([island], grow, bp.join, bp.fillCounters, eps)) {
            const { x, y } = interiorPoint(shape);
            const host = merged.find((m) => shapeContains(m, x, y)) ?? shape;
            builder.span = span(host);
            extrudeSolid(builder, [shape], spec);
          }
        continue;
      }
      for (const shape of merged) {
        builder.span = span(shape);
        extrudeSolid(builder, [shape], spec);
      }
    }
  };
  // the shared stack backs the unrigged glyphs (or the shape / orb); a hull / box base spans
  // the whole title; each plate shape spans the glyphs it backs
  let sharedOutline: [PathCmd[], ShapeContours[]] | undefined;
  let sharedAll: PathCmd[] | undefined;
  const sharedBase = (shape: PlateShape) => {
    if (shape.kind === 'contour') {
      const [cmds, shapes] = (sharedOutline ??= banded(t.outlineCmds, t.outline));
      return plateBase(cmds, shapes, shape);
    }
    sharedAll ??= outW > 0 ? banded([], [...t.outline, ...riggedParts.flatMap(({ part }) => part.shapes)])[0] : t.allCmds;
    return plateBase(sharedAll, t.outline, shape);
  };
  plates(main, sharedBase, (shape) => unionSpan(table, marksIn(t.marks, shape)), 0);
  // a rigged glyph carries its own stack on its own contour, so the plate moves and tilts with
  // the letter; it is lifted a hair so it never z-fights the shared stack where the two overlap
  // at tiny tilts
  for (const { part, rig, builder } of riggedParts) {
    let own: [PathCmd[], ShapeContours[]] | undefined;
    const glyphBase = (shape: PlateShape) => {
      const [cmds, shapes] = (own ??= banded(part.cmds ?? [], part.shapes));
      return plateBase(cmds, shapes, shape.kind === 'contour' ? shape : { ...shape, kind: 'contour' });
    };
    plates(builder, glyphBase, () => part.span, RIG_PLATE_LIFT * size);
    rigged.push({ ...builder.build(table), rig });
  }
  const built = main.build(table);
  if (built.geometry.getAttribute('position').count === 0) {
    built.geometry.dispose();
    return { main: null, rigged, orb, pivotZ };
  }
  return { main: built, rigged, orb, pivotZ };
}

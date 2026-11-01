import type opentype from 'opentype.js';
import type { GradientSpan, TextSource } from '../model/types';

// Shared text layout for 2D and 3D titles. Produces glyph outlines in LAYER SPACE:
// comp px, y-UP, block frame (the layout before per-character offsets / rotations) centred on
// the origin, with tracking, kerning, 詰め, line height, alignment, vertical writing ('vert'
// substitutions, 縦中横), 長体 / 平体, per-line and per-character adjustments and shear already
// applied. Renderers only draw/extrude `cmds`.

export type PathCmd =
  | { type: 'M' | 'L'; x: number; y: number }
  | { type: 'Q'; x1: number; y1: number; x: number; y: number }
  | { type: 'C'; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { type: 'Z' };

export interface PlacedGlyph {
  /** Index into Array.from(source.text) — the key of TextSource.chars. */
  index: number;
  char: string;
  /** Line (column when vertical) index, counting empty lines — the key of TextSource.lines. */
  line: number;
  cmds: PathCmd[];
  /** Centre of the glyph's em cell in layer space (pivot for per-character transforms). */
  center: { x: number; y: number };
}

export interface Bounds {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface TextLayout {
  /** Only glyphs with outlines (spaces/newlines are omitted). */
  glyphs: PlacedGlyph[];
  /**
   * Ink bounds of all glyphs as drawn (control points included, per-character adjustments
   * applied), y-up. NOT centred on the origin once a glyph is adjusted: renderers size their
   * targets from these.
   */
  bounds: Bounds;
  /**
   * The block's frame: ink bounds of the glyphs WITHOUT per-character adjustments (line
   * adjustments and shear included), centred on the origin. The block is centred on it (so
   * moving / scaling one glyph leaves every other glyph where it was) and warps over it.
   */
  frame: Bounds;
}

const vertCache = new WeakMap<opentype.Font, Map<number, number>>();

/** opentype.js 2 has Substitution.getSingle at runtime; @types/opentype.js (1.x) lacks it. */
type SingleSubstitution = {
  getSingle(feature: string, script: string, language: string): { sub: number; by: number }[];
};

function vertMap(font: opentype.Font): Map<number, number> {
  let m = vertCache.get(font);
  if (m) return m;
  m = new Map();
  const gsub = font.substitution as unknown as SingleSubstitution;
  for (const script of ['hani', 'kana', 'DFLT', 'latn']) {
    try {
      for (const s of gsub.getSingle('vert', script, 'dflt')) {
        if (!m.has(s.sub)) m.set(s.sub, s.by);
      }
    } catch {
      // font has no GSUB / script — fine
    }
  }
  vertCache.set(font, m);
  return m;
}

type Pt = { x: number; y: number };

/** Apply fn to every point of a command list (returns a new list). */
export function mapCmds(cmds: PathCmd[], fn: (p: Pt) => Pt): PathCmd[] {
  return cmds.map((c) => {
    switch (c.type) {
      case 'M':
      case 'L': {
        const p = fn(c);
        return { type: c.type, x: p.x, y: p.y };
      }
      case 'Q': {
        const a = fn({ x: c.x1, y: c.y1 });
        const p = fn(c);
        return { type: 'Q', x1: a.x, y1: a.y, x: p.x, y: p.y };
      }
      case 'C': {
        const a = fn({ x: c.x1, y: c.y1 });
        const b = fn({ x: c.x2, y: c.y2 });
        const p = fn(c);
        return { type: 'C', x1: a.x, y1: a.y, x2: b.x, y2: b.y, x: p.x, y: p.y };
      }
      case 'Z':
        return c;
    }
  });
}

export function cmdsBounds(cmds: PathCmd[], into?: Bounds): Bounds {
  const b = into ?? { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  const add = (x: number, y: number) => {
    if (x < b.x0) b.x0 = x;
    if (x > b.x1) b.x1 = x;
    if (y < b.y0) b.y0 = y;
    if (y > b.y1) b.y1 = y;
  };
  for (const c of cmds) {
    if (c.type === 'Z') continue;
    add(c.x, c.y);
    if (c.type === 'Q' || c.type === 'C') add(c.x1, c.y1);
    if (c.type === 'C') add(c.x2, c.y2);
  }
  return b;
}

/**
 * Glyph outline at a y-up baseline origin (ox, oy), em size `size` px, stretched by sx / sy
 * about that origin (長体 / 平体).
 */
function glyphCmds(glyph: opentype.Glyph, ox: number, oy: number, size: number, sx: number, sy: number): PathCmd[] {
  const path = glyph.getPath(0, 0, size);
  // opentype paths are y-down around baseline 0 → flip.
  const out: PathCmd[] = [];
  for (const c of path.commands) {
    switch (c.type) {
      case 'M':
      case 'L':
        out.push({ type: c.type, x: ox + c.x * sx, y: oy - c.y * sy });
        break;
      case 'Q':
        out.push({ type: 'Q', x1: ox + c.x1 * sx, y1: oy - c.y1 * sy, x: ox + c.x * sx, y: oy - c.y * sy });
        break;
      case 'C':
        out.push({ type: 'C', x1: ox + c.x1 * sx, y1: oy - c.y1 * sy, x2: ox + c.x2 * sx, y2: oy - c.y2 * sy, x: ox + c.x * sx, y: oy - c.y * sy });
        break;
      case 'Z':
        out.push({ type: 'Z' });
        break;
    }
  }
  return out;
}

// ---------- 詰め (proportional spacing) ----------

/**
 * Proportional-spacing adjustment of one glyph along the writing direction, font units:
 * `pla` moves the glyph (+x right / +y up), `adv` is added to its advance (negative = tighter).
 */
interface PropAdjust {
  pla: number;
  adv: number;
}

/** Shapes of the opentype.js 2 GPOS parse used here (the 1.x typings leave tables untyped). */
type ValueRecord = { xPlacement?: number; yPlacement?: number; xAdvance?: number; yAdvance?: number };
type Coverage = { format: 1; glyphs: number[] } | { format: 2; ranges: { start: number; end: number; index: number }[] };
interface GposTable {
  features?: { tag: string; feature: { lookupListIndexes: number[] } }[];
  lookups?: { lookupType: number; subtables: { posFormat: number; coverage: Coverage; value?: ValueRecord; values?: ValueRecord[] }[] }[];
}

/**
 * Per-glyph single adjustments (GPOS lookup type 1) of a feature such as 'palt' / 'vpal', or
 * null when the font has none opentype.js can read (it leaves extension lookups unparsed).
 */
function gposSingle(font: opentype.Font, tag: string): Map<number, ValueRecord> | null {
  const gpos = font.tables.gpos as unknown as GposTable | undefined;
  if (!gpos?.features || !gpos.lookups) return null;
  const m = new Map<number, ValueRecord>();
  let found = false;
  for (const rec of gpos.features) {
    if (rec.tag !== tag) continue;
    for (const li of rec.feature.lookupListIndexes) {
      const lookup = gpos.lookups[li];
      if (lookup?.lookupType !== 1) continue;
      found = true;
      for (const st of lookup.subtables) {
        const add = (gi: number, k: number) => {
          const v = st.posFormat === 1 ? st.value : st.values?.[k];
          if (v && !m.has(gi)) m.set(gi, v);
        };
        const cov = st.coverage;
        if (cov.format === 1) cov.glyphs.forEach(add);
        else for (const r of cov.ranges) for (let gi = r.start; gi <= r.end; gi++) add(gi, r.index + gi - r.start);
      }
    }
  }
  return found ? m : null;
}

/** Side bearing (em) each side of the ink box when 詰め fits advances without GPOS data. */
const TSUME_SIDE = 0.05;

interface PropTables {
  palt: Map<number, ValueRecord> | null;
  vpal: Map<number, ValueRecord> | null;
  h: Map<number, PropAdjust | null>;
  v: Map<number, PropAdjust | null>;
}

const propCache = new WeakMap<opentype.Font, PropTables>();

/**
 * Full (tsume = 1) proportional adjustment of `glyph`: the font's 'palt' / 'vpal' values when
 * it has them (glyphs it leaves out stay full-width), else the advance fitted to the ink box
 * plus TSUME_SIDE each side with the ink centred in it (never widened).
 */
function propAdjust(font: opentype.Font, glyph: opentype.Glyph, vertical: boolean): PropAdjust | null {
  let t = propCache.get(font);
  if (!t) propCache.set(font, (t = { palt: gposSingle(font, 'palt'), vpal: gposSingle(font, 'vpal'), h: new Map(), v: new Map() }));
  const memo = vertical ? t.v : t.h;
  const hit = memo.get(glyph.index);
  if (hit !== undefined) return hit;
  let a: PropAdjust | null = null;
  const table = vertical ? t.vpal : t.palt;
  if (table) {
    const v = table.get(glyph.index);
    if (v) a = vertical ? { pla: v.yPlacement ?? 0, adv: v.yAdvance ?? 0 } : { pla: v.xPlacement ?? 0, adv: v.xAdvance ?? 0 };
  } else {
    const bb = glyph.getBoundingBox();
    const upm = font.unitsPerEm;
    const side = 2 * TSUME_SIDE * upm;
    if (Number.isFinite(bb.x1) && Number.isFinite(bb.x2) && bb.x2 > bb.x1) {
      if (!vertical) {
        const full = glyph.advanceWidth ?? upm;
        const ink = bb.x2 - bb.x1;
        if (ink + side < full) a = { adv: ink + side - full, pla: side / 2 - bb.x1 };
      } else {
        // The vertical cell is one em with the em box (ascender..descender) centred in it; the
        // cell top stays put, so the shorter cell's centre rises by half the saving.
        const ink = bb.y2 - bb.y1;
        if (ink + side < upm) {
          const save = upm - ink - side;
          a = { adv: -save, pla: save / 2 - ((bb.y1 + bb.y2) / 2 - (font.ascender + font.descender) / 2) };
        }
      }
    }
  }
  memo.set(glyph.index, a);
  return a;
}

/**
 * 詰め applies to kana, CJK punctuation and full-width forms, plus other full-width symbols
 * (★ ♪ ※ →…); kanji, Latin letters and digits keep their metrics.
 */
function tsumeApplies(char: string, glyph: opentype.Glyph, upm: number): boolean {
  const cp = char.codePointAt(0)!;
  if ((cp >= 0x3000 && cp <= 0x30ff) || (cp >= 0x31f0 && cp <= 0x31ff) || (cp >= 0xff01 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6)) return true;
  return (glyph.advanceWidth ?? upm) >= 0.9 * upm && !/[\p{L}\p{N}]/u.test(char);
}

/** 縦中横 candidates: printable ASCII and Latin-1 (digits, !?, ×). */
function halfWidth(char: string): boolean {
  const cp = char.codePointAt(0)!;
  return (cp > 0x20 && cp < 0x7f) || (cp >= 0xa1 && cp <= 0xff);
}

/** Longest half-width run set as one upright 縦中横 unit; longer runs keep one cell per character. */
const TCY_MAX = 3;

// ---------- layout ----------

interface Placed {
  index: number;
  char: string;
  line: number;
  glyph: opentype.Glyph;
  size: number; // em size after line × character scale, comp px
  sx: number; // 長体 / 平体 stretch about the origin
  sy: number;
  ox: number; // y-up baseline origin
  oy: number;
  cx: number; // em-cell centre
  cy: number;
}

/** A character with its resolved size multiplier (line × char scale) and stretches (source × line × char). */
interface Item {
  index: number;
  char: string;
  s: number;
  hx: number;
  vy: number;
}

export function layoutText(src: TextSource, font: opentype.Font): TextLayout {
  const size = src.size;
  const upm = font.unitsPerEm;
  const scale = size / upm;
  const asc = font.ascender * scale;
  const desc = font.descender * scale; // negative
  const emMid = (asc + desc) / 2; // em-box centre above the baseline at em size `size`
  const track = (src.tracking / 1000) * size;
  const lineAdv = size * src.lineHeight;
  const tsume = Math.min(1, Math.max(0, src.tsume));
  const chars = Array.from(src.text);
  // Non-positive / missing multipliers mean unchanged.
  const pos = (v: number | undefined) => (v !== undefined && v > 0 ? v : 1);

  // Split into lines keeping character indices; resolve every character's scale factors.
  const raw: { index: number; char: string }[][] = [[]];
  chars.forEach((char, index) => {
    if (char === '\n') raw.push([]);
    else raw[raw.length - 1].push({ index, char });
  });
  const lines = raw.map((line, li) => {
    const la = src.lines[li];
    const ls = pos(la?.scale);
    const lh = pos(src.hScale) * pos(la?.hScale);
    const lv = pos(src.vScale) * pos(la?.vScale);
    const items: Item[] = line.map(({ index, char }) => {
      const ca = src.chars[index];
      return { index, char, s: ls * pos(ca?.scale), hx: lh * pos(ca?.hScale), vy: lv * pos(ca?.vScale) };
    });
    return { ls, lh, lv, items };
  });
  // Fraction of the spare extent (block − line) placed before a line for the alignment.
  const alignFrac = src.align === 'start' ? 0 : src.align === 'center' ? 0.5 : 1;

  const placed: Placed[] = [];
  if (!src.vertical) {
    // Each character keeps its own em metrics: advance, kerning after it and tracking scale
    // with its size, advance and kerning also with its horizontal stretch.
    const rows = lines.map(({ items, ls, lv }) => {
      let x = 0;
      let prev: { glyph: opentype.Glyph; it: Item } | null = null;
      const cells = items.map((it) => {
        const glyph = font.charToGlyph(it.char);
        if (prev) x += font.getKerningValue(prev.glyph, glyph) * scale * prev.it.s * prev.it.hx + track * prev.it.s;
        let adv = (glyph.advanceWidth ?? upm) * scale;
        let pla = 0;
        const a = tsume > 0 && tsumeApplies(it.char, glyph, upm) ? propAdjust(font, glyph, false) : null;
        if (a) {
          adv += a.adv * scale * tsume;
          pla = a.pla * scale * tsume;
        }
        const f = it.s * it.hx;
        const cell = { it, glyph, x, adv: adv * f, pla: pla * f };
        x += cell.adv;
        prev = { glyph, it };
        return cell;
      });
      // Line spacing follows the tallest character (size × vertical stretch).
      const vf = items.length ? Math.max(...items.map((it) => it.s * it.vy)) : ls * lv;
      return { cells, width: x, vf };
    });
    const W = Math.max(0, ...rows.map((r) => r.width));
    // Each line box is vf·lineAdv tall with the em box (asc − desc) centred in it, so the
    // baseline step is the previous box's part below its baseline, vf·(lineAdv − asc − desc)/2,
    // plus this one's part above, vf·(lineAdv + asc + desc)/2: vf·lineAdv for uniform lines,
    // and a small line over a big one sits tight.
    let baseline = 0;
    rows.forEach((row, li) => {
      if (li > 0) baseline -= (rows[li - 1].vf * (lineAdv - asc - desc) + row.vf * (lineAdv + asc + desc)) / 2;
      const adj = src.lines[li];
      const shift = alignFrac * (W - row.width) + (adj ? (adj.dx / 100) * size : 0);
      const oy = baseline + (adj ? (adj.dy / 100) * size : 0);
      for (const { it, glyph, x, adv, pla } of row.cells) {
        const x0 = x + shift;
        placed.push({
          index: it.index,
          char: it.char,
          line: li,
          glyph,
          size: size * it.s,
          sx: it.hx,
          sy: it.vy,
          ox: x0 + pla,
          oy,
          cx: x0 + adv / 2,
          cy: oy + emMid * it.s * it.vy,
        });
      }
    });
  } else {
    const vmap = vertMap(font);
    /** One cell down the column: glyphs positioned relative to the column centre and cell top. */
    interface Cell {
      h: number; // cell height, px
      f: number; // vertical size factor (tracking after the cell scales with it)
      glyphs: { it: Item; glyph: opentype.Glyph; dx: number; top: number; sx: number; cdx: number }[];
    }
    // dx = glyph origin x from the column centre; top = baseline below the cell top (≤ 0 is
    // above); cdx = the glyph's own cell centre x from the column centre.
    const cols = lines.map(({ items, ls, lh }) => {
      const cells: Cell[] = [];
      let i = 0;
      while (i < items.length) {
        let j = i;
        if (src.tateChuYoko) while (j < items.length && halfWidth(items[j].char)) j++;
        if (j > i && j - i <= TCY_MAX) {
          // 縦中横: the run set upright side by side, compressed to one column em when wider,
          // its ink centred in a cell as tall as its tallest character.
          const run = items.slice(i, j);
          let px = 0;
          let prev: opentype.Glyph | null = null;
          let y0 = Infinity;
          let y1 = -Infinity;
          const xs = run.map((it) => {
            const glyph = font.charToGlyph(it.char);
            const k = it.s * it.hx * scale;
            if (prev) px += font.getKerningValue(prev, glyph) * k;
            const at = px;
            const adv = (glyph.advanceWidth ?? upm) * k;
            px += adv;
            prev = glyph;
            const bb = glyph.getBoundingBox();
            if (Number.isFinite(bb.y1) && Number.isFinite(bb.y2)) {
              y0 = Math.min(y0, bb.y1 * scale * it.s * it.vy);
              y1 = Math.max(y1, bb.y2 * scale * it.s * it.vy);
            }
            return { it, glyph, at, adv };
          });
          const q = Math.min(1, (size * ls * lh) / Math.max(px, 1e-9));
          const f = Math.max(...run.map((it) => it.s * it.vy));
          const h = size * f;
          const inkMid = y0 <= y1 ? (y0 + y1) / 2 : emMid * f;
          cells.push({
            h,
            f,
            glyphs: xs.map(({ it, glyph, at, adv }) => ({
              it,
              glyph,
              dx: (at - px / 2) * q,
              top: -h / 2 - inkMid,
              sx: it.hx * q,
              cdx: (at + adv / 2 - px / 2) * q,
            })),
          });
          i = j;
          continue;
        }
        // One cell per character (runs too long for 縦中横 included).
        const end = Math.max(j, i + 1);
        for (; i < end; i++) {
          const it = items[i];
          let glyph = font.charToGlyph(it.char);
          const sub = vmap.get(glyph.index);
          if (sub !== undefined) glyph = font.glyphs.get(sub) ?? glyph;
          const f = it.s * it.vy;
          const em = size * f;
          // The em box centred in a full em cell; 詰め shortens the cell from the bottom and
          // moves the glyph (vpal semantics: +pla = up).
          let h = em;
          let shift = 0;
          const a = tsume > 0 && tsumeApplies(it.char, glyph, upm) ? propAdjust(font, glyph, true) : null;
          if (a) {
            h += a.adv * scale * tsume * f;
            shift = a.pla * scale * tsume * f;
          }
          const w = (glyph.advanceWidth ?? upm) * scale * it.s * it.hx;
          cells.push({ h, f, glyphs: [{ it, glyph, dx: -w / 2, top: -em / 2 - emMid * f + shift, sx: it.hx, cdx: 0 }] });
        }
      }
      let height = 0;
      cells.forEach((c, k) => (height += c.h + (k > 0 ? track * cells[k - 1].f : 0)));
      // Column spacing follows the widest character (size × horizontal stretch).
      const wf = items.length ? Math.max(...items.map((it) => it.s * it.hx)) : ls * lh;
      return { cells, height: Math.max(0, height), wf };
    });
    const H = Math.max(0, ...cols.map((c) => c.height));
    let colX = 0; // columns run right → left; centre spacing follows both columns' widths
    cols.forEach((col, ci) => {
      if (ci > 0) colX -= ((cols[ci - 1].wf + col.wf) / 2) * lineAdv;
      const adj = src.lines[ci];
      const x = colX + (adj ? (adj.dx / 100) * size : 0);
      let top = -(alignFrac * (H - col.height) - (adj ? (adj.dy / 100) * size : 0));
      col.cells.forEach((cell, k) => {
        if (k > 0) top -= track * col.cells[k - 1].f;
        const cy = top - cell.h / 2;
        for (const g of cell.glyphs) {
          placed.push({
            index: g.it.index,
            char: g.it.char,
            line: ci,
            glyph: g.glyph,
            size: size * g.it.s,
            sx: g.sx,
            sy: g.it.vy,
            ox: x + g.dx,
            oy: top + g.top,
            cx: x + g.cdx,
            cy,
          });
        }
        top -= cell.h;
      });
    });
  }

  const DEG = Math.PI / 180;
  const outlined: { p: Placed; cmds: PathCmd[] }[] = [];
  const raw0 = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const p of placed) {
    const cmds = glyphCmds(p.glyph, p.ox, p.oy, p.size, p.sx, p.sy);
    if (!cmds.some((c) => c.type !== 'Z' && c.type !== 'M')) continue;
    cmdsBounds(cmds, raw0);
    outlined.push({ p, cmds });
  }
  if (outlined.length === 0) {
    const zero = { x0: 0, y0: 0, x1: 0, y1: 0 };
    return { glyphs: [], bounds: zero, frame: { ...zero } };
  }

  // Frame = the block before per-character offsets / rotations (scales reflow, so they are
  // part of it): centre it vertically, shear about its centre line, then centre the sheared
  // frame horizontally. Offsets / rotations never move the frame.
  const k = Math.tan(src.shear * DEG);
  const my = (raw0.y0 + raw0.y1) / 2;
  let fx0 = raw0.x0;
  let fx1 = raw0.x1;
  if (k) {
    const sb = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    for (const o of outlined) cmdsBounds(mapCmds(o.cmds, ({ x, y }) => ({ x: x + k * (y - my), y })), sb);
    fx0 = sb.x0;
    fx1 = sb.x1;
  }
  const mx = (fx0 + fx1) / 2;
  const frame = { x0: fx0 - mx, y0: raw0.y0 - my, x1: fx1 - mx, y1: raw0.y1 - my };

  const glyphs: PlacedGlyph[] = [];
  const bounds = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const { p, cmds } of outlined) {
    // Per-character rotation about the em-cell centre and offset, in pre-shear layout space.
    const adj = src.chars[p.index];
    const a = adj ? -adj.rotate * DEG : 0; // clockwise on screen = negative in y-up
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    const dx = adj ? (adj.dx / 100) * size : 0;
    const dy = adj ? (adj.dy / 100) * size : 0;
    const place = (x: number, y: number) => {
      const u = x - p.cx;
      const v = y - p.cy;
      const ax = p.cx + u * cos - v * sin + dx;
      const ay = p.cy + u * sin + v * cos + dy - my;
      return { x: ax + k * ay - mx, y: ay };
    };
    const out = mapCmds(cmds, ({ x, y }) => place(x, y));
    cmdsBounds(out, bounds);
    glyphs.push({ index: p.index, char: p.char, line: p.line, cmds: out, center: place(p.cx, p.cy) });
  }
  return { glyphs, bounds, frame };
}

const spanCache = new WeakMap<TextLayout, Partial<Record<GradientSpan, Bounds[]>>>();

/**
 * One layer-space, y-up box per `layout.glyphs[i]` for a gradient span: 'char' = that glyph's
 * ink bounds, 'line' = the ink bounds of every glyph on its line, 'layer' = `layout.bounds`.
 * Pass the WARPED layout so boxes follow the warp. Memoized per layout object (renderers call
 * it per frame); the returned arrays and boxes are shared, never mutate them.
 */
export function glyphSpanBoxes(layout: TextLayout, span: GradientSpan): Bounds[] {
  let entry = spanCache.get(layout);
  if (!entry) spanCache.set(layout, (entry = {}));
  const hit = entry[span];
  if (hit) return hit;
  let boxes: Bounds[];
  if (span === 'layer') boxes = layout.glyphs.map(() => layout.bounds);
  else {
    const chars = (entry.char ??= layout.glyphs.map((g) => cmdsBounds(g.cmds)));
    if (span === 'char') boxes = chars;
    else {
      const byLine = new Map<number, Bounds>();
      layout.glyphs.forEach((g, i) => {
        const c = chars[i];
        const b = byLine.get(g.line);
        if (!b) byLine.set(g.line, { ...c });
        else {
          b.x0 = Math.min(b.x0, c.x0);
          b.y0 = Math.min(b.y0, c.y0);
          b.x1 = Math.max(b.x1, c.x1);
          b.y1 = Math.max(b.y1, c.y1);
        }
      });
      boxes = layout.glyphs.map((g) => byLine.get(g.line)!);
    }
  }
  entry[span] = boxes;
  return boxes;
}

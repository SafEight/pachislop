// ICC printer-profile reader and soft-proof engine, pure TS (no colour-management library).
//
// Reads ICC v2 and v4 output profiles with CMYK data and a Lab or XYZ PCS: the header, the tag
// table, the name (`desc` as v2 textDescription or v4 multiLocalizedUnicode), `wtpt`, `bkpt`, and
// the colorimetric tables A2B0/A2B1 (CMYK → PCS) and B2A0/B2A1 (PCS → CMYK) stored as lut8
// (`mft1`), lut16 (`mft2`), lutAtoB (`mAB `) or lutBtoA (`mBA `). Curves are `curv` or `para`.
// CLUTs interpolate like Little CMS: multilinearly for a Lab input (B2A of a Lab-PCS profile),
// tetrahedrally for other 3-input tables, and for 4 inputs (CMYK) as two tetrahedral lookups
// blended along the first input.
//
// Every table works on normalised values (0..1). PCS Lab is encoded per table type: lut16 always
// uses the legacy v2 16-bit encoding (L 100 = 0xFF00), lut8 and lutAtoB/BtoA the v4 one
// (L 100 = 0xFFFF); PCS XYZ is u1Fixed15 (1.0 = 0x8000) in all of them.

import { msg, MsgError } from '../store/msg';

/** CIELAB under D50, the ICC PCS illuminant. */
export interface Lab {
  L: number;
  a: number;
  b: number;
}

/** CIE XYZ with Y = 1 for the PCS white. */
export type Xyz = readonly [number, number, number];

/** A colorimetric table: normalised input channels in, normalised output channels out. */
export interface IccLut {
  readonly inCh: number;
  readonly outCh: number;
  /** The table stores PCS Lab in the legacy v2 16-bit encoding (lut16). */
  readonly legacyLab: boolean;
  /** Evaluates `x[0..inCh)` into `y[0..outCh)`; `x` is left unchanged. */
  readonly eval: (x: Float64Array, y: Float64Array) => void;
}

export interface IccProfile {
  /** The profile's own description ('' when it has none). */
  readonly name: string;
  /** Major version (2 or 4). */
  readonly version: number;
  readonly pcs: 'Lab' | 'XYZ';
  /** Media white point (`wtpt`), absolute XYZ; D50 when the tag is missing. */
  readonly white: Xyz;
  /** Media black point (`bkpt`, v2 only in practice), absolute XYZ, or null. */
  readonly black: Xyz | null;
  /** CMYK → PCS per intent: [perceptual, relative colorimetric]; a missing A2B1 reuses A2B0, as the ICC spec says. */
  readonly a2b: readonly [IccLut, IccLut];
  /** PCS → CMYK per intent, like `a2b`. */
  readonly b2a: readonly [IccLut, IccLut];
}

export type ProofIntent = 'relative' | 'perceptual';

export interface ProofResult {
  /** The tested colour in the PCS (after black-point compensation when it is on). */
  lab: Lab;
  /** `lab` after PCS → CMYK → PCS through the profile: what the press prints of it. */
  labRoundTrip: Lab;
  /** CIEDE2000 between `lab` and `labRoundTrip`. */
  deltaE: number;
}

/** PCS illuminant D50 (ICC's rounded values). */
const D50: Xyz = [0.9642, 1, 0.8249];

const damaged = () => new MsgError(msg('The ICC profile is damaged'));
const unsupported = (what: string) => new MsgError(msg('Unsupported ICC profile: {what}', { what }));

// ---------- binary reading ----------

class Reader {
  readonly v: DataView;
  constructor(buf: ArrayBuffer) {
    this.v = new DataView(buf);
  }
  u8 = (o: number) => this.v.getUint8(o);
  u16 = (o: number) => this.v.getUint16(o);
  u32 = (o: number) => this.v.getUint32(o);
  s15f16 = (o: number) => this.v.getInt32(o) / 65536;
  sig = (o: number) => String.fromCharCode(this.u8(o), this.u8(o + 1), this.u8(o + 2), this.u8(o + 3));
}

const clamp01 = (x: number) => (x > 0 ? (x < 1 ? x : 1) : 0);

// ---------- curves ----------

type Curve = (x: number) => number;

/** Piecewise-linear lookup of `t` (≥ 2 entries, normalised) over 0..1. */
function tableCurve(t: Float32Array): Curve {
  const last = t.length - 1;
  return (x) => {
    const p = clamp01(x) * last;
    const i = Math.min(last - 1, Math.floor(p));
    return t[i] + (t[i + 1] - t[i]) * (p - i);
  };
}

const identity: Curve = (x) => clamp01(x);

/** A `curv` or `para` element at `o` and its size in bytes (unpadded). */
function readCurve(r: Reader, o: number): { f: Curve; size: number } {
  const type = r.sig(o);
  if (type === 'curv') {
    const n = r.u32(o + 8);
    const size = 12 + 2 * n;
    if (n === 0) return { f: identity, size };
    if (n === 1) {
      const g = r.u16(o + 12) / 256;
      return { f: (x) => clamp01(x) ** g, size };
    }
    const t = new Float32Array(n);
    for (let i = 0; i < n; i++) t[i] = r.u16(o + 12 + 2 * i) / 65535;
    return { f: tableCurve(t), size };
  }
  if (type === 'para') {
    const fn = r.u16(o + 8);
    const count = [1, 3, 4, 5, 7][fn];
    if (count === undefined) throw unsupported(`parametric curve type ${fn}`);
    const p = Array.from({ length: 7 }, (_, i) => (i < count ? r.s15f16(o + 12 + 4 * i) : 0));
    const [g, a, b, c, d, e, f] = p;
    const pow = (x: number) => Math.max(0, a * x + b) ** g;
    const fs: Curve[] = [
      (x) => x ** g,
      (x) => (x >= -b / a ? pow(x) : 0),
      (x) => (x >= -b / a ? pow(x) + c : c),
      (x) => (x >= d ? pow(x) : c * x),
      (x) => (x >= d ? pow(x) + e : c * x + f),
    ];
    const fx = fs[fn];
    return { f: (x) => fx(clamp01(x)), size: 12 + 4 * count };
  }
  throw unsupported(`curve type '${type}'`);
}

/** `n` consecutive curves from `o`, each padded to 4 bytes (lutAtoB / lutBtoA). */
function readCurves(r: Reader, o: number, n: number): Curve[] {
  const out: Curve[] = [];
  for (let i = 0; i < n; i++) {
    const { f, size } = readCurve(r, o);
    out.push(f);
    o += (size + 3) & ~3;
  }
  return out;
}

// ---------- pipeline stages ----------

/** Reads `x`, writes `y` (distinct buffers). */
type Stage = (x: Float64Array, y: Float64Array) => void;

const curvesStage =
  (cs: readonly Curve[]): Stage =>
  (x, y) => {
    for (let i = 0; i < cs.length; i++) y[i] = cs[i](x[i]);
  };

/** 3×3 matrix (row-major) plus offsets. */
const matrixStage =
  (m: readonly number[], off: readonly number[]): Stage =>
  (x, y) => {
    for (let i = 0; i < 3; i++) y[i] = m[i * 3] * x[0] + m[i * 3 + 1] * x[1] + m[i * 3 + 2] * x[2] + off[i];
  };

/** Grid cell of a normalised coordinate on `g` points: [lower index, fraction]. */
function cell(x: number, g: number): [number, number] {
  const p = clamp01(x) * (g - 1);
  const i = Math.min(g - 2, Math.floor(p));
  return [i, p - i];
}

/**
 * Tetrahedral interpolation over three dimensions of `d` from the cell at `o` (corner strides
 * `dx`, `dy`, `dz`, fractions `rx`, `ry`, `rz`), writing `n` channels into `y`.
 */
function tetra(d: Float32Array, o: number, dx: number, dy: number, dz: number, rx: number, ry: number, rz: number, n: number, y: Float64Array) {
  for (let k = 0; k < n; k++) {
    const b = o + k;
    const c0 = d[b];
    let c1: number, c2: number, c3: number;
    if (rx >= ry && ry >= rz) {
      c1 = d[b + dx] - c0;
      c2 = d[b + dx + dy] - d[b + dx];
      c3 = d[b + dx + dy + dz] - d[b + dx + dy];
    } else if (rx >= rz && rz >= ry) {
      c1 = d[b + dx] - c0;
      c2 = d[b + dx + dy + dz] - d[b + dx + dz];
      c3 = d[b + dx + dz] - d[b + dx];
    } else if (rz >= rx && rx >= ry) {
      c1 = d[b + dx + dz] - d[b + dz];
      c2 = d[b + dx + dy + dz] - d[b + dx + dz];
      c3 = d[b + dz] - c0;
    } else if (ry >= rx && rx >= rz) {
      c1 = d[b + dx + dy] - d[b + dy];
      c2 = d[b + dy] - c0;
      c3 = d[b + dx + dy + dz] - d[b + dx + dy];
    } else if (ry >= rz && rz >= rx) {
      c1 = d[b + dx + dy + dz] - d[b + dy + dz];
      c2 = d[b + dy] - c0;
      c3 = d[b + dy + dz] - d[b + dy];
    } else {
      c1 = d[b + dx + dy + dz] - d[b + dy + dz];
      c2 = d[b + dy + dz] - d[b + dz];
      c3 = d[b + dz] - c0;
    }
    y[k] = c0 + c1 * rx + c2 * ry + c3 * rz;
  }
}

/**
 * CLUT lookup: `grid[i]` points along input `i` (the first input varies slowest), `n` outputs per
 * point. `multilinear` forces multilinear interpolation, which Little CMS uses for Lab inputs.
 */
function clutStage(grid: readonly number[], n: number, d: Float32Array, multilinear: boolean): Stage {
  const dims = grid.length;
  const s: number[] = new Array<number>(dims);
  for (let i = dims - 1, st = n; i >= 0; i--) {
    s[i] = st;
    st *= grid[i];
  }
  if (dims === 3 && !multilinear) {
    return (x, y) => {
      const [i0, r0] = cell(x[0], grid[0]);
      const [i1, r1] = cell(x[1], grid[1]);
      const [i2, r2] = cell(x[2], grid[2]);
      tetra(d, i0 * s[0] + i1 * s[1] + i2 * s[2], s[0], s[1], s[2], r0, r1, r2, n, y);
    };
  }
  if (dims === 4) {
    const t0 = new Float64Array(n);
    const t1 = new Float64Array(n);
    return (x, y) => {
      const [i0, r0] = cell(x[0], grid[0]);
      const [i1, r1] = cell(x[1], grid[1]);
      const [i2, r2] = cell(x[2], grid[2]);
      const [i3, r3] = cell(x[3], grid[3]);
      const o = i0 * s[0] + i1 * s[1] + i2 * s[2] + i3 * s[3];
      tetra(d, o, s[1], s[2], s[3], r1, r2, r3, n, t0);
      tetra(d, o + s[0], s[1], s[2], s[3], r1, r2, r3, n, t1);
      for (let k = 0; k < n; k++) y[k] = t0[k] + (t1[k] - t0[k]) * r0;
    };
  }
  // Multilinear over the 2^dims corners of the cell.
  const idx = new Array<number>(dims);
  const fr = new Array<number>(dims);
  return (x, y) => {
    let o = 0;
    for (let i = 0; i < dims; i++) {
      [idx[i], fr[i]] = cell(x[i], grid[i]);
      o += idx[i] * s[i];
    }
    y.fill(0, 0, n);
    for (let corner = 0; corner < 1 << dims; corner++) {
      let w = 1;
      let co = o;
      for (let i = 0; i < dims; i++) {
        if (corner & (1 << (dims - 1 - i))) {
          w *= fr[i];
          co += s[i];
        } else w *= 1 - fr[i];
      }
      if (w === 0) continue;
      for (let k = 0; k < n; k++) y[k] += w * d[co + k];
    }
  };
}

function makeLut(inCh: number, outCh: number, legacyLab: boolean, stages: Stage[]): IccLut {
  let a = new Float64Array(16);
  let b = new Float64Array(16);
  return {
    inCh,
    outCh,
    legacyLab,
    eval: (x, y) => {
      a.set(x.subarray(0, inCh));
      for (const st of stages) {
        st(a, b);
        [a, b] = [b, a];
      }
      for (let i = 0; i < outCh; i++) y[i] = a[i];
    },
  };
}

// ---------- table types ----------

/**
 * lut8 (`mft1`) or lut16 (`mft2`) at `o`. `pcsIn`: the PCS when it is the input (B2A), else null;
 * the matrix only applies to an XYZ input.
 */
function readLutN(r: Reader, o: number, wide: boolean, pcsIn: IccProfile['pcs'] | null): IccLut {
  const inCh = r.u8(o + 8);
  const outCh = r.u8(o + 9);
  const g = r.u8(o + 10);
  if (!inCh || !outCh || inCh > 15 || outCh > 15 || g < 2) throw damaged();
  const m = Array.from({ length: 9 }, (_, i) => r.s15f16(o + 12 + 4 * i));
  const nIn = wide ? r.u16(o + 48) : 256;
  const nOut = wide ? r.u16(o + 50) : 256;
  if (nIn < 2 || nOut < 2) throw damaged();
  let p = o + (wide ? 52 : 48);
  const unit = wide ? 2 : 1;
  const max = wide ? 65535 : 255;
  const table = (n: number) => {
    const t = new Float32Array(n);
    for (let i = 0; i < n; i++, p += unit) t[i] = (wide ? r.u16(p) : r.u8(p)) / max;
    return t;
  };
  const stages: Stage[] = [];
  const isIdentity = m.every((v, i) => v === (i % 4 === 0 ? 1 : 0));
  if (pcsIn === 'XYZ' && inCh === 3 && !isIdentity) stages.push(matrixStage(m, [0, 0, 0]));
  stages.push(curvesStage(Array.from({ length: inCh }, () => tableCurve(table(nIn)))));
  stages.push(clutStage(new Array<number>(inCh).fill(g), outCh, table(g ** inCh * outCh), pcsIn === 'Lab'));
  stages.push(curvesStage(Array.from({ length: outCh }, () => tableCurve(table(nOut)))));
  return makeLut(inCh, outCh, wide, stages);
}

/** lutAtoB (`mAB `, `aToB` true) or lutBtoA (`mBA `) at `o`. `labIn`: the input is PCS Lab. */
function readLutAB(r: Reader, o: number, aToB: boolean, labIn: boolean): IccLut {
  const inCh = r.u8(o + 8);
  const outCh = r.u8(o + 9);
  const [offB, offMat, offM, offClut, offA] = [12, 16, 20, 24, 28].map((k) => r.u32(o + k));
  if (!inCh || !outCh || inCh > 15 || outCh > 15 || !offB) throw damaged();
  // The B curves sit on the PCS side, the A curves on the device side.
  const pcsCh = aToB ? outCh : inCh;
  const devCh = aToB ? inCh : outCh;
  const curves = (off: number, n: number) => curvesStage(readCurves(r, o + off, n));
  const matrix = () => {
    if (pcsCh !== 3) throw damaged();
    const v = Array.from({ length: 12 }, (_, i) => r.s15f16(o + offMat + 4 * i));
    return matrixStage(v.slice(0, 9), v.slice(9));
  };
  const clut = () => {
    const q = o + offClut;
    const grid = Array.from({ length: inCh }, (_, i) => r.u8(q + i));
    if (grid.some((g) => g < 2)) throw damaged();
    const prec = r.u8(q + 16);
    if (prec !== 1 && prec !== 2) throw damaged();
    const n = grid.reduce((s, g) => s * g, outCh);
    const d = new Float32Array(n);
    for (let i = 0; i < n; i++) d[i] = prec === 2 ? r.u16(q + 20 + 2 * i) / 65535 : r.u8(q + 20 + i) / 255;
    return clutStage(grid, outCh, d, labIn);
  };
  const stages: Stage[] = [];
  if (aToB) {
    if (offA) stages.push(curves(offA, devCh));
    if (offClut) stages.push(clut());
    else if (inCh !== outCh) throw damaged();
    if (offM) stages.push(curves(offM, pcsCh));
    if (offMat) stages.push(matrix());
    stages.push(curves(offB, pcsCh));
  } else {
    stages.push(curves(offB, pcsCh));
    if (offMat) stages.push(matrix());
    if (offM) stages.push(curves(offM, pcsCh));
    if (offClut) stages.push(clut());
    else if (inCh !== outCh) throw damaged();
    if (offA) stages.push(curves(offA, devCh));
  }
  return makeLut(inCh, outCh, false, stages);
}

// ---------- text and points ----------

function readText(r: Reader, o: number, len: number): string {
  const type = r.sig(o);
  const bytes = new Uint8Array(r.v.buffer, r.v.byteOffset, r.v.byteLength);
  const cut = (s: string) => s.replace(/\0[\s\S]*$/, '').trim();
  if (type === 'desc') {
    const n = r.u32(o + 8);
    return cut(new TextDecoder('latin1').decode(bytes.subarray(o + 12, o + 12 + n)));
  }
  if (type === 'text') return cut(new TextDecoder('latin1').decode(bytes.subarray(o + 8, o + len)));
  if (type === 'mluc') {
    const n = r.u32(o + 8);
    const size = r.u32(o + 12);
    if (!n) return '';
    let pick = 0;
    for (let i = 0; i < n; i++) {
      if (r.sig(o + 16 + i * size).startsWith('en')) {
        pick = i;
        break;
      }
    }
    const rec = o + 16 + pick * size;
    const sLen = r.u32(rec + 4);
    const sOff = r.u32(rec + 8);
    return cut(new TextDecoder('utf-16be').decode(bytes.subarray(o + sOff, o + sOff + sLen)));
  }
  return '';
}

function readXyz(r: Reader, o: number): Xyz {
  if (r.sig(o) !== 'XYZ ') throw damaged();
  return [r.s15f16(o + 8), r.s15f16(o + 12), r.s15f16(o + 16)];
}

// ---------- profile ----------

/** Parses a CMYK output profile. Throws `MsgError` for anything else, or for damaged / unsupported data. */
export function parseIcc(buf: ArrayBuffer): IccProfile {
  try {
    return parse(new Reader(buf));
  } catch (e) {
    if (e instanceof MsgError) throw e;
    throw damaged();
  }
}

function parse(r: Reader): IccProfile {
  if (r.v.byteLength < 132 || r.sig(36) !== 'acsp') throw new MsgError(msg('Not an ICC profile'));
  const version = r.u8(8);
  if (version !== 2 && version !== 4) throw unsupported(`version ${version}`);
  if (r.sig(12) !== 'prtr' || r.sig(16) !== 'CMYK') throw new MsgError(msg('Not a CMYK printer (output) ICC profile'));
  const pcsSig = r.sig(20);
  if (pcsSig !== 'Lab ' && pcsSig !== 'XYZ ') throw unsupported(`PCS '${pcsSig}'`);
  const pcs = pcsSig === 'Lab ' ? 'Lab' : 'XYZ';

  const tags = new Map<string, { o: number; len: number }>();
  const count = r.u32(128);
  for (let i = 0; i < count; i++) {
    const e = 132 + 12 * i;
    const o = r.u32(e + 4);
    const len = r.u32(e + 8);
    if (o + len > r.v.byteLength) throw damaged();
    tags.set(r.sig(e), { o, len });
  }

  const lut = (tag: string, toPcs: boolean): IccLut | null => {
    const t = tags.get(tag);
    if (!t) return null;
    const type = r.sig(t.o);
    const l =
      type === 'mft1' || type === 'mft2'
        ? readLutN(r, t.o, type === 'mft2', toPcs ? null : pcs)
        : type === (toPcs ? 'mAB ' : 'mBA ')
          ? readLutAB(r, t.o, toPcs, !toPcs && pcs === 'Lab')
          : null;
    if (!l) throw unsupported(`${tag} type '${type}'`);
    if (l.inCh !== (toPcs ? 4 : 3) || l.outCh !== (toPcs ? 3 : 4)) throw damaged();
    return l;
  };
  const required = (tag: string, toPcs: boolean): IccLut => {
    const l = lut(tag, toPcs);
    if (!l) throw new MsgError(msg('The ICC profile has no {tag} table', { tag }));
    return l;
  };
  const a2b0 = required('A2B0', true);
  const b2a0 = required('B2A0', false);

  const desc = tags.get('desc');
  const wtpt = tags.get('wtpt');
  const bkpt = tags.get('bkpt');
  return {
    name: desc ? readText(r, desc.o, desc.len) : '',
    version,
    pcs,
    white: wtpt ? readXyz(r, wtpt.o) : D50,
    black: bkpt ? readXyz(r, bkpt.o) : null,
    a2b: [a2b0, lut('A2B1', true) ?? a2b0],
    b2a: [b2a0, lut('B2A1', false) ?? b2a0],
  };
}

// ---------- colour maths ----------

const EPS = 216 / 24389;
const KAPPA = 24389 / 27;
const labF = (t: number) => (t > EPS ? Math.cbrt(t) : (KAPPA * t + 16) / 116);
const labFInv = (t: number) => (t ** 3 > EPS ? t ** 3 : (116 * t - 16) / KAPPA);

/** Lab of PCS XYZ (D50, Y = 1 for white). */
function xyzToLab(x: number, y: number, z: number): Lab {
  const fx = labF(x / D50[0]);
  const fy = labF(y / D50[1]);
  const fz = labF(z / D50[2]);
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

/** PCS XYZ (D50, Y = 1 for white) of a Lab colour. */
function labToXyz(c: Lab): [number, number, number] {
  const fy = (c.L + 16) / 116;
  return [D50[0] * labFInv(fy + c.a / 500), D50[1] * labFInv(fy), D50[2] * labFInv(fy - c.b / 200)];
}

/** sRGB value (0..255, fractions allowed) → linear light. */
function linear(v: number): number {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** PCS XYZ (D50 via Bradford, as in the ICC sRGB profile) of an sRGB colour given as 0..255 values. */
function srgbToXyz(r: number, g: number, b: number): [number, number, number] {
  const R = linear(r);
  const G = linear(g);
  const B = linear(b);
  return [0.4360747 * R + 0.3850649 * G + 0.1430804 * B, 0.2225045 * R + 0.7168786 * G + 0.0606169 * B, 0.0139322 * R + 0.0971045 * G + 0.7141733 * B];
}

const RAD = Math.PI / 180;
const P25_7 = 25 ** 7;

/** CIEDE2000 colour difference (kL = kC = kH = 1), per Sharma, Wu & Dalal 2005. */
export function deltaE2000(p: Lab, q: Lab): number {
  const Cab = (Math.hypot(p.a, p.b) + Math.hypot(q.a, q.b)) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cab ** 7 / (Cab ** 7 + P25_7)));
  const a1 = (1 + G) * p.a;
  const a2 = (1 + G) * q.a;
  const C1 = Math.hypot(a1, p.b);
  const C2 = Math.hypot(a2, q.b);
  const hue = (b: number, a: number) => (b === 0 && a === 0 ? 0 : ((Math.atan2(b, a) / RAD) % 360 + 360) % 360);
  const h1 = hue(p.b, a1);
  const h2 = hue(q.b, a2);
  const dL = q.L - p.L;
  const dC = C2 - C1;
  let dh = 0;
  if (C1 * C2 !== 0) {
    dh = h2 - h1;
    if (dh > 180) dh -= 360;
    else if (dh < -180) dh += 360;
  }
  const dH = 2 * Math.sqrt(C1 * C2) * Math.sin((dh / 2) * RAD);
  const Lm = (p.L + q.L) / 2;
  const Cm = (C1 + C2) / 2;
  let hm = h1 + h2;
  if (C1 * C2 !== 0) {
    if (Math.abs(h1 - h2) <= 180) hm /= 2;
    else hm = hm < 360 ? (hm + 360) / 2 : (hm - 360) / 2;
  }
  const T = 1 - 0.17 * Math.cos((hm - 30) * RAD) + 0.24 * Math.cos(2 * hm * RAD) + 0.32 * Math.cos((3 * hm + 6) * RAD) - 0.2 * Math.cos((4 * hm - 63) * RAD);
  const dTheta = 30 * Math.exp(-(((hm - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(Cm ** 7 / (Cm ** 7 + P25_7));
  const L50 = (Lm - 50) ** 2;
  const Sl = 1 + (0.015 * L50) / Math.sqrt(20 + L50);
  const Sc = 1 + 0.045 * Cm;
  const Sh = 1 + 0.015 * Cm * T;
  const Rt = -Math.sin(2 * dTheta * RAD) * Rc;
  const l = dL / Sl;
  const c = dC / Sc;
  const h = dH / Sh;
  return Math.sqrt(l * l + c * c + h * h + Rt * c * h);
}

// ---------- soft proof ----------

/** Little CMS's fixed v4 perceptual black (luminance Y; neutral). */
const V4_PERCEPTUAL_BLACK_Y = 0.0034731;

/** Writes `lab` in `lut`'s PCS encoding into `x`. */
function encodePcs(lut: IccLut, xyzPcs: boolean, lab: Lab, x: Float64Array) {
  if (xyzPcs) {
    const v = labToXyz(lab);
    for (let i = 0; i < 3; i++) x[i] = clamp01((v[i] * 32768) / 65535);
  } else if (lut.legacyLab) {
    x[0] = clamp01((lab.L * 652.8) / 65535);
    x[1] = clamp01(((lab.a + 128) * 256) / 65535);
    x[2] = clamp01(((lab.b + 128) * 256) / 65535);
  } else {
    x[0] = clamp01(lab.L / 100);
    x[1] = clamp01((lab.a + 128) / 255);
    x[2] = clamp01((lab.b + 128) / 255);
  }
}

/** Lab of `y` in `lut`'s PCS encoding. */
function decodePcs(lut: IccLut, xyzPcs: boolean, y: Float64Array): Lab {
  if (xyzPcs) return xyzToLab((y[0] * 65535) / 32768, (y[1] * 65535) / 32768, (y[2] * 65535) / 32768);
  if (lut.legacyLab) return { L: (y[0] * 65535) / 652.8, a: (y[1] * 65535) / 256 - 128, b: (y[2] * 65535) / 256 - 128 };
  return { L: y[0] * 100, a: y[1] * 255 - 128, b: y[2] * 255 - 128 };
}

/** PCS → CMYK through `b2a`, then back to the PCS through `a2b`. */
function roundTripper(p: IccProfile, b2a: IccLut, a2b: IccLut): (lab: Lab) => Lab {
  const xyz = p.pcs === 'XYZ';
  const pcsIn = new Float64Array(16);
  const cmyk = new Float64Array(16);
  const pcsOut = new Float64Array(16);
  return (lab) => {
    encodePcs(b2a, xyz, lab, pcsIn);
    b2a.eval(pcsIn, cmyk);
    a2b.eval(cmyk, pcsOut);
    return decodePcs(a2b, xyz, pcsOut);
  };
}

/**
 * The press's darkest printable black, media-relative PCS XYZ, for black-point compensation: the
 * fixed perceptual black for the perceptual intent of v4 profiles (as Little CMS), else what Lab 0
 * prints as through the intent's own tables (ink limiting lives in B2A), capped at L* 50. Its
 * slight tint is kept, so black maps onto a colour the press reproduces exactly. A v2 `bkpt`
 * (absolute) wins only when it is lighter: it is the measured media black, which ink limits can
 * keep out of reach but never undercut.
 */
function blackPoint(p: IccProfile, n: 0 | 1, trip: (lab: Lab) => Lab): Xyz {
  if (n === 0 && p.version >= 4) return [D50[0] * V4_PERCEPTUAL_BLACK_Y, V4_PERCEPTUAL_BLACK_Y, D50[2] * V4_PERCEPTUAL_BLACK_Y];
  const rt = trip({ L: 0, a: 0, b: 0 });
  const bp = labToXyz({ L: Math.min(50, Math.max(0, rt.L)), a: rt.a, b: rt.b });
  if (p.black && p.version < 4) {
    const tag = p.black.map((c, i) => (c * D50[i]) / p.white[i]) as [number, number, number];
    if (tag[1] > bp[1]) return tag;
  }
  return bp;
}

/**
 * Soft proof of sRGB colours (channel values 0..255; fractions allowed) on the profile's press:
 * sRGB → PCS Lab (D50, Bradford) → B2A → CMYK → A2B → Lab, with the B2A / A2B tables of `intent`.
 * `bpc` maps sRGB black to the press's black point (Photoshop's Black Point Compensation) so pure
 * black isn't reported as unprintable.
 */
export function softProof(p: IccProfile, intent: ProofIntent, bpc: boolean): (r: number, g: number, b: number) => ProofResult {
  const n = intent === 'perceptual' ? 0 : 1;
  const trip = roundTripper(p, p.b2a[n], p.a2b[n]);
  // sRGB's black is 0, so BPC reduces to scaling XYZ toward the black point (white stays D50).
  const bp = bpc ? blackPoint(p, n, trip) : ([0, 0, 0] as const);
  const s = bp.map((c, i) => 1 - c / D50[i]);
  return (r, g, b) => {
    const [x, y, z] = srgbToXyz(r, g, b);
    const lab = xyzToLab(x * s[0] + bp[0], y * s[1] + bp[1], z * s[2] + bp[2]);
    const labRoundTrip = trip(lab);
    return { lab, labRoundTrip, deltaE: deltaE2000(lab, labRoundTrip) };
  };
}

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { PNG } from 'pngjs';

// Image comparison for the golden suite. Pixels are compared PREMULTIPLIED (r·a, g·a, b·a, a):
// the references are straight-alpha PNGs, whose colour channels are meaningless where alpha is
// tiny (a 1/255 haze pixel may carry any colour), and a premultiplied difference is what is
// actually visible once composited.

export interface DiffStats {
  /** Largest channel difference, 0..255. */
  max: number;
  /** Mean channel difference over every channel of every pixel, 0..255. */
  mean: number;
  /** % of pixels whose largest channel difference exceeds 8/255. */
  pct: number;
  /** The two images differ in size (the stats then cover their centred overlap padded with transparency). */
  sizeMismatch: boolean;
}

/**
 * Failure thresholds (inclusive limits). On the machine the references were made on a render is
 * reproduced exactly (every determinism run so far diffed to 0), so these only absorb GPU /
 * driver rounding between machines and browser updates: a few stray codes on edge pixels, never
 * a visible change. A changed default moves hundreds of pixels by far more than 8/255.
 */
export const THRESHOLDS = { max: 48, mean: 0.25, pct: 0.1 } as const;

export const PIXEL_TOLERANCE = 8;

export const fails = (d: DiffStats) => d.sizeMismatch || d.max > THRESHOLDS.max || d.mean > THRESHOLDS.mean || d.pct > THRESHOLDS.pct;

export const formatStats = (d: DiffStats) =>
  `${d.sizeMismatch ? 'SIZE MISMATCH, ' : ''}max ${d.max}/255, mean ${d.mean.toFixed(3)}/255, ${d.pct.toFixed(3)} % of px > ${PIXEL_TOLERANCE}/255`;

export function pngFromRgba(width: number, height: number, rgba: Uint8Array): PNG {
  const png = new PNG({ width, height });
  png.data.set(rgba);
  return png;
}

export function writePng(path: string, png: PNG) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, PNG.sync.write(png));
}

/** Premultiplied channel `c` (0..3) of pixel `i` (byte offset) of `d`, 0..255. */
const premul = (d: Uint8Array, i: number, c: number) => (c === 3 ? d[i + 3] : (d[i + c] * d[i + 3]) / 255);

/** `img` centred on a transparent `w × h` canvas (cropped when larger). */
function centred(img: PNG, w: number, h: number): Uint8Array {
  if (img.width === w && img.height === h) return img.data;
  const out = new Uint8Array(w * h * 4);
  const ox = Math.floor((w - img.width) / 2);
  const oy = Math.floor((h - img.height) / 2);
  for (let y = 0; y < img.height; y++) {
    const ty = y + oy;
    if (ty < 0 || ty >= h) continue;
    for (let x = 0; x < img.width; x++) {
      const tx = x + ox;
      if (tx < 0 || tx >= w) continue;
      out.set(img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4), (ty * w + tx) * 4);
    }
  }
  return out;
}

/**
 * Stats of `actual` against `expected`, and a diff sheet: expected | actual | difference, each
 * over dark grey, the difference as red (×8, so 32/255 is full red) over the expected image's
 * faint luminance.
 */
export function compare(expected: PNG, actual: PNG): { stats: DiffStats; sheet: PNG } {
  const w = Math.max(expected.width, actual.width);
  const h = Math.max(expected.height, actual.height);
  const e = centred(expected, w, h);
  const a = centred(actual, w, h);
  let max = 0;
  let sum = 0;
  let over = 0;
  const heat = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < e.length; i += 4, p++) {
    let m = 0;
    for (let c = 0; c < 4; c++) {
      const d = Math.abs(premul(e, i, c) - premul(a, i, c));
      sum += d;
      if (d > m) m = d;
    }
    m = Math.round(m);
    heat[p] = m;
    if (m > max) max = m;
    if (m > PIXEL_TOLERANCE) over++;
  }
  const n = w * h;
  const stats: DiffStats = {
    max,
    mean: n ? sum / (n * 4) : 0,
    pct: n ? (100 * over) / n : 0,
    sizeMismatch: expected.width !== actual.width || expected.height !== actual.height,
  };

  const GAP = 4;
  const sheet = new PNG({ width: 3 * w + 2 * GAP, height: h });
  sheet.data.fill(0);
  const put = (panel: number, x: number, y: number, r: number, g: number, b: number) => {
    const o = (y * sheet.width + panel * (w + GAP) + x) * 4;
    sheet.data[o] = r;
    sheet.data[o + 1] = g;
    sheet.data[o + 2] = b;
    sheet.data[o + 3] = 255;
  };
  const BG = 40;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      for (const [panel, src] of [[0, e] as const, [1, a] as const]) {
        const k = src[i + 3] / 255;
        put(panel, x, y, src[i] * k + BG * (1 - k), src[i + 1] * k + BG * (1 - k), src[i + 2] * k + BG * (1 - k));
      }
      const lum = ((e[i] * 0.3 + e[i + 1] * 0.59 + e[i + 2] * 0.11) * e[i + 3]) / 255 / 4;
      const hot = Math.min(255, heat[y * w + x] * 8);
      put(2, x, y, Math.max(lum, hot), lum, lum);
    }
  }
  return { stats, sheet };
}

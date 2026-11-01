import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PathCmd } from '../../src/text/layout';
import { imageFit, traceImage, type TraceImage } from '../../src/text/trace';

/** ImageBitmap stand-in carrying its RGBA pixels for FakeCanvas. */
interface FakeImage {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
}

/** An image of `w` × `h` with alpha 255 where `inside(x, y)` (pixel index, image space, y down). */
function image(w: number, h: number, inside: (x: number, y: number) => boolean): TraceImage {
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (inside(x, y)) rgba[(y * w + x) * 4 + 3] = 255;
  const img: FakeImage = { width: w, height: h, rgba };
  return img as unknown as TraceImage;
}

/**
 * OffscreenCanvas stand-in: trace.ts draws the image at the sample size and reads its pixels back.
 * The tests trace at sample count = the image's long side, so the draw is 1:1.
 */
class FakeCanvas {
  readonly width: number;
  readonly height: number;
  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }
  getContext() {
    let src: FakeImage | null = null;
    const { width, height } = this;
    return {
      imageSmoothingEnabled: false,
      imageSmoothingQuality: 'low',
      drawImage(img: FakeImage, _x: number, _y: number, w: number, h: number) {
        if (w !== img.width || h !== img.height || w !== width || h !== height) throw new Error(`unexpected resample ${img.width}×${img.height} → ${w}×${h}`);
        src = img;
      },
      getImageData() {
        if (!src) throw new Error('getImageData before drawImage');
        return { data: src.rgba };
      },
    };
  }
}

beforeAll(() => vi.stubGlobal('OffscreenCanvas', FakeCanvas));
afterAll(() => vi.unstubAllGlobals());

type Pt = [number, number];

/** Closed contours of M / L / Z commands. */
function loops(cmds: PathCmd[]): Pt[][] {
  const out: Pt[][] = [];
  for (const c of cmds) {
    if (c.type === 'M') out.push([[c.x, c.y]]);
    else if (c.type === 'L') out.at(-1)!.push([c.x, c.y]);
    else expect(c.type).toBe('Z');
  }
  return out;
}

/** Shoelace area, positive counter-clockwise in y-up space. */
function area(p: Pt[]): number {
  let s = 0;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) s += p[j][0] * p[i][1] - p[i][0] * p[j][1];
  return s / 2;
}

function bounds(p: Pt[]) {
  const xs = p.map((q) => q[0]);
  const ys = p.map((q) => q[1]);
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
}

/** Sharpest turn between consecutive edges of a closed loop, in degrees. */
function maxTurn(p: Pt[]): number {
  let m = 0;
  for (let i = 0, n = p.length; i < n; i++) {
    const [a, b, c] = [p[(i + n - 1) % n], p[i], p[(i + 1) % n]];
    const t = Math.abs(Math.atan2(c[1] - b[1], c[0] - b[0]) - Math.atan2(b[1] - a[1], b[0] - a[0]));
    m = Math.max(m, Math.min(t, 2 * Math.PI - t));
  }
  return (m * 180) / Math.PI;
}

const sharp = { threshold: 128, smooth: 0, despeckle: 0 };
const inRect = (x: number, y: number, x0: number, y0: number, x1: number, y1: number) => x >= x0 && x < x1 && y >= y0 && y < y1;

describe('traceImage', () => {
  it('a centred square: one loop, y-up, centred, fitted to size', () => {
    // 12 × 12 square in a 20 × 20 image; size 20 → 1 layer px per image px.
    const ls = loops(traceImage(image(20, 20, (x, y) => inRect(x, y, 4, 4, 16, 16)), 20, sharp));
    expect(ls).toHaveLength(1);
    // The edge sits halfway between the last opaque and first clear pixel centre; marching squares bevels the corners.
    expect(Math.abs(area(ls[0]))).toBeGreaterThan(140);
    expect(Math.abs(area(ls[0]))).toBeLessThanOrEqual(144);
    const b = bounds(ls[0]);
    for (const v of [b.x0, b.y0]) expect(v).toBeCloseTo(-6, 1);
    for (const v of [b.x1, b.y1]) expect(v).toBeCloseTo(6, 1);
  });

  it('scales with size: the same image at twice the size has 4× the area', () => {
    const img = image(20, 20, (x, y) => inRect(x, y, 4, 4, 16, 16));
    const a10 = area(loops(traceImage(img, 10, sharp))[0]);
    const a20 = area(loops(traceImage(img, 20, sharp))[0]);
    expect(a20).toBeCloseTo(4 * a10, 6);
  });

  it('flips y: a blob at the top of the image is at +y, on the left at −x', () => {
    const [l] = loops(traceImage(image(20, 20, (x, y) => inRect(x, y, 0, 0, 4, 4)), 20, sharp));
    const b = bounds(l);
    expect(b.y0).toBeGreaterThan(0);
    expect(b.x1).toBeLessThan(0);
  });

  it('a ring: outer contour and a hole of opposite winding inside it', () => {
    const ring = (x: number, y: number) => inRect(x, y, 2, 2, 18, 18) && !inRect(x, y, 7, 7, 13, 13);
    const ls = loops(traceImage(image(20, 20, ring), 20, sharp));
    expect(ls).toHaveLength(2);
    const [outer, hole] = [...ls].sort((p, q) => Math.abs(area(q)) - Math.abs(area(p)));
    expect(Math.sign(area(hole))).toBe(-Math.sign(area(outer)));
    expect(Math.abs(area(outer))).toBeCloseTo(256, -1);
    expect(Math.abs(area(hole))).toBeCloseTo(36, -1);
    const bo = bounds(outer);
    const bh = bounds(hole);
    expect(bh.x0 > bo.x0 && bh.x1 < bo.x1 && bh.y0 > bo.y0 && bh.y1 < bo.y1).toBe(true);
  });

  /** Outer ring 1..23 with a hole 5..19 and an island 9..15 in the hole (24 × 24 image). */
  const nested = () => image(24, 24, (x, y) => (inRect(x, y, 1, 1, 23, 23) && !inRect(x, y, 5, 5, 19, 19)) || inRect(x, y, 9, 9, 15, 15));
  const signsBySize = (cmds: PathCmd[]) =>
    loops(cmds)
      .map(area)
      .sort((a, b) => Math.abs(b) - Math.abs(a))
      .map(Math.sign);

  it('nesting levels alternate winding: outer, hole, island in the hole', () => {
    const [s, ...rest] = signsBySize(traceImage(nested(), 24, sharp));
    expect(rest).toEqual([-s, s]);
  });

  it('documented orientation (trace.ts header): outers counter-clockwise, holes clockwise, islands in holes counter-clockwise', () => {
    expect(signsBySize(traceImage(nested(), 24, sharp))).toEqual([1, -1, 1]);
  });

  it('two separate squares: two loops of the same winding', () => {
    const ls = loops(traceImage(image(30, 10, (x, y) => inRect(x, y, 1, 2, 9, 8) || inRect(x, y, 20, 2, 28, 8)), 30, sharp));
    expect(ls).toHaveLength(2);
    expect(area(ls[0])).toBeCloseTo(area(ls[1]), 6);
    expect(Math.abs(area(ls[0]))).toBeCloseTo(48, -1);
    const xs = ls.map((l) => bounds(l).x0).sort((a, b) => a - b);
    expect(xs[0]).toBeLessThan(0);
    expect(xs[1]).toBeGreaterThan(0);
  });

  it('despeckle drops loops below the given % of size², holes included', () => {
    // 2 × 2 speck ≈ 4 / 400 = 1 % of size²; the 12 × 12 square ≈ 36 %, its 2 × 2 hole ≈ 1 %.
    const img = image(20, 20, (x, y) => inRect(x, y, 16, 16, 18, 18) || (inRect(x, y, 2, 2, 14, 14) && !inRect(x, y, 7, 7, 9, 9)));
    expect(loops(traceImage(img, 20, { ...sharp, despeckle: 0.2 }))).toHaveLength(3);
    const big = loops(traceImage(img, 20, { ...sharp, despeckle: 2 }));
    expect(big).toHaveLength(1);
    expect(Math.abs(area(big[0]))).toBeGreaterThan(100);
  });

  it('threshold picks the alpha level the edge goes through', () => {
    // Horizontal alpha ramp: the edge moves right as the threshold rises.
    const w = 20;
    const rgba = new Uint8ClampedArray(w * 4 * 4);
    for (let y = 1; y < 3; y++) for (let x = 1; x < w - 1; x++) rgba[(y * w + x) * 4 + 3] = Math.round((255 * x) / (w - 1));
    const img = { width: w, height: 4, rgba } as unknown as TraceImage;
    const leftEdge = (threshold: number) => bounds(loops(traceImage(img, w, { threshold, smooth: 0, despeckle: 0 }))[0]).x0;
    // Alpha ≥ threshold runs from the ramp position to the right end: a higher threshold starts further right.
    expect(leftEdge(64)).toBeLessThan(leftEdge(192) - 5);
  });

  it('smoothing rounds a disc’s pixel steps, keeping its orientation and area', () => {
    const disc = image(40, 40, (x, y) => (x + 0.5 - 20) ** 2 + (y + 0.5 - 20) ** 2 <= 15 ** 2);
    const raw = loops(traceImage(disc, 40, sharp));
    const smooth = loops(traceImage(disc, 40, { threshold: 128, smooth: 1, despeckle: 0 }));
    expect(raw).toHaveLength(1);
    expect(smooth).toHaveLength(1);
    expect(Math.sign(area(smooth[0]))).toBe(Math.sign(area(raw[0])));
    expect(Math.abs(area(smooth[0]))).toBeCloseTo(Math.PI * 15 ** 2, -1);
    expect(maxTurn(smooth[0])).toBeLessThan(maxTurn(raw[0]) - 5);
  });

  it('smoothing keeps the real corners of a square sharp', () => {
    const square = image(40, 40, (x, y) => inRect(x, y, 8, 8, 32, 32));
    const [l] = loops(traceImage(square, 40, { threshold: 128, smooth: 2, despeckle: 0 }));
    expect(maxTurn(l)).toBeGreaterThan(85);
    expect(Math.abs(area(l))).toBeGreaterThan(0.95 * 24 * 24);
  });

  it('an empty image or zero size traces nothing; results are memoized per (image, size, trace)', () => {
    expect(traceImage(image(10, 10, () => false), 10, sharp)).toEqual([]);
    const img = image(10, 10, (x, y) => inRect(x, y, 2, 2, 8, 8));
    expect(traceImage(img, 0, sharp)).toEqual([]);
    expect(traceImage(img, 10, sharp)).toBe(traceImage(img, 10, { ...sharp }));
  });
});

describe('imageFit', () => {
  it('fits the larger side to size', () => {
    expect(imageFit(image(40, 10, () => false), 100)).toEqual({ hw: 50, hh: 12.5 });
    expect(imageFit({ naturalWidth: 10, naturalHeight: 20, width: 0, height: 0 } as unknown as TraceImage, 100)).toEqual({ hw: 25, hh: 50 });
  });
});

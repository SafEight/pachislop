import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { boxGap, clusterIslands, cutParts, labelIslands, partsOf, WORK_MAX, type CutPart, type IslandMap, type PxBox } from '../../src/io/imageSplit';

/** Straight-alpha RGBA picture: the ImageData fields imageSplit reads. */
class Picture {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.data = new Uint8ClampedArray(width * height * 4);
  }
  /** Fill [x0, x1) × [y0, y1) with a colour derived from the position, at `alpha`. */
  rect(x0: number, y0: number, x1: number, y1: number, alpha = 255): this {
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const i = (y * this.width + x) * 4;
        this.data.set([x & 0xff, y & 0xff, (x * 7 + y) & 0xff, alpha], i);
      }
    return this;
  }
  get img(): ImageData {
    return this as unknown as ImageData;
  }
}

const box = (x0: number, y0: number, x1: number, y1: number): PxBox => ({ x0, y0, x1, y1 });
const ownerAt = (m: IslandMap, x: number, y: number) => m.owner[((y / m.cell) | 0) * m.cols + ((x / m.cell) | 0)];

describe('labelIslands', () => {
  it('labels separate blobs with exact half-open boxes, in scan order', () => {
    const m = labelIslands(new Picture(40, 20).rect(2, 3, 6, 8).rect(20, 1, 30, 4).img);
    expect(m.cell).toBe(1);
    expect(m.islands).toEqual([box(20, 1, 30, 4), box(2, 3, 6, 8)]);
  });

  it('is 8-connected: diagonal neighbours are one island', () => {
    const m = labelIslands(new Picture(10, 10).rect(2, 2, 3, 3).rect(3, 3, 4, 4).rect(4, 2, 5, 3).img);
    expect(m.islands).toEqual([box(2, 2, 5, 4)]);
  });

  it('a hole is not an island, and its pixels are owned by the ring', () => {
    const p = new Picture(20, 20).rect(2, 2, 18, 18);
    for (let y = 6; y < 14; y++) for (let x = 6; x < 14; x++) p.data[(y * 20 + x) * 4 + 3] = 0;
    const m = labelIslands(p.img);
    expect(m.islands).toEqual([box(2, 2, 18, 18)]);
    expect(ownerAt(m, 10, 10)).toBe(0);
  });

  it('pixels below the threshold make no island but belong to the nearest one', () => {
    const p = new Picture(30, 10).rect(0, 0, 4, 4).rect(26, 0, 30, 4).rect(5, 0, 6, 1, 7).rect(24, 6, 25, 7, 7);
    const m = labelIslands(p.img);
    expect(m.islands).toHaveLength(2);
    expect(ownerAt(m, 5, 0)).toBe(0);
    expect(ownerAt(m, 24, 6)).toBe(1);
    // The threshold is inclusive.
    expect(labelIslands(p.img, 7).islands).toHaveLength(4);
  });

  it('a picture with no island has every owner -1', () => {
    const m = labelIslands(new Picture(8, 8).rect(0, 0, 8, 8, 3).img);
    expect(m.islands).toEqual([]);
    expect(m.owner.every((o) => o === -1)).toBe(true);
  });

  it('large pictures label on a coarser grid; thin strokes survive and boxes stay inside the picture', () => {
    const W = WORK_MAX * 2 + 4; // cell = 3
    const m = labelIslands(new Picture(W, 6).rect(4000, 2, 4001, 3).rect(W - 1, 0, W, 1).img);
    expect(m.cell).toBe(3);
    expect(m.cols).toBe(Math.ceil(W / 3));
    // Both sit in cell row 0, so the scan meets the stroke first.
    expect(m.islands).toEqual([box(3999, 0, 4002, 3), box(W - 2, 0, W, 3)]);
  });
});

describe('clusterIslands', () => {
  /** Islands 10 px wide on one row; `gaps` are the px between consecutive ones. 200 px wide picture. */
  function row(gaps: number[]): IslandMap {
    const p = new Picture(200, 20);
    let x = 0;
    p.rect(x, 5, x + 10, 15);
    for (const g of gaps) {
      x += 10 + g;
      p.rect(x, 5, x + 10, 15);
    }
    return labelIslands(p.img);
  }

  it('merges islands within mergePct % of the long side, inclusive', () => {
    const m = row([6, 30]);
    // 3 % of 200 px = 6 px: the first gap merges, the second doesn't.
    expect(clusterIslands(m, 3).map((p) => p.islands)).toEqual([[0, 1], [2]]);
    expect(clusterIslands(m, 2.9).map((p) => p.islands)).toEqual([[0], [1], [2]]);
    expect(clusterIslands(m, 15).map((p) => p.islands)).toEqual([[0, 1, 2]]);
    expect(clusterIslands(m, 3)[0].box).toEqual(box(0, 5, 26, 15));
  });

  it('chains: A–B and B–C close join A and C even when A–C is far', () => {
    expect(clusterIslands(row([5, 5]), 2.5).map((p) => p.islands)).toEqual([[0, 1, 2]]);
  });

  it('gap is Euclidean between boxes, and 0 for touching / overlapping boxes', () => {
    expect(boxGap(box(0, 0, 10, 10), box(13, 14, 20, 20))).toBe(5);
    expect(boxGap(box(0, 0, 10, 10), box(10, 0, 20, 10))).toBe(0);
    expect(boxGap(box(0, 0, 10, 10), box(5, 5, 20, 20))).toBe(0);
    const p = new Picture(100, 100).rect(0, 0, 10, 10).rect(13, 14, 20, 20);
    const m = labelIslands(p.img);
    expect(clusterIslands(m, 5)).toHaveLength(1);
    expect(clusterIslands(m, 4.9)).toHaveLength(2);
  });

  it('a wide island sorted first still merges with a far-right neighbour it overlaps in x', () => {
    // Long bar on top, small blob below its right end: x0 sort puts the bar first; the blob's x0
    // is far right of the bar's x0 but within its span.
    const p = new Picture(200, 50).rect(0, 0, 190, 5).rect(180, 8, 185, 12).rect(5, 40, 10, 45);
    const parts = clusterIslands(labelIslands(p.img), 2);
    expect(parts.map((q) => q.box)).toEqual([box(0, 0, 190, 12), box(5, 40, 10, 45)]);
  });

  it('partsOf orders parts left to right then top to bottom and drops empty groups', () => {
    const m = labelIslands(new Picture(50, 50).rect(30, 0, 35, 5).rect(0, 30, 5, 35).rect(0, 10, 5, 15).img);
    const parts = partsOf(m, [[0], [], [2, 1]]);
    expect(parts.map((q) => q.islands)).toEqual([[1, 2], [0]]);
    const top = partsOf(m, [[1], [2]]);
    expect(top.map((q) => q.box.y0)).toEqual([10, 30]);
  });
});

describe('cutParts', () => {
  beforeAll(() => {
    vi.stubGlobal(
      'ImageData',
      class {
        readonly width: number;
        readonly height: number;
        readonly data: Uint8ClampedArray;
        constructor(width: number, height: number) {
          this.width = width;
          this.height = height;
          this.data = new Uint8ClampedArray(width * height * 4);
        }
      },
    );
  });
  afterAll(() => vi.unstubAllGlobals());

  /** Every non-transparent source pixel lands in exactly one part, unchanged, where it was. */
  function expectExactCover(p: Picture, cut: CutPart[]) {
    const seen = new Uint8Array(p.width * p.height);
    for (const { box: b, pixels } of cut) {
      expect(b.x0 % 64).toBe(0);
      expect(b.y0 % 64).toBe(0);
      expect((b.x1 - b.x0) % 64).toBe(p.width % 64);
      expect((b.y1 - b.y0) % 64).toBe(p.height % 64);
      expect(b.x1).toBeLessThanOrEqual(p.width);
      expect(b.y1).toBeLessThanOrEqual(p.height);
      expect([pixels.width, pixels.height]).toEqual([b.x1 - b.x0, b.y1 - b.y0]);
      for (let y = 0; y < pixels.height; y++)
        for (let x = 0; x < pixels.width; x++) {
          const d = (y * pixels.width + x) * 4;
          if (pixels.data[d + 3] === 0) continue;
          const s = ((y + b.y0) * p.width + x + b.x0) * 4;
          expect([...pixels.data.subarray(d, d + 4)]).toEqual([...p.data.subarray(s, s + 4)]);
          seen[(y + b.y0) * p.width + x + b.x0]++;
        }
    }
    for (let i = 0; i < seen.length; i++) expect(seen[i], `pixel ${i % p.width},${(i / p.width) | 0}`).toBe(p.data[i * 4 + 3] ? 1 : 0);
  }

  it('cuts each part with its own and its faint pixels, nothing of the other parts, even inside its box', () => {
    // An L-shape whose box contains a separate small blob (another part), plus faint specks.
    const p = new Picture(300, 130)
      .rect(10, 10, 20, 120)
      .rect(10, 110, 200, 120)
      .rect(60, 40, 70, 50)
      .rect(250, 20, 290, 60)
      .rect(22, 60, 23, 61, 3)
      .rect(240, 62, 241, 63, 5);
    const m = labelIslands(p.img);
    // Islands in scan order: 0 the L, 1 the right blob, 2 the blob inside the L's box.
    expect(m.islands).toEqual([box(10, 10, 200, 120), box(250, 20, 290, 60), box(60, 40, 70, 50)]);
    const parts = partsOf(m, [[0], [1], [2]]);
    const cut = cutParts(p.img, m, parts);
    expect(cut).toHaveLength(3);
    expectExactCover(p, cut);
  });

  it('works on the coarse grid of a large picture and drops parts with no visible pixel', () => {
    const p = new Picture(WORK_MAX + 300, 70).rect(5, 5, 400, 9).rect(1000, 30, 1003, 33).rect(2300, 60, 2340, 70);
    const m = labelIslands(p.img);
    expect(m.cell).toBe(2);
    const cut = cutParts(p.img, m, clusterIslands(m, 0));
    expect(cut).toHaveLength(3);
    expectExactCover(p, cut);
    // A part made of no island has no visible pixel: dropped, the others unaffected.
    const withEmpty = cutParts(p.img, m, [{ islands: [], box: box(0, 0, 1, 1) }, ...clusterIslands(m, 0)]);
    expect(withEmpty.map((c) => c.box)).toEqual(cut.map((c) => c.box));
  });
});

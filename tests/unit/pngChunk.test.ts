import { crc32 as zlibCrc32, deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { adler32, adler32Combine, writeChunk } from '../../src/io/pngChunk';

/** Deterministic bytes (xorshift32) so a failure reproduces. */
function bytes(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n);
  let s = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    out[i] = s & 0xff;
  }
  return out;
}

/** Adler-32 straight from RFC 1950: modulo after every byte. */
function referenceAdler(data: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (const x of data) {
    a = (a + x) % 65521;
    b = (b + a) % 65521;
  }
  return b * 65536 + a;
}

/** The Adler-32 trailer zlib writes after a deflate stream of `data`. */
const zlibAdler = (data: Uint8Array): number => {
  const z = deflateSync(data);
  return new DataView(z.buffer, z.byteOffset, z.byteLength).getUint32(z.byteLength - 4);
};

const concat = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
};

/** A chunk of `type` with `data`, written by writeChunk into a buffer with `at` bytes in front. */
function chunk(type: string, data: Uint8Array, at = 0): { png: Uint8Array; end: number } {
  const png = new Uint8Array(at + 12 + data.length + 5).fill(0xee);
  const end = writeChunk(png, at, type, data.length, (o) => png.set(data, o));
  return { png, end };
}

describe('adler32', () => {
  it('is 1 for no bytes and matches the RFC 1950 example ("Wikipedia")', () => {
    expect(adler32(new Uint8Array(0), 1)).toBe(1);
    expect(adler32(new TextEncoder().encode('Wikipedia'), 1)).toBe(0x11e60398);
  });

  it('matches a per-byte-modulo reference and zlib on long runs of 0xff (reduction boundaries)', () => {
    for (const n of [3799, 3800, 3801, 7600, 5552, 65521, 200_000]) {
      const data = new Uint8Array(n).fill(0xff);
      const got = adler32(data, 1);
      expect(got, `n=${n}`).toBe(referenceAdler(data));
      expect(got, `n=${n}`).toBe(zlibAdler(data));
    }
  });

  it('matches the reference on random data of many lengths', () => {
    for (const n of [1, 2, 17, 255, 3800, 10_001, 123_457]) {
      const data = bytes(n, n * 7919);
      expect(adler32(data, 1), `n=${n}`).toBe(referenceAdler(data));
    }
  });

  it('continues a running checksum: adler(A then B) = adler(B, adler(A))', () => {
    const a = bytes(9000, 3);
    const b = bytes(12_345, 4);
    expect(adler32(b, adler32(a, 1))).toBe(referenceAdler(concat(a, b)));
  });
});

describe('adler32Combine', () => {
  it('combine(adler(A), adler(B), |B|) = adler(A + B) for random splits', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const all = bytes(1 + ((seed * 104_729) % 90_000), seed);
      const cut = (seed * 7_777) % all.length;
      const a = all.subarray(0, cut);
      const b = all.subarray(cut);
      expect(adler32Combine(adler32(a, 1), adler32(b, 1), b.length), `seed=${seed} cut=${cut}`).toBe(referenceAdler(all));
    }
  });

  it('handles an empty side and |B| at and above the modulus', () => {
    const a = bytes(1000, 11);
    expect(adler32Combine(adler32(a, 1), 1, 0)).toBe(adler32(a, 1));
    expect(adler32Combine(1, adler32(a, 1), a.length)).toBe(adler32(a, 1));
    for (const n of [65520, 65521, 65522, 131_042, 200_003]) {
      const b = new Uint8Array(n).fill(0xff);
      expect(adler32Combine(adler32(a, 1), adler32(b, 1), n), `n=${n}`).toBe(referenceAdler(concat(a, b)));
    }
  });

  it('folds many strips like the PNG worker does (= zlib over the whole)', () => {
    const all = bytes(250_000, 99);
    let acc = 1;
    for (let o = 0; o < all.length; o += 17_000) {
      const strip = all.subarray(o, o + 17_000);
      acc = adler32Combine(acc, adler32(strip, 1), strip.length);
    }
    expect(acc).toBe(zlibAdler(all));
  });
});

describe('writeChunk', () => {
  it('writes length, type, data and the known CRC of an empty IEND chunk', () => {
    const { png, end } = chunk('IEND', new Uint8Array(0));
    expect(end).toBe(12);
    expect([...png.subarray(0, 12)]).toEqual([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
  });

  it('CRC covers type + data (not length) and matches node:zlib crc32, at any offset', () => {
    for (const [n, at] of [
      [1, 0],
      [13, 8],
      [4096, 33],
      [70_000, 5],
    ]) {
      const data = bytes(n, n + at);
      const { png, end } = chunk('IDAT', data, at);
      const view = new DataView(png.buffer);
      expect(end).toBe(at + 12 + n);
      expect(view.getUint32(at)).toBe(n);
      expect(png.subarray(at + 8, at + 8 + n)).toEqual(data);
      expect(view.getUint32(at + 8 + n)).toBe(zlibCrc32(png.subarray(at + 4, at + 8 + n)));
      // Bytes before and after the chunk are untouched.
      expect(png.subarray(0, at).every((x) => x === 0xee)).toBe(true);
      expect(png.subarray(end).every((x) => x === 0xee)).toBe(true);
    }
  });

  it('writes into a subarray view without touching the bytes around the view', () => {
    const backing = new Uint8Array(64).fill(0xee);
    const view = backing.subarray(10, 10 + 12 + 3);
    writeChunk(view, 0, 'tEXt', 3, (o) => view.set([1, 2, 3], o));
    expect(backing.subarray(0, 10).every((x) => x === 0xee)).toBe(true);
    expect(backing.subarray(25).every((x) => x === 0xee)).toBe(true);
    expect(new DataView(backing.buffer).getUint32(10)).toBe(3);
    expect(new DataView(backing.buffer).getUint32(10 + 11)).toBe(zlibCrc32(backing.subarray(14, 21)));
  });
});

// PNG chunk and zlib checksum helpers shared by the PNG encoder worker (pngWorker.ts), which
// writes the IDAT chunks, and `pngBytes` (export.ts), which writes the other chunks around them.

/** CRC-32 (PNG / zlib polynomial) lookup table. */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Writes a PNG chunk at `at` in `png`: length, `type`, the `length` data bytes that `fill` puts
 * at the offset it is given, and the CRC over type + data. Returns the offset after the chunk.
 */
export function writeChunk(png: Uint8Array, at: number, type: string, length: number, fill: (o: number) => void): number {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  view.setUint32(at, length);
  for (let i = 0; i < 4; i++) png[at + 4 + i] = type.charCodeAt(i);
  fill(at + 8);
  view.setUint32(at + 8 + length, crc32(png.subarray(at + 4, at + 8 + length)));
  return at + 12 + length;
}

const ADLER_BASE = 65521;
/**
 * Bytes summed between reductions: keeps the second sum below 2^31 (from at most BASE − 1,
 * adding at most 255 per byte), so it stays a small integer in the JIT.
 */
const ADLER_RUN = 3800;

/** Adler-32 of `bytes` continued from `adler` (1 for a fresh checksum). */
export function adler32(bytes: Uint8Array, adler: number): number {
  let a = adler & 0xffff;
  let b = adler >>> 16;
  for (let i = 0; i < bytes.length; ) {
    const end = Math.min(bytes.length, i + ADLER_RUN);
    for (; i < end; i++) {
      a += bytes[i];
      b += a;
    }
    a %= ADLER_BASE;
    b %= ADLER_BASE;
  }
  return ((b << 16) | a) >>> 0;
}

/** Adler-32 of A followed by B, from `adlerA`, `adlerB` and B's length (zlib's `adler32_combine`). */
export function adler32Combine(adlerA: number, adlerB: number, lengthB: number): number {
  const rem = lengthB % ADLER_BASE;
  let a = adlerA & 0xffff;
  let b = (rem * a) % ADLER_BASE;
  a += (adlerB & 0xffff) + ADLER_BASE - 1;
  b += (adlerA >>> 16) + (adlerB >>> 16) + ADLER_BASE - rem;
  if (a >= ADLER_BASE) a -= ADLER_BASE;
  if (a >= ADLER_BASE) a -= ADLER_BASE;
  if (b >= 2 * ADLER_BASE) b -= 2 * ADLER_BASE;
  if (b >= ADLER_BASE) b -= ADLER_BASE;
  return ((b << 16) | a) >>> 0;
}

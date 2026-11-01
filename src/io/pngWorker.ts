// PNG encoder worker for `pngBytes` (export.ts): straight-alpha sRGB RGBA rows in (8 or 16 bits
// per channel), IDAT chunk out, so deflate never blocks the UI and batch exports encode on several
// cores. Encoded directly rather than through a canvas: canvases premultiply, which crushes the
// colour of low-alpha pixels (3D haze, glow tails) to a few levels, and hold 8 bits only.
//
// A large image is split into row bands that workers deflate in parallel (pigz-style): Sub
// filtering only looks within a row, so bands are independent, and their raw deflate streams are
// joined into the image's one zlib stream. Every band but the last must then end without
// finishing the stream: its last block is made non-final and followed by an empty stored block,
// which ends it on a byte boundary like a zlib sync flush. `pngBytes` combines the bands'
// Adler-32s and writes the stream's trailer.

import { adler32, writeChunk } from './pngChunk';

/** Another band's rows, sent by the top band's worker over `port`. */
export interface PngShare {
  port: MessagePort;
  /** First row. */
  y: number;
  /** Rows. */
  h: number;
}

/** RGBA samples: 8-bit bytes, or 16-bit values (host order; PNG stores them big-endian). */
export type PngPixels = Uint8ClampedArray<ArrayBuffer> | Uint16Array<ArrayBuffer>;

export interface PngRequest {
  /** Image width in px. */
  w: number;
  /** Rows in this band. */
  h: number;
  /**
   * The band's straight-alpha sRGB RGBA, `w × h × 4` samples from its first one on, top row
   * first. The top band gets the whole image (transferred) and copies the other bands' rows out
   * to them (`share`): they get a port their rows arrive on.
   */
  data: PngPixels | MessagePort;
  /** Top band only: the other bands, whose rows it sends them. */
  share: PngShare[];
  /** Top band: its IDAT data starts with the zlib header. */
  first: boolean;
  /** Bottom band: its deflate data ends the stream. A band that is also `first` ends its IDAT with the stream's Adler-32. */
  last: boolean;
}

/**
 * `ready` once the worker has loaded; then per request, one IDAT chunk (length, type, data, CRC)
 * and the Adler-32 of the band's filtered bytes.
 */
export type PngReply = { ready: true } | { idat: Uint8Array<ArrayBuffer>; adler: number } | { error: string };

/**
 * Filtered bytes written to the compressor per block (at least one row). Large enough that the
 * per-write stream overhead vanishes, small enough that no second band-sized buffer is held.
 */
const BLOCK_BYTES = 1 << 20;

/** zlib header: deflate with a 32 KiB window, default level (what `CompressionStream` uses). */
const ZLIB_HEADER = [0x78, 0x9c];

/**
 * The raw deflate stream of the band's scanlines, every row Sub-filtered, and their Adler-32.
 * Measured on this app's renders (flat plates, dithered gradients, 3D metal): Sub deflates 4–9 %
 * smaller than libpng's per-row minimum-sum-of-absolute-differences choice, None or Paeth, and
 * is the cheapest filter. Fully transparent pixels become 0,0,0,0 first: their colour is
 * invisible, and the zeros deflate better. 16-bit samples are written big-endian, so a pixel is
 * two words and Sub subtracts the bytes 8 back.
 *
 * Deflate is the browser's native zlib (`CompressionStream`, level 6), not fflate, although
 * fflate's streaming `Deflate.flush(true)` could end a band without finishing the stream. Per
 * core on a 2× export (13 MB filtered), native took 0.95 s for 2.14 MB; fflate took 0.86–1.06 s
 * at levels 1–3 for 2.49–2.91 MB, 1.2 s at levels 4–5 for 2.39–2.43 MB, 2.4 s at level 6 for
 * 2.26 MB. On a 12 MB band of a 4× export, native took 0.78 s for 1.26 MB, fflate 0.72–0.77 s at
 * levels 1–3 for 1.54–2.02 MB. Native's finished stream costs `finalBlock`'s scan: 60 ms there.
 */
async function deflateBand(data: PngPixels, w: number, h: number): Promise<{ chunks: Uint8Array[]; adler: number }> {
  const wide = data instanceof Uint16Array;
  // Little-endian RGBA read as u32: 8-bit, alpha is the top byte, so alpha 0 ⇔ value < 2^24;
  // 16-bit, a pixel is (R | G << 16, B | A << 16), so alpha 0 ⇔ second word < 2^16.
  const perPx = wide ? 2 : 1;
  const words = new Uint32Array(data.buffer, data.byteOffset, w * h * perPx);
  const stride = w * 4 * perPx;
  const rows = Math.max(1, Math.floor(BLOCK_BYTES / (stride + 1)));
  // One filtered row, aligned for whole-pixel writes; copied in after its filter-type byte.
  const filtered = new Uint32Array(w * perPx);
  const filteredBytes = new Uint8Array(filtered.buffer);
  const raw = new CompressionStream('deflate-raw');
  const chunks: Uint8Array[] = [];
  let adler = 1;
  const read = async () => {
    const reader = raw.readable.getReader();
    for (let r = await reader.read(); !r.done; r = await reader.read()) chunks.push(r.value);
  };
  const write = async () => {
    const writer = raw.writable.getWriter();
    for (let y0 = 0; y0 < h; y0 += rows) {
      const y1 = Math.min(h, y0 + rows);
      // A fresh block per write: the stream keeps queued chunks by reference.
      const block = new Uint8Array((y1 - y0) * (stride + 1));
      for (let y = y0; y < y1; y++) {
        // Sub on four bytes at once: per byte, (a | 0x80) − (b & 0x7F) never borrows from the
        // next byte, and xoring back the top bits of a ^ ~b fixes each byte's top bit.
        if (wide) {
          let left0 = 0;
          let left1 = 0;
          for (let x = 0, i = y * w * 2; x < 2 * w; x += 2, i += 2) {
            const clear = words[i + 1] < 0x10000;
            // Byte-swapped within each 16-bit sample: big-endian.
            const a0 = clear ? 0 : ((words[i] & 0x00ff00ff) << 8) | ((words[i] >>> 8) & 0x00ff00ff);
            const a1 = clear ? 0 : ((words[i + 1] & 0x00ff00ff) << 8) | ((words[i + 1] >>> 8) & 0x00ff00ff);
            filtered[x] = (((a0 | 0x80808080) >>> 0) - (left0 & 0x7f7f7f7f)) ^ ((a0 ^ ~left0) & 0x80808080);
            filtered[x + 1] = (((a1 | 0x80808080) >>> 0) - (left1 & 0x7f7f7f7f)) ^ ((a1 ^ ~left1) & 0x80808080);
            left0 = a0;
            left1 = a1;
          }
        } else {
          let left = 0;
          for (let x = 0, i = y * w; x < w; x++, i++) {
            const a = words[i] < 0x1000000 ? 0 : words[i];
            filtered[x] = (((a | 0x80808080) >>> 0) - (left & 0x7f7f7f7f)) ^ ((a ^ ~left) & 0x80808080);
            left = a;
          }
        }
        const o = (y - y0) * (stride + 1);
        block[o] = 1;
        block.set(filteredBytes, o + 1);
      }
      adler = adler32(block, adler);
      await writer.write(block);
    }
    await writer.close();
  };
  await Promise.all([read(), write()]);
  return { chunks, adler };
}

/** Extra bits of length symbols 257…287. */
const LENGTH_EXTRA = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0, 0, 0]);
/** Extra bits of distance symbols 0…31. */
const DISTANCE_EXTRA = new Uint8Array([0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13, 0, 0]);
/** Order of the code-length code lengths in a dynamic block header. */
const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/** Huffman decoding table: indexed by the next `bits` stream bits, entries are `symbol << 4 | code length`. */
interface Huffman {
  table: Uint16Array;
  bits: number;
}

/** Decoding table of the canonical Huffman code with code lengths `lengths` (0 = unused symbol). */
function huffman(lengths: Uint8Array): Huffman {
  const count = new Uint16Array(16);
  for (const l of lengths) count[l]++;
  count[0] = 0;
  let bits = 0;
  for (let l = 1; l < 16; l++) if (count[l]) bits = l;
  const next = new Uint16Array(16);
  for (let l = 1, code = 0; l < 16; l++) next[l] = code = (code + count[l - 1]) << 1;
  const table = new Uint16Array(1 << bits);
  for (let s = 0; s < lengths.length; s++) {
    const l = lengths[s];
    if (!l) continue;
    // Codes are stored most significant bit first, the stream is read least significant first.
    let reversed = 0;
    for (let k = 0, c = next[l]++; k < l; k++, c >>= 1) reversed = (reversed << 1) | (c & 1);
    for (let j = reversed; j < table.length; j += 1 << l) table[j] = (s << 4) | l;
  }
  return { table, bits };
}

const FIXED_LITERALS = huffman(new Uint8Array(288).fill(8, 0, 144).fill(9, 144, 256).fill(7, 256, 280).fill(8, 280, 288));
const FIXED_DISTANCES = huffman(new Uint8Array(30).fill(5));

/**
 * Bit offsets of the final block's header and of the end of the raw deflate stream in
 * `stream[0, length)`, found by decoding every block's symbols (no output is produced). `stream`
 * must hold at least 4 zero bytes after `length`: the bit reader fetches ahead.
 */
function finalBlock(stream: Uint8Array, length: number): { header: number; end: number } {
  let i = 0;
  let bits = 0;
  let count = 0;
  const limit = length + 4;
  const corrupt = () => new Error('unreadable deflate stream');
  /** Tops up `bits` to at least 24 valid bits. */
  const refill = () => {
    for (; count < 24; count += 8) {
      if (i === limit) throw corrupt();
      bits |= stream[i++] << count;
    }
  };
  const take = (n: number) => {
    refill();
    const v = bits & ((1 << n) - 1);
    bits >>>= n;
    count -= n;
    return v;
  };
  const decode = ({ table, bits: n }: Huffman) => {
    refill();
    const e = table[bits & ((1 << n) - 1)];
    const l = e & 15;
    if (!l) throw corrupt();
    bits >>>= l;
    count -= l;
    return e >> 4;
  };
  for (;;) {
    const header = i * 8 - count;
    const final = take(1);
    const type = take(2);
    if (type === 0) {
      // Stored: skip to the byte boundary, then LEN, NLEN and LEN bytes.
      const at = i - (count >> 3);
      i = at + 4 + (stream[at] | (stream[at + 1] << 8));
      bits = count = 0;
      if (i > length) throw corrupt();
    } else {
      let literals = FIXED_LITERALS;
      let distances = FIXED_DISTANCES;
      if (type === 2) {
        const nLiterals = take(5) + 257;
        const nDistances = take(5) + 1;
        const nCodeLengths = take(4) + 4;
        const codeLengthLengths = new Uint8Array(19);
        for (let k = 0; k < nCodeLengths; k++) codeLengthLengths[CODE_LENGTH_ORDER[k]] = take(3);
        const codeLengths = huffman(codeLengthLengths);
        const lengths = new Uint8Array(nLiterals + nDistances);
        for (let k = 0; k < lengths.length; ) {
          const s = decode(codeLengths);
          if (s < 16) lengths[k++] = s;
          else if (s === 16) lengths.fill(lengths[k - 1], k, (k += 3 + take(2)));
          else k += s === 17 ? 3 + take(3) : 11 + take(7);
        }
        literals = huffman(lengths.subarray(0, nLiterals));
        distances = huffman(lengths.subarray(nLiterals));
      } else if (type !== 1) throw corrupt();
      for (;;) {
        const s = decode(literals);
        if (s < 256) continue;
        if (s === 256) break;
        take(LENGTH_EXTRA[s - 257]);
        take(DISTANCE_EXTRA[decode(distances)]);
      }
    }
    if (final) return { header, end: i * 8 - count };
  }
}

/** The band's IDAT chunk: zlib header (first band), deflate data, then the empty stored block (not last) or the Adler-32 (sole band). */
async function encode({ w, h, data, share, first, last }: PngRequest): Promise<{ idat: Uint8Array<ArrayBuffer>; adler: number }> {
  let pixels: PngPixels;
  if (data instanceof MessagePort) {
    pixels = await new Promise((resolve) => {
      data.onmessage = (e: MessageEvent<PngPixels>) => {
        data.close();
        resolve(e.data);
      };
    });
  } else {
    pixels = data;
    // Copied here rather than on the main thread, where a 4× export's 60+ MB of copies stall the UI.
    for (const s of share) {
      const rows = data.slice(s.y * w * 4, (s.y + s.h) * w * 4);
      s.port.postMessage(rows, [rows.buffer]);
      s.port.close();
    }
  }
  const { chunks, adler } = await deflateBand(pixels, w, h);
  const head = first ? ZLIB_HEADER.length : 0;
  const length = chunks.reduce((n, c) => n + c.length, 0);
  // 12 chunk bytes around the data; the 5 spare bytes take the tail and are `finalBlock`'s read-ahead.
  const chunk = new Uint8Array(12 + head + length + 5);
  const at = 8 + head;
  let o = at;
  for (const c of chunks) {
    chunk.set(c, o);
    o += c.length;
  }
  const stream = chunk.subarray(at);
  let tail: number[] = [];
  if (!last) {
    const { header, end } = finalBlock(stream, length);
    if (Math.ceil(end / 8) !== length) throw new Error('unexpected data after the deflate stream');
    stream[header >> 3] &= ~(1 << (header & 7));
    // After the last block: an empty stored block with BFINAL 0. Its 3 header bits (all 0) go in
    // the zero padding of the last byte when they fit, else in a new 0 byte, whose remaining bits
    // pad to the byte boundary; then LEN 0 and NLEN 0xFFFF.
    const padding = (8 - (end & 7)) & 7;
    if (padding) stream[length - 1] &= 0xff >> padding;
    tail = padding >= 3 ? [0, 0, 0xff, 0xff] : [0, 0, 0, 0xff, 0xff];
  } else if (first) tail = [adler >>> 24, (adler >>> 16) & 0xff, (adler >>> 8) & 0xff, adler & 0xff];
  const size = head + length + tail.length;
  const chunkEnd = writeChunk(chunk, 0, 'IDAT', size, (d) => {
    chunk.set(ZLIB_HEADER.slice(0, head), d);
    chunk.set(tail, d + head + length);
  });
  return { idat: chunk.subarray(0, chunkEnd), adler };
}

// The pool (export.ts) sends a worker its next job only after this reply, so encodes never overlap.
self.onmessage = async (e: MessageEvent<PngRequest>) => {
  let reply: PngReply;
  try {
    reply = await encode(e.data);
  } catch (err) {
    reply = { error: err instanceof Error ? err.message : String(err) };
  }
  self.postMessage(reply, { transfer: 'idat' in reply ? [reply.idat.buffer] : [] });
};

self.postMessage({ ready: true } satisfies PngReply);

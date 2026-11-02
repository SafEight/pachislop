import * as THREE from 'three';
import type { PassKit } from './passkit';
import { outputMaterial } from './shaders';

/** Straight-alpha sRGB RGBA at 16 bits per channel (0..65535), top row first: a 16-bit export render. */
export interface ImageData16 {
  readonly width: number;
  readonly height: number;
  readonly data: Uint16Array<ArrayBuffer>;
}

/** Floats per strip of the 16-bit export readback (16 MB), so a large export never holds a whole float copy. */
const READBACK_FLOATS = 1 << 22;

/** Which kept 8-bit readback target a readback goes through. */
export type ReadbackUse = 'export' | 'thumb' | 'backdrop' | 'part' | 'overview';

/** A composite (premultiplied linear) to the canvas, or read back as straight-alpha sRGB at 8 bits (dithered) or 16 bits. */
export class Readback {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly kit: PassKit;
  private readonly outputMat: THREE.ShaderMaterial;
  /** 8-bit readback targets per use, each kept at its last size. */
  private readonly outRTs: Partial<Record<ReadbackUse, THREE.WebGLRenderTarget>> = {};

  /** `kit`: the preview's pool, whose renderer draws the output pass. */
  constructor(kit: PassKit) {
    this.kit = kit;
    this.renderer = kit.renderer;
    this.outputMat = outputMaterial(kit);
  }

  /** `src` (premultiplied linear) to the canvas as premultiplied sRGB. */
  toCanvas(src: THREE.Texture) {
    this.outputMat.uniforms.tSrc.value = src;
    this.outputMat.uniforms.uUnpremultiply.value = false;
    this.kit.run(this.outputMat, null);
  }

  /** `src` (premultiplied linear) as straight-alpha sRGB 8 bits in the `use` target (`w`×`h`, kept at its last size). */
  toBytes(src: THREE.Texture, w: number, h: number, use: ReadbackUse): THREE.WebGLRenderTarget {
    let rt = this.outRTs[use];
    if (!rt || rt.width !== w || rt.height !== h) {
      rt?.dispose();
      rt = this.outRTs[use] = new THREE.WebGLRenderTarget(w, h, { type: THREE.UnsignedByteType, depthBuffer: false });
    }
    this.outputMat.uniforms.tSrc.value = src;
    this.outputMat.uniforms.uUnpremultiply.value = true;
    this.outputMat.uniforms.uDither.value = true;
    this.kit.run(this.outputMat, rt);
    return rt;
  }

  /** `src` (premultiplied linear) as straight-alpha sRGB 8-bit pixels, top row first, read through the `use` target. */
  readImage(src: THREE.Texture, w: number, h: number, use: ReadbackUse): ImageData {
    const rt = this.toBytes(src, w, h, use);
    const buf = new Uint8Array(w * h * 4);
    this.renderer.readRenderTargetPixels(rt, 0, 0, w, h, buf);
    const out = new ImageData(w, h);
    const row = w * 4;
    for (let y = 0; y < h; y++) out.data.set(buf.subarray((h - 1 - y) * row, (h - y) * row), y * row);
    return out;
  }

  /**
   * `tex` (premultiplied linear, `w`×`h`) un-premultiplied and sRGB-encoded in float, undithered,
   * read back in row strips and rounded to 0..65535, top row first.
   */
  readImage16(tex: THREE.Texture, w: number, h: number): ImageData16 {
    // Not kept like the 8-bit targets: at 16 bytes per px a large export's would hold hundreds of MB.
    const rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.FloatType, depthBuffer: false });
    this.outputMat.uniforms.tSrc.value = tex;
    this.outputMat.uniforms.uUnpremultiply.value = true;
    this.outputMat.uniforms.uDither.value = false;
    this.kit.run(this.outputMat, rt);
    const row = w * 4;
    const data = new Uint16Array(row * h);
    const rows = Math.max(1, Math.min(h, Math.floor(READBACK_FLOATS / row)));
    const strip = new Float32Array(rows * row);
    try {
      for (let y0 = 0; y0 < h; y0 += rows) {
        const n = Math.min(rows, h - y0);
        this.renderer.readRenderTargetPixels(rt, 0, y0, w, n, n === rows ? strip : strip.subarray(0, n * row));
        // GL rows run bottom-up; the shader output is already within 0..1.
        for (let r = 0; r < n; r++) {
          const src = r * row;
          const dst = (h - 1 - y0 - r) * row;
          for (let i = 0; i < row; i++) data[dst + i] = Math.round(strip[src + i] * 65535);
        }
      }
    } finally {
      rt.dispose();
    }
    return { width: w, height: h, data };
  }

  dispose() {
    for (const rt of Object.values(this.outRTs)) rt.dispose();
  }
}

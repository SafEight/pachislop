import * as THREE from 'three';
import type { ReflectionMap2D } from '../../model/types';

// Reflection panoramas for the 2D reflection map (Material2D.reflection; Eye Candy Bevel's
// 反射イメージ): photographic equirectangular maps in public/reflections (Poly Haven CC0 HDRIs,
// tone-mapped, 1024 × 512; see THIRD_PARTY_NOTICES.md), sampled raw as sRGB values. Row 0 is the
// zenith, the horizon runs across the middle, and the centre column is where a flat face's mirrored
// view ray points. Each map loads on first use (renders skip the reflection until it is ready and
// re-render on onReflectionReady); blurred copies are cached per (map, blur).

const W = 1024;
const H = 512;

const pixels = new Map<ReflectionMap2D, Float32Array>();
const loading = new Map<ReflectionMap2D, Promise<void>>();
const listeners = new Set<() => void>();

export function onReflectionReady(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Start (or join) loading `map`; resolves once its pixels are available (or failed to load). */
export function loadReflectionMap(map: ReflectionMap2D): Promise<void> {
  if (pixels.has(map)) return Promise.resolve();
  let p = loading.get(map);
  if (p) return p;
  p = fetch(`${import.meta.env.BASE_URL}reflections/${map}.jpg`)
    .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then((blob) => createImageBitmap(blob))
    .then((bmp) => {
      const ctx = new OffscreenCanvas(W, H).getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(bmp, 0, 0, W, H);
      bmp.close();
      const rgba = ctx.getImageData(0, 0, W, H).data;
      const px = new Float32Array(W * H * 3);
      for (let i = 0; i < W * H; i++) for (let c = 0; c < 3; c++) px[i * 3 + c] = rgba[i * 4 + c] / 255;
      pixels.set(map, px);
      listeners.forEach((l) => l());
    })
    .catch((err: unknown) => console.warn(`Reflection map ${map} could not be loaded`, err))
    .finally(() => loading.delete(map));
  loading.set(map, p);
  return p;
}

/** One box-blur pass of radius r along rows (wrapping: the panorama is periodic) or columns (clamped). */
function boxPass(src: Float32Array, dst: Float32Array, r: number, horizontal: boolean) {
  const n = horizontal ? W : H;
  const lines = horizontal ? H : W;
  const k = 1 / (2 * r + 1);
  const at = (line: number, i: number) => {
    const j = horizontal ? ((i % W) + W) % W : Math.min(H - 1, Math.max(0, i));
    return (horizontal ? line * W + j : j * W + line) * 3;
  };
  for (let line = 0; line < lines; line++) {
    for (let ch = 0; ch < 3; ch++) {
      let s = 0;
      for (let i = -r; i <= r; i++) s += src[at(line, i) + ch];
      for (let i = 0; i < n; i++) {
        dst[at(line, i) + ch] = s * k;
        s += src[at(line, i + r + 1) + ch] - src[at(line, i - r) + ch];
      }
    }
  }
}

/** Gaussian-like blur (three box passes each way), sigma in px. */
function blurred(src: Float32Array, sigma: number): Float32Array {
  const r = Math.round((Math.sqrt(4 * sigma * sigma + 1) - 1) / 2);
  if (r < 1) return src;
  let a = src.slice();
  let b = new Float32Array(a.length);
  for (const horizontal of [true, false]) {
    for (let i = 0; i < 3; i++) {
      boxPass(a, b, r, horizontal);
      [a, b] = [b, a];
    }
  }
  return a;
}

const texCache = new Map<string, THREE.DataTexture>();

/** Sigma of Eye Candy's blur 100, as a fraction of the panorama width (360°). */
const MAX_BLUR = 0.04;

/**
 * RGBA8 panorama texture of `map` blurred by `blur` (0..100), wrapping horizontally; null while
 * the map is still loading (loading starts here).
 */
export function reflectionTexture(map: ReflectionMap2D, blur: number): THREE.DataTexture | null {
  const src = pixels.get(map);
  if (!src) {
    void loadReflectionMap(map);
    return null;
  }
  const b = Math.round(Math.min(100, Math.max(0, blur)));
  const key = `${map}|${b}`;
  let tex = texCache.get(key);
  if (tex) return tex;
  const px = blurred(src, (b / 100) * MAX_BLUR * W);
  const data = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    for (let c = 0; c < 3; c++) data[i * 4 + c] = Math.round(Math.min(1, Math.max(0, px[i * 3 + c])) * 255);
    data[i * 4 + 3] = 255;
  }
  tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
  tex.colorSpace = THREE.NoColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  if (texCache.size > 16) {
    for (const t of texCache.values()) t.dispose();
    texCache.clear();
  }
  texCache.set(key, tex);
  return tex;
}

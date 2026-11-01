import * as THREE from 'three';
import { getAsset } from '../../assets/registry';

// Decoded image assets shared by image title sources (Canvas2D masks), image fills and custom
// patterns (GPU textures, 2D and 3D). Decoding is asynchronous: callers draw what they can and
// re-render when onImageReady fires.

const bitmaps = new Map<string, ImageBitmap>();
const decoding = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
const textures = new Map<string, THREE.Texture>();

export function onImageReady(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** The decoded bitmap of an image asset (straight alpha), or undefined while it decodes / is missing. */
export const getBitmap = (assetId: string) => bitmaps.get(assetId);

/** Start (or join) decoding an image asset; resolves when the bitmap is available. */
export function decodeImage(assetId: string): Promise<void> {
  if (bitmaps.has(assetId)) return Promise.resolve();
  let p = decoding.get(assetId);
  if (p) return p;
  const asset = getAsset(assetId);
  if (!asset) return Promise.resolve();
  // Straight alpha: fills un-premultiply nothing, Canvas2D draws it the same either way.
  p = createImageBitmap(new Blob([asset.data], { type: asset.mime }), { premultiplyAlpha: 'none' })
    .then((bmp) => {
      bitmaps.set(assetId, bmp);
      const tex = textures.get(assetId);
      if (tex) {
        tex.image = bmp;
        tex.needsUpdate = true;
      }
      listeners.forEach((l) => l());
    })
    .catch((err: unknown) => console.warn(`Image asset ${assetId} could not be decoded`, err))
    .finally(() => decoding.delete(assetId));
  decoding.set(assetId, p);
  return p;
}

/**
 * A stable, mipmapped GPU texture of an image asset: raw sRGB values, straight alpha, rows top →
 * bottom (flipY off, so v = 0 is the image's TOP row). Edge-clamped: shaders wrap / clamp the
 * coordinate themselves and pass analytic derivatives (textureGrad), so tiling has no seams.
 * The texture is empty until decoding finishes; it then updates itself (and onImageReady fires).
 */
export function imageTexture(assetId: string): THREE.Texture {
  let tex = textures.get(assetId);
  if (tex) return tex;
  tex = new THREE.Texture();
  tex.colorSpace = THREE.NoColorSpace;
  tex.flipY = false;
  tex.premultiplyAlpha = false;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = 4;
  textures.set(assetId, tex);
  const bmp = bitmaps.get(assetId);
  if (bmp) {
    tex.image = bmp;
    tex.needsUpdate = true;
  } else void decodeImage(assetId);
  return tex;
}

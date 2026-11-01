import { getAsset } from '../../assets/registry';
import { decodeImage, getBitmap } from '../../engine/layer2d/images';
import { encodePng, readPixels } from '../../io/imageSplit';
import { isTitleLayer } from '../../model/parts';
import { msg, MsgError } from '../../store/msg';
import { useEditor } from '../../store/store';
import { engineHost } from '../engineHost';
import { pngAsset } from '../layerActions';
import { toComp } from '../viewport/geometry';

// Apply mask (Photoshop Apply Layer Mask) for image layers: the mask's values multiply the
// picture's alpha in a new PNG asset, which replaces the picture (store.applyMask), as one undo step.

/** Longest side of the comp-frame mask render, render px. */
const MAX_MASK_SIDE = 8192;

/**
 * Bake mask `maskId` of image layer `layerId` into its picture. The mask is rendered over the comp
 * frame at about the picture's own resolution and sampled at every picture pixel through the
 * layer's transform; picture pixels outside the comp frame take the frame edge's value.
 */
export async function bakeMask(layerId: string, maskId: string): Promise<void> {
  const engine = engineHost.engine;
  if (!engine) throw new MsgError(msg('The renderer is not ready'));
  const { project } = useEditor.getState();
  const layer = project.layers.find((l) => l.id === layerId);
  if (!isTitleLayer(layer) || layer.source.kind !== 'image' || !layer.masks.some((m) => m.id === maskId)) return;
  const { assetId, size } = layer.source;
  await decodeImage(assetId);
  const bmp = getBitmap(assetId);
  if (!bmp) throw new MsgError(msg('The image could not be decoded'));
  const img = readPixels(bmp);
  const { width: W, height: H, data } = img;

  // Layer units per picture px (the picture is fitted so its larger side is `size`, centred on the
  // layer origin), and the layer → comp map as origin + unit vectors (toComp is affine).
  const k = size / Math.max(W, H, 1);
  const o = toComp(layer, { x: 0, y: 0 });
  const ex = toComp(layer, { x: 1, y: 0 });
  const ey = toComp(layer, { x: 0, y: 1 });
  const ax = { x: ex.x - o.x, y: ex.y - o.y };
  const ay = { x: ey.x - o.x, y: ey.y - o.y };

  // Render px per comp px: the picture's own density (picture px per comp px), within limits.
  const { width: cw, height: ch } = project.comp;
  const density = 1 / Math.max(1e-6, k * Math.hypot(ax.x, ax.y));
  const scale = Math.min(MAX_MASK_SIDE / Math.max(cw, ch), Math.max(1, density));
  const mask = engine.renderLayerMask(project, layerId, { scale, maskId });
  const mw = mask.width;
  const mh = mask.height;
  const mv = mask.data;
  const at = (x: number, y: number) => mv[(Math.min(mh - 1, Math.max(0, y)) * mw + Math.min(mw - 1, Math.max(0, x))) * 4];

  for (let j = 0; j < H; j++) {
    const ly = (H / 2 - j - 0.5) * k;
    for (let i = 0; i < W; i++) {
      const p = (j * W + i) * 4 + 3;
      if (data[p] === 0) continue;
      const lx = (i + 0.5 - W / 2) * k;
      // Comp point (centre origin, +y up) → mask render px (rows top first), bilinear.
      const fx = (o.x + ax.x * lx + ay.x * ly) * scale + mw / 2 - 0.5;
      const fy = mh / 2 - (o.y + ax.y * lx + ay.y * ly) * scale - 0.5;
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const tx = fx - x0;
      const ty = fy - y0;
      const top = at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx;
      const bottom = at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx;
      data[p] = Math.round((data[p] * (top * (1 - ty) + bottom * ty)) / 255);
    }
  }

  const png = await encodePng(img);
  const base = (getAsset(assetId)?.name ?? layer.name).replace(/\.[^.]+$/, '');
  const baked = pngAsset(`${base} masked.png`, png);
  // The picture was replaced or the mask removed meanwhile: nothing to apply it to.
  const now = useEditor.getState().project.layers.find((l) => l.id === layerId);
  if (!isTitleLayer(now) || now.source.kind !== 'image' || now.source.assetId !== assetId) return;
  useEditor.getState().applyMask(layerId, maskId, baked);
}

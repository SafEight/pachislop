import { create } from 'zustand';
import { addAsset, getAsset, listAssets, removeAsset } from '../assets/registry';
import { decodeImage, getBitmap } from '../engine/layer2d/images';
import { cutParts, encodePng, type ImagePart, type IslandMap } from '../io/imageSplit';
import { createGroupLayer, createTitle2DLayer, createTitle3DLayer, imageSource, material3D, shapeSource } from '../model/defaults';
import { isTitleLayer, type TitleLayer } from '../model/parts';
import type { Comp, ShapeKind } from '../model/types';
import { numberedName } from '../store/arrange';
import { errorMsg, joinMsgs, msg, type Msg, type Translate } from '../store/msg';
import { titleLayerFor } from '../store/imageOps';
import { selectedLayer, useEditor, type LayerDest } from '../store/store';
import type { Bounds } from '../text/layout';
import type { MenuItem } from './controls';
import { installFont, slug } from './fontFiles';
import { tr } from './i18n';
import { pickFile, SHAPES } from './util';
import type { Pt } from './viewport/geometry';

// Layer-creating commands shared by the Layers panel, the canvas tools, the empty-canvas card,
// the T / ⇧T shortcuts, paste and file drops (kept out of component modules so Fast Refresh
// stays local). New layers go through store.addLayer: above the primary selection, inside its
// parent (group), unless a Layers-panel drop names the slot.

/**
 * Add a 2D (layer style) or 3D (extruded) text layer and open it for typing on the canvas. It
 * takes the Text tool's defaults (view.textDefaults) and is placed at `at` (comp px, +y up)
 * when given, else at the comp centre.
 */
export function addTextLayer(dim: '2d' | '3d', at?: { x: number; y: number }) {
  const st = useEditor.getState();
  const { fontId, size, tracking, fill } = st.view.textDefaults;
  const l = dim === '2d' ? createTitle2DLayer('BIG BONUS') : createTitle3DLayer('激アツ');
  if (l.source.kind === 'text') l.source = { ...l.source, fontId, size, tracking };
  if (fill && l.kind === 'title2d') l.style.face = { ...l.style.face, fill: { ...l.style.face.fill, kind: 'solid', color: fill } };
  if (fill && l.kind === 'title3d') l.style3d.face = { ...l.style3d.face, color: fill, gradient: undefined };
  if (at) l.transform = { ...l.transform, x: round2(at.x), y: round2(at.y) };
  st.addLayer(l);
  st.beginTextEdit(l.id);
}

/** ⊕ New group: an empty group above the primary selection, named in the UI language like PS (“Group 3” / “グループ 3”). */
export function addGroupLayer() {
  const st = useEditor.getState();
  st.addLayer(createGroupLayer(numberedName(tr('Group'), st.project.layers.map((l) => l.name))));
}

/**
 * Add a shape layer, named after its kind (English, project data). With `box` (comp px, +y up;
 * the Shape tool's drag) it fills that box: height = box height, aspect = its width / height,
 * centred in it. Without, it starts at its default size at the comp centre, and with a text layer
 * selected it becomes a backing shape: inserted just below the text and fitted around it (a plate
 * / burst / bubble behind a title). A 3D orb starts as a 保留 candy orb (titleLayerFor), lit by
 * its own softbox lighting (the studio strips streak arcs across a sphere).
 */
export function addShapeLayer(kind: ShapeKind, dim: '2d' | '3d', box?: Bounds) {
  const label = SHAPES.find((s) => s.kind === kind)?.label ?? kind;
  const l = titleLayerFor(dim, shapeSource(kind), label);
  if (l.source.kind !== 'shape') throw new Error('unreachable: titleLayerFor keeps the shape source');
  const st = useEditor.getState();
  if (box) {
    const w = Math.max(1, box.x1 - box.x0);
    const h = Math.max(1, box.y1 - box.y0);
    l.source = { ...l.source, size: Math.round(h), aspect: round2(w / h) };
    l.transform = { ...l.transform, x: round2((box.x0 + box.x1) / 2), y: round2((box.y0 + box.y1) / 2) };
    return st.addLayer(l);
  }
  const sel = selectedLayer(st);
  if (isTitleLayer(sel) && sel.source.kind === 'text') st.addBackingShape(l, sel.id);
  else st.addLayer(l);
}

/** The Shape ▾ menu, labelled through `t`; new layers keep the English shape name (project data). */
export const shapeItems = (t: Translate): MenuItem[] =>
  (['2d', '3d'] as const).flatMap((dim) =>
    SHAPES.map((sh) => ({
      label: t(sh.label),
      group: dim === '2d' ? t('2D · layer style') : t('3D · extruded'),
      hint: t(sh.hint),
      onClick: () => addShapeLayer(sh.kind, dim),
    })),
  );

const round2 = (v: number) => Math.round(v * 100) / 100;

const baseName = (f: File) => f.name.replace(/\.[^.]+$/, '');

/** Raster types a layer takes (decoded by the browser), with their file extensions. */
const IMAGE_TYPES: Readonly<Record<string, RegExp>> = {
  'image/png': /\.png$/i,
  'image/jpeg': /\.jpe?g$/i,
  'image/webp': /\.webp$/i,
  'image/gif': /\.gif$/i,
};
const SVG_TYPE = 'image/svg+xml';
/** Font MIME types browsers report for TTF / OTF / WOFF / WOFF2 files. */
const FONT_TYPE = /^(font\/|application\/(x-)?font|application\/vnd\.ms-opentype)/;

type FileKind = 'image' | 'svg' | 'model' | 'font';

/** MIME type of a raster image file (its type, else its extension), or null when it isn't one. */
function imageMime(f: File): string | null {
  if (f.type in IMAGE_TYPES) return f.type;
  return Object.entries(IMAGE_TYPES).find(([, ext]) => ext.test(f.name))?.[0] ?? null;
}

/** What a file is, from its type or extension; null when it is none of the importable kinds. */
function fileKind(f: File): FileKind | null {
  if (f.type === SVG_TYPE || /\.svg$/i.test(f.name)) return 'svg';
  if (imageMime(f)) return 'image';
  if (f.type === 'model/gltf-binary' || /\.glb$/i.test(f.name)) return 'model';
  if (FONT_TYPE.test(f.type) || /\.(ttf|otf|woff2?)$/i.test(f.name)) return 'font';
  return null;
}

/** During a drag (file contents and names are unreadable until the drop): true when it carries files. */
export const draggingFiles = (dt: DataTransfer | null): boolean => !!dt?.types.includes('Files');

/** During a drag: true when every dragged file reports a font type (dropping only installs them). */
export function draggingFonts(dt: DataTransfer): boolean {
  const files = [...dt.items].filter((i) => i.kind === 'file');
  return files.length > 0 && files.every((i) => FONT_TYPE.test(i.type));
}

/** Pasted text that is SVG markup (an XML prolog, comments or a doctype may precede the root). */
const isSvgMarkup = (text: string) => /^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*|<!DOCTYPE[^>]*>\s*)*<svg[\s>]/i.test(text);

const svgTextFile = (text: string) => new File([text], 'Pasted SVG.svg', { type: SVG_TYPE });

/**
 * The image / SVG files of a paste event's clipboard: image files (PNG / JPEG / WebP / GIF, an
 * `.svg`), else SVG markup copied as text. Empty when it holds neither.
 */
export function clipboardFiles(dt: DataTransfer): File[] {
  const files = [...dt.files].filter((f) => {
    const k = fileKind(f);
    return k === 'image' || k === 'svg';
  });
  if (files.length) return files;
  const text = dt.getData('text/plain');
  return isSvgMarkup(text) ? [svgTextFile(text)] : [];
}

/**
 * Edit ▸ Paste (as 3D): read the clipboard through the async Clipboard API (a keyboard shortcut
 * other than ⌘V gets no paste event) and import its images / SVG as `dim` layers at the comp centre.
 */
export async function pasteClipboard(dim: '2d' | '3d') {
  const st = useEditor.getState();
  let items: ClipboardItems;
  try {
    items = await navigator.clipboard.read();
  } catch (e) {
    return st.notify(msg('Can’t read the clipboard: {error}', { error: errorMsg(e) }), 'error');
  }
  const files: File[] = [];
  for (const item of items) {
    const image = item.types.find((type) => type in IMAGE_TYPES);
    if (image) {
      files.push(new File([await item.getType(image)], `Pasted image.${image.slice('image/'.length)}`, { type: image }));
    } else if (item.types.includes(SVG_TYPE)) {
      files.push(svgTextFile(await (await item.getType(SVG_TYPE)).text()));
    } else if (item.types.includes('text/plain')) {
      const text = await (await item.getType('text/plain')).text();
      if (isSvgMarkup(text)) files.push(svgTextFile(text));
    }
  }
  if (!files.length) return st.notify('The clipboard holds no image or SVG', 'error');
  await importFiles(files, { dim });
}

/** ImageSource.size of a decoded image: its own pixel size, scaled down to fit the comp (PS paste / place). */
const fitSize = ({ width: w, height: h }: ImageBitmap, comp: Comp) => round2(Math.max(w, h) * Math.min(1, comp.width / w, comp.height / h));

/** Register an SVG file as an asset: its id, or the reason it isn't one. */
async function svgAsset(file: File): Promise<string | Msg> {
  const data = await file.arrayBuffer();
  if (!/<svg[\s>]/i.test(new TextDecoder().decode(data))) return msg('{file} is not an SVG file', { file: file.name });
  return addAsset({ name: file.name, mime: SVG_TYPE, data }).id;
}

/** A new layer from an image, SVG or GLB file (`dim` for images / SVG; a model is always 3D), or the reason it can't be one. */
async function fileLayer(file: File, kind: Exclude<FileKind, 'font'>, dim: '2d' | '3d'): Promise<TitleLayer | Msg> {
  const name = baseName(file) || file.name;
  if (kind === 'svg') {
    const id = await svgAsset(file);
    return typeof id === 'string' ? titleLayerFor(dim, { kind: 'svg', assetId: id, size: 500 }, name) : id;
  }
  if (kind === 'image') {
    const asset = addAsset({ name: file.name, mime: imageMime(file)!, data: await file.arrayBuffer() });
    // Decoded into the shared bitmap cache before the layer exists, so its box, picking and
    // first render already have the picture's real aspect (no square stand-in).
    await decodeImage(asset.id);
    const bmp = getBitmap(asset.id);
    if (!bmp) {
      removeAsset(asset.id);
      return msg('{name}: {error}', { name: file.name, error: msg('The image could not be decoded') });
    }
    return titleLayerFor(dim, imageSource(asset.id, fitSize(bmp, useEditor.getState().project.comp)), name);
  }
  const data = await file.arrayBuffer();
  if (new TextDecoder().decode(data.slice(0, 4)) !== 'glTF') return msg('{name}: {error}', { name: file.name, error: msg('Only binary glTF (.glb) files are supported') });
  const asset = addAsset({ name: file.name, mime: 'model/gltf-binary', data });
  const l = createTitle3DLayer(name);
  l.name = name;
  l.source = { kind: 'model', assetId: asset.id, size: 500 };
  // 'custom' face material keeps the model's own materials.
  l.style3d.face = material3D('custom');
  return l;
}

/**
 * Where imported files land. `dim`: the kind of layer an image or SVG becomes (a GLB model is
 * always 3D). `at`: comp point (+y up) each new layer is centred on (default: the comp centre).
 * `dest`: the stack slot of the first new layer (default: above the primary selection).
 */
export interface ImportTarget {
  dim: '2d' | '3d';
  at?: Pt;
  dest?: LayerDest;
}

/**
 * Import pasted / dropped files: one layer per image, SVG or GLB file, stacked in file order
 * (each lands above the one before), and fonts installed like an upload in the font browser.
 * Files that can't be imported are reported in one toast.
 */
export async function importFiles(files: readonly File[], target: ImportTarget) {
  const st = useEditor.getState();
  const errors: Msg[] = [];
  const fonts: string[] = [];
  let fontFailed = false;
  let dest = target.dest;
  for (const file of files) {
    const kind = fileKind(file);
    if (kind === 'font') {
      const id = await installFont(`user-${slug(file.name)}-${Date.now().toString(36)}`, baseName(file), await file.arrayBuffer());
      if (id) fonts.push(baseName(file));
      else fontFailed = true;
      continue;
    }
    const made = kind ? await fileLayer(file, kind, target.dim) : msg('{file}: not an image, SVG, GLB or font file', { file: file.name });
    if ('en' in made) {
      errors.push(made);
      continue;
    }
    if (target.at) made.transform = { ...made.transform, x: round2(target.at.x), y: round2(target.at.y) };
    st.addLayer(made, dest);
    dest = undefined;
  }
  // installFont reports each font itself; a failed one keeps its own message on screen.
  if (errors.length) st.notify(joinMsgs(errors, '; '), 'error');
  else if (fonts.length && !fontFailed) st.notify(msg('Installed font {names}', { names: fonts.map((f) => `“${f}”`).join(', ') }));
}

export async function addFileLayer(kind: 'svg3d' | 'svg2d' | 'image' | 'model') {
  const accept = kind === 'image' ? Object.keys(IMAGE_TYPES).join(',') : kind === 'model' ? '.glb' : `.svg,${SVG_TYPE}`;
  const file = await pickFile(accept);
  if (file) await importFiles([file], { dim: kind === 'svg3d' ? '3d' : '2d' });
}

/** Layer ⋯ ▸ Replace with SVG…: swap the source, keeping transform, style and effects (see store.replaceWithSvg). */
export async function replaceWithSvgFile(layerId: string) {
  const file = await pickFile(`.svg,${SVG_TYPE}`);
  if (!file) return;
  const id = await svgAsset(file);
  const st = useEditor.getState();
  if (typeof id === 'string') st.replaceWithSvg(layerId, id, baseName(file));
  else st.notify(id, 'error');
}

/** Layer ▸ Split image…: the image layer SplitImageDialog is open on (App mounts it), or null. */
export const useSplitImage = create<{ layerId: string | null }>(() => ({ layerId: null }));
export const openSplitImage = (layerId: string) => useSplitImage.setState({ layerId });
export const closeSplitImage = () => useSplitImage.setState({ layerId: null });

/** The PNG asset holding exactly `data` (an identical piece, or one cut before), else a new one named `name`. */
export function pngAsset(name: string, data: ArrayBuffer): string {
  const bytes = new Uint8Array(data);
  const same = listAssets().find((a) => {
    if (a.mime !== 'image/png' || a.data.byteLength !== bytes.length) return false;
    const b = new Uint8Array(a.data);
    return bytes.every((v, i) => v === b[i]);
  });
  return (same ?? addAsset({ name, mime: 'image/png', data })).id;
}

/**
 * Split image layer `layerId` into `parts` of its picture (`img`, full resolution, labelled as
 * `map`): each part is cut, stored as a PNG asset like a pasted image (shared when identical) and
 * becomes one layer of the group that replaces the layer (store.splitImageLayer), as one undo step.
 */
export async function splitImageLayer(layerId: string, img: ImageData, map: IslandMap, parts: readonly ImagePart[]) {
  const layer = useEditor.getState().project.layers.find((l) => l.id === layerId);
  if (!isTitleLayer(layer) || layer.source.kind !== 'image') return;
  const base = (getAsset(layer.source.assetId)?.name ?? layer.name).replace(/\.[^.]+$/, '');
  const cut = cutParts(img, map, parts);
  const pngs = await Promise.all(cut.map((c) => encodePng(c.pixels)));
  const pieces = cut.map((c, i) => ({ assetId: pngAsset(`${base} ${i + 1}.png`, pngs[i]), box: c.box }));
  useEditor.getState().splitImageLayer(layerId, { w: img.width, h: img.height }, pieces);
}

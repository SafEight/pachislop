import { Euler, Vector3 } from 'three';
import { bevel3D, createGroupLayer, createTitle2DLayer, createTitle3DLayer, erode2D, material2D, plainTitle3D, solidFill } from '../model/defaults';
import { isTitleLayer, type TitleLayer } from '../model/parts';
import type { BevelShape3D, Fill, Layer, Material2D, Material3D, Pattern, PlateShape, SvgSource, Title2DLayer, Title3DProps, TitleStyle2D, Transform } from '../model/types';
import { sourceBounds, toComp } from '../ui/viewport/geometry';
import { isNumberedName, textName, uniqueName } from './arrange';
import type { Slice } from './core';
import { commit } from './history';
import { cloneLayerFresh } from './layerOps';
import { msg } from './msg';
import { layerNode, selection } from './selection';
import { withParent } from './tree';

// A title's source and kind: the plain image look, SVG swap, 2D ⇄ 3D, Split image.

/**
 * The plain 2D image look: the picture exactly as it is. The face is an image fill of the
 * source's own asset placed exactly over it, which the 2D renderer shows texel for texel
 * (Title2DRenderer ownPicture); no rims, bevel, gloss, texture or glow.
 */
export function plainImageStyle2D(assetId: string): TitleStyle2D {
  const fill: Fill = { ...solidFill('#ffffff'), kind: 'image', image: { assetId, scale: 1, offsetX: 0, offsetY: 0, rotate: 0, tile: false } };
  return { face: material2D(fill), rims: [], knockout: false, erode: erode2D() };
}

/**
 * The plain 3D image look: the picture on the face and around the edges (faceImage / edgeImage
 * 1) over the plain material, a shallow extrusion with one small round bevel inside the picture's
 * silhouette (`size` is the image's long side, so thin spikes stay thin); otherwise plainTitle3D:
 * no bands, glint, AO or shadow catcher, the comp's environment and lights.
 */
export function plainImageStyle3D(): Title3DProps {
  return { ...plainTitle3D(), depth: 5, bevel: bevel3D(0.5, 0.5), bevelPosition: 'inside', edgeImage: 1 };
}

/**
 * A new 2D (layer style) or 3D (extruded) title named `name` around `source`, in that kind's
 * plain look (createTitle2DLayer / createTitle3DLayer; an image in the plain image look,
 * plainImageStyle2D / plainImageStyle3D, so a pasted or dropped picture arrives as it is). New
 * layers and convertLayerKind share it; Library looks apply on top.
 */
export function titleLayerFor(dim: '2d' | '3d', source: Title2DLayer['source'], name: string): TitleLayer {
  const blank = dim === '2d' ? createTitle2DLayer(name) : createTitle3DLayer(name);
  blank.name = name;
  blank.source = source;
  if (source.kind === 'image') {
    if (blank.kind === 'title2d') blank.style = plainImageStyle2D(source.assetId);
    else blank.style3d = plainImageStyle3D();
  }
  return blank;
}

/**
 * `l` with every size-relative style unit (% of the source size, see model/types.ts) multiplied
 * by `k`, and an image source's trace smoothing (% of size) and despeckle area (% of size²) with
 * them: at source size / `k` the look keeps its absolute dimensions (a piece cut from a picture
 * keeps the picture's rims, bevels and extrusion depth). Effects are in comp px and stay.
 */
function scaleStyleUnits(l: TitleLayer, k: number): TitleLayer {
  const pattern = (p: Pattern): Pattern => ({ ...p, scale: p.scale * k });
  const plate = (p: PlateShape): PlateShape => ({ ...p, close: p.close * k, corner: p.corner * k });
  const src = l.source;
  const source = src.kind === 'image' ? { ...src, trace: { ...src.trace, smooth: src.trace.smooth * k, despeckle: src.trace.despeckle * k * k } } : src;
  if (l.kind === 'title2d') {
    const mat = (m: Material2D): Material2D => ({
      ...m,
      bevel: { ...m.bevel, size: m.bevel.size * k, soften: m.bevel.soften * k },
      pattern: pattern(m.pattern),
      satin: { ...m.satin, distance: m.satin.distance * k, size: m.satin.size * k },
      texture: { ...m.texture, scale: m.texture.scale * k },
      innerGlow: { ...m.innerGlow, size: m.innerGlow.size * k },
      refraction: m.refraction * k,
    });
    const s = l.style;
    const rims = s.rims.map((r) => ({ ...r, width: r.width * k, offsetX: r.offsetX * k, offsetY: r.offsetY * k, plate: plate(r.plate), material: mat(r.material) }));
    return { ...l, source, style: { ...s, face: mat(s.face), rims, erode: { ...s.erode, edge: s.erode.edge * k, scale: s.erode.scale * k } } } as TitleLayer;
  }
  const mat = (m: Material3D): Material3D => ({ ...m, flakeScale: m.flakeScale * k, pattern: pattern(m.pattern), surface: { ...m.surface, scale: m.surface.scale * k } });
  const bevel = (b: BevelShape3D): BevelShape3D => ({ ...b, width: b.width * k, depth: b.depth * k });
  const s = l.style3d;
  const style3d: Title3DProps = {
    ...s,
    inflate: { ...s.inflate, height: s.inflate.height * k },
    depth: s.depth * k,
    face: mat(s.face),
    ...(s.side ? { side: mat(s.side) } : {}),
    bevel: bevel(s.bevel),
    bands: s.bands.map((b) => ({
      ...b,
      grow: b.grow * k,
      depth: b.depth * k,
      offset: b.offset * k,
      shape: plate(b.shape),
      bevel: bevel(b.bevel),
      material: mat(b.material),
      ...(b.side ? { side: mat(b.side) } : {}),
    })),
    glint: { ...s.glint, radius: s.glint.radius * k, length: s.glint.length * k },
    ao: { ...s.ao, radius: s.ao.radius * k },
  };
  return { ...l, source, style3d } as TitleLayer;
}

const DEG = Math.PI / 180;

/**
 * `l`'s transform moved so that its layer-space point (x, y) (+y up) becomes the origin, with
 * the same rotation, scale and flip: a 2D layer moves in the comp plane, a 3D one along its own
 * turned plane (Layer3DRenderer: flip, then rotation X → Y → Z, uniform scale).
 */
function shiftedOrigin(l: TitleLayer, x: number, y: number): Transform {
  const t = l.transform;
  if (l.kind === 'title2d') {
    const c = toComp(l, { x, y });
    return { ...t, x: c.x, y: c.y };
  }
  const fx = t.flipX ? -1 : 1;
  const fy = t.flipY ? -1 : 1;
  const v = new Vector3(x * fx * t.scale, y * fy * t.scale, 0).applyEuler(new Euler(t.rotX * DEG, t.rotY * DEG, -t.rotZ * DEG, 'ZYX'));
  return { ...t, x: t.x + v.x, y: t.y + v.y, z: t.z + v.z };
}

/**
 * `layer` showing image asset `to` where it showed `from`: its image source and every image fill
 * of that asset in a 2D style (the plain 2D look fills the face with its own picture), so they
 * stay in step when the picture is replaced or cut.
 */
export function swapImageAsset(layer: TitleLayer, from: string, to: string): TitleLayer {
  const source = layer.source.kind === 'image' && layer.source.assetId === from ? { ...layer.source, assetId: to } : layer.source;
  if (layer.kind !== 'title2d') return { ...layer, source } as TitleLayer;
  const walk = (v: unknown, key: string): unknown => {
    if (Array.isArray(v)) return v.map((x) => walk(x, ''));
    if (!v || typeof v !== 'object') return v;
    const o = v as Record<string, unknown>;
    if (key === 'image' && o.assetId === from) return { ...o, assetId: to };
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, walk(x, k)]));
  };
  return { ...layer, source, style: walk(layer.style, '') as TitleStyle2D } as TitleLayer;
}

export const imageSlice: Slice<'replaceWithSvg' | 'convertLayerKind' | 'splitImageLayer'> = (core) => {
  const { get, set } = core;
  return {
    replaceWithSvg(id, assetId, name) {
      const { project } = get();
      const old = project.layers.find((l) => l.id === id);
      if (!isTitleLayer(old)) return;
      const svg = (size: number): SvgSource => ({ kind: 'svg', assetId, size });
      const before = sourceBounds(old);
      const unit = sourceBounds({ ...old, source: svg(100) } as Layer);
      // Fit inside the old source box (aspect kept), centred where the old ink was.
      const k = before && unit ? Math.min((before.x1 - before.x0) / (unit.x1 - unit.x0), (before.y1 - before.y0) / (unit.y1 - unit.y0)) : null;
      const size = k && Number.isFinite(k) && k > 0 ? Math.round(k * 100 * 100) / 100 : old.source.size;
      const c = before ? toComp(old, { x: (before.x0 + before.x1) / 2, y: (before.y0 + before.y1) / 2 }) : old.transform;
      const autoNamed = old.source.kind === 'text' && isNumberedName(old.name, textName(old.source.text));
      const layer = {
        ...old,
        name: autoNamed ? uniqueName(name, new Set(project.layers.filter((l) => l.id !== id).map((l) => l.name))) : old.name,
        source: svg(size),
        transform: { ...old.transform, x: Math.round(c.x * 100) / 100, y: Math.round(c.y * 100) / 100 },
      } as Layer;
      commit(core, { ...project, layers: project.layers.map((l) => (l.id === id ? layer : l)) }, undefined, msg('Replace “{name}” with {file}', { name: old.name, file: `${name}.svg` }));
    },
    convertLayerKind(id, kind) {
      const { project, notify } = get();
      const old = project.layers.find((l) => l.id === id);
      if (!isTitleLayer(old) || old.kind === (kind === '2d' ? 'title2d' : 'title3d')) return;
      if (old.source.kind === 'model') return notify(msg('“{name}” is a 3D model; it can’t become a 2D layer', { name: old.name }), 'error');
      const fresh = titleLayerFor(kind, old.source, old.name);
      const { visible, solo, locked, guide, blend, transform, effects, masks, clip, warp, distort, weight } = old;
      const layer = withParent({ ...fresh, id, visible, solo, locked, guide, blend, transform, effects, masks, clip, warp, distort, weight } as Layer, old.parentId);
      const label = msg(kind === '3d' ? 'Convert “{name}” to 3D layer' : 'Convert “{name}” to 2D layer', { name: old.name });
      commit(core, { ...project, layers: project.layers.map((l) => (l.id === id ? layer : l)) }, undefined, label);
    },
    splitImageLayer(id, size, pieces) {
      const { project } = get();
      const old = project.layers.find((l) => l.id === id);
      if (!isTitleLayer(old) || old.source.kind !== 'image' || !pieces.length) return;
      const src = old.source;
      // Layer units per picture px: the picture is fitted so its larger side is src.size.
      const k = src.size / Math.max(size.w, size.h, 1);
      const group = withParent({ ...createGroupLayer(old.name), clip: old.clip }, old.parentId);
      const parts = pieces.map(({ assetId, box }, i) => {
        const partSize = k * Math.max(box.x1 - box.x0, box.y1 - box.y0);
        // Style units are % of the source size: scaled by size / part size, every dimension stays as it was.
        const copy = scaleStyleUnits(swapImageAsset(cloneLayerFresh(old), src.assetId, assetId), src.size / partSize);
        const cx = k * ((box.x0 + box.x1) / 2 - size.w / 2);
        const cy = k * (size.h / 2 - (box.y0 + box.y1) / 2);
        const source = { ...copy.source, size: partSize };
        // Linked masks sit in layer space: they follow the moved origin so they stay where they were.
        const masks = copy.masks.map((m) => (m.linked && m.kind !== 'layer' ? { ...m, x: m.x - cx, y: m.y - cy } : m));
        return withParent({ ...copy, name: `${old.name} ${i + 1}`, source, masks, transform: shiftedOrigin(old, cx, cy), clip: false } as Layer, group.id);
      });
      // Bottom first in the array: piece 1 ends up at the top of the group.
      const layers = project.layers.flatMap((l) => (l.id === id ? [...parts.toReversed(), group] : [l]));
      commit(core, { ...project, layers }, undefined, msg('Split “{name}” into {n} layers', { name: old.name, n: parts.length }));
      core.anchor = group.id;
      set(selection(core, [], group.id, layerNode(group.id)));
    },
  };
};

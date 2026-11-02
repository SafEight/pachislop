import { isTitleLayer, layerParts, parsePartKey, type TitleLayer } from '../../model/parts';
import { sideMaterial } from '../../model/bands';
import type { GradientSpan, PartKey, Project } from '../../model/types';
import type { Text } from '../../store/msg';
import { partLabel } from '../../store/labels';
import type { NodeRef, Path } from '../../store/store';
import { glyphSpanBoxes, type Bounds } from '../../text/layout';
import { layerTextLayout, partLocalBounds, rim2DFrame, sourceBounds } from './geometry';
import type { GradParams } from './gradient';

// The fill the Gradient tool edits: the selected node's part (a layer node or one of its
// effects → the face), read and written through store paths relative to the layer.

export interface FillGradient {
  params: GradParams;
  /** Store path (relative to the layer) of each param. */
  paths: Record<'angle' | 'scale' | 'offset', Path>;
  span: GradientSpan;
}

export interface GradientTarget {
  layer: TitleLayer;
  part: PartKey;
  /** Display name of the part (Face / Rim 2 / Band 1 / Side / Plate 1); show with formatMsg. */
  label: Text;
  /** The part's gradient, or null when its fill is no gradient (solid, image, shape burst; a 3D depth-axis ramp). */
  grad: FillGradient | null;
}

/** Gradient-tool target of the selected node; null when the node is not on a title layer, names a part it no longer has, or is a mask (masks lay their own line). */
export function gradientTarget(project: Project, node: NodeRef | null): GradientTarget | null {
  if (!node || node.kind === 'mask') return null;
  const layer = project.layers.find((l) => l.id === node.layerId);
  if (!isTitleLayer(layer)) return null;
  const part: PartKey = node.kind === 'part' ? node.part : node.kind === 'parts' ? node.parts[0] : node.kind === 'effect' ? (node.part ?? 'face') : 'face';
  if (part !== 'face' && !layerParts(layer).includes(part)) return null;
  return { layer, part, label: partLabel(layer, part), grad: partGradient(layer, part) };
}

function partGradient(layer: TitleLayer, part: PartKey): FillGradient | null {
  const { kind, id } = parsePartKey(part);
  if (layer.kind === 'title2d') {
    const i = kind === 'rim' ? layer.style.rims.findIndex((r) => r.id === id) : -1;
    if (kind !== 'face' && i < 0) return null;
    const f = i < 0 ? layer.style.face.fill : layer.style.rims[i].material.fill;
    if (f.kind === 'solid' || f.kind === 'shapeBurst' || f.kind === 'image') return null;
    const base = i < 0 ? ['style', 'face', 'fill'] : ['style', 'rims', i, 'material', 'fill'];
    return {
      params: { kind: f.kind, angle: f.angle, scale: f.scale, offset: f.offset },
      paths: { angle: [...base, 'angle'], scale: [...base, 'scale'], offset: [...base, 'offset'] },
      span: f.span,
    };
  }
  const s = layer.style3d;
  const bi = kind === 'band' ? s.bands.findIndex((b) => b.id === id) : -1;
  // A side without a material of its own shows the face: its gradient is the face's.
  const base: Path | null =
    kind === 'face' ? ['style3d', 'face'] : kind === 'side' ? ['style3d', s.side ? 'side' : 'face'] : bi >= 0 ? ['style3d', 'bands', bi, 'material'] : null;
  if (!base) return null;
  const m = kind === 'face' ? s.face : kind === 'side' ? sideMaterial(s) : s.bands[bi].material;
  if (!m.gradient || m.gradient.stops.length < 2 || m.gradientAxis === 'depth') return null;
  return {
    params: { kind: m.gradientKind, angle: m.gradientAngle, scale: m.gradientScale, offset: m.gradientOffset },
    paths: { angle: [...base, 'gradientAngle'], scale: [...base, 'gradientScale'], offset: [...base, 'gradientOffset'] },
    span: m.gradientSpan,
  };
}

/**
 * Layer-space box the part's gradient spans, as the renderers map it: per 'line' / 'char' span
 * the box of the primary picked glyph (or the first); a 2D rim's box grows by its running width
 * and follows its drop offset, like Title2DRenderer's element box.
 */
export function gradientBox(t: GradientTarget, span: GradientSpan, selectedChars: readonly number[]): Bounds | null {
  const { layer, part } = t;
  const lay = span === 'layer' ? null : layerTextLayout(layer);
  const glyph = lay && lay.glyphs.length > 0 ? (glyphSpanBoxes(lay, span)[Math.max(0, lay.glyphs.findIndex((g) => g.index === selectedChars[0]))] ?? null) : null;
  if (layer.kind === 'title2d' && part !== 'face') {
    const f = rim2DFrame(layer, parsePartKey(part).id ?? '');
    const b = f && (glyph ?? f.base);
    return f && b ? { x0: b.x0 - f.grow + f.dx, y0: b.y0 - f.grow + f.dy, x1: b.x1 + f.grow + f.dx, y1: b.y1 + f.grow + f.dy } : null;
  }
  return glyph ?? (part === 'face' ? sourceBounds(layer) : partLocalBounds(layer, part));
}

import { companionOwner } from '../../model/companions';
import { isTitleLayer, type TitleLayer } from '../../model/parts';
import type { EffectInstance, GeneratorLayer, Layer, LayerMask, PartKey, Project, Title2DLayer, Title3DLayer } from '../../model/types';
import { effectsOf } from '../../store/effects';
import type { NodeRef } from '../../store/store';
import { hasPart } from '../../store/tree';
import { partScope } from './parts';

// What Properties shows for the selection, and the kind of node that is (the scope its section
// states and scroll position are remembered under). Shared by the panel and its search, whose
// index renders each page under the scope the panel will show it with.

/**
 * The selected node checked against the project: a stale part / effect / mask falls back to its
 * owner, a missing layer to the Document. Selected parts show in their layer's page, expanded in
 * Appearance (`parts`), unless the one part was opened on its own page (`pageKey`). A glint node
 * shows its 3D title's glint card, an erode node its 2D title's かすれ card, a companion
 * generator's layer node (ui/companions.ts) its card under the layer it follows (`layer`).
 */
export type Resolved =
  | { kind: 'document' }
  | { kind: 'layer'; layer: Layer; parts: readonly PartKey[] }
  | { kind: 'part'; layer: TitleLayer; part: PartKey }
  | { kind: 'effect'; layer: Layer; part: PartKey | null; fx: EffectInstance }
  | { kind: 'mask'; layer: Layer; mask: LayerMask }
  | { kind: 'glint'; layer: Title3DLayer }
  | { kind: 'erode'; layer: Title2DLayer }
  | { kind: 'companion'; layer: Layer; gen: GeneratorLayer };

export function resolve(project: Project, node: NodeRef | null, pageKey: string | null): Resolved {
  const layer = node && project.layers.find((l) => l.id === node.layerId);
  if (!node || !layer) return { kind: 'document' };
  if (node.kind === 'layer') {
    const owner = companionOwner(project.layers, layer);
    return owner && layer.kind === 'generator' ? { kind: 'companion', layer: owner, gen: layer } : { kind: 'layer', layer, parts: [] };
  }
  if (node.kind === 'mask') {
    const mask = layer.masks.find((m) => m.id === node.maskId);
    return mask ? { kind: 'mask', layer, mask } : { kind: 'layer', layer, parts: [] };
  }
  if (node.kind === 'glint') return layer.kind === 'title3d' ? { kind: 'glint', layer } : { kind: 'layer', layer, parts: [] };
  if (node.kind === 'erode') return layer.kind === 'title2d' ? { kind: 'erode', layer } : { kind: 'layer', layer, parts: [] };
  if (node.kind === 'parts') return { kind: 'layer', layer, parts: isTitleLayer(layer) ? node.parts.filter((p) => hasPart(layer, p)) : [] };
  const part = node.part !== null && isTitleLayer(layer) && hasPart(layer, node.part) ? node.part : null;
  if (node.kind === 'effect' && (part !== null || node.part === null)) {
    const fx = effectsOf(project, { layerId: layer.id, part }).find((e) => e.id === node.effectId);
    if (fx) return { kind: 'effect', layer, part, fx };
  }
  if (part === null || !isTitleLayer(layer)) return { kind: 'layer', layer, parts: [] };
  return node.kind === 'part' && pageKey === `${layer.id}:${part}` ? { kind: 'part', layer, part } : { kind: 'layer', layer, parts: [part] };
}

/** The kind of node shown, for remembering section states (SectionScope) and the scroll position. */
export function nodeKind(at: Resolved, multi: boolean): string {
  switch (at.kind) {
    case 'document':
      return 'doc';
    case 'layer':
      return multi && !at.parts.length ? 'multi' : at.layer.kind === 'generator' ? `generator:${at.layer.generator.type}` : at.layer.kind === 'adjustment' ? `adjustment:${at.layer.adjustment.type}` : at.layer.kind;
    case 'part':
      return partScope(at.layer, [at.part]);
    case 'effect':
      return `effect:${at.fx.type}`;
    case 'mask':
      return `mask:${at.mask.kind}`;
    case 'glint':
      return 'glint3d';
    case 'erode':
      return 'erode2d';
    case 'companion':
      return `generator:${at.gen.generator.type}`;
  }
}

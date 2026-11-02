import { isFoldedWrapper, listedCompanions } from '../../model/companions';
import { layerParts, partEffectsOf, isTitleLayer, type TitleLayer } from '../../model/parts';
import type { EffectInstance, GeneratorLayer, GroupLayer, Layer, PartKey, Title2DLayer, Title3DLayer } from '../../model/types';
import type { NodeRef } from '../../store/store';
import { ancestorsOf, childrenOf, clippedTo, isClipped } from '../../store/tree';
import { companionSides } from '../companions';
import { erodeListed } from '../erode';
import { glintListed } from '../glint';

// The Layers panel's flat row list: the layer tree top-first with the open twirls' sub-rows.

export type PanelRow =
  | {
      kind: 'layer';
      layer: Layer;
      /** Nesting depth (0 = top level). */
      depth: number;
      /** Clipped onto the layer below (drawn with the ↴ indent). */
      clipped: boolean;
      /** Has clipped layers above it (its name is underlined, as in PS). */
      isBase: boolean;
      /** Hidden by its own eye or an ancestor group's. */
      dimmed: boolean;
      /** Twirl state; null = nothing to twirl open. */
      open: boolean | null;
      /** The folded companion group(s) this row stands in for (outermost; see isFoldedWrapper), or null. */
      wrapper: GroupLayer | null;
    }
  | { kind: 'head'; key: string; label: 'Style' | 'Effects'; depth: number; dimmed: boolean }
  | { kind: 'part'; layer: TitleLayer; part: PartKey; depth: number; dimmed: boolean }
  | { kind: 'effect'; layerId: string; part: PartKey | null; fx: EffectInstance; depth: number; dimmed: boolean }
  /** A 3D title's glint (`style3d.glint`): pinned first under its Effects, see ui/glint.ts. */
  | { kind: 'glint'; layer: Title3DLayer; depth: number; dimmed: boolean }
  /** A 2D title's かすれ dry brush (`style.erode`): pinned first under its Effects, see ui/erode.ts. */
  | { kind: 'erode'; layer: Title2DLayer; depth: number; dimmed: boolean }
  /** A companion generator listed under the Effects of the layer it follows (ui/companions.ts); `behind`: below that layer in the stack. */
  | { kind: 'companion'; owner: Layer; layer: GeneratorLayer; behind: boolean; depth: number; dimmed: boolean };

/**
 * A title's parts FRONT to back (face first, as a stack reads in PS). A 2D face switched off
 * (`hideFace`) is no part of the style but stays listed so its eye can turn it back on. A 3D
 * side is listed while the title owns a side material (`style3d.side`) or the side carries
 * effects; else it is part of the letter, which its face row stands for.
 */
export function listedParts(l: TitleLayer): PartKey[] {
  const parts = layerParts(l).reverse();
  if (l.kind === 'title2d' && l.style.hideFace) parts.unshift('face');
  return parts.filter((p) => p === listedPart(l, p));
}

/** The listed part standing for `part` (a viewport pick, say): a 3D side that isn't listed is its letter's face. */
export function listedPart(l: TitleLayer, part: PartKey): PartKey {
  return l.kind === 'title3d' && part === 'side' && !l.style3d.side && !partEffectsOf(l, 'side').length ? 'face' : part;
}

/** Twirl state of layer `l`: groups default open, everything else closed; null when it has nothing to list (`companions`: it lists some). */
export function twirlOf(l: Layer, expanded: Readonly<Record<string, boolean>>, companions = false): boolean | null {
  if (!isTitleLayer(l) && l.kind !== 'group' && l.effects.length === 0 && !companions) return null;
  return expanded[l.id] ?? l.kind === 'group';
}

/**
 * Rows top-first. A layer's Effects list its stack top-first: the companions in front of it, its
 * 3D glint or 2D かすれ while listed (ui/glint.ts, ui/erode.ts), its effects last-applied first,
 * then the companions behind it. Companions have no row of their own among the layers.
 */
export function buildRows(layers: readonly Layer[], expanded: Readonly<Record<string, boolean>>): PanelRow[] {
  const out: PanelRow[] = [];
  const listed = listedCompanions(layers);
  const asEffect = new Set([...listed.values()].flat().map((c) => c.id));
  const effectRows = (layerId: string, part: PartKey | null, fx: readonly EffectInstance[], depth: number, dimmed: boolean) => {
    for (let i = fx.length - 1; i >= 0; i--) out.push({ kind: 'effect', layerId, part, fx: fx[i], depth, dimmed: dimmed || !fx[i].enabled });
  };
  // A companion draws whether or not its layer is shown: dimmed by its own eye and its own groups'.
  const companionRows = (owner: Layer, list: readonly GeneratorLayer[], behind: boolean, depth: number) => {
    for (const c of list) out.push({ kind: 'companion', owner, layer: c, behind, depth, dimmed: !c.visible || ancestorsOf(layers, c.id).some((g) => !g.visible) });
  };
  // A folded companion group has no row: its members are listed in its place, its layer's row
  // standing in for it (`wrapper`, the outermost one).
  const walk = (parentId: string | null, depth: number, hiddenAbove: boolean, wrapper: GroupLayer | null = null) => {
    const kids = childrenOf(layers, parentId).filter((l) => !asEffect.has(l.id));
    const folded = parentId !== null ? layers.find((l) => l.id === parentId) : undefined;
    for (let i = kids.length - 1; i >= 0; i--) {
      const l = kids[i];
      if (l.kind === 'group' && isFoldedWrapper(layers, l)) {
        walk(l.id, depth, hiddenAbove || !l.visible, wrapper ?? l);
        continue;
      }
      const stands = wrapper && folded?.kind === 'group' && folded.companionGroupOf === l.id ? wrapper : null;
      // A folded row shows its group's place in the stack too: clipped with it, a base under it.
      const clipped = isClipped(layers, l.id) || (!!stands && isClipped(layers, stands.id));
      const above = kids[i + 1];
      const isBase = (!clipped && !!above && isClipped(layers, above.id)) || (!!stands && !clipped && clippedTo(layers, stands.id).length > 0);
      const dimmed = hiddenAbove || !l.visible;
      const open = twirlOf(l, expanded, listed.has(l.id));
      out.push({ kind: 'layer', layer: l, depth, clipped, isBase, dimmed, open, wrapper: stands });
      if (!open) continue;
      const sub = depth + 1;
      if (isTitleLayer(l)) {
        out.push({ kind: 'head', key: `${l.id}:style`, label: 'Style', depth: sub, dimmed });
        for (const part of listedParts(l)) {
          out.push({ kind: 'part', layer: l, part, depth: sub, dimmed });
          effectRows(l.id, part, partEffectsOf(l, part), sub + 1, dimmed);
        }
      }
      const glint = glintListed(l);
      const erode = erodeListed(l);
      const { front, back } = companionSides(layers, l.id, listed);
      if (l.effects.length || glint || erode || front.length || back.length) {
        out.push({ kind: 'head', key: `${l.id}:fx`, label: 'Effects', depth: sub, dimmed });
        companionRows(l, front, false, sub);
        if (glint) out.push({ kind: 'glint', layer: l, depth: sub, dimmed: dimmed || !l.style3d.glint.enabled });
        if (erode) out.push({ kind: 'erode', layer: l, depth: sub, dimmed: dimmed || !l.style.erode.enabled });
        effectRows(l.id, null, l.effects, sub, dimmed);
        companionRows(l, back, true, sub);
      }
      if (l.kind === 'group') walk(l.id, sub, dimmed);
    }
  };
  walk(null, 0, false);
  return out;
}

/** The tree node a row selects; null for the Style / Effects headings. */
export function rowNode(r: PanelRow): NodeRef | null {
  switch (r.kind) {
    case 'layer':
      return { kind: 'layer', layerId: r.layer.id };
    case 'part':
      return { kind: 'part', layerId: r.layer.id, part: r.part };
    case 'effect':
      return { kind: 'effect', layerId: r.layerId, part: r.part, effectId: r.fx.id };
    case 'glint':
      return { kind: 'glint', layerId: r.layer.id };
    case 'erode':
      return { kind: 'erode', layerId: r.layer.id };
    case 'companion':
      return { kind: 'layer', layerId: r.layer.id };
    case 'head':
      return null;
  }
}

export function sameNode(a: NodeRef | null, b: NodeRef | null): boolean {
  if (!a || !b || a.kind !== b.kind || a.layerId !== b.layerId) return false;
  if (a.kind === 'layer') return true;
  if (a.kind === 'part') return b.kind === 'part' && a.part === b.part;
  if (a.kind === 'parts') return b.kind === 'parts' && a.parts.length === b.parts.length && a.parts.every((p) => b.parts.includes(p));
  if (a.kind === 'mask') return b.kind === 'mask' && a.maskId === b.maskId;
  if (a.kind === 'glint' || a.kind === 'erode') return true;
  return b.kind === 'effect' && a.effectId === b.effectId && a.part === b.part;
}

/** Whether the row of `row` shows as focused for the selected node `sel`: its own node, or one of several selected parts. */
export function rowFocused(row: NodeRef | null, sel: NodeRef | null): boolean {
  return sameNode(row, sel) || (row?.kind === 'part' && sel?.kind === 'parts' && sel.layerId === row.layerId && sel.parts.includes(row.part));
}

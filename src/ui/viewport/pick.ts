import { companionOwner, isFoldedWrapper } from '../../model/companions';
import { isTitleLayer, type TitleLayer } from '../../model/parts';
import type { Comp, GeneratorLayer, Layer } from '../../model/types';
import { ancestorsOf, clipBaseOf, unionCompBounds } from '../../store/tree';
import { inBounds, isFullFrame, layerHit, type Pt } from './geometry';

// Canvas picking over the nested layer tree. Only leaves with pixels are hit: title layers and
// generator layers by their content box; full-frame generators (no box) only where they draw,
// and never over a layer with a box. Groups are picked through their members, and adjustment
// layers and backgrounds never are.

/** The layers a canvas press can hit. */
export type PickLayer = TitleLayer | GeneratorLayer;

/** Does full-frame generator `l` draw at comp point p? */
export type DrawsAt = (l: GeneratorLayer, p: Pt) => boolean;

/**
 * Predicate of the layers a canvas press or marquee may pick: title and generator layers that
 * are visible and unlocked along with every ancestor group; while anything is soloed, only
 * soloed layers (or members of a soloed group).
 */
export function pickable(layers: readonly Layer[]): (l: Layer) => l is PickLayer {
  const anySolo = layers.some((l) => l.solo && l.visible);
  return (l): l is PickLayer => {
    if (!(isTitleLayer(l) || l.kind === 'generator') || !l.visible || l.locked) return false;
    const up = ancestorsOf(layers, l.id);
    if (up.some((g) => !g.visible || g.locked)) return false;
    return !anySolo || l.solo || up.some((g) => g.solo);
  };
}

/** Does comp point p fall on the clip base's content (a group: its members' common box; a full-frame generator: anywhere)? */
function onBase(comp: Comp, layers: readonly Layer[], base: Layer, p: Pt): boolean {
  if (isFullFrame(base)) return true;
  if (isTitleLayer(base) || base.kind === 'generator') return layerHit(comp, base, p);
  const b = base.kind === 'group' ? unionCompBounds(layers, [base.id]) : null;
  return !!b && inBounds(b, p);
}

/**
 * Topmost pickable layer whose content box contains comp point p (a clipped layer only where its
 * base shows too, as it is drawn), optionally narrowed by `only`. When no layer with a box is
 * under p: the topmost full-frame generator that `drawsAt` p (none without `drawsAt`).
 */
export function hitLeaf(comp: Comp, layers: readonly Layer[], p: Pt, only?: (l: PickLayer) => boolean, drawsAt?: DrawsAt): PickLayer | undefined {
  const ok = pickable(layers);
  const shows = (l: Layer) => {
    const base = clipBaseOf(layers, l.id);
    return !base || onBase(comp, layers, base, p);
  };
  const full: GeneratorLayer[] = [];
  for (let i = layers.length - 1; i >= 0; i--) {
    const l = layers[i];
    if (!ok(l) || (only && !only(l))) continue;
    if (l.kind === 'generator' && isFullFrame(l)) full.push(l);
    else if (layerHit(comp, l, p) && shows(l)) return l;
  }
  return drawsAt ? full.find((l) => shows(l) && drawsAt(l, p)) : undefined;
}

/**
 * The layer Auto-Select picks for a hit leaf: the leaf itself, or its top-level group ('group'),
 * never a folded companion group (it has no row: its layer stands for it). A companion generator
 * (listed as an effect of the layer it follows) picks that layer, as an effect's pixels pick their
 * layer — while that layer is shown and unlocked (else the companion).
 */
export function autoSelectTarget(layers: readonly Layer[], leaf: PickLayer, mode: 'layer' | 'group'): Layer {
  const owner = companionOwner(layers, leaf);
  const l = owner?.visible && !owner.locked ? owner : leaf;
  return mode === 'group' ? (ancestorsOf(layers, l.id).filter((g) => !isFoldedWrapper(layers, g)).at(-1) ?? l) : l;
}

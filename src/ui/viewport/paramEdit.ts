import type { TitleLayer } from '../../model/parts';
import type { Comp, GradientMask, Layer } from '../../model/types';
import { useEditor, type PropRef } from '../../store/store';
import { oneShot } from '../util';
import { press, type StageMap } from './drag';
import { layerView } from './geometry';
import { gradientFromLine, type GradParams } from './gradient';
import { gradientBox, type FillGradient, type GradientTarget } from './gradientTarget';
import { gradientMaskFromLine, maskView, snapOnCanvas } from './mask';

// Pointer mapping and store writes of the param handles (ParamHandles) and the Gradient tool's
// canvas drag (Viewport): a fill's gradient, or a gradient mask's line.

export const ref = (layer: TitleLayer, path: (string | number)[]): PropRef => ({ layerId: layer.id, path });

/** Pointer → layer-space point on the layer's front face. */
export function pointerOn(comp: Comp, layer: TitleLayer, stage: StageMap) {
  const view = layerView(comp, layer);
  return (ev: { clientX: number; clientY: number }) => view.fromComp(stage.toComp(ev.clientX, ev.clientY), 0);
}

/** Write the changed gradient params of the target, one undo step per `key`. */
export function writeGradient(layer: TitleLayer, g: FillGradient, patch: Partial<GradParams>, key: string) {
  const { setAt } = useEditor.getState();
  for (const k of ['angle', 'scale', 'offset'] as const) if (patch[k] !== undefined && patch[k] !== g.params[k]) setAt(ref(layer, [...g.paths[k]]), patch[k], key, 'Gradient tool');
}

/**
 * Gradient tool drag on the canvas: lay the target's gradient from the press to the pointer
 * (Shift: 15°). Returns false (nothing started) when the target has no gradient or box.
 */
export function startGradientLay(e: React.PointerEvent, comp: Comp, target: GradientTarget, selectedChars: readonly number[], stage: StageMap, onClick: () => void): boolean {
  const g = target.grad;
  const box = g && gradientBox(target, g.span, selectedChars);
  const at = pointerOn(comp, target.layer, stage);
  const a = at(e);
  if (!g || !box || !a) return false;
  const key = oneShot(`grad-lay:${target.layer.id}`);
  press(e, {
    onClick,
    onDrag: (ev) => {
      const b = at(ev);
      if (b) writeGradient(target.layer, g, gradientFromLine(g.params, box, a, b, ev.shiftKey), key);
    },
  });
  return true;
}

/** Gradient tool drag with a gradient mask selected: lay the mask's line from the press to the pointer (Shift: 15°). */
export function startMaskGradientLay(e: React.PointerEvent, layer: Layer, mask: GradientMask, stage: StageMap, onClick: () => void) {
  const space = maskView(layer, mask);
  const a = space.fromComp(stage.toComp(e.clientX, e.clientY));
  const key = oneShot(`mask-lay:${mask.id}`);
  press(e, {
    onClick,
    onDrag: (ev) => {
      const b = space.fromComp(stage.toComp(ev.clientX, ev.clientY));
      if (a && b) useEditor.getState().updateMask(layer.id, mask.id, gradientMaskFromLine(a, ev.shiftKey ? snapOnCanvas(space, a, b) : b), key, 'Mask gradient');
    },
  });
}

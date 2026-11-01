import { isTitleLayer } from '../../model/parts';
import type { Layer, LayerMask } from '../../model/types';
import { errorMsg } from '../../store/msg';
import { useEditor, type PropRef } from '../../store/store';
import { CheckRow, RefCheck, RefNum, RefSelect, Section } from '../controls';
import { useT } from '../i18n';
import { bakeMask } from '../layers/maskBake';
import { LayerPicker } from './ParamControl';
import { ShapeFields } from './TextSection';

/**
 * Mask node: the mask's switches (enabled, invert, linked), feather and density, then its kind's
 * fields — the shape with its placement, the gradient's line, or the source layer and channel.
 * Its on-canvas handles show because the selected node is this mask.
 */
export function MaskView({ layer, mask }: { layer: Layer; mask: LayerMask }) {
  const t = useT();
  const viewing = useEditor((s) => s.view.viewMask === layer.id);
  const { setMaskEnabled, updateMask, removeMask, setView, notify } = useEditor.getState();
  const r = (...k: string[]): PropRef => ({ layerId: layer.id, path: ['masks', layer.masks.indexOf(mask), ...k] });
  const kind = mask.kind === 'shape' ? t('Vector mask') : mask.kind === 'gradient' ? t('Gradient mask') : t('Layer mask');
  const space = mask.linked ? t('From the layer position, in the layer’s own space (+y up)') : t('From the comp centre, in comp px (+y up)');
  const image = isTitleLayer(layer) && layer.source.kind === 'image';
  return (
    <>
      <Section id="mask" title={kind}>
        <CheckRow label={t('Enabled')} value={mask.enabled} title={t('⇧-click the mask chip in the Layers panel to switch it too')} onChange={(v) => setMaskEnabled(layer.id, mask.id, v)} />
        <RefCheck label={t('Invert')} refp={r('invert')} title={t('Swap the shown and hidden areas')} />
        {mask.kind !== 'layer' && (
          <CheckRow
            label={t('Linked')}
            value={mask.linked}
            title={t('Linked: the mask moves, turns and scales with the layer. Unlinked: it stays put on the canvas')}
            onChange={(linked) => updateMask(layer.id, mask.id, { linked })}
          />
        )}
        <RefNum label={t('Feather', undefined, { ctx: 'mask' })} refp={r('feather')} min={0} max={500} step={0.5} unit="px" clamp defaultValue={0} title={t('Edge softness: Gaussian blur of the mask, comp px')} />
        <RefNum label={t('Density', undefined, { ctx: 'mask' })} refp={r('density')} min={0} max={1} step={0.01} display={100} unit="%" clamp defaultValue={1} title={t('How strongly the mask hides: 50% leaves hidden areas half visible')} />
        <CheckRow label={t('View mask')} value={viewing} title={t('Show the layer’s combined masks in greyscale over the canvas (⌥-click a mask chip)')} onChange={(v) => setView({ viewMask: v ? layer.id : null })} />
        <div className="mask-actions">
          <button className="small" title={t('Delete this mask (Del)')} onClick={() => removeMask(layer.id, mask.id)}>
            {t('Delete mask')}
          </button>
          {image && (
            <button className="small" title={t('Bake the mask into the picture’s transparency and remove it')} onClick={() => bakeMask(layer.id, mask.id).catch((e: unknown) => notify(errorMsg(e), 'error'))}>
              {t('Apply mask')}
            </button>
          )}
        </div>
      </Section>
      {mask.kind === 'shape' && (
        <Section id="mask-shape" title={t('Shape')}>
          <ShapeFields src={mask.source} base={r('source')} />
          <RefNum label={t('X')} refp={r('x')} min={-4000} max={4000} step={1} unit="px" title={space} />
          <RefNum label={t('Y')} refp={r('y')} min={-4000} max={4000} step={1} unit="px" title={space} />
          <RefNum label={t('Rotation')} refp={r('rotation')} min={-180} max={180} step={0.5} unit="deg" defaultValue={0} title={t('Clockwise')} />
        </Section>
      )}
      {mask.kind === 'gradient' && (
        <Section id="mask-gradient" title={t('Gradient')}>
          <RefSelect
            label={t('Shape')}
            refp={r('shape')}
            options={[
              { value: 'linear', label: t('Linear') },
              { value: 'radial', label: t('Radial') },
            ]}
          />
          <RefNum label={t('X')} refp={r('x')} min={-4000} max={4000} step={1} unit="px" title={space} />
          <RefNum label={t('Y')} refp={r('y')} min={-4000} max={4000} step={1} unit="px" title={space} />
          {mask.shape === 'linear' && <RefNum label={t('Angle')} refp={r('angle')} min={-180} max={180} step={0.5} unit="deg" title={t('Direction from the opaque start toward the transparent end, counter-clockwise from →')} />}
          <RefNum label={t('Length')} refp={r('length')} min={1} max={4000} step={1} unit="px" clamp title={t(mask.shape === 'linear' ? 'Distance from opaque to transparent' : 'Radius where the mask turns transparent')} />
          {mask.shape === 'radial' && <RefNum label={t('Inner')} refp={r('inner')} min={0} max={0.99} step={0.01} display={100} unit="%" clamp title={t('Share of the radius that stays fully opaque')} />}
          <RefNum label={t('Midpoint')} refp={r('mid')} min={0.01} max={0.99} step={0.01} display={100} unit="%" clamp defaultValue={0.5} title={t('Where along the gradient the mask is half transparent')} />
          <div className="hint-line">{t('Drag on the canvas with the Gradient tool (G) to lay the line.')}</div>
        </Section>
      )}
      {mask.kind === 'layer' && (
        <Section id="mask-layer" title={t('Source layer')}>
          <LayerPicker label={t('Layer')} refp={r('layerId')} noNone title={t('The layer drawn alone, with its effects, whose pixels shape this mask (it still draws itself unless hidden)')} />
          <RefSelect
            label={t('Channel')}
            refp={r('channel')}
            options={[
              { value: 'alpha', label: t('Alpha') },
              { value: 'luminance', label: t('Luminance') },
            ]}
          />
          <div className="hint-line">{t('Always in comp space: the masked layer moves under it.')}</div>
        </Section>
      )}
    </>
  );
}

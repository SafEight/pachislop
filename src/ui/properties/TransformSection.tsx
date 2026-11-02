import { useMemo, useRef, useState } from 'react';
import { followTarget, generatorFillsComp, getGenerator } from '../../generators/registry';
import { defaultTransform } from '../../model/defaults';
import type { GeneratorLayer, GroupLayer, Layer } from '../../model/types';
import { isTitleLayer, type TitleLayer } from '../../model/parts';
import { useEditor, type AlignMode, type Refs } from '../../store/store';
import { flipTargets } from '../../store/transformOps';
import { unionCompBounds } from '../../store/tree';
import { NumRow, RefNum, Section } from '../controls';
import { useT } from '../i18n';
import { oneShot } from '../util';
import { InfoTip } from './InfoTip';

/** A generator drawing over the whole comp (generatorFillsComp; unknown types too). */
const isFullFrame = (layer: GeneratorLayer): boolean => !getGenerator(layer.generator.type) || generatorFillsComp(layer.generator);

const ALIGNS: { a: AlignMode; icon: string; label: string }[] = [
  { a: 'left', icon: '⇤', label: 'left edges' },
  { a: 'hcenter', icon: '↔', label: 'horizontal centres' },
  { a: 'right', icon: '⇥', label: 'right edges' },
  { a: 'top', icon: '⤒', label: 'top edges' },
  { a: 'vmiddle', icon: '↕', label: 'vertical centres' },
  { a: 'bottom', icon: '⤓', label: 'bottom edges' },
];

const SIZE_NOUN: Record<TitleLayer['source']['kind'], string> = { text: 'Font size', shape: 'Height', svg: 'Size', image: 'Size', model: 'Size' };

/**
 * The size the layer really has on the comp: its source size (font em / shape height / fitted
 * side) times Transform Scale, so a scaled shape doesn't claim "300 px" while drawing 430.
 */
function EffectiveSize({ layer }: { layer: TitleLayer }) {
  const t = useT();
  const src = layer.source;
  const s = layer.transform.scale;
  const eff = Math.round(src.size * s);
  const w = src.kind === 'shape' ? Math.round(src.size * src.aspect * s) : null;
  const noun = t(SIZE_NOUN[src.kind]);
  return (
    <div className="hint-line eff-size" title={t('Effective size on the comp = the source size × Scale')}>
      <span title={t('{noun} {size} px × Scale {scale} %', { noun, size: Math.round(src.size), scale: Math.round(s * 100) })}>
        {t('Size')} {w !== null ? `${w} × ${eff} px` : `${eff} px`}
        {s !== 1 && <> ({Math.round(src.size)} px × {Math.round(s * 100)} %)</>}
      </span>
      {s !== 1 && (
        <button
          className="small"
          title={t('Bake Scale into {noun}: {noun} becomes {eff} px and Scale 100 % (looks the same; size-relative style units follow)', { noun, eff })}
          onClick={() =>
            useEditor
              .getState()
              .replaceLayer(layer.id, { ...layer, source: { ...src, size: Math.round(src.size * s * 100) / 100 }, transform: { ...layer.transform, scale: 1 } } as TitleLayer, undefined, 'Apply scale to size')
          }
        >
          {t('Apply scale')}
        </button>
      )}
    </div>
  );
}

/**
 * Align / distribute / flip for the selected layers (to the comp when one is selected), as one
 * compact toolbar row: six align, two distribute (3+ layers), two flip buttons.
 */
export function AlignBar() {
  const t = useT();
  const ids = useEditor((s) => s.selectedLayerIds);
  const canFlip = useEditor((s) => flipTargets(s.project.layers, s.selectedLayerIds).length > 0);
  const { alignLayers, distributeLayers, flipLayers } = useEditor.getState();
  const to = ids.length >= 2 ? t("the {n} selected layers' common box", { n: ids.length }) : t('the comp');
  return (
    <div className="xf-tools" role="toolbar" aria-label={t('Align, distribute and flip')}>
      <span className="align-btns" title={t("Line the layers' boxes up with {to} (rims included, effects not)", { to })}>
        {ALIGNS.map((al) => (
          <button
            key={al.a}
            className="small"
            title={t('Align {what} to {to}', { what: t(al.label), to })}
            aria-label={t('Align {what}', { what: t(al.label) })}
            onClick={() => alignLayers(ids, al.a)}
          >
            {al.icon}
          </button>
        ))}
      </span>
      <span className="align-btns">
        <button
          className="small"
          disabled={ids.length < 3}
          title={t('Distribute horizontally: equal gaps between the selected layers (3+)')}
          aria-label={t('Distribute horizontally')}
          onClick={() => distributeLayers(ids, 'x')}
        >
          ⇹
        </button>
        <button
          className="small"
          disabled={ids.length < 3}
          title={t('Distribute vertically: equal gaps between the selected layers (3+)')}
          aria-label={t('Distribute vertically')}
          onClick={() => distributeLayers(ids, 'y')}
        >
          ⇳
        </button>
      </span>
      <span className="align-btns" title={t('Mirror the selected layers in place (Edit ▸ Transform ▸ Flip); several mirror across their common box')}>
        <button className="small" disabled={!canFlip} title={t('Flip Horizontal: mirror left ↔ right')} aria-label={t('Flip Horizontal')} onClick={() => flipLayers(ids, 'x')}>
          ⇆
        </button>
        <button className="small" disabled={!canFlip} title={t('Flip Vertical: mirror top ↔ bottom')} aria-label={t('Flip Vertical')} onClick={() => flipLayers(ids, 'y')}>
          ⇅
        </button>
      </span>
    </div>
  );
}

/**
 * Position, rotation, scale of titles or generators in compact rows (3D: X / Y / Z, then
 * rotation X / Y / Z, as the Letters section and the canvas gizmo), under the align / distribute
 * / flip toolbar. Opacity is the Layers panel header's. Several layers (a multi-selection) edit
 * together: a typed value moves every layer there, scrubbing moves them all by the same amount
 * (keeping their spacing); Z and rotation X / Y show when all are 3D.
 */
export function TransformSection({ layers }: { layers: readonly (TitleLayer | GeneratorLayer)[] }) {
  const t = useT();
  const layer = layers[0];
  const single = layers.length === 1;
  const r = (k: keyof Layer['transform']): Refs => (single ? { layerId: layer.id, path: ['transform', k] } : layers.map((l) => ({ layerId: l.id, path: ['transform', k] })));
  const is3d = layers.every((l) => l.kind === 'title3d');
  const title = single && isTitleLayer(layer) ? layer : null;
  const fullFrame = layer.kind === 'generator' && isFullFrame(layer);
  const following = layer.kind === 'generator' && followTarget(layer.generator) !== '';
  const ids = useEditor((s) => s.selectedLayerIds);
  const patchLayer = useEditor((s) => s.patchLayer);
  const tip = !single
    ? null
    : following
      ? t('Follows a layer: it draws where that layer is, and the transform is an offset on top.')
      : fullFrame
        ? t('Fills the whole comp: the transform moves, turns and scales its pattern.')
        : null;
  const reset = () => {
    // One undo step for every layer.
    const k = oneShot('reset-xf');
    for (const l of layers) patchLayer(l.id, { transform: { ...defaultTransform(), opacity: l.transform.opacity } }, k);
  };
  return (
    <Section
      id="transform"
      title={
        <>
          {t('Transform')}
          {!single && <span className="muted"> · {t('{n} layers', { n: layers.length })}</span>}
          {tip && <InfoTip text={tip} />}
        </>
      }
      actions={
        <button className="small" title={single ? t('Reset position, rotation and scale') : t('Reset position, rotation and scale of the {n} layers', { n: layers.length })} onClick={reset}>
          {t('Reset')}
        </button>
      }
    >
      <AlignBar />
      {!single && <div className="hint-line">{t('The values edit all {n} layers: typing sets every layer to it, scrubbing moves them together.', { n: layers.length })}</div>}
      {single && ids.length >= 2 && (
        <div className="hint-line">{t('Align / distribute / flip act on all {n} selected layers; the values below edit “{name}” only.', { n: ids.length, name: layer.name })}</div>
      )}
      <div className="xf-grid">
        <RefNum label="X" refp={r('x')} min={-1500} max={1500} step={1} unit="px" slider={false} title={t('From comp centre, + = right')} />
        <RefNum label="Y" refp={r('y')} min={-1000} max={1000} step={1} unit="px" slider={false} title={t('From comp centre, + = up')} />
        {is3d && <RefNum label="Z" refp={r('z')} min={-3000} max={1000} step={1} unit="px" slider={false} title={t('+ = toward the viewer')} />}
      </div>
      {is3d && (
        <div className="xf-grid">
          <RefNum label={t('Rotation X')} refp={r('rotX')} min={-180} max={180} step={0.5} unit="deg" slider={false} title={t('+ = top toward the viewer')} />
          <RefNum label={t('Rotation Y')} refp={r('rotY')} min={-180} max={180} step={0.5} unit="deg" slider={false} title={t('+ = right side away from the viewer')} />
          <RefNum label={t('Rotation Z')} refp={r('rotZ')} min={-180} max={180} step={0.5} unit="deg" slider={false} title={t('Clockwise on screen')} />
        </div>
      )}
      <div className="xf-grid">
        {!is3d && <RefNum label={t('Rotation')} refp={r('rotZ')} min={-180} max={180} step={0.5} unit="deg" slider={false} title={t('Clockwise on screen')} />}
        <RefNum label={t('Scale')} refp={r('scale')} min={0.05} max={4} step={0.01} display={100} unit="%" slider={false} />
      </div>
      {title && <EffectiveSize layer={title} />}
    </Section>
  );
}

/**
 * A group's transform: its members move, rotate and scale as one about their common box centre,
 * as when the group is dragged on the canvas (the group itself stores no transform). X / Y are
 * that centre; Rotation and Scale count from where the members stood, and read 0° / 100 % again
 * once something else changes the layers (an undo, a canvas drag).
 */
export function GroupTransformSection({ layer }: { layer: GroupLayer }) {
  const t = useT();
  const layers = useEditor((s) => s.project.layers);
  const { nudgeLayers, transformLayers } = useEditor.getState();
  const box = useMemo(() => unionCompBounds(layers, [layer.id]), [layers, layer.id]);
  /** Rotation / Scale applied from here, valid while the layers are still the ones they produced. */
  const [acc, setAcc] = useState<{ rot: number; scale: number; after: readonly Layer[] | null }>({ rot: 0, scale: 1, after: null });
  /** The gesture in progress: its coalesce key, the layers at its start and the values shown then. */
  const gesture = useRef<{ key: string; base: readonly Layer[]; rot: number; scale: number } | null>(null);
  const fresh = acc.after === layers;
  const rot = fresh ? acc.rot : 0;
  const scale = fresh ? acc.scale : 1;
  const done = (next: { rot: number; scale: number }) => setAcc({ ...next, after: useEditor.getState().project.layers });
  const begin = (key: string) => {
    if (gesture.current?.key !== key) gesture.current = { key, base: useEditor.getState().project.layers, rot, scale };
    return gesture.current;
  };
  const cx = box ? Math.round(((box.x0 + box.x1) / 2) * 100) / 100 : 0;
  const cy = box ? Math.round(((box.y0 + box.y1) / 2) * 100) / 100 : 0;
  const id = `group-xf:${layer.id}`;
  return (
    <Section
      id="group-transform"
      title={
        <>
          {t('Transform')}
          <InfoTip text={t('Moves, rotates and scales the members as one, about the centre of their common box (like dragging the group on the canvas).')} />
        </>
      }
    >
      <AlignBar />
      {box ? (
        <>
          <div className="xf-grid">
            <NumRow
              label="X"
              id={`${id}:x`}
              value={cx}
              min={-1500}
              max={1500}
              step={1}
              unit="px"
              slider={false}
              title={t('Centre of the members, from comp centre, + = right')}
              onChange={(v, c) => {
                nudgeLayers([layer.id], v - cx, 0, c);
                done({ rot, scale });
              }}
            />
            <NumRow
              label="Y"
              id={`${id}:y`}
              value={cy}
              min={-1000}
              max={1000}
              step={1}
              unit="px"
              slider={false}
              title={t('Centre of the members, from comp centre, + = up')}
              onChange={(v, c) => {
                nudgeLayers([layer.id], 0, v - cy, c);
                done({ rot, scale });
              }}
            />
          </div>
          <div className="xf-grid">
            <NumRow
              label={t('Rotation')}
              id={`${id}:r`}
              value={rot}
              min={-180}
              max={180}
              step={0.5}
              unit="deg"
              slider={false}
              title={t('Clockwise on screen')}
              onChange={(v, c) => {
                const g = begin(c);
                transformLayers([layer.id], { rotate: v - g.rot }, c, 'Rotate group', g.base);
                done({ rot: v, scale });
              }}
            />
            <NumRow
              label={t('Scale')}
              id={`${id}:s`}
              value={scale}
              min={0.05}
              max={4}
              step={0.01}
              display={100}
              unit="%"
              slider={false}
              onChange={(v, c) => {
                const g = begin(c);
                const s = Math.max(0.05, v);
                transformLayers([layer.id], { scale: s / g.scale }, c, 'Scale group', g.base);
                done({ rot, scale: s });
              }}
            />
          </div>
        </>
      ) : (
        <div className="hint-line">{t('No member has a box to transform.')}</div>
      )}
    </Section>
  );
}

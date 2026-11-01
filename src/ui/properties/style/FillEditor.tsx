import type { Fill, FillKind, Gradient, GradientSpan, ImageFill } from '../../../model/types';
import { getRefs, isMultiRef, refKey, refList } from '../../../store/paths';
import { useEditor, type Refs } from '../../../store/store';
import { NumberField, RefCheck, RefNum, RefColor, Row, Seg } from '../../controls';
import { GradientEditor } from '../../GradientEditor';
import { useT } from '../../i18n';
import { oneShot, useMixed } from '../../util';
import { FillKindIcon } from './icons';
import { FILL_KINDS, fillCss, findHorizon, moveHorizon, pinchHorizon, sub, tOpts } from './shared';
import { IconChoice, ImageAssetPicker } from './widgets';

const KIND_OPTIONS = FILL_KINDS.map((k) => ({ ...k, icon: <FillKindIcon kind={k.value} /> }));

const SPANS: readonly { value: GradientSpan; label: string; title: string }[] = [
  { value: 'layer', label: 'Layer', title: 'One gradient across the whole element' },
  { value: 'line', label: 'Line', title: 'The full gradient on every line (column when vertical)' },
  { value: 'char', label: 'Char', title: 'The full gradient on every character' },
];
const IMAGE_SPANS: readonly { value: GradientSpan; label: string; title: string }[] = [
  { value: 'layer', label: 'Layer', title: 'One image across the whole element' },
  { value: 'line', label: 'Line', title: 'The image on every line (column when vertical)' },
  { value: 'char', label: 'Char', title: 'The image on every character' },
];

const USES_ANGLE: Partial<Record<FillKind, true>> = { linear: true, reflected: true, angle: true };

/** Image placement before a picture is chosen: cover the span box, untransformed. */
const newImageFill = (assetId = ''): ImageFill => ({ assetId, scale: 1, offsetX: 0, offsetY: 0, rotate: 0, tile: false });

/**
 * Every fill kind (2D face & rims, background); span only for text titles. Over several targets
 * `fill` is the first one's; differing values show “—” and an edit sets every target.
 */
export function FillEditor({ refp, fill }: { refp: Refs; fill: Fill }) {
  const t = useT();
  const setAt = useEditor((s) => s.setAt);
  const setEachAt = useEditor((s) => s.setEachAt);
  const isText = useEditor((s) =>
    refList(refp).every((r) => {
      const l = s.project.layers.find((x) => x.id === r.layerId);
      return l?.kind === 'title2d' && l.source.kind === 'text';
    }),
  );
  const gradRef = sub(refp, 'gradient');
  const imgRef = sub(refp, 'image');
  const [fillMixed, kindMixed, spanMixed, gradMixed] = useMixed(refp, sub(refp, 'kind'), sub(refp, 'span'), gradRef);
  const horizon = fill.kind === 'solid' || fill.kind === 'image' ? null : findHorizon(fill.gradient);
  const pickKind = (v: FillKind) => {
    // An image fill needs its placement record; add it in the same undo step.
    if (v === 'image' && getRefs(useEditor.getState().project, refp).some((f) => !(f as Fill).image))
      setEachAt(refp, (f) => ({ ...(f as Fill), kind: v, image: (f as Fill).image ?? newImageFill() }));
    else setAt(sub(refp, 'kind'), v);
  };
  // Several targets: each gradient's horizon moves from where it was when the drag began.
  const setHorizon = (v: number, c: string) => (isMultiRef(gradRef) ? setEachAt(gradRef, (g) => moveHorizon(g as Gradient, v), c) : setAt(gradRef, moveHorizon(fill.gradient, v), c));
  return (
    <>
      <IconChoice label={t('Type')} value={fill.kind} mixed={kindMixed} options={tOpts(t, KIND_OPTIONS)} onChange={pickKind} />
      <div className="sty-strip checker" title={t('Fill preview')}>
        <span className={fillMixed ? 'mixed-stripes' : undefined} style={{ background: fillCss(fill) }} />
      </div>
      {fill.kind === 'solid' ? (
        <RefColor label={t('Colour')} refp={sub(refp, 'color')} />
      ) : fill.kind === 'image' ? (
        <>
          <ImageAssetPicker
            label={t('Image')}
            title={t('The picture to fill with (Photoshop Pattern Overlay with an imported image)')}
            assetId={fill.image?.assetId}
            onPick={(id) => setEachAt(imgRef, (img) => ({ ...((img as ImageFill | undefined) ?? newImageFill()), assetId: id }), oneShot(refKey(imgRef)))}
          />
          {isText && (
            <Row label={t('Span')} title={t('What one image covers')}>
              <Seg value={fill.span} mixed={spanMixed} options={tOpts(t, IMAGE_SPANS)} onChange={(v) => setAt(sub(refp, 'span'), v)} />
            </Row>
          )}
          <RefNum label={t('Scale')} refp={sub(imgRef, 'scale')} min={0.1} max={4} unit="x" defaultValue={1} title={t('1× = the image just covers the span box')} />
          <RefNum label={t('Offset X →')} refp={sub(imgRef, 'offsetX')} min={-1} max={1} display={100} unit="%" defaultValue={0} title={t('Shift right, % of the span box width')} />
          <RefNum label={t('Offset Y ↑')} refp={sub(imgRef, 'offsetY')} min={-1} max={1} display={100} unit="%" defaultValue={0} title={t('Shift up, % of the span box height')} />
          <RefNum label={t('Rotate')} refp={sub(imgRef, 'rotate')} min={-180} max={180} step={1} unit="deg" defaultValue={0} title={t('Clockwise on screen')} />
          <RefCheck label={t('Tile')} refp={sub(imgRef, 'tile')} title={t('Repeat the image beyond its edges (off: the edge pixels stretch outward)')} />
        </>
      ) : (
        <>
          <GradientEditor id={refKey(gradRef)} value={fill.gradient} mixed={gradMixed} onChange={(g, c) => setAt(gradRef, g, c)} />
          <Row label={t('Horizon')} title={t('Chrome horizon: a hard edge between two coincident stops (sky above, ground below)')}>
            <button title={t('Pinch the two middle stops into a hard chrome horizon')} onClick={() => setEachAt(gradRef, (g) => pinchHorizon(g as Gradient), oneShot(refKey(gradRef)))}>
              {t('Pinch horizon')}
            </button>
            {horizon !== null && (
              <NumberField
                id={`${refKey(gradRef)}:horizon`}
                label={t('Horizon position')}
                value={horizon}
                mixed={gradMixed}
                onChange={setHorizon}
                min={0.02}
                max={0.98}
                clamp
                display={100}
                unit="%"
              />
            )}
          </Row>
          {isText && fill.kind !== 'shapeBurst' && (
            <Row label={t('Span')} title={t('What one full gradient covers')}>
              <Seg value={fill.span} mixed={spanMixed} options={tOpts(t, SPANS)} onChange={(v) => setAt(sub(refp, 'span'), v)} />
            </Row>
          )}
          {USES_ANGLE[fill.kind] && (
            <RefNum
              label={t('Angle')}
              refp={sub(refp, 'angle')}
              min={0}
              max={360}
              step={1}
              unit="deg"
              title={fill.kind === 'angle' ? t('Where the sweep starts: 0° = right, 90° = down (clockwise)') : t('90° = top → bottom, 0° = left → right')}
            />
          )}
          <RefNum label={t('Scale')} refp={sub(refp, 'scale')} min={0.1} max={3} unit="x" title={t('Gradient span relative to the span box (shape burst: to the deepest point)')} />
          <RefNum label={t('Offset')} refp={sub(refp, 'offset')} min={-1} max={1} clamp display={100} unit="%" title={t('Shift along the gradient')} />
        </>
      )}
    </>
  );
}

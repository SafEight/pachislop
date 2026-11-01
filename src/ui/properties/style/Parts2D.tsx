import type { Material2D, PlateShape, Title2DLayer } from '../../../model/types';
import { refKey } from '../../../store/paths';
import { useEditor, type PropRef, type Refs } from '../../../store/store';
import { CheckRow, IconBtn, NumberField, RefCheck, RefNum, Row, Section, Seg } from '../../controls';
import { useT } from '../../i18n';
import { oneShot, useRefValue } from '../../util';
import { refsOf } from '../parts';
import { PlateIcon } from './icons';
import { Material2DEditor } from './Material2DEditor';
import { MaterialLink } from './MaterialLink';
import { fillCss, material2DClipboard, sub, tOpts } from './shared';
import { ClipActions, FlippedNum, IconChoice, SwatchTitle } from './widgets';

// 2D layer style (Eye Candy / Photoshop layer-style replacement) split by part: the face and each
// rim get their own editor (Properties › part node); knockout and かすれ belong to no part and sit
// in the layer node's Style section.

const JOINS = [
  { value: 'miter', label: 'Miter', title: 'Sharp corners (classic pachislot look)' },
  { value: 'round', label: 'Round' },
  { value: 'bevel', label: 'Bevel' },
] as const;

const PLATES: readonly { value: PlateShape['kind']; label: string; title: string }[] = [
  { value: 'contour', label: 'Contour', title: 'Contour: follow the outline (Close bridges gaps between letters)' },
  { value: 'hull', label: 'Hull', title: 'Hull: one convex plate around the whole word' },
  { value: 'box', label: 'Box', title: 'Box: a chamfered box around the word, leaning with Slant + the text shear (北斗 / カバネリ plates)' },
];
const PLATE_OPTIONS = PLATES.map((p) => ({ ...p, icon: <PlateIcon kind={p.value} /> }));

/**
 * The material of a 2D part (face or rim): swatch, "Material", copy / paste, then the
 * Material2DEditor. `id` keys the remembered open state of it and its groups. Over several
 * targets `mat` is the first one's (the fields show “—” where they differ).
 */
export function PartMaterial2D({ id, refp, mat }: { id: string; refp: Refs; mat: Material2D }) {
  const t = useT();
  return (
    <Section
      id={id}
      title={<SwatchTitle css={fillCss(mat.fill)}>{t('Material')}</SwatchTitle>}
      actions={
        <>
          <MaterialLink refp={refp} kind="2d" />
          <ClipActions clip={material2DClipboard} value={mat} refp={refp} />
        </>
      }
    >
      <Material2DEditor id={id} refp={refp} mat={mat} />
    </Section>
  );
}

/**
 * The face of a 2D title: its material. Renders on the part page or inline under a part row;
 * `id` (default "part") prefixes its sections' remembered open state, unique on the page.
 * `layers`: the titles whose faces are edited together (one for a single part).
 */
export function Face2DEditor({ layers, id = 'part' }: { layers: readonly Title2DLayer[]; id?: string }) {
  return <PartMaterial2D id={`${id}-material`} refp={refsOf(layers.map((l) => ({ layerId: l.id, path: ['style', 'face'] })))} mat={layers[0].style.face} />;
}

/** A rim of a title, by its index in `style.rims`. */
export interface RimTarget {
  layer: Title2DLayer;
  index: number;
}

/**
 * Rims (縁取り), one or several edited together: their material first, then their geometry
 * (width, joins, base shape, offset). Shape-specific rows show while every rim has that shape.
 * Renders on the part page or inline; `id` as for Face2DEditor.
 */
export function RimEditor({ rims, id = 'part' }: { rims: readonly RimTarget[]; id?: string }) {
  const t = useT();
  const setAt = useEditor((s) => s.setAt);
  const rimRef = refsOf(rims.map(({ layer, index }) => ({ layerId: layer.id, path: ['style', 'rims', index] })));
  const plateRef = sub(rimRef, 'plate');
  const join = useRefValue(sub(rimRef, 'join'));
  const shape = useRefValue(sub(plateRef, 'kind'));
  const kind = shape.mixed ? null : (shape.value as PlateShape['kind']);
  const first = rims[0].layer.style.rims[rims[0].index];
  return (
    <>
      <PartMaterial2D id={`${id}-material`} refp={sub(rimRef, 'material')} mat={first.material} />
      <Section id={`${id}-geometry`} title={t('Geometry')}>
        <RefNum label={t('Width')} refp={sub(rimRef, 'width')} min={0} max={8} step={0.05} unit="%" />
        <Row label={t('Joins')} title={t('How the rim turns the corners of the letters')}>
          <Seg value={first.join} mixed={join.mixed} options={tOpts(t, JOINS)} onChange={(v) => setAt(sub(rimRef, 'join'), v)} />
        </Row>
        <IconChoice label={t('Shape')} value={first.plate.kind} mixed={shape.mixed} options={tOpts(t, PLATE_OPTIONS)} onChange={(v) => setAt(sub(plateRef, 'kind'), v)} />
        {kind === 'contour' && (
          <RefNum
            label={t('Close', undefined, { ctx: 'plate' })}
            refp={sub(plateRef, 'close')}
            min={0}
            max={20}
            step={0.1}
            unit="%"
            defaultValue={0}
            title={t('Bridge gaps and fill notches narrower than about twice this (grow, then shrink back)')}
          />
        )}
        {kind === 'box' && (
          <>
            <RefNum label={t('Chamfer')} refp={sub(plateRef, 'corner')} min={0} max={20} step={0.1} unit="%" title={t('Chamfer of the box corners')} />
            <RefNum label={t('Slant')} refp={sub(plateRef, 'slant')} min={-45} max={45} step={0.5} unit="deg" defaultValue={0} title={t("Lean of the box, positive leans right (the text's shear is added)")} />
          </>
        )}
        <RefCheck label={t('Fill counters')} refp={sub(rimRef, 'fillCounters')} title={t('Fill the holes of 口, B, O… so the rim is a solid plate')} />
        <RefNum label={t('Offset X →')} refp={sub(rimRef, 'offsetX')} min={-10} max={10} step={0.05} unit="%" defaultValue={0} title={t('+ = right on screen')} />
        <FlippedNum label={t('Offset Y ↑')} refp={sub(rimRef, 'offsetY')} min={-10} max={10} step={0.05} unit="%" defaultValue={0} title={t('+ = up on screen; negative drops the rim (a seated base)')} />
      </Section>
    </>
  );
}

/** Style settings of a 2D title that belong to no single part: knockout, かすれ. The global light is the Document's. */
export function Style2DSettings({ layer }: { layer: Title2DLayer }) {
  const t = useT();
  const setAt = useEditor((s) => s.setAt);
  const { face, knockout, erode } = layer.style;
  const styleRef: PropRef = { layerId: layer.id, path: ['style'] };
  const erodeRef = sub(styleRef, 'erode');
  return (
    <>
      <CheckRow
        label={t('Knockout')}
        value={knockout}
        title={t('Knockout: the face punches through every rim to transparency, leaving only the outline rings (hollow neon 狙え). The face then shows at its fill opacity — ticking this sets a fully opaque face to 0%.')}
        onChange={(v) => {
          const k = oneShot(refKey(sub(styleRef, 'knockout')));
          setAt(sub(styleRef, 'knockout'), v, k);
          if (v && face.opacity >= 1) setAt(sub(styleRef, 'face', 'opacity'), 0, k);
        }}
      />
      <Section
        id="style2d-erode"
        title={t('かすれ (dry-brush erode)')}
        defaultOpen={erode.enabled}
        enabled={erode.enabled}
        onToggle={(v) => setAt(sub(erodeRef, 'enabled'), v)}
      >
        <RefNum label={t('Amount')} refp={sub(erodeRef, 'amount')} min={0} max={1} clamp display={100} unit="%" title={t('How much of the edge band the dry brush leaves bare')} />
        <RefNum label={t('Edge band')} refp={sub(erodeRef, 'edge')} min={0.5} max={30} step={0.1} unit="%" title={t('How far in from the outer silhouette the streaks may reach (face and every rim alike)')} />
        <RefNum label={t('Streak length')} refp={sub(erodeRef, 'scale')} min={1} max={60} step={0.5} unit="%" title={t('Length of the dry-brush drag marks')} />
        <RefNum label={t('Drag angle')} refp={sub(erodeRef, 'angle')} min={-180} max={180} step={1} unit="deg" defaultValue={0} title={t('Direction the brush was dragged, clockwise on screen (0 = left → right)')} />
        <Row label={t('Seed')}>
          <NumberField id={refKey(sub(erodeRef, 'seed'))} label={t('Erode seed')} value={erode.seed} onChange={(v, c) => setAt(sub(erodeRef, 'seed'), v, c)} min={0} max={9999} integer slider={false} />
          <IconBtn title={t('New random streaks')} onClick={() => setAt(sub(erodeRef, 'seed'), Math.floor(Math.random() * 10000))}>
            🎲
          </IconBtn>
        </Row>
      </Section>
    </>
  );
}

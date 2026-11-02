import type { Material2D, PlateShape, Title2DLayer } from '../../../model/types';
import { refKey } from '../../../store/paths';
import { useEditor, type Refs } from '../../../store/store';
import { RefCheck, RefChoice, RefNum, Section } from '../../controls';
import { useT } from '../../i18n';
import { oneShot, useRefValue } from '../../util';
import { refsOf } from '../parts';
import { PlateIcon } from './icons';
import { Material2DEditor } from './Material2DEditor';
import { MaterialLink } from './MaterialLink';
import { fillCss, material2DClipboard, sub, tOpts } from './shared';
import { ClipActions, FlippedNum, SwatchTitle } from './widgets';

// 2D layer style (Eye Candy / Photoshop layer-style replacement) split by part: the face and each
// rim get their own editor (Properties › part node). The face's editor also holds Hollow letters
// (`style.knockout`); かすれ is listed as an effect (ui/erode.ts).

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
 * The face of a 2D title: Hollow letters (Photoshop's Knockout: Shallow, `style.knockout`), then
 * its material. Renders on the part page or inline under a part row; `id` (default "part")
 * prefixes its sections' remembered open state, unique on the page. `layers`: the titles whose
 * faces are edited together (one for a single part).
 */
export function Face2DEditor({ layers, id = 'part' }: { layers: readonly Title2DLayer[]; id?: string }) {
  const t = useT();
  const setAt = useEditor((s) => s.setAt);
  const setEachAt = useEditor((s) => s.setEachAt);
  const styleRef = refsOf(layers.map((l) => ({ layerId: l.id, path: ['style'] })));
  const knockoutRef = sub(styleRef, 'knockout');
  return (
    <>
      <RefCheck
        label={t('Hollow letters')}
        refp={knockoutRef}
        title={t('Cut the letters out through every rim, so the background shows inside them (Photoshop: Knockout). Lower the face opacity to see through.')}
        pick={(v) => {
          const k = oneShot(refKey(knockoutRef));
          const label = v ? 'Hollow letters on' : 'Hollow letters off';
          setAt(knockoutRef, v, k, label);
          // The face shows at its fill opacity inside the hollow: ticking takes a fully opaque face to 0 %.
          if (v) setEachAt(sub(styleRef, 'face', 'opacity'), (o) => ((o as number) >= 1 ? 0 : o), k, label);
        }}
      />
      <PartMaterial2D id={`${id}-material`} refp={sub(styleRef, 'face')} mat={layers[0].style.face} />
    </>
  );
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
  const rimRef = refsOf(rims.map(({ layer, index }) => ({ layerId: layer.id, path: ['style', 'rims', index] })));
  const plateRef = sub(rimRef, 'plate');
  const shape = useRefValue(sub(plateRef, 'kind'));
  const kind = shape.mixed ? null : (shape.value as PlateShape['kind']);
  const first = rims[0].layer.style.rims[rims[0].index];
  return (
    <>
      <PartMaterial2D id={`${id}-material`} refp={sub(rimRef, 'material')} mat={first.material} />
      <Section id={`${id}-geometry`} title={t('Geometry')}>
        <RefNum label={t('Width')} refp={sub(rimRef, 'width')} min={0} max={8} step={0.05} unit="%" />
        <RefChoice label={t('Joins')} title={t('How the rim turns the corners of the letters')} refp={sub(rimRef, 'join')} options={tOpts(t, JOINS)} />
        <RefChoice label={t('Shape')} refp={sub(plateRef, 'kind')} options={tOpts(t, PLATE_OPTIONS)} icons />
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

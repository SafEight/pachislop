import type { ReactNode } from 'react';
import { addAsset } from '../../../assets/registry';
import { refKey } from '../../../store/paths';
import { useEditor, type Refs } from '../../../store/store';
import { msg } from '../../../store/msg';
import { ColorInput, Findable, IconBtn, MixedCheckbox, NumberField, NumRow, Row } from '../../controls';
import { useT } from '../../i18n';
import { pickFile, useRefValue } from '../../util';
import { assetUrl, useImageAssets, type Clipboard } from './shared';

/**
 * Image asset chooser (image fill, custom 柄): thumbnail, a list of the project's raster images
 * to reuse, and Import… to add a PNG / JPEG / WebP file to the assets.
 */
export function ImageAssetPicker({ label, assetId, onPick, title }: { label: string; assetId: string | undefined; onPick: (id: string) => void; title: string }) {
  const t = useT();
  const images = useImageAssets();
  const notify = useEditor((s) => s.notify);
  const url = assetId ? assetUrl(assetId) : null;
  return (
    <Row label={label} title={title}>
      <span className="sty-swatch checker" aria-hidden>
        <span style={{ background: url ? `url("${url}") center / cover no-repeat` : 'transparent' }} />
      </span>
      <select
        aria-label={t('{label}: image asset', { label })}
        title={t('Reuse an image already in the project')}
        value={assetId && images.some((a) => a.id === assetId) ? assetId : ''}
        onChange={(e) => e.target.value && onPick(e.target.value)}
      >
        <option value="">{images.length ? t('Choose image…') : t('No images yet')}</option>
        {images.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </select>
      <button
        className="small"
        title={t("Import a PNG / JPEG / WebP image into the project's assets")}
        aria-label={t('{label}: import image', { label })}
        onClick={async () => {
          const f = await pickFile('image/png,image/jpeg,image/webp,image/gif,image/avif');
          if (!f) return;
          const a = addAsset({ name: f.name, mime: f.type || 'image/png', data: await f.arrayBuffer() });
          onPick(a.id);
          notify(msg('Image “{name}” imported', { name: f.name }));
        }}
      >
        {t('Import…')}
      </button>
    </Row>
  );
}

/** Small preview chip (colour or CSS gradient) for stack rows and section headers; `mixed`: striped (several targets that differ). */
export function Swatch({ css, mixed }: { css: string; mixed?: boolean }) {
  return (
    <span className="sty-swatch checker" aria-hidden>
      <span className={mixed ? 'mixed-stripes' : undefined} style={{ background: css }} />
    </span>
  );
}

/** Section title with a leading swatch. */
export function SwatchTitle({ css, children, mixed }: { css: string; children: ReactNode; mixed?: boolean }) {
  return (
    <span className="sty-title">
      <Swatch css={css} mixed={mixed} />
      {children}
    </span>
  );
}

/** Material group header: the group's name, then what is switched on inside it (muted), e.g. "Finish · Metal finish, Satin". */
export function GroupTitle({ name, on }: { name: string; on: readonly string[] }) {
  return (
    <span className="sty-title">
      {name}
      {on.length > 0 && <span className="muted sty-group-on">· {on.join(', ')}</span>}
    </span>
  );
}

/**
 * On/off sub-heading of one feature inside a material group (Reflection map, Satin, Inner glow…),
 * bound to its boolean `enabled` at `refp` (indeterminate when its targets differ). The feature's
 * own rows follow only while it is on.
 */
export function FeatureToggle(props: { label: string; refp: Refs; title?: string }) {
  const { label, refp, title } = props;
  const { value, mixed } = useRefValue(refp);
  const setAt = useEditor((s) => s.setAt);
  return (
    <Findable type={FeatureToggle} props={props}>
      <label className="sub-head sty-feature" title={title} data-fid={refKey(refp)}>
        <MixedCheckbox checked={value === true} mixed={mixed} onChange={(v) => setAt(refp, v)} />
        {label}
      </label>
    </Findable>
  );
}

/**
 * Number row shown with the opposite sign of the stored value: a value stored "+ = down" that the
 * panel shows "+ = up", like every other Offset Y. `min` / `max` / `defaultValue` are in shown
 * units; scrubbing right raises the shown number. Mixed targets: as RefNum.
 */
export function FlippedNum(props: { label: string; refp: Refs; min: number; max: number; step?: number; unit?: string; title?: string; defaultValue?: number }) {
  const { label, refp, min, max, step, unit, title, defaultValue } = props;
  const { value: v, mixed } = useRefValue(refp);
  const setAt = useEditor((s) => s.setAt);
  const setEachAt = useEditor((s) => s.setEachAt);
  const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
  // `0 - x` keeps a zero a positive 0 (no "-0" in the field or the file).
  return (
    <Findable type={FlippedNum} props={props}>
      <NumRow
        label={label}
        title={title}
        id={refKey(refp)}
        value={0 - num(v)}
        onChange={(x, c) => setAt(refp, 0 - x, c)}
        mixed={mixed}
        onOffset={(d, c) => setEachAt(refp, (start) => num(start) - d, c)}
        min={min}
        max={max}
        step={step}
        unit={unit}
        defaultValue={defaultValue}
      />
    </Findable>
  );
}

/** Colour + amount on one row (highlight / shadow / emissive), bound to the store. Defaults: 0..1 opacity shown as %. Mixed targets show “—” per field. */
export function ColorAmountRow(props: { label: string; colorRef: Refs; amountRef: Refs; min?: number; max?: number; display?: number; unit?: string }) {
  const { label, colorRef, amountRef, min = 0, max = 1, display = 100, unit = '%' } = props;
  const t = useT();
  const setAt = useEditor((s) => s.setAt);
  const setEachAt = useEditor((s) => s.setEachAt);
  const color = useRefValue(colorRef);
  const amount = useRefValue(amountRef);
  const shown = typeof amount.value === 'number' ? amount.value : min;
  return (
    <Findable type={ColorAmountRow} props={props}>
      <Row label={label}>
        <ColorInput id={refKey(colorRef)} label={t('{label} colour', { label })} value={typeof color.value === 'string' ? color.value : '#ffffff'} mixed={color.mixed} onChange={(v, c) => setAt(colorRef, v, c)} />
        <NumberField
          id={refKey(amountRef)}
          label={t('{label} amount', { label })}
          value={shown}
          onChange={(v, c) => setAt(amountRef, v, c)}
          mixed={amount.mixed}
          onOffset={(d, c) => setEachAt(amountRef, (s) => Math.max(min, Math.min(max, (typeof s === 'number' ? s : shown) + d)), c)}
          min={min}
          max={max}
          clamp
          display={display}
          unit={unit}
        />
      </Row>
    </Findable>
  );
}

/** Copy / Paste buttons for a material held in an in-memory clipboard; Paste fills every target of `refp`. */
export function ClipActions<T>({ clip, value, refp }: { clip: Clipboard<T>; value: T; refp: Refs }) {
  const t = useT();
  const has = clip.useHas();
  const setAt = useEditor((s) => s.setAt);
  const notify = useEditor((s) => s.notify);
  return (
    <span className="sty-clip">
      <IconBtn
        title={t('Copy this material')}
        onClick={() => {
          clip.copy(value);
          notify('Material copied');
        }}
      >
        {t('Copy')}
      </IconBtn>
      <IconBtn
        title={t('Paste the copied material here')}
        disabled={!has}
        onClick={() => {
          const v = clip.paste();
          if (v !== null) setAt(refp, v);
        }}
      >
        {t('Paste')}
      </IconBtn>
    </span>
  );
}

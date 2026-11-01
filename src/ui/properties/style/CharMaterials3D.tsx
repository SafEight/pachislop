import { withoutLink } from '../../../model/links';
import type { CharAdjust, Material3D, TextSource, Title3DLayer } from '../../../model/types';
import { useEditor } from '../../../store/store';
import { msg, type Msg } from '../../../store/msg';
import { Row } from '../../controls';
import { useT } from '../../i18n';
import { oneShot } from '../../util';
import { isNeutralAdjust, NO_ADJUST } from '../../viewport/glyphs';
import { Material3DSection } from './Material3DEditor';

// Per-character 3D band and side materials (CharAdjust.bands3d / side3d), shown under the
// character's face override in the Letters section: a white 元祖 inside a gold word loses the gold
// bands and side too. Band entries are index-aligned with style3d.bands; a missing entry keeps
// the layer's band.

/** Band and side overrides of the picked characters of a 3D text layer (their primary is edited). */
export function CharMaterials3D({ layer, src, selected }: { layer: Title3DLayer; src: TextSource; selected: number[] }) {
  const t = useT();
  const setAt = useEditor((s) => s.setAt);
  const st = layer.style3d;
  const chars = Array.from(src.text);
  const primary = selected[0];
  const a = src.chars[primary];
  const picked = selected.map((i) => chars[i]).join('');
  const ref = { layerId: layer.id, path: ['source', 'chars'] };
  const charRef = { layerId: layer.id, path: ['source', 'chars', primary] };

  /** Rewrite the band / side overrides of every picked character. */
  const edit = (fn: (a: CharAdjust) => Pick<CharAdjust, 'bands3d' | 'side3d'>, label: Msg) => {
    const next = { ...src.chars };
    for (const i of selected) {
      const base: CharAdjust = { ...(next[i] ?? NO_ADJUST) };
      delete base.bands3d;
      delete base.side3d;
      const o = fn(next[i] ?? NO_ADJUST);
      const adj: CharAdjust = { ...base, ...(o.bands3d ? { bands3d: o.bands3d } : {}), ...(o.side3d ? { side3d: o.side3d } : {}) };
      if (isNeutralAdjust(adj)) delete next[i];
      else next[i] = adj;
    }
    setAt(ref, next, oneShot(`${layer.id}:charMaterials3d`), label);
  };
  // The letter's own copies: a linked layer material leaves its link behind.
  const copy = (m: Material3D) => structuredClone(withoutLink(m));
  const faceOf = (c: CharAdjust) => c.face3d ?? st.face;
  const overridden = selected.some((i) => src.chars[i]?.bands3d || src.chars[i]?.side3d);

  return (
    <>
      <Row label={t('Bands & side')} title={t("Per-character bevel band and side materials (3D): the rest of the word keeps the layer's")}>
        <button
          className="small"
          title={t('Give “{chars}” the face material on every band and the side (a white 元祖 in a gold word)', { chars: picked })}
          aria-label={t('Match bands and side to the face of {chars}', { chars: picked })}
          onClick={() => edit((c) => ({ bands3d: st.bands.map(() => copy(faceOf(c))), side3d: copy(faceOf(c)) }), msg('Bands = face “{chars}”', { chars: picked }))}
        >
          {t('Match face')}
        </button>
        <button
          className="small"
          title={t("Own copies of the layer's bands and side for “{chars}”, to edit separately", { chars: picked })}
          aria-label={t('Override bands and side of {chars}', { chars: picked })}
          onClick={() => edit(() => ({ bands3d: st.bands.map((b) => copy(b.material)), side3d: copy(st.side) }), msg('Own bands “{chars}”', { chars: picked }))}
        >
          {t('Own')}
        </button>
        <button
          className="small"
          disabled={!overridden}
          title={t("“{chars}” uses the layer's bands and side again", { chars: picked })}
          aria-label={t('Clear band and side overrides of {chars}', { chars: picked })}
          onClick={() => edit(() => ({}), msg('Clear bands “{chars}”', { chars: picked }))}
        >
          {t('Clear')}
        </button>
      </Row>
      {a?.bands3d &&
        st.bands.map((b, k) =>
          a.bands3d?.[k] ? (
            <Material3DSection key={b.id} id={`char-band-${k}`} title={t('Band {n} of “{char}”', { n: k + 1, char: chars[primary] })} refp={{ ...charRef, path: [...charRef.path, 'bands3d', k] }} mat={a.bands3d[k]!} />
          ) : (
            <Row key={b.id} label={t('Band {n}', { n: k + 1 })} title={t("This band uses the layer's material on this character")}>
              <button
                className="small"
                title={t('Give “{char}” its own band {n} material', { char: chars[primary], n: k + 1 })}
                aria-label={t('Override band {n} of {char}', { n: k + 1, char: chars[primary] })}
                onClick={() => {
                  const list = st.bands.map((_, i) => a.bands3d?.[i] ?? null);
                  list[k] = copy(b.material);
                  setAt({ ...charRef, path: [...charRef.path, 'bands3d'] }, list, oneShot(`${layer.id}:charBand`), msg('Own band {n} “{char}”', { n: k + 1, char: chars[primary] }));
                }}
              >
                {t("Layer's · override")}
              </button>
            </Row>
          ),
        )}
      {a?.side3d && <Material3DSection id="char-side" title={t('Side of “{char}”', { char: chars[primary] })} refp={{ ...charRef, path: [...charRef.path, 'side3d'] }} mat={a.side3d} />}
    </>
  );
}

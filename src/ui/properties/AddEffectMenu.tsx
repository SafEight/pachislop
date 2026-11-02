import { useEffect, useEffectEvent, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { listEffects } from '../../effects/registry';
import type { EffectCategory, EffectDef } from '../../engine/contracts';
import { defaultAdjustment } from '../../model/defaults';
import { isTitleLayer, partEffectsOf } from '../../model/parts';
import type { EffectInstance, Layer, ParamValue, Project } from '../../model/types';
import { makeEffect } from '../../store/effects';
import { effectOwnerLabel } from '../../store/labels';
import { withCompanion } from '../../store/layerOps';
import { formatMsg, type Translate } from '../../store/msg';
import { useEditor, type EffectOwner } from '../../store/store';
import { COMPANION_CATEGORIES, companionEntries, takesCompanions, type CompanionCategory, type CompanionEntry } from '../companions';
import { addErode, ERODE_ABOUT, ERODE_NAME } from '../erode';
import { GeneratorIcon } from '../generatorIcons';
import { addGlint, GLINT_ABOUT, GLINT_ADD_LABEL } from '../glint';
import { tr, useT } from '../i18n';
import { ADJUSTMENT_MENU } from '../layers/commands';
import './effects.css';

type Category = EffectCategory | CompanionCategory;

/** Add-menu categories in menu order, with a rail glyph and a tooltip: the effects', then the companions' (ui/companions.ts). */
const CATEGORIES: { id: Category; glyph: string; title: string }[] = [
  { id: 'Glow', glyph: '✺', title: 'Outer and inner glows (colour or gradient), HDR deep glow, 導光板 contour lines' },
  { id: 'Blur', glyph: '◍', title: 'Gaussian, motion, lens, tilt-shift and radial blurs' },
  { id: 'Shadow', glyph: '◣', title: 'Drop, inner and perspective shadows, floor reflection' },
  { id: 'Material', glyph: '◈', title: 'Material (bevel, chrome, glass, metal grain), keyline strokes and 2D extrusion' },
  { id: 'Color', glyph: '◐', title: 'Adjustments (levels, curves, hue/saturation, gradient map…), gradient overlay (rainbow, glint sweep), halftone, film grain' },
  { id: 'Distort', glyph: '≈', title: 'Wave, chromatic aberration, glitch, shatter, motion trail and かすれ dry brush' },
  ...COMPANION_CATEGORIES,
];

/** A category's name: the companions' Light and Energy are the generator categories' words. */
const categoryName = (t: Translate, c: Category) => (c === 'Light' || c === 'Energy' ? t(c, undefined, { ctx: 'generator' }) : t(c));

/** First sentence of a (translated) description: the menu's one-line summary (the full text is the tooltip). */
const summary = (desc: string) => desc.match(/^.*?(?:\.(?=\s|$)|。)/)?.[0] ?? desc;

/**
 * One add-menu entry: an effect with its default params, or, for the Adjust effect, one entry
 * per adjustment of the adjustment-layer menu (bar Effects only), named by the adjustment; or,
 * on a 3D title, its glint (switched on, ui/glint.ts); on a 2D title, its かすれ (switched on,
 * ui/erode.ts); or, on a layer that takes them, a generator preset added as a companion
 * (ui/companions.ts).
 */
interface Entry {
  /** Unique per entry: the effect type, `adjust:<adjustment type>`, `glint3d`, `erode2d` or `gen:<type>:<preset>`. */
  key: string;
  /** The effect added; null for the 3D glint, the 2D かすれ and companions. */
  def: EffectDef | null;
  /** The companion added. */
  companion?: CompanionEntry;
  category: Category;
  /** English description (the i18n key). */
  description: string;
  /** English name (the i18n key) and its i18n context. */
  label: string;
  ctx?: string;
  /** Params the added effect starts with instead of the defaults (the adjustment). */
  params?: Readonly<Record<string, ParamValue>>;
}

const GLINT_ENTRY: Entry = { key: 'glint3d', def: null, category: 'Glow', description: GLINT_ABOUT, label: GLINT_ADD_LABEL };
const ERODE_ENTRY: Entry = { key: 'erode2d', def: null, category: 'Distort', description: ERODE_ABOUT, label: ERODE_NAME };

function menuEntries(): Entry[] {
  return listEffects().flatMap((def): Entry[] =>
    def.type === 'adjust'
      ? ADJUSTMENT_MENU.filter((a) => a.type !== 'effectsOnly').map((a) => ({
          key: `adjust:${a.type}`,
          def,
          category: def.category,
          description: def.description,
          label: a.label,
          ctx: 'adjustment',
          params: { adjustment: defaultAdjustment(a.type) },
        }))
      : [{ key: def.type, def, category: def.category, description: def.description, label: def.label }],
  );
}

const COMPANION_ENTRIES: Entry[] = companionEntries().map((c) => ({
  key: `gen:${c.def.type}:${c.presetId}`,
  def: null,
  companion: c,
  category: c.category,
  description: c.def.description,
  label: c.label,
}));

/** The searchable text of an entry in one language, normalised (NFKC, lower case) for matching. */
interface SearchText {
  label: string;
  hay: string;
}

/** English and Japanese search text per entry key, built once (the tables are static). */
const searchTexts = new Map<string, SearchText[]>();

function searchTextsOf(e: Entry): SearchText[] {
  let texts = searchTexts.get(e.key);
  if (!texts) {
    const norm = (s: string) => s.normalize('NFKC').toLowerCase();
    const d = e.def;
    texts = (['en', 'ja'] as const).map((lang) => {
      const label = norm(tr(e.label, undefined, { lang, ctx: e.ctx }));
      // An adjustment entry is also found by its effect's name (“Adjust”), a companion by its generator's (“Fire”).
      const also = d && e.label !== d.label ? d.label : e.companion?.def.label;
      const effect = also ? ` ${norm(tr(also, undefined, { lang }))}` : '';
      return { label, hay: `${label}${effect} ${e.key.toLowerCase()} ${norm(categoryName((en, v, o) => tr(en, v, { ...o, lang }), e.category))} ${norm(tr(e.description, undefined, { lang }))}` };
    });
    searchTexts.set(e.key, texts);
  }
  return texts;
}

/**
 * Search rank of `d` for the normalised query `q` (lower = better, −1 = no match): the exact
 * name, then a name prefix, a word in the name starting with it, the name containing it, and
 * last every query word found in the name, type, category or description. Both the English and
 * the Japanese text are searched whatever the UI language; the better rank wins.
 */
function searchRank(e: Entry, q: string): number {
  const words = q.split(/\s+/);
  const rankIn = ({ label, hay }: SearchText) => {
    if (label === q) return 0;
    if (label.startsWith(q)) return 1;
    if (label.split(/[\s/()·・（）、-]+/).some((w) => w.startsWith(q))) return 2;
    if (label.includes(q)) return 3;
    if (words.every((w) => label.includes(w))) return 4;
    return words.every((w) => hay.includes(w)) ? 5 : -1;
  };
  const ranks = searchTextsOf(e).map(rankIn).filter((r) => r >= 0);
  return ranks.length ? Math.min(...ranks) : -1;
}

const catRank = (c: Category) => CATEGORIES.findIndex((x) => x.id === c);

/** `layer` with `fx` added on top of each of `owners`' stacks (all on `layer`): the hover preview. */
function withEffect(layer: Layer, owners: readonly EffectOwner[], fx: EffectInstance): Layer {
  if (owners.length === 1 && owners[0].part === null) return { ...layer, effects: [...layer.effects, fx] };
  if (!isTitleLayer(layer)) return layer;
  const partEffects = { ...layer.partEffects };
  for (const { part } of owners) if (part !== null) partEffects[part] = [...partEffectsOf(layer, part), fx];
  return { ...layer, partEffects };
}

/** Screen box the menu opens against: an element's `getBoundingClientRect()`, or a point as a zero-size box. */
export type MenuAnchor = Pick<DOMRect, 'left' | 'top' | 'right' | 'bottom'>;

const MENU_WIDTH = 540; // px, matches `.menu-pop.fx-add`
const MARGIN = 8; // px kept clear of the window edges

/** Fixed placement below `a` (above when there is more room there), left-aligned unless that overflows the window. */
function placement(a: MenuAnchor): CSSProperties {
  const below = window.innerHeight - a.bottom;
  const up = below < 300 && a.top > below;
  const fitsLeft = a.left + MENU_WIDTH <= window.innerWidth - MARGIN;
  return {
    position: 'fixed',
    ...(fitsLeft ? { left: Math.max(MARGIN, a.left) } : { right: Math.max(MARGIN, window.innerWidth - a.right) }),
    ...(up ? { bottom: window.innerHeight - a.top + 2 } : { top: a.bottom + 2 }),
    maxHeight: (up ? a.top : below) - 12,
  };
}

/**
 * Categorised, searchable “Add effect” popover for any effect owner (layer, group or style
 * part), or several parts of one layer (one effect each, one undo step), portalled to the body
 * at `anchor`. Typing ranks the matches best-first and highlights the top hit (Enter adds it);
 * the rail counts the matches per category and narrows them. Hovering (or arrowing to) an entry
 * previews it on the layer. Esc, an outside click or adding an effect calls `onClose`; the caller
 * unmounts it then. The header names where the effect goes; for parts it also offers their layer.
 */
export function AddEffectMenu({ owner: picked, onClose, anchor }: { owner: EffectOwner | readonly EffectOwner[]; onClose: () => void; anchor: MenuAnchor }) {
  const t = useT();
  const { addEffect, addGenerator, setPreviewOverride } = useEditor.getState();
  const [selected] = useState<readonly EffectOwner[]>(() => ('layerId' in picked ? [picked] : picked));
  const layerId = selected[0].layerId;
  const ownerLayer = useEditor((s) => s.project.layers.find((l) => l.id === layerId));
  // Where the effect goes, named in the header: the selected part(s), or (switchable) their whole layer.
  const [owners, setOwners] = useState(selected);
  const [style] = useState(() => placement(anchor));
  const [query, setQuery] = useState('');
  const [cat, setCat] = useState<Category | 'all'>('all');
  const [active, setActive] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const previewing = useRef(false);
  const q = query.trim().normalize('NFKC').toLowerCase();
  // A 3D title's glint and a 2D title's かすれ are offered for the layer (not its parts) while
  // off; companions on a title or group itself.
  const onLayer = owners.length === 1 && owners[0].part === null;
  const glintOffered = ownerLayer?.kind === 'title3d' && onLayer && !ownerLayer.style3d.glint.enabled;
  const erodeOffered = ownerLayer?.kind === 'title2d' && onLayer && !ownerLayer.style.erode.enabled;
  const companionsOffered = onLayer && takesCompanions(ownerLayer);
  const entries = useMemo(
    () => [...(glintOffered ? [GLINT_ENTRY] : []), ...(erodeOffered ? [ERODE_ENTRY] : []), ...menuEntries(), ...(companionsOffered ? COMPANION_ENTRIES : [])],
    [glintOffered, erodeOffered, companionsOffered],
  );
  // Every match across categories, best first while searching, else category then registry order.
  const hits = useMemo(() => {
    const scored = entries.map((e, i) => ({ e, i, s: q ? searchRank(e, q) : 0 })).filter((h) => h.s >= 0);
    return scored.sort((a, b) => a.s - b.s || catRank(a.e.category) - catRank(b.e.category) || a.i - b.i).map((h) => h.e);
  }, [entries, q]);
  const shown = useMemo(() => (cat === 'all' ? hits : hits.filter((e) => e.category === cat)), [hits, cat]);
  const counts = useMemo(() => {
    const m = new Map<Category, number>();
    for (const e of hits) m.set(e.category, (m.get(e.category) ?? 0) + 1);
    return m;
  }, [hits]);
  // The highlighted entry: the one hovered / arrowed to, else the top hit while searching.
  const current = shown.find((e) => e.key === active) ?? (q ? (shown[0] ?? null) : null);
  const name = (e: Entry) => t(e.label, undefined, { ctx: e.ctx });
  const preview = (e: Entry | null) => {
    setActive(e?.key ?? null);
    const project = useEditor.getState().project;
    const layer = project.layers.find((l) => l.id === layerId);
    let shownAs: Layer | Project | null = null;
    if (layer && e?.def) {
      const fx = makeEffect(e.def.type, e.params);
      shownAs = fx && withEffect(layer, owners, fx);
    } else if (layer && e?.companion) {
      shownAs = withCompanion(project, e.companion.def.type, e.companion.presetId, layer.id)?.project ?? null;
    } else if (layer?.kind === 'title3d' && e) {
      shownAs = { ...layer, style3d: { ...layer.style3d, glint: { ...layer.style3d.glint, enabled: true } } };
    } else if (layer?.kind === 'title2d' && e) {
      shownAs = { ...layer, style: { ...layer.style, erode: { ...layer.style.erode, enabled: true } } };
    }
    previewing.current = !!shownAs;
    setPreviewOverride(shownAs);
  };
  // Esc and outside clicks close the menu. Closing drops the hover preview, only when this menu
  // set one, so mounting or closing never clears another preview.
  const close = useEffectEvent(() => onClose());
  useEffect(() => {
    const outside = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) close();
    };
    const esc = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('pointerdown', outside);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('pointerdown', outside);
      window.removeEventListener('keydown', esc);
      if (previewing.current) setPreviewOverride(null);
    };
  }, [setPreviewOverride]);
  const add = (e: Entry) => {
    if (previewing.current) setPreviewOverride(null);
    previewing.current = false;
    if (e.def) addEffect(owners, e.def.type, e.params);
    else if (e.companion) addGenerator(e.companion.def.type, e.companion.presetId, layerId);
    else if (e.key === ERODE_ENTRY.key) addErode(layerId);
    else addGlint(layerId);
    onClose();
  };
  const onQuery = (v: string) => {
    // A new search starts over every category, from its top hit.
    if (!query.trim() && v.trim()) setCat('all');
    if (active) preview(null);
    setQuery(v);
    listRef.current?.scrollTo({ top: 0 });
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (shown.length === 0) return;
      const i = current ? shown.indexOf(current) : -1;
      const step = e.key === 'ArrowDown' ? 1 : -1;
      const next = shown[i < 0 ? (step > 0 ? 0 : shown.length - 1) : (i + step + shown.length) % shown.length];
      preview(next);
      listRef.current?.querySelector(`[data-key="${next.key}"]`)?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      // isComposing: Enter that confirms a Japanese IME conversion must not add an effect.
      e.preventDefault();
      const hit = current ?? shown[0];
      if (hit) add(hit);
    }
  };
  const railBtn = (id: Category | 'all', glyph: string, name: string, title: string, n: number) => (
    <button
      key={id}
      role="tab"
      aria-selected={cat === id}
      className={`${cat === id ? 'on' : ''} ${n === 0 ? 'none' : ''}`}
      title={q ? t(n === 1 ? '{title} ({n} match for “{query}”)' : '{title} ({n} matches for “{query}”)', { title, n, query: query.trim() }) : title}
      onClick={() => setCat(id)}
    >
      <span className="glyph">{glyph}</span>
      {name}
      <span className="count">{n}</span>
    </button>
  );
  return createPortal(
    // React events bubble through portals to the opener's tree (a Layers row, Properties): keep
    // keys and clicks in here from reaching it. Esc closes here, as the window never sees it then.
    <div
      ref={rootRef}
      className="menu-pop fx-add"
      style={style}
      role="dialog"
      aria-label={t('Add effect')}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') onClose();
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      {ownerLayer &&
        (selected[0].part === null ? (
          <div className="fx-add-target">{t('Add effect to {name}', { name: formatMsg(effectOwnerLabel(ownerLayer, null), t) })}</div>
        ) : (
          <div className="fx-add-target" role="radiogroup" aria-label={t('Add the effect to')}>
            {t('Add effect to')}
            {[selected, [{ layerId, part: null }]].map((o) => {
              const layer = o[0].part === null;
              const on = layer === (owners[0].part === null);
              return (
                <button
                  key={layer ? 'layer' : 'parts'}
                  role="radio"
                  aria-checked={on}
                  className={`small ${on ? 'on' : ''}`}
                  title={
                    layer
                      ? t('Run it on the whole layer, after its parts')
                      : o.length > 1
                        ? t("One effect on each part, run on that part's own pixels before the layer's effects")
                        : t("Run it on this part's own pixels, before the layer's effects")
                  }
                  onClick={() => {
                    if (active) preview(null);
                    setOwners(o);
                  }}
                >
                  {o.length > 1 ? t('{n} parts', { n: o.length }) : formatMsg(effectOwnerLabel(ownerLayer, o[0].part), t)}
                </button>
              );
            })}
          </div>
        ))}
      <input
        className="fx-add-search"
        type="search"
        autoFocus
        placeholder={t('Search effects (glow, sparkle, 集中線…)')}
        aria-label={t('Search effects')}
        aria-controls="fx-add-list"
        aria-activedescendant={current ? `fx-add-${current.key}` : undefined}
        title={t('Type to search every effect by name or description (best match first); ↑/↓ to preview, Enter to add the highlighted one, Esc to close')}
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        onKeyDown={onKey}
      />
      <div className="fx-add-body">
        <div className="fx-add-rail" role="tablist" aria-label={t('Effect categories')} aria-orientation="vertical">
          {railBtn('all', '☰', t('All'), t(q ? 'Every match, best first' : 'Every effect, grouped by category'), hits.length)}
          {CATEGORIES.filter((c) => companionsOffered || !COMPANION_CATEGORIES.some((x) => x.id === c.id)).map((c) => railBtn(c.id, c.glyph, categoryName(t, c.id), t(c.title), counts.get(c.id) ?? 0))}
        </div>
        <div className="fx-add-list" id="fx-add-list" role="listbox" aria-label={t('Effects')} ref={listRef} onPointerLeave={() => preview(null)}>
          {shown.length === 0 && (
            <div className="menu-empty">
              {q
                ? cat === 'all'
                  ? t('No effect matches “{query}”.', { query: query.trim() })
                  : t('No effect in {category} matches “{query}”.', { category: categoryName(t, cat), query: query.trim() })
                : t('No effects in this category.')}
            </div>
          )}
          {shown.map((e, i) => (
            <div key={e.key}>
              {!q && cat === 'all' && e.category !== shown[i - 1]?.category && <div className="menu-group">{categoryName(t, e.category)}</div>}
              <button
                id={`fx-add-${e.key}`}
                role="option"
                aria-selected={e === current}
                data-key={e.key}
                className={`fx-add-item ${e === current ? 'active' : ''}`}
                title={t('{label}: {description}', { label: name(e), description: t(e.description) })}
                onPointerEnter={() => preview(e)}
                onFocus={() => preview(e)}
                onClick={() => add(e)}
              >
                <span className="fx-add-label">
                  {e.companion && <GeneratorIcon type={e.companion.def.type} />}
                  {name(e)}
                  {e.companion?.behind && <span className="fx-behind">{t('behind')}</span>}
                  {q && <span className="fx-add-cat">{categoryName(t, e.category)}</span>}
                  {e === current && q && <kbd className="fx-add-enter">↵</kbd>}
                </span>
                <span className="fx-add-sum">{summary(t(e.description))}</span>
              </button>
            </div>
          ))}
        </div>
      </div>
      <div className="fx-add-detail" aria-live="polite">
        {current ? (
          <>
            <b>{name(current)}</b> {t(current.description)}
          </>
        ) : (
          t('Hover an effect to preview it on the layer. Click or press Enter to add it on top of the stack.')
        )}
      </div>
    </div>,
    document.body,
  );
}

/** “+ Add effect” button opening AddEffectMenu for `owner` below it. */
export function AddEffectButton({ owner }: { owner: EffectOwner }) {
  const t = useT();
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  return (
    <>
      <button
        className="menu-btn"
        title={t('Add an effect to this layer: browse by category or search; hover an entry to preview it')}
        aria-haspopup="dialog"
        aria-expanded={!!anchor}
        // While open, the menu's outside-pointerdown closes it; keep that from re-opening it here.
        onPointerDown={(e) => anchor && e.stopPropagation()}
        onClick={(e) => setAnchor(anchor ? null : e.currentTarget.getBoundingClientRect())}
      >
        {t('+ Add effect')}
      </button>
      {anchor && <AddEffectMenu owner={owner} anchor={anchor} onClose={() => setAnchor(null)} />}
    </>
  );
}

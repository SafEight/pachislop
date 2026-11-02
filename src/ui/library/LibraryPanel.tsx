import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { BUILTIN_FONTS } from '../../assets/registry';
import { classicTitleStyle2D, createTitle2DLayer, createTitle3DLayer } from '../../model/defaults';
import { isTitleLayer } from '../../model/parts';
import type { Layer, Project } from '../../model/types';
import { applyPresetToProject, canApplyPreset, presetFromLayer } from '../../presets/apply';
import { FACTORY_STYLES } from '../../presets/factory';
import { applyColourway, applyColourwayToProject, COLOURWAY_INFO } from '../../presets/colourways';
import { COLOURWAYS, type Colourway, type StylePreset } from '../../presets/types';
import {
  addUserPreset,
  deleteUserPreset,
  exportUserPresets,
  importUserPresets,
  PRESET_FILE_EXT,
  renameUserPreset,
  userPresets,
} from '../../presets/user';
import { syncLinks } from '../../store/links';
import { errorMsg, msg, type Msg } from '../../store/msg';
import { selectedLayer, useEditor } from '../../store/store';
import { subtreeIds } from '../../store/tree';
import { useT } from '../i18n';
import { Seg } from '../controls';
import { PsStyleImportButton } from '../PsStyleImport';
import { downloadBlob, pickFile, useLatest } from '../util';
import { addRecent, setCollapsed, useLibraryPrefs, type TileSize } from './prefs';
import { LIB_FIND_INPUT_ID, queryWords, searchText } from './search';
import { colourwayContentKey, getThumb, requestThumb, THUMB_H, THUMB_W, thumbContentKey, thumbStore, type ColourwayThumbJob, type ThumbJob } from './thumbs';
import './library.css';

const USER_GROUP = 'My Styles';
/** Recolour presets: they keep the selected layer's structure, so they apply to every kind. */
const COLOURWAYS_GROUP = 'Colourways 配色';
/** The looks and colourways applied last; shown while no search or filter is on. */
const RECENT_GROUP = 'Recent';
/** Thumbnails show this when no title layer is selected (in the classic gold look, so colourways show on rims and bevels); clicking a style then adds a new title. */
const SAMPLE_TEXT = '確定';
const SAMPLE_LAYER = { ...createTitle2DLayer(SAMPLE_TEXT), style: classicTitleStyle2D() };

const FACTORY_GROUPS = [...new Set(FACTORY_STYLES.map((p) => p.group))];
/** Kind of each factory section: 3D when all its looks are 3D, else 2D. */
const GROUP_KIND: Record<string, StylePreset['kind']> = Object.fromEntries(
  FACTORY_GROUPS.map((group) => [group, FACTORY_STYLES.every((p) => p.group !== group || p.kind === 'title3d') ? 'title3d' : 'title2d']),
);

const KIND_NAME: Record<StylePreset['kind'], string> = { title2d: '2D', title3d: '3D' };

type KindFilter = 'all' | StylePreset['kind'];

/** A library tile: a look, or a colourway (a recolour of the selected layer's own structure). */
type LookItem = { type: 'look'; preset: StylePreset };
type Item = LookItem | { type: 'colourway'; colourway: Colourway };

const look = (preset: StylePreset): LookItem => ({ type: 'look', preset });
const COLOURWAY_ITEMS: Item[] = COLOURWAYS.map((colourway) => ({ type: 'colourway', colourway }));
const FACTORY_ITEMS = new Map(FACTORY_STYLES.map((p) => [p.id, look(p)]));
const GROUP_ITEMS: Record<string, LookItem[]> = Object.fromEntries(FACTORY_GROUPS.map((group) => [group, [...FACTORY_ITEMS.values()].filter((it) => it.preset.group === group)]));

/** Search text of each tile (its name, section and kind), made on its first search. */
const searchTexts = new WeakMap<Item, string>();
function itemText(it: Item, group: string): string {
  let s = searchTexts.get(it);
  if (s === undefined) {
    s = searchText(it.type === 'colourway' ? [COLOURWAY_INFO[it.colourway].name, group] : [it.preset.name, group, KIND_NAME[it.preset.kind]]);
    searchTexts.set(it, s);
  }
  return s;
}

/** The thumbnail sizes (each one's least tile width is in library.css). */
const TILE_SIZES: readonly { value: TileSize; label: string; title: string }[] = [
  { value: 's', label: 'S', title: 'Small thumbnails' },
  { value: 'm', label: 'M', title: 'Medium thumbnails' },
  { value: 'l', label: 'L', title: 'Large thumbnails' },
];

/** Hover previews wait this long after real pointer movement (ms), so sweeping across tiles stays calm. */
const HOVER_DELAY = 150;

interface Snapshot {
  key: string;
  project: Project;
  layer: Layer;
}

/**
 * Hover intent for preview tiles: fires `onIntent` HOVER_DELAY ms after the pointer genuinely
 * MOVES over the element. Content appearing under a still cursor (a menu closing over a
 * thumbnail, the list scrolling, a layout shift) only produces enter / zero-movement move
 * events, which never preview.
 */
function useHoverIntent(onIntent: () => void, onLeave: () => void) {
  const timer = useRef(0);
  const live = useLatest(onIntent);
  useEffect(() => () => clearTimeout(timer.current), []);
  return {
    onPointerMove: (e: React.PointerEvent) => {
      if (timer.current || (e.movementX === 0 && e.movementY === 0)) return;
      timer.current = window.setTimeout(() => live.current(), HOVER_DELAY);
    },
    onPointerLeave: () => {
      clearTimeout(timer.current);
      timer.current = 0;
      onLeave();
    },
  };
}

/** `live`, held until its key has stopped changing for 300 ms: typing / dragging re-renders thumbnails once it settles. */
function useSettled(live: Snapshot): Snapshot {
  const [snap, setSnap] = useState<Snapshot>(live);
  useEffect(() => {
    if (live.key === snap.key) return;
    const t = setTimeout(() => setSnap(live), 300);
    return () => clearTimeout(t);
  }, [live, snap.key]);
  return snap;
}

/**
 * Eye Candy–style style library: live thumbnails, hover preview, click to apply, colourways, user
 * presets. Fills its dock tab at any width (the tile grid adds columns as the dock widens).
 */
export function LibraryPanel() {
  const t = useT();
  const project = useEditor((s) => s.project);
  const sel = useEditor(selectedLayer);
  const users = useSyncExternalStore(userPresets.subscribe, userPresets.getSnapshot);
  const [applyFont, setApplyFont] = useState(false);
  const { size, collapsed, recent } = useLibraryPrefs();
  const [query, setQuery] = useState('');
  /** The one section shown; null = all of them. */
  const [category, setCategory] = useState<string | null>(null);
  const [kindFilter, setKindFilter] = useState<KindFilter>('all');
  const [saveName, setSaveName] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);

  const title = isTitleLayer(sel) ? sel : null;
  const target = title ?? SAMPLE_LAYER;
  const live = useMemo(
    () => ({ key: thumbContentKey(project, target, applyFont), project, layer: target }),
    [project, target, applyFont],
  );
  const snap = useSettled(live);
  // Colourways draw the selected title, generator or group itself (the sample title otherwise).
  const recolourable = isTitleLayer(sel) || sel?.kind === 'generator' || sel?.kind === 'group' ? sel : null;
  const colourTarget = recolourable ?? SAMPLE_LAYER;
  const colourLive = useMemo(() => ({ key: colourwayContentKey(project, colourTarget), project, layer: colourTarget }), [project, colourTarget]);
  const colourSnap = useSettled(colourLive);

  // Never leave a hover preview behind.
  useEffect(() => () => useEditor.getState().setPreviewOverride(null), []);

  const current = () => {
    const l = selectedLayer(useEditor.getState());
    return isTitleLayer(l) ? l : null;
  };

  // Hover previews go through syncLinks like the commit, so linked materials elsewhere preview too.
  const preview = (p: StylePreset | null) => {
    const st = useEditor.getState();
    const l = current();
    st.setPreviewOverride(p && l && canApplyPreset(l, p) ? syncLinks(st.project, applyPresetToProject(st.project, l.id, p, { applyFont })) : null);
  };

  /**
   * Applies `p` to the selected title, then optionally a font, as ONE undo step named `label`.
   * With no title selected it adds a new title (above the selection, like Add Layer). A 3D look
   * brings its lighting as the layer's own (style3d.lighting); the comp never changes.
   */
  const apply = (p: StylePreset, extra: { fontId?: string; label?: Msg } = {}) => {
    const st = useEditor.getState();
    st.setPreviewOverride(null);
    const l = current();
    /** `p` on layer `id` of `proj` (its companions and group included), then the picked font. */
    const styled = (proj: Project, id: string, applyFont: boolean): Project => {
      const out = applyPresetToProject(proj, id, p, { applyFont });
      if (!extra.fontId) return out;
      const font = extra.fontId;
      return { ...out, layers: out.layers.map((x) => (x.id === id && isTitleLayer(x) && x.source.kind === 'text' ? { ...x, source: { ...x.source, fontId: font } } : x)) };
    };
    try {
      if (!l) {
        const base = p.kind === 'title3d' ? createTitle3DLayer(SAMPLE_TEXT) : createTitle2DLayer(SAMPLE_TEXT);
        st.edit(
          (proj) => {
            const at = proj.layers.findIndex((x) => x.id === st.selectedLayerId) + 1 || proj.layers.length;
            return styled({ ...proj, layers: [...proj.layers.slice(0, at), base, ...proj.layers.slice(at)] }, base.id, true);
          },
          undefined,
          extra.label ?? msg('Add title with style “{name}”', { name: p.name }),
        );
        st.selectLayer(base.id);
      } else {
        // A cross-kind look converts the layer (2D ↔ 3D): say so, it changes every style control.
        const converted = l.kind !== p.kind;
        const label = extra.label ?? (converted ? msg('Apply style “{name}” (→{kind})', { name: p.name, kind: KIND_NAME[p.kind] }) : msg('Apply style “{name}”', { name: p.name }));
        st.edit((proj) => styled(proj, l.id, applyFont), undefined, label);
        if (converted) st.notify(msg('“{layer}” is now a {kind} layer (“{name}”) — ⌘Z to convert back', { layer: l.name, kind: KIND_NAME[p.kind], name: p.name }));
      }
      addRecent({ type: 'look', id: p.id });
    } catch (e) {
      st.notify(errorMsg(e), 'error');
    }
  };

  /** おまかせ: a random factory style of the target's kind and (with "Apply font too") a random font. */
  const omakase = () => {
    const l = current();
    const kind = l?.kind ?? 'title2d';
    const pool = FACTORY_STYLES.filter((p) => p.kind === kind && (!l || canApplyPreset(l, p)));
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)];
    const p = pick(pool);
    const fonts = BUILTIN_FONTS.filter((f) => !f.latinOnly && !(l && l.source.kind === 'text' && l.source.fontId === f.id));
    const fontId = applyFont && (!l || l.source.kind === 'text') ? pick(fonts).id : undefined;
    const font = fontId ? BUILTIN_FONTS.find((f) => f.id === fontId)?.name : undefined;
    const label = font ? msg('おまかせ “{name}” · {font}', { name: p.name, font }) : msg('おまかせ “{name}”', { name: p.name });
    apply(p, { fontId, label });
    useEditor.getState().notify(label);
  };

  /** The layer a colourway recolours directly: a title or a generator (a group recolours its members). */
  const colourwayLayer = () => {
    const l = selectedLayer(useEditor.getState());
    return isTitleLayer(l) || l?.kind === 'generator' ? l : null;
  };

  const previewColourway = (c: Colourway | null) => {
    const l = colourwayLayer();
    const st = useEditor.getState();
    st.setPreviewOverride(c && l ? syncLinks(st.project, applyColourwayToProject(st.project, l.id, c)) : null);
  };

  /** A selected group recolours as one: every title and generator inside it, nested groups included (title + its rays, button + label). */
  const applyColourwayTo = (c: Colourway) => {
    const st = useEditor.getState();
    st.setPreviewOverride(null);
    const name = COLOURWAY_INFO[c].name;
    const l = colourwayLayer();
    if (l) st.edit((proj) => applyColourwayToProject(proj, l.id, c), undefined, msg('Colourway {name}', { name }));
    else {
      const g = selectedLayer(st);
      if (g?.kind !== 'group') return;
      st.edit(
        (proj) => {
          const inside = new Set(subtreeIds(proj.layers, g.id));
          return { ...proj, layers: proj.layers.map((x) => (inside.has(x.id) ? applyColourway(x, c) : x)) };
        },
        undefined,
        msg('Colourway {name} on “{group}”', { name, group: g.name }),
      );
    }
    addRecent({ type: 'colourway', id: c });
  };

  const saveCurrent = () => {
    const st = useEditor.getState();
    const l = current();
    const name = saveName?.trim();
    if (!l || !name) return;
    try {
      addUserPreset(presetFromLayer(st.project, l.id, name, USER_GROUP));
      st.notify(msg('Saved style “{name}”', { name }));
      setSaveName(null);
      setCollapsed(USER_GROUP, false);
    } catch (e) {
      st.notify(msg('Could not save the style: {error}', { error: errorMsg(e) }), 'error');
    }
  };

  const importFile = async () => {
    const st = useEditor.getState();
    const file = await pickFile(`${PRESET_FILE_EXT},.json,application/json`);
    if (!file) return;
    try {
      const n = importUserPresets(await file.text());
      st.notify(msg(n === 1 ? 'Imported {n} style from {file}' : 'Imported {n} styles from {file}', { n, file: file.name }));
      setCollapsed(USER_GROUP, false);
    } catch (e) {
      st.notify(msg('{file}: {error}', { file: file.name, error: errorMsg(e) }), 'error');
    }
  };

  const exportFile = () => {
    downloadBlob(exportUserPresets(), `my-styles${PRESET_FILE_EXT}`);
    useEditor.getState().notify(msg(users.length === 1 ? 'Exported {n} style' : 'Exported {n} styles', { n: users.length }));
  };

  const removeUser = async (p: StylePreset) => {
    if (await useEditor.getState().confirm({ title: 'Delete style', message: msg('Delete the style “{name}”?', { name: p.name }), ok: 'Delete' })) deleteUserPreset(p.id);
  };

  // Colourways first (they apply to every kind), then sections of the target's kind (3D sections
  // for a 3D title); My Styles stays last.
  const kind = title?.kind ?? 'title2d';
  const ordered = [...FACTORY_GROUPS].sort((a, b) => Number(GROUP_KIND[a] !== kind) - Number(GROUP_KIND[b] !== kind));
  const userItems = useMemo(() => users.map(look), [users]);
  const words = queryWords(query);
  // Each section's tiles of the kind shown that match every word of the search.
  const all: { group: string; items: readonly Item[] }[] = [
    { group: COLOURWAYS_GROUP, items: COLOURWAY_ITEMS },
    ...ordered.map((group) => ({ group, items: GROUP_ITEMS[group] })),
    { group: USER_GROUP, items: userItems },
  ];
  const sections = all.map(({ group, items }) => ({
    group,
    items: items.filter((it) => (it.type === 'colourway' || kindFilter === 'all' || it.preset.kind === kindFilter) && words.every((w) => itemText(it, group).includes(w))),
  }));
  const filtering = words.length > 0 || category !== null;
  // A section without a match hides; My Styles stays while nothing is searched (its Save and Import).
  const shown = sections.filter(({ group, items }) => (category === null || group === category) && (items.length > 0 || (group === USER_GROUP && !words.length)));
  const recentItems = recent.flatMap((r): Item[] => {
    if (r.type === 'colourway') return COLOURWAY_ITEMS.filter((it) => it.type === 'colourway' && it.colourway === r.id);
    const it = FACTORY_ITEMS.get(r.id) ?? userItems.find((u) => u.preset.id === r.id);
    return it ? [it] : [];
  });
  const listed = !filtering && kindFilter === 'all' && recentItems.length ? [{ group: RECENT_GROUP, items: recentItems }, ...shown] : shown;
  const clearFilters = () => {
    setQuery('');
    setCategory(null);
    setKindFilter('all');
  };
  const omakaseTip = t(applyFont ? 'Random {kind} style + random font (undoable)' : 'Random {kind} style (undoable)', { kind: title?.kind === 'title3d' ? '3D' : '2D' });

  const kindOptions: { value: KindFilter; label: string; title: string }[] = [
    { value: 'all', label: t('All'), title: t('Looks of both kinds') },
    { value: 'title2d', label: '2D', title: t('2D looks only') },
    { value: 'title3d', label: '3D', title: t('3D looks only') },
  ];
  /** A category chip: shows only `group`'s section (null: every section); again: every section. */
  const chip = (group: string | null, label: string, count: number) => {
    const on = category === group;
    return (
      <button
        key={group ?? ''}
        className={`small lib-chip${on ? ' active' : ''}`}
        aria-pressed={on}
        disabled={!on && count === 0}
        title={group === null ? t('Show every section') : t('Show only {section}', { section: label })}
        onClick={() => setCategory(on ? null : group)}
      >
        {label} <span className="lib-count">{count}</span>
      </button>
    );
  };
  const tile = (it: Item, isUser: boolean) =>
    it.type === 'colourway' ? (
      <ColourwayTile
        key={it.colourway}
        colourway={it.colourway}
        snap={colourSnap}
        enabled={!!recolourable}
        group={recolourable?.kind === 'group'}
        onPreview={previewColourway}
        onApply={applyColourwayTo}
      />
    ) : (
      <Tile
        key={it.preset.id}
        preset={it.preset}
        snap={snap}
        applyFont={applyFont}
        usable={canApplyPreset(target, it.preset)}
        converts={title && title.kind !== it.preset.kind ? it.preset.kind : null}
        renaming={renaming === it.preset.id}
        onHover={preview}
        onApply={apply}
        onRename={isUser ? () => setRenaming(it.preset.id) : undefined}
        onRenamed={(name) => {
          if (name.trim()) renameUserPreset(it.preset.id, name.trim());
          setRenaming(null);
        }}
        onDelete={isUser ? () => void removeUser(it.preset) : undefined}
      />
    );

  return (
    <div className={`panel library-panel tiles-${size}`}>
      {/* The dock tab names the panel: this row says what a click applies to. */}
      <div className="panel-head lib-head">
        <span className="muted ellipsis lib-target">{title ? t('Applies to “{name}”', { name: title.name }) : t('sample “{text}”', { text: SAMPLE_TEXT })}</span>
        <PsStyleImportButton />
      </div>

      <div className="lib-find">
        <input
          id={LIB_FIND_INPUT_ID}
          type="search"
          value={query}
          placeholder={t('Search styles…')}
          aria-label={t('Search styles')}
          title={t('Search the looks, colourways and My Styles by name, section or 2D / 3D, in English or Japanese (⌘F)')}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            // isComposing: Esc that cancels a Japanese IME conversion isn't a clear.
            if (e.key !== 'Escape' || e.nativeEvent.isComposing) return;
            e.preventDefault();
            if (query) setQuery('');
            else e.currentTarget.blur();
          }}
        />
      </div>

      <div className="lib-chips" role="group" aria-label={t('Sections')}>
        {chip(null, t('All'), sections.reduce((n, s) => n + s.items.length, 0))}
        {sections.map(({ group, items }) => chip(group, t(group), items.length))}
      </div>

      <div className="lib-options">
        <label title={t('Also switch to the font the style was designed with (おまかせ: a random font)')}>
          <input type="checkbox" checked={applyFont} aria-label={t('Apply font too')} onChange={(e) => setApplyFont(e.target.checked)} /> {t('Apply font too')}
        </label>
        <Seg value={kindFilter} options={kindOptions} onChange={setKindFilter} />
        <Seg value={size} options={TILE_SIZES.map((o) => ({ ...o, title: t(o.title) }))} onChange={(s) => useLibraryPrefs.setState({ size: s })} />
        <button className="small lib-omakase" title={omakaseTip} aria-label={omakaseTip} onClick={omakase}>
          おまかせ
        </button>
      </div>

      <div className="scroll lib-scroll" onMouseLeave={() => preview(null)}>
        {!title && <div className="lib-hint muted">{t('No title selected — click a style to add a new title with it.')}</div>}
        {!listed.length && (
          <div className="lib-none">
            <span className="muted">{words.length ? t('No styles match “{q}”', { q: query.trim() }) : t('No styles match the filter')}</span>
            <button className="small" title={t('Clear the search and filters')} aria-label={t('Clear the search and filters')} onClick={clearFilters}>
              {t('Clear')}
            </button>
          </div>
        )}
        {listed.map(({ group, items }) => {
          const isUser = group === USER_GROUP;
          // A search or a chosen section shows its matches, folded or not.
          const open = filtering || !collapsed[group];
          return (
            <section key={group} className="lib-section">
              <div className="lib-section-head">
                <button className="lib-fold" title={t(open ? 'Collapse' : 'Expand')} aria-label={t(group)} aria-expanded={open} disabled={filtering} onClick={() => setCollapsed(group, open)}>
                  {open ? '▾' : '▸'} {t(group)} <span className="muted">{items.length}</span>
                </button>
                {isUser && (
                  <span className="lib-section-actions">
                    <button className="small" title={t('Import styles from a file')} aria-label={t('Import styles from a file')} onClick={() => void importFile()}>
                      {t('Import')}
                    </button>
                    <button className="small" title={t('Export My Styles to a file')} aria-label={t('Export My Styles to a file')} disabled={users.length === 0} onClick={exportFile}>
                      {t('Export')}
                    </button>
                  </span>
                )}
              </div>
              {open && (
                <>
                  {isUser && (
                    <div className="lib-save">
                      {saveName === null ? (
                        <button
                          className="small"
                          disabled={!title}
                          title={t('Save the selected title’s look (style, layer and part effects) to My Styles')}
                          aria-label={t('Save current style…')}
                          onClick={() => setSaveName(title ? t('{name} style', { name: title.name }) : '')}
                        >
                          {t('Save current style…')}
                        </button>
                      ) : (
                        <form
                          className="lib-save-form"
                          onSubmit={(e) => {
                            e.preventDefault();
                            saveCurrent();
                          }}
                        >
                          <input
                            type="text"
                            autoFocus
                            value={saveName}
                            title={t('Style name')}
                            aria-label={t('Style name')}
                            onChange={(e) => setSaveName(e.target.value)}
                            onKeyDown={(e) => e.key === 'Escape' && setSaveName(null)}
                          />
                          <button className="small primary" type="submit" title={t('Save')} aria-label={t('Save')} disabled={!saveName.trim() || !title}>
                            {t('Save')}
                          </button>
                          <button className="small" type="button" title={t('Cancel')} aria-label={t('Cancel')} onClick={() => setSaveName(null)}>
                            {t('Cancel')}
                          </button>
                        </form>
                      )}
                    </div>
                  )}
                  <div className="lib-grid">
                    {items.map((it) => tile(it, isUser))}
                    {isUser && users.length === 0 && <div className="lib-empty muted">{t('Saved and imported styles appear here.')}</div>}
                  </div>
                </>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}

/** A colourway tile: the selected title, generator or group recoloured; hover previews it (not on a group), click applies it. */
function ColourwayTile({
  colourway,
  snap,
  enabled,
  group,
  onPreview,
  onApply,
}: {
  colourway: Colourway;
  snap: Snapshot;
  enabled: boolean;
  /** A group is selected: the colourway recolours all its members. */
  group: boolean;
  onPreview(c: Colourway | null): void;
  onApply(c: Colourway): void;
}) {
  const t = useT();
  const job = useMemo<ColourwayThumbJob>(
    () => ({ key: `colourway|${colourway}|${snap.key}`, project: snap.project, layer: snap.layer, colourway }),
    [colourway, snap],
  );
  const hover = useHoverIntent(
    () => enabled && onPreview(colourway),
    () => onPreview(null),
  );
  const { name } = COLOURWAY_INFO[colourway];
  const tip = !enabled
    ? t('Select a title, a generator or a group')
    : group
      ? t('{name} — click to recolour every layer in the group (keeps the structure)', { name })
      : t('{name} — click to recolour the layer (keeps the structure)', { name });
  return (
    <div
      className={`lib-tile${enabled ? '' : ' disabled'}`}
      title={tip}
      {...hover}
      onClick={(e) => {
        // The second click of a double-click would apply (and add an undo step) again.
        if (e.detail > 1) return;
        if (enabled) onApply(colourway);
      }}
    >
      <Thumb job={job} />
      <div className="lib-name ellipsis">{name}</div>
    </div>
  );
}

interface TileProps {
  preset: StylePreset;
  snap: Snapshot;
  applyFont: boolean;
  usable: boolean;
  /** The kind the selected layer becomes when this cross-kind look is applied; null = same kind. */
  converts: StylePreset['kind'] | null;
  renaming: boolean;
  onHover(p: StylePreset | null): void;
  onApply(p: StylePreset): void;
  onRename?: () => void;
  onRenamed(name: string): void;
  onDelete?: () => void;
}

function Tile({ preset, snap, applyFont, usable, converts, renaming, onHover, onApply, onRename, onRenamed, onDelete }: TileProps) {
  const job = useMemo<ThumbJob>(
    () => ({
      key: `${preset.id}|${applyFont && preset.fontId ? preset.fontId : ''}|${snap.key}`,
      project: snap.project,
      layer: snap.layer,
      preset,
      applyFont,
    }),
    [preset, snap, applyFont],
  );
  const hover = useHoverIntent(
    () => usable && onHover(preset),
    () => onHover(null),
  );
  const t = useT();
  const tip = !usable
    ? t("{name} can't be applied to this layer type", { name: preset.name })
    : converts
      ? t('{name} — click to apply — converts the layer to {kind} (undoable)', { name: preset.name, kind: KIND_NAME[converts] })
      : t('{name} — click to apply', { name: preset.name });
  return (
    <div
      className={`lib-tile${usable ? '' : ' disabled'}`}
      title={tip}
      {...hover}
      onClick={(e) => {
        // The second click of a double-click would apply (and add an undo step) again.
        if (e.detail > 1) return;
        if (usable && !renaming) onApply(preset);
      }}
    >
      <Thumb job={job} />
      {converts && usable && (
        <span className={`lib-convert k-${converts}`} title={t('Converts to {kind}', { kind: KIND_NAME[converts] })} aria-label={t('Converts to {kind}', { kind: KIND_NAME[converts] })}>
          →{KIND_NAME[converts]}
        </span>
      )}
      {renaming ? (
        <input
          className="lib-rename"
          type="text"
          autoFocus
          title={t('Style name')}
          aria-label={t('Style name')}
          defaultValue={preset.name}
          onClick={(e) => e.stopPropagation()}
          onBlur={(e) => onRenamed(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onRenamed(e.currentTarget.value);
            if (e.key === 'Escape') onRenamed('');
          }}
        />
      ) : (
        <div className="lib-name ellipsis">
          {preset.kind === 'title3d' && <span className="badge k-title3d">3D</span>} {preset.name}
        </div>
      )}
      {(onRename || onDelete) && !renaming && (
        <div className="lib-tile-actions">
          {onRename && (
            <button
              className="icon-btn"
              title={t('Rename')}
              aria-label={t('Rename')}
              onClick={(e) => {
                e.stopPropagation();
                onRename();
              }}
            >
              ✎
            </button>
          )}
          {onDelete && (
            <button
              className="icon-btn danger"
              title={t('Delete')}
              aria-label={t('Delete')}
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
              }}
            >
              ×
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Live thumbnail canvas: requested while on screen. While a new render is pending it keeps the
 * previous image only if that image shows the same layer (typing, fitting, scrubbing): an image
 * of ANOTHER layer — or a failed render — is cleared, never left standing in for the new one.
 */
function Thumb({ job }: { job: ThumbJob }) {
  const t = useT();
  const ref = useRef<HTMLCanvasElement>(null);
  /** Layer id the canvas currently shows (null = blank). */
  const shown = useRef<string | null>(null);
  const [visible, setVisible] = useState(false);
  useSyncExternalStore(thumbStore.subscribe, thumbStore.getVersion);
  const data = getThumb(job.key);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { rootMargin: '120px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const missing = data === undefined;
  useEffect(() => {
    if (visible && missing) return requestThumb(job);
  }, [visible, missing, job]);

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    if (data) {
      c.width = data.width;
      c.height = data.height;
      c.getContext('2d')?.putImageData(data, 0, 0);
      shown.current = job.layer.id;
    } else if (data === null || shown.current !== job.layer.id) {
      c.getContext('2d')?.clearRect(0, 0, c.width, c.height);
      shown.current = null;
    }
  }, [data, job.layer.id]);

  return (
    <div className="lib-thumb" style={{ aspectRatio: `${THUMB_W} / ${THUMB_H}` }}>
      <canvas ref={ref} />
      {missing && <span className="lib-busy" />}
      {data === null && <span className="lib-failed">{t('render failed')}</span>}
    </div>
  );
}

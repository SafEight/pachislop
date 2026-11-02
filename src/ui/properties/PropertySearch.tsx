import { Activity, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { isTitleLayer, partEffectsOf } from '../../model/parts';
import type { EffectInstance, GeneratorLayer, Layer, PartKey, Project } from '../../model/types';
import { maskLabel, partLabel } from '../../store/labels';
import { formatMsg, type Translate } from '../../store/msg';
import { useEditor, type NodeRef } from '../../store/store';
import { companionSides } from '../companions';
import { ERODE_NAME, erodeListed } from '../erode';
import { glintListed } from '../glint';
import { tr, useLang, useT, type Lang } from '../i18n';
import { listedParts } from '../layers/rows';
import { FindCapture, FindProbe, SectionScope } from '../sectionMemory';
import { effectName } from '../util';
import { CompanionCard } from './CompanionCard';
import { DocumentView } from './DocumentView';
import { EffectView } from './EffectView';
import { ErodeCard } from './ErodeCard';
import { GlintCard } from './GlintCard';
import { LayerView } from './LayerView';
import { MaskView } from './MaskView';
import { MultiView } from './MultiView';
import { PartsInline } from './PartView';
import { nodeKind, resolve } from './resolve';
import { collectHits, FIND_INPUT_ID, focusField, isAdd, landOn, search, type FindIndex, type Hit, type HitMatch, type Match, type Slot } from './searchIndex';
import './search.css';

// The search box at the top of Properties. Its index is built from the real views, rendered once
// per selection (and project / language change) into a detached root inside a hidden <Activity>:
// hidden content renders without running its effects, so no thumbnail, preview or histogram
// work starts, and FindProbe opens every section. Reading the DOM of the views the panel itself
// renders keeps the index in step with the panel by construction (no list of controls to keep in
// sync by hand) and indexes exactly what the selected layer has: a 3D-only control on a 2D layer
// is simply not there. See searchIndex.ts for what is read and how a result is found again. The
// store-bound controls register themselves in the render (FindCapture), and the results show
// them live: the same control bound to the same ref, edited in place with the usual undo.

/** What the index depends on. */
interface Inputs {
  project: Project;
  node: NodeRef | null;
  ids: readonly string[];
  lang: Lang;
}

interface ProbeView {
  slot: Slot;
  scope: string;
  view: ReactNode;
}

/**
 * The pages of the index for the selection: the layer's page (or the several layers' page), each
 * part as edited in place, a 3D title's listed glint or a 2D title's listed かすれ, each effect
 * (layer and part), companion (ui/companions.ts) and mask as its own node page, then the Document.
 */
function probeViews({ project, node, ids }: Inputs, t: Translate): ProbeView[] {
  const views: ProbeView[] = [];
  const at = resolve(project, node, null);
  if (at.kind !== 'document') {
    const layer = at.layer;
    if (ids.length > 1 && at.kind === 'layer' && !at.parts.length) {
      views.push({ slot: { key: 'multi', target: { kind: 'multi' }, prefix: [], open: [] }, scope: 'multi', view: <MultiView layer={layer} /> });
    } else {
      const scope = nodeKind({ kind: 'layer', layer, parts: [] }, false);
      views.push({ slot: { key: 'layer', target: { kind: 'layer', layerId: layer.id }, prefix: [], open: [] }, scope, view: <LayerView layer={layer} /> });
      const effectView = (part: PartKey | null, fx: EffectInstance, prefix: string[]): ProbeView => ({
        slot: { key: `fx:${fx.id}`, target: { kind: 'effect', layerId: layer.id, part, effectId: fx.id }, prefix, open: [] },
        scope: `effect:${fx.type}`,
        view: <EffectView layerId={layer.id} part={part} effectId={fx.id} />,
      });
      const companionView = (gen: GeneratorLayer, behind: boolean): ProbeView => ({
        slot: { key: `companion:${gen.id}`, target: { kind: 'companion', layerId: gen.id }, prefix: [t('Effects'), gen.name], open: [] },
        scope: `generator:${gen.generator.type}`,
        view: <CompanionCard owner={layer} gen={gen} behind={behind} full />,
      });
      if (isTitleLayer(layer)) {
        // As the Appearance list shows them (a GLB model only has its face material).
        const parts = layer.kind === 'title3d' && layer.source.kind === 'model' ? (['face'] as const) : listedParts(layer);
        for (const part of parts) {
          const name = formatMsg(partLabel(layer, part), t);
          views.push({
            slot: { key: `part:${part}`, target: { kind: 'part', layerId: layer.id, part }, prefix: [name], open: [`${scope}/appearance`] },
            scope,
            view: <PartsInline layer={layer} parts={[part]} />,
          });
          for (const fx of partEffectsOf(layer, part)) views.push(effectView(part, fx, [name, effectName(t, fx)]));
        }
      }
      if (glintListed(layer))
        views.push({
          slot: { key: 'glint', target: { kind: 'glint', layerId: layer.id }, prefix: [t('Effects'), t('Glint')], open: [] },
          scope: 'glint3d',
          view: <GlintCard layers={[layer]} full />,
        });
      if (erodeListed(layer))
        views.push({
          slot: { key: 'erode', target: { kind: 'erode', layerId: layer.id }, prefix: [t('Effects'), t(ERODE_NAME)], open: [] },
          scope: 'erode2d',
          view: <ErodeCard layers={[layer]} full />,
        });
      const { front, back } = companionSides(project.layers, layer.id);
      for (const c of front) views.push(companionView(c, false));
      for (const fx of layer.effects) views.push(effectView(null, fx, [t('Effects'), effectName(t, fx)]));
      for (const c of back) views.push(companionView(c, true));
      for (const mask of layer.masks)
        views.push({
          slot: { key: `mask:${mask.id}`, target: { kind: 'mask', layerId: layer.id, maskId: mask.id }, prefix: [formatMsg(maskLabel(layer, mask.id), t)], open: [] },
          scope: `mask:${mask.kind}`,
          view: <MaskView layer={layer} mask={mask} />,
        });
    }
  }
  views.push({ slot: { key: 'doc', target: { kind: 'document' }, prefix: [t('Document')], open: [] }, scope: 'doc', view: <DocumentView /> });
  return views;
}

/** The pages, each in its own `[data-find-slot]` box, then the end marker of render `run`; their store-bound controls register in `captured`. */
function Probe({ views, run, captured }: { views: readonly ProbeView[]; run: number; captured: Map<string, ReactElement> }) {
  return (
    <FindProbe value>
      <FindCapture value={captured}>
        {views.map((v, i) => (
          <div key={v.slot.key} data-find-slot={i}>
            <SectionScope value={v.scope}>{v.view}</SectionScope>
          </div>
        ))}
      </FindCapture>
      <i data-find-end={run} />
    </FindProbe>
  );
}

/** Whether the Document's 3D lighting concerns the selection: a 3D title among it (a group's members included), or nothing selected. */
function uses3d(project: Project, ids: readonly string[]): boolean {
  if (!ids.length) return true;
  const within = (id: string): boolean => project.layers.some((l: Layer) => (l.id === id && l.kind === 'title3d') || (l.parentId === id && within(l.id)));
  return ids.some(within);
}

const probeHost = document.createElement('div');
let probeRoot: Root | null = null;
let probeRun = 0;
/** Ends the render in progress (with what is there, or nothing). */
let finishProbe: (() => void) | null = null;
let lastBuild: { inputs: Inputs; index: Promise<FindIndex> } | null = null;

/** Render the pages hidden, read the hits once the end marker is in, and unmount them again. */
function buildIndex(inputs: Inputs): Promise<FindIndex> {
  finishProbe?.();
  const run = ++probeRun;
  const views = probeViews(inputs, tr);
  const captured = new Map<string, ReactElement>();
  const first = views[0].slot.target;
  const layer = first.kind === 'layer' ? inputs.project.layers.find((l) => l.id === first.layerId) : undefined;
  // Executor form: the app's lib predates Promise.withResolvers.
  return new Promise<FindIndex>((done) => {
    const finish = () => {
      observer.disconnect();
      finishProbe = null;
      const hits = probeHost.querySelector(`[data-find-end="${run}"]`) ? collectHits(probeHost, views.map((v) => v.slot), inputs.lang, captured) : [];
      probeRoot?.render(null);
      done({
        hits,
        with3d: uses3d(inputs.project, inputs.ids),
        addTo: layer?.id ?? null,
        hasTypes: new Set(layer?.effects.map((e) => e.type)),
        addPinned: layer?.kind === 'title3d' && !glintListed(layer) ? 'glint' : layer?.kind === 'title2d' && !erodeListed(layer) ? 'erode' : null,
      });
    };
    const observer = new MutationObserver(() => {
      if (probeHost.querySelector(`[data-find-end="${run}"]`)) finish();
    });
    observer.observe(probeHost, { childList: true, subtree: true });
    finishProbe = finish;
    probeRoot ??= createRoot(probeHost, {
      onUncaughtError: (error) => {
        console.error('[find] the settings index failed to render', error);
        finishProbe?.();
      },
    });
    probeRoot.render(
      <Activity mode="hidden">
        <Probe views={views} run={run} captured={captured} />
      </Activity>,
    );
  });
}

/** Same selection and language (the project may differ): the shown index's controls stay valid while edits re-index. */
const sameSelection = (a: Inputs, b: Inputs) => a.lang === b.lang && JSON.stringify(a.node) === JSON.stringify(b.node) && a.ids.join() === b.ids.join();

/** Same index: the same project, and a selection equal in value (clicking the selected layer again makes new objects). */
const sameInputs = (a: Inputs, b: Inputs) => a.project === b.project && sameSelection(a, b);

/** The index for `inputs`, built once per change of the selection, project or language. */
function indexFor(inputs: Inputs): Promise<FindIndex> {
  if (!lastBuild || !sameInputs(lastBuild.inputs, inputs)) lastBuild = { inputs, index: buildIndex(inputs) };
  return lastBuild.index;
}

/** Quiet time (ms) after an edit before the shown results are re-indexed: a drag in a result doesn't re-render every page each frame. */
const REINDEX_MS = 250;
/** Results rendered at first, and added by each "Show more": each live result is a mounted control. */
const PAGE = 30;

/** React key of a hit, stable across re-indexing (its order shifts when a control appears above it). */
const hitKey = (h: Hit) => `${h.slot.key}|${h.sections.join('>')}|${h.fid ?? ''}|${h.nth}`;

/**
 * "Find a setting…" (⌘F from the canvas or Properties): the selected layer's controls — its page,
 * every part, its letters, its effects and masks — and the Document's, by label in English and
 * Japanese, section name or synonym. While a query is typed the results cover the panel, each
 * store-bound control rendered live under its location (edit it right there; the location goes
 * to it in its page), the others (sections, cards, controls that only work in their page, effects
 * to add) as links. ↑ / ↓ pick a result, ↵ focuses its control or follows its link (selects its
 * part, effect or the Document, opens the sections, scrolls to the control, focuses and flashes
 * it); Esc in a result returns to the field, Esc in the field clears, then leaves it.
 */
export function PropertySearch() {
  const t = useT();
  const project = useEditor((s) => s.project);
  const node = useEditor((s) => s.selectedNode);
  const ids = useEditor((s) => s.selectedLayerIds);
  const lang = useLang((s) => s.lang);
  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState(false);
  // Whether the results show for the query: closed by going to a result, opened by the field.
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [shown, setShown] = useState(PAGE);
  const [index, setIndex] = useState<{ inputs: Inputs; index: FindIndex } | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searching = open && query.trim() !== '';
  const current = index && sameSelection(index.inputs, { project, node, ids, lang }) ? index.index : null;
  const indexed = current !== null;
  // Built as soon as the field has focus, so it is usually ready by the first letter typed; kept
  // while results show. An edit keeps the shown results (their controls read the store) until
  // the edits pause, then re-indexes.
  useEffect(() => {
    if (!focused && !searching) return;
    const want = { project, node, ids, lang };
    let live = true;
    const build = () => void indexFor(want).then((ix) => live && setIndex({ inputs: want, index: ix }));
    const timer = indexed ? setTimeout(build, REINDEX_MS) : undefined;
    if (!indexed) build();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [focused, searching, indexed, project, node, ids, lang]);
  const deferredQuery = useDeferredValue(query);
  const { hits, adds } = useMemo(() => {
    const found = current ? search(current, deferredQuery) : [];
    return { hits: found.filter((m): m is HitMatch => !isAdd(m)), adds: found.filter(isAdd) };
  }, [current, deferredQuery]);
  const rows: Match[] = [...hits.slice(0, shown), ...adds];
  const at = Math.min(active, Math.max(0, rows.length - 1));
  // The list covers the panel below the field.
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (searching && box && listRef.current) listRef.current.style.top = `${box.offsetTop + box.offsetHeight}px`;
  }, [searching]);
  useEffect(() => {
    listRef.current?.querySelector('[data-active]')?.scrollIntoView({ block: 'nearest' });
  }, [at]);
  const go = (m: Match) => {
    setOpen(false);
    landOn(m);
  };
  /** ↵ on result `i`: focus its live control, else follow it. */
  const enter = (i: number) => {
    const m = rows[i];
    if (!m) return;
    const field = !isAdd(m) && m.hit.live ? listRef.current?.querySelector<HTMLElement>(`[data-row="${i}"] [data-fid]`) : null;
    if (field && !isAdd(m)) focusField(field, m.pick);
    else go(m);
  };
  return (
    <div className="props-find" ref={boxRef}>
      <input
        id={FIND_INPUT_ID}
        type="search"
        value={query}
        placeholder={t('Find a setting…')}
        aria-label={t('Find a setting')}
        title={t('Find a setting of this layer (its parts, letters, effects and masks) or the Document, in English or Japanese (⌘F)')}
        aria-expanded={searching}
        aria-controls="props-find-list"
        autoComplete="off"
        spellCheck={false}
        onFocus={() => {
          setFocused(true);
          setOpen(true);
        }}
        onBlur={() => setFocused(false)}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          setActive(0);
          setShown(PAGE);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            if (rows.length) setActive((at + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length);
          } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            // isComposing: Enter that confirms a Japanese IME conversion isn't a pick.
            e.preventDefault();
            if (searching) enter(at);
            else setOpen(true);
          } else if (e.key === 'Escape' && !e.nativeEvent.isComposing) {
            e.preventDefault();
            if (query) setQuery('');
            else e.currentTarget.blur();
          }
        }}
      />
      {searching && (
        <div
          className="props-find-list"
          id="props-find-list"
          aria-label={t('Find a setting')}
          ref={listRef}
          onKeyDown={(e) => {
            // Esc a control didn't take: back to the field.
            if (e.key === 'Escape' && !e.defaultPrevented && !e.nativeEvent.isComposing) document.getElementById(FIND_INPUT_ID)?.focus();
          }}
        >
          {!current ? (
            <div className="props-find-note">{t('Searching…')}</div>
          ) : !rows.length ? (
            <div className="props-find-note">{t('No setting here matches “{q}”', { q: deferredQuery.trim() })}</div>
          ) : (
            rows.map((m, i) => {
              const add = isAdd(m);
              const value = !add && m.pick >= 0 ? m.hit.values[m.pick] : null;
              if (!add && m.hit.live)
                return (
                  <div key={hitKey(m.hit)} className="props-find-item live" data-row={i} data-active={i === at || undefined} onFocus={() => setActive(i)}>
                    <button type="button" className="pf-path" tabIndex={-1} title={t('Show this setting in its place')} onClick={() => go(m)}>
                      {m.hit.crumbs.join(' › ') || m.hit.label}
                      {value && <span className="muted"> · {value}</span>}
                    </button>
                    {m.hit.live}
                  </div>
                );
              const path = add ? t('Add effect') : m.hit.crumbs.join(' › ');
              return (
                <button
                  type="button"
                  key={add ? `add:${m.def?.type ?? m.pinned}` : hitKey(m.hit)}
                  className={`props-find-item ${add ? 'add' : ''}`}
                  data-row={i}
                  data-active={i === at || undefined}
                  tabIndex={-1}
                  onFocus={() => setActive(i)}
                  onClick={() => go(m)}
                >
                  <span className="pf-label">
                    {add ? `+ ${m.name}` : m.hit.label}
                    {value && <span className="muted"> · {value}</span>}
                  </span>
                  {path && <span className="pf-path">{path}</span>}
                </button>
              );
            })
          )}
          {current && hits.length > shown && (
            <button type="button" className="small props-find-more" onClick={() => setShown(shown + PAGE)}>
              {t('Show {n} more', { n: Math.min(PAGE, hits.length - shown) })}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

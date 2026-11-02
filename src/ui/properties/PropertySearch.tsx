import { Activity, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { isTitleLayer, partEffectsOf } from '../../model/parts';
import type { EffectInstance, Layer, PartKey, Project } from '../../model/types';
import { maskLabel, partLabel } from '../../store/labels';
import { formatMsg, type Translate } from '../../store/msg';
import { useEditor, type NodeRef } from '../../store/store';
import { glintListed } from '../glint';
import { tr, useLang, useT, type Lang } from '../i18n';
import { listedParts } from '../layers/rows';
import { FindProbe, SectionScope } from '../sectionMemory';
import { effectName } from '../util';
import { DocumentView } from './DocumentView';
import { EffectView } from './EffectView';
import { GlintCard } from './GlintCard';
import { LayerView } from './LayerView';
import { MaskView } from './MaskView';
import { MultiView } from './MultiView';
import { PartsInline } from './PartView';
import { nodeKind, resolve } from './resolve';
import { collectHits, FIND_INPUT_ID, isAdd, landOn, search, type FindIndex, type Match, type Slot } from './searchIndex';
import './search.css';

// The search box at the top of Properties. Its index is built from the real views, rendered once
// per selection (and project / language change) into a detached root inside a hidden <Activity>:
// hidden content renders without running its effects, so no thumbnail, preview or histogram
// work starts, and FindProbe opens every section. Reading the DOM of the views the panel itself
// renders keeps the index in step with the panel by construction (no list of controls to keep in
// sync by hand) and indexes exactly what the selected layer has: a 3D-only control on a 2D layer
// is simply not there. See searchIndex.ts for what is read and how a result is found again.

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
 * part as edited in place, a 3D title's listed glint, each effect (layer and part) and mask as its
 * own node page, then the Document.
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
      for (const fx of layer.effects) views.push(effectView(null, fx, [t('Effects'), effectName(t, fx)]));
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

/** The pages, each in its own `[data-find-slot]` box, then the end marker of render `run`. */
function Probe({ views, run }: { views: readonly ProbeView[]; run: number }) {
  return (
    <FindProbe value>
      {views.map((v, i) => (
        <div key={v.slot.key} data-find-slot={i}>
          <SectionScope value={v.scope}>{v.view}</SectionScope>
        </div>
      ))}
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
  const layer = views[0].slot.target.kind === 'layer' ? inputs.project.layers.find((l) => l.id === inputs.node?.layerId) : undefined;
  // Executor form: the app's lib predates Promise.withResolvers.
  return new Promise<FindIndex>((done) => {
    const finish = () => {
      observer.disconnect();
      finishProbe = null;
      const hits = probeHost.querySelector(`[data-find-end="${run}"]`) ? collectHits(probeHost, views.map((v) => v.slot), inputs.lang) : [];
      probeRoot?.render(null);
      done({
        hits,
        with3d: uses3d(inputs.project, inputs.ids),
        addTo: layer?.id ?? null,
        hasTypes: new Set(layer?.effects.map((e) => e.type)),
        addGlint: layer?.kind === 'title3d' && !glintListed(layer),
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
        <Probe views={views} run={run} />
      </Activity>,
    );
  });
}

/** Same index: the same project and language, and a selection equal in value (clicking the selected layer again makes new objects). */
const sameInputs = (a: Inputs, b: Inputs) =>
  a.project === b.project && a.lang === b.lang && JSON.stringify(a.node) === JSON.stringify(b.node) && a.ids.join() === b.ids.join();

/** The index for `inputs`, built once per change of the selection, project or language. */
function indexFor(inputs: Inputs): Promise<FindIndex> {
  if (!lastBuild || !sameInputs(lastBuild.inputs, inputs)) lastBuild = { inputs, index: buildIndex(inputs) };
  return lastBuild.index;
}

/**
 * "Find a setting…" (⌘F from the canvas or Properties): the selected layer's controls — its page,
 * every part, its letters, its effects and masks — and the Document's, by label in English and
 * Japanese, section name or synonym. ↑ / ↓ pick a result, ↵ goes there (selects its part, effect
 * or the Document, opens the sections, scrolls to the control, focuses and flashes it); Esc
 * clears, then leaves the field.
 */
export function PropertySearch() {
  const t = useT();
  const project = useEditor((s) => s.project);
  const node = useEditor((s) => s.selectedNode);
  const ids = useEditor((s) => s.selectedLayerIds);
  const lang = useLang((s) => s.lang);
  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(0);
  const [index, setIndex] = useState<{ inputs: Inputs; index: FindIndex } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const wanted = focused && query.trim() !== '';
  // Built as soon as the field has focus, so it is usually ready by the first letter typed.
  useEffect(() => {
    if (!focused) return;
    const inputs = { project, node, ids, lang };
    let live = true;
    void indexFor(inputs).then((ix) => live && setIndex({ inputs, index: ix }));
    return () => {
      live = false;
    };
  }, [focused, project, node, ids, lang]);
  const current = index && sameInputs(index.inputs, { project, node, ids, lang }) ? index.index : null;
  const results = useMemo(() => (current ? search(current, query) : []), [current, query]);
  const at = Math.min(active, Math.max(0, results.length - 1));
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [at, results]);
  const choose = (m: Match) => {
    setFocused(false);
    landOn(m);
  };
  return (
    <div className="props-find">
      <input
        id={FIND_INPUT_ID}
        type="search"
        value={query}
        placeholder={t('Find a setting…')}
        aria-label={t('Find a setting')}
        title={t('Find a setting of this layer (its parts, letters, effects and masks) or the Document, in English or Japanese (⌘F)')}
        role="combobox"
        aria-expanded={wanted}
        aria-controls="props-find-list"
        autoComplete="off"
        spellCheck={false}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            if (results.length) setActive((at + (e.key === 'ArrowDown' ? 1 : results.length - 1)) % results.length);
          } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            // isComposing: Enter that confirms a Japanese IME conversion isn't a pick.
            e.preventDefault();
            if (results[at]) choose(results[at]);
          } else if (e.key === 'Escape' && !e.nativeEvent.isComposing) {
            e.preventDefault();
            if (query) setQuery('');
            else e.currentTarget.blur();
          }
        }}
      />
      {wanted && (
        // Pointer-down keeps the focus in the field, so a click picks before the list closes.
        <div className="props-find-list" id="props-find-list" role="listbox" ref={listRef} onPointerDown={(e) => e.preventDefault()}>
          {!current ? (
            <div className="props-find-note">{t('Searching…')}</div>
          ) : !results.length ? (
            <div className="props-find-note">{t('No setting here matches “{q}”', { q: query.trim() })}</div>
          ) : (
            results.map((m, i) => {
              const add = isAdd(m);
              const value = !add && m.pick >= 0 ? m.hit.values[m.pick] : null;
              const path = add ? t('Add effect') : m.hit.crumbs.join(' › ');
              return (
                <div
                  key={add ? `add:${m.def?.type ?? 'glint3d'}` : `${m.hit.slot.key}|${m.hit.order}`}
                  role="option"
                  aria-selected={i === at}
                  className={`props-find-item ${add ? 'add' : ''}`}
                  onPointerEnter={() => setActive(i)}
                  onClick={() => choose(m)}
                >
                  <span className="pf-label">
                    {add ? `+ ${m.name}` : m.hit.label}
                    {value && <span className="muted"> · {value}</span>}
                  </span>
                  {path && <span className="pf-path">{path}</span>}
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

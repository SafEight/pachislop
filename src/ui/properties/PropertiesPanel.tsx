import { useEffect, useLayoutEffect, useRef } from 'react';
import type { Layer } from '../../model/types';
import { formatMsg } from '../../store/msg';
import { maskLabel, partLabel } from '../../store/labels';
import { useEditor } from '../../store/store';
import { SectionScope } from '../sectionMemory';
import { useT } from '../i18n';
import { effectName } from '../util';
import { Breadcrumb } from './Breadcrumb';
import { DocumentView } from './DocumentView';
import { EffectView } from './EffectView';
import { LayerView } from './LayerView';
import { MultiView } from './MultiView';
import { MaskView } from './MaskView';
import { PartView } from './PartView';
import { usePartPage } from './parts';
import { PropertySearch } from './PropertySearch';
import { nodeKind, resolve, type Resolved } from './resolve';
import './properties.css';
import './style.css';

const KIND_LABEL: Record<Layer['kind'], string> = { title2d: '2D', title3d: '3D', background: 'BG', group: 'GRP', adjustment: 'ADJ', generator: 'GEN' };

/** Kind badge and name of the shown node. */
function Header({ at }: { at: Resolved }) {
  const t = useT();
  const nSel = useEditor((s) => s.selectedLayerIds.length);
  const comp = useEditor((s) => s.project.comp);
  const projectName = useEditor((s) => s.project.name);
  if (at.kind === 'document')
    return (
      <div className="panel-head props-head">
        <span className="badge k-document">{t('DOC')}</span>
        <span className="ellipsis">
          {projectName} <span className="muted">{comp.width}×{comp.height}</span>
        </span>
      </div>
    );
  const { layer } = at;
  const badge =
    at.kind === 'part' ? (
      <span className="badge k-part">{t('Part')}</span>
    ) : at.kind === 'effect' ? (
      <span className="badge k-effect">fx</span>
    ) : at.kind === 'mask' ? (
      <span className="badge k-mask">{t('Mask')}</span>
    ) : (
      <span className={`badge k-${layer.kind}`}>{layer.kind === 'title2d' || layer.kind === 'title3d' ? KIND_LABEL[layer.kind] : t(KIND_LABEL[layer.kind])}</span>
    );
  const name =
    at.kind === 'part'
      ? formatMsg(partLabel(at.layer, at.part), t)
      : at.kind === 'effect'
        ? effectName(t, at.fx)
        : at.kind === 'mask'
          ? formatMsg(maskLabel(at.layer, at.mask.id), t)
          : layer.name;
  return (
    <div className="panel-head props-head">
      {badge}
      <span className="ellipsis" title={name}>
        {name}
      </span>
      {at.kind === 'layer' && nSel > 1 && (
        <span className="muted" title={t('{n} layers selected: Properties shows “{name}”; align / distribute, arrange, duplicate and delete act on all of them', { n: nSel, name: layer.name })}>
          +{nSel - 1}
        </span>
      )}
      {layer.guide && (
        <span className="guide-tag right" title={t('Guide layer: shown in the editor, excluded from exports')}>
          {t('guide')}
        </span>
      )}
    </div>
  );
}

/** Scroll position of the body per node kind + layer, for this session: going back to a layer (or to another of its rims) returns to where you were. */
const scrollMemory = new Map<string, number>();

/**
 * Properties: contextual to the selected tree node, no tabs. The setting search (⌘F), a
 * breadcrumb and a header, then the node's view — a layer (by kind; its selected parts expanded
 * in Appearance), a part opened on its own page, an effect, a layer mask, several layers, or the
 * Document when nothing is selected. Section states and the scroll position are remembered per
 * kind of node; expanding or collapsing a part keeps the layer page and its scroll.
 */
export function PropertiesPanel() {
  const project = useEditor((s) => s.project);
  const node = useEditor((s) => s.selectedNode);
  const multi = useEditor((s) => s.selectedLayerIds.length > 1);
  const pageKey = usePartPage((s) => s.key);
  const bodyRef = useRef<HTMLDivElement>(null);
  const at = resolve(project, node, pageKey);
  // A part page lasts while its part or one of its effects is selected.
  useEffect(() => {
    const own = node && (node.kind === 'part' || node.kind === 'effect') && node.part !== null ? `${node.layerId}:${node.part}` : null;
    if (pageKey && own !== pageKey) usePartPage.setState({ key: null });
  }, [node, pageKey]);
  const kind = nodeKind(at, multi);
  const scrollKey = at.kind === 'document' ? kind : `${kind}|${at.layer.id}`;
  const key =
    at.kind === 'document'
      ? 'doc'
      : at.kind === 'layer'
        ? at.layer.id
        : at.kind === 'part'
          ? `${at.layer.id}:${at.part}`
          : at.kind === 'mask'
            ? `${at.layer.id}:${at.mask.id}`
            : `${at.layer.id}:${at.fx.id}`;
  // The body remounts per node: restore its remembered scroll, once more on the next frame for
  // content that grows after the first layout (thumbnails, previews).
  const shownKey = useRef(scrollKey);
  useLayoutEffect(() => {
    shownKey.current = scrollKey;
    const el = bodyRef.current;
    const top = scrollMemory.get(scrollKey) ?? 0;
    if (!el || !top) return;
    el.scrollTop = top;
    const raf = requestAnimationFrame(() => {
      if (el.scrollTop < top) el.scrollTop = top;
    });
    return () => cancelAnimationFrame(raf);
  }, [key, scrollKey]);
  // Every store change is seen here before React swaps the body: note where the shown one is
  // scrolled (a scroll event of the last moment may not have arrived yet).
  useEffect(
    () =>
      useEditor.subscribe(() => {
        if (bodyRef.current) scrollMemory.set(shownKey.current, bodyRef.current.scrollTop);
      }),
    [],
  );
  return (
    <div className="panel properties">
      <PropertySearch />
      <Breadcrumb at={at} />
      <Header at={at} />
      <div
        className={`scroll props-body ${at.kind === 'effect' ? 'full' : ''}`}
        key={key}
        ref={bodyRef}
        onScroll={(e) => scrollMemory.set(scrollKey, e.currentTarget.scrollTop)}
      >
        <SectionScope value={kind}>
          {at.kind === 'document' ? (
            <DocumentView />
          ) : at.kind === 'layer' ? (
            multi && !at.parts.length ? <MultiView layer={at.layer} /> : <LayerView layer={at.layer} parts={at.parts} />
          ) : at.kind === 'part' ? (
            <PartView layer={at.layer} part={at.part} />
          ) : at.kind === 'mask' ? (
            <MaskView layer={at.layer} mask={at.mask} />
          ) : (
            <EffectView layerId={at.layer.id} part={at.part} effectId={at.fx.id} />
          )}
        </SectionScope>
      </div>
    </div>
  );
}

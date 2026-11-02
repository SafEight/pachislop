import { isFoldedWrapper } from '../../model/companions';
import { isTitleLayer } from '../../model/parts';
import type { Layer } from '../../model/types';
import { formatMsg } from '../../store/msg';
import { maskLabel, partLabel } from '../../store/labels';
import { useEditor, type NodeRef } from '../../store/store';
import { ancestorsOf } from '../../store/tree';
import { useT } from '../i18n';
import { ERODE_NAME } from '../erode';
import { effectName } from '../util';
import type { Resolved } from './resolve';

/**
 * Path of the shown node — Document, the enclosing groups, the layer, the part (also one
 * expanded in the layer page), the effect, glint, かすれ, companion or mask — like
 * `BIG BONUS › Rim 2 › Outer Glow`, `BIG BONUS › Effects › Star glints`, `BIG BONUS › Mask 1` or
 * `BIG BONUS › 2 parts`. A layer's own effects (its glint, かすれ and companions too) sit under an
 * Effects crumb. Every crumb but the last selects its node (Effects: the layer), so the layer
 * crumb collapses an expanded part.
 */
export function Breadcrumb({ at }: { at: Resolved }) {
  const t = useT();
  const layers = useEditor((s) => s.project.layers);
  const selectNode = useEditor((s) => s.selectNode);
  const crumbs: { key: string; label: string; node: NodeRef | null }[] = [{ key: 'doc', label: t('Document'), node: null }];
  if (at.kind !== 'document') {
    const layer: Layer = at.layer;
    // A folded companion group (isFoldedWrapper) has no row, so no crumb: the path reads its layer.
    for (const g of ancestorsOf(layers, layer.id).reverse()) if (!isFoldedWrapper(layers, g)) crumbs.push({ key: g.id, label: g.name, node: { kind: 'layer', layerId: g.id } });
    crumbs.push({ key: layer.id, label: layer.name, node: { kind: 'layer', layerId: layer.id } });
    const part = at.kind === 'part' || at.kind === 'effect' ? at.part : null;
    if (part && isTitleLayer(layer)) crumbs.push({ key: part, label: formatMsg(partLabel(layer, part), t), node: { kind: 'part', layerId: layer.id, part } });
    if (at.kind === 'layer' && isTitleLayer(layer) && at.parts.length)
      crumbs.push({ key: 'parts', label: at.parts.length === 1 ? formatMsg(partLabel(layer, at.parts[0]), t) : t('{n} parts', { n: at.parts.length }), node: null });
    if ((at.kind === 'effect' && at.part === null) || at.kind === 'glint' || at.kind === 'erode' || at.kind === 'companion')
      crumbs.push({ key: 'fx', label: t('Effects', undefined, { ctx: 'layers' }), node: { kind: 'layer', layerId: layer.id } });
    if (at.kind === 'effect') crumbs.push({ key: at.fx.id, label: effectName(t, at.fx), node: null });
    if (at.kind === 'glint') crumbs.push({ key: 'glint', label: t('Glint'), node: null });
    if (at.kind === 'erode') crumbs.push({ key: 'erode', label: t(ERODE_NAME), node: null });
    if (at.kind === 'companion') crumbs.push({ key: at.gen.id, label: at.gen.name, node: null });
    if (at.kind === 'mask') crumbs.push({ key: at.mask.id, label: formatMsg(maskLabel(layer, at.mask.id), t), node: null });
  }
  return (
    <nav className="props-crumbs" aria-label={t('Selection path')}>
      {crumbs.map((c, i) => {
        const last = i === crumbs.length - 1;
        return (
          <span key={c.key} className="crumb-wrap">
            {i > 0 && (
              <span className="crumb-sep" aria-hidden>
                ›
              </span>
            )}
            {last ? (
              <span className="crumb current" aria-current="page" title={c.label}>
                {c.label}
              </span>
            ) : (
              <button className="crumb" title={t('Select {name}', { name: c.label })} aria-label={t('Select {name}', { name: c.label })} onClick={() => selectNode(c.node)}>
                {c.label}
              </button>
            )}
          </span>
        );
      })}
    </nav>
  );
}

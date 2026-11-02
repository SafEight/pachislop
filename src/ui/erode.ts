import { erode2D } from '../model/defaults';
import type { Erode2D, Layer, Title2DLayer } from '../model/types';
import { msg } from '../store/msg';
import { useEditor, type PropRef, type Refs } from '../store/store';

// The 2D かすれ dry brush (`style.erode`, streak noise eating the outer silhouette band) shown as
// an effect of its title, as the 3D glint is (ui/glint.ts): a row pinned first under the layer's
// Effects in the Layers panel, an effect card, an “Add effect” entry. It stays the title's own
// style setting: it is listed while it is on or tuned away from the defaults (so a tuned one
// hidden by its eye stays listed); “adding” switches it on, “deleting” puts it back to the
// defaults, off. It erodes the drawn title itself, before every other effect, so it can't be
// reordered.

/** Name of the dry brush: its row, card and “+ Add effect” entry (menu and ⌘F). */
export const ERODE_NAME = 'かすれ Dry brush';

/** What the dry brush does (card info tip, Add effect menu). */
export const ERODE_ABOUT =
  'Dry-brush streaks eat into the outer edge of the title (distressed, brush-kanji かすれ), cutting the face and every rim alike. Applied to the drawn title itself, before every other effect.';

/** Why the dry-brush row / card stays first and has no drag handle. */
export const ERODE_PINNED = 'Pinned first: かすれ erodes the drawn title itself, before the other effects run, so it can’t be reordered';

const DEFAULT_ERODE = erode2D();

/** Whether `l` lists its dry brush as an effect: a 2D title whose erode is on, or has any setting (on / off aside) off its default. */
export function erodeListed(l: Layer | undefined): l is Title2DLayer {
  if (l?.kind !== 'title2d') return false;
  const e = l.style.erode;
  return e.enabled || (Object.keys(DEFAULT_ERODE) as (keyof Erode2D)[]).some((k) => k !== 'enabled' && e[k] !== DEFAULT_ERODE[k]);
}

/** `style.erode` (or a field of it, `path`) of every layer of `ids`, as one target or a list. */
export function erodeRefs(ids: readonly string[], ...path: string[]): Refs {
  const refs = ids.map((layerId): PropRef => ({ layerId, path: ['style', 'erode', ...path] }));
  return refs.length === 1 ? refs[0] : refs;
}

/** Eye / checkbox: the dry brush on or off on every layer of `ids` (a tuned one stays listed while off). */
export function setErodeEnabled(ids: readonly string[], on: boolean) {
  useEditor.getState().setAt(erodeRefs(ids, 'enabled'), on, undefined, on ? 'Dry brush on' : 'Dry brush off');
}

/** “+ Add effect › かすれ”: switch the dry brush on with the values it has (the defaults after a Delete), and open its card. */
export function addErode(layerId: string) {
  const st = useEditor.getState();
  st.setAt(erodeRefs([layerId], 'enabled'), true, undefined, 'Dry brush on');
  st.selectNode({ kind: 'erode', layerId });
}

/** Delete: the dry brush back to the defaults, off (one undo step), so it is unlisted; a selected erode node falls back to its layer. */
export function deleteErode(ids: readonly string[]) {
  const st = useEditor.getState();
  st.setAt(erodeRefs(ids), erode2D(), undefined, msg('Delete {effect}', { effect: msg(ERODE_NAME) }));
  const node = st.selectedNode;
  if (node?.kind === 'erode' && ids.includes(node.layerId)) st.selectNode({ kind: 'layer', layerId: node.layerId });
}

/** Reset: the default dry-brush settings on every layer of `ids`, each keeping its on / off. */
export function resetErode(ids: readonly string[]) {
  useEditor.getState().setEachAt(erodeRefs(ids), (e) => ({ ...erode2D(), enabled: (e as Erode2D).enabled }), undefined, 'Reset dry brush');
}

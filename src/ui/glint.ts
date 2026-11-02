import { glint3D } from '../model/defaults';
import type { Glint3D, Layer, Title3DLayer } from '../model/types';
import { msg } from '../store/msg';
import { useEditor, type PropRef, type Refs } from '../store/store';

// The 3D glint (`style3d.glint`, bloom + star streaks on the HDR highlights) shown as an effect
// of its title, as After Effects lists Starglow or Deep Glow: a row pinned first under the
// layer's Effects in the Layers panel, an effect card, an “Add effect” entry. It stays the
// title's own render setting: it is listed while it is on or tuned away from the defaults (so a
// tuned glint hidden by its eye stays listed); “adding” switches it on, “deleting” puts it back
// to the defaults, off. It is computed inside the 3D render, before every other effect, so it
// can't be reordered.

/** Name of the “+ Add effect” entry (menu and ⌘F) that switches the glint on. */
export const GLINT_ADD_LABEL = 'Glint (3D highlights)';

/** What the glint does (card info tip, Add effect menu). */
export const GLINT_ABOUT =
  'Bloom and star streaks on the 3D highlights brighter than the threshold. Computed inside the 3D render, before tone mapping and before every other effect, so it is always applied first.';

/** Why the glint row / card stays first and has no drag handle. */
export const GLINT_PINNED = 'Pinned first: the glint is computed inside the 3D render, before every other effect, so it can’t be reordered';

const DEFAULT_GLINT = glint3D();

/** Whether `l` lists its glint as an effect: a 3D title whose glint is on, or has any setting (on / off aside) off its default. */
export function glintListed(l: Layer | undefined): l is Title3DLayer {
  if (l?.kind !== 'title3d') return false;
  const g = l.style3d.glint;
  return g.enabled || (Object.keys(DEFAULT_GLINT) as (keyof Glint3D)[]).some((k) => k !== 'enabled' && g[k] !== DEFAULT_GLINT[k]);
}

/** `style3d.glint` (or a field of it, `path`) of every layer of `ids`, as one target or a list. */
export function glintRefs(ids: readonly string[], ...path: string[]): Refs {
  const refs = ids.map((layerId): PropRef => ({ layerId, path: ['style3d', 'glint', ...path] }));
  return refs.length === 1 ? refs[0] : refs;
}

/** Eye / checkbox: the glint on or off on every layer of `ids` (a tuned glint stays listed while off). */
export function setGlintEnabled(ids: readonly string[], on: boolean) {
  useEditor.getState().setAt(glintRefs(ids, 'enabled'), on, undefined, on ? 'Glint on' : 'Glint off');
}

/** “+ Add effect › Glint”: switch the glint on with the values it has (the defaults after a Delete), and open its card. */
export function addGlint(layerId: string) {
  const st = useEditor.getState();
  st.setAt(glintRefs([layerId], 'enabled'), true, undefined, 'Glint on');
  st.selectNode({ kind: 'glint', layerId });
}

/** Delete: the glint back to the defaults, off (one undo step), so it is unlisted; a selected glint node falls back to its layer. */
export function deleteGlint(ids: readonly string[]) {
  const st = useEditor.getState();
  st.setAt(glintRefs(ids), glint3D(), undefined, msg('Delete {effect}', { effect: msg('Glint') }));
  const node = st.selectedNode;
  if (node?.kind === 'glint' && ids.includes(node.layerId)) st.selectNode({ kind: 'layer', layerId: node.layerId });
}

/** Reset: the default glint settings on every layer of `ids`, each keeping its on / off. */
export function resetGlint(ids: readonly string[]) {
  useEditor.getState().setEachAt(glintRefs(ids), (g) => ({ ...glint3D(), enabled: (g as Glint3D).enabled }), undefined, 'Reset glint');
}

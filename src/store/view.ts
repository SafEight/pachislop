import { DEFAULT_FONT_ID } from '../assets/registry';
import type { Layer, Project } from '../model/types';
import type { Slice } from './core';
import type { ViewState } from './store';

// Editor view state: tools, zoom / pan, preview settings, the hover preview.

/** The project as the viewport should draw it (hover-preview layer substituted, or the previewed project). */
export function previewProject(project: Project, override: Layer | Project | null): Project {
  if (!override) return project;
  if ('layers' in override) return override;
  const i = project.layers.findIndex((l) => l.id === override.id);
  if (i < 0) return project;
  const layers = project.layers.slice();
  layers[i] = override;
  return { ...project, layers };
}

export const DEFAULT_VIEW: ViewState = {
  tool: 'move',
  autoSelect: 'layer',
  textKind: '2d',
  shapeKind: 'rect',
  expanded: {},
  textDefaults: { fontId: DEFAULT_FONT_ID, size: 200, tracking: 0, fill: null },
  showHandles: true,
  zoom: 'fit',
  panX: 0,
  panY: 0,
  previewRes: 1,
  previewBg: 'checker',
  previewBgColor: '#202028',
  safeGuides: false,
  orbit: false,
  distance: false,
  distanceScale: 0.25,
  valueCheck: false,
  gamut: false,
  viewMask: null,
};

export const viewSlice: Slice<'setTool' | 'setPreviewOverride' | 'setView' | 'setFitScale'> = ({ get, set }) => ({
  setTool: (tool) => set({ view: { ...get().view, tool } }),
  setPreviewOverride: (previewOverride) => {
    if (previewOverride !== get().previewOverride) set({ previewOverride });
  },
  setView: (patch) => set({ view: { ...get().view, ...patch } }),
  setFitScale: (fitScale) => {
    if (fitScale !== get().fitScale) set({ fitScale });
  },
});

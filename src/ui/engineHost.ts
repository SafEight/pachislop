import type { Engine } from '../engine/Engine';

/** The single preview engine (owned by Viewport); export borrows it. */
export interface EngineHost {
  /**
   * Null until the Viewport mounts. `renderThumb` / `renderBackdrop` / `layerAlphaAt` use their
   * own pools and leave the preview untouched; after `renderImageData` call `invalidate`.
   */
  engine: Engine | null;
  /** Request a preview redraw (e.g. after an export used the engine). */
  invalidate: () => void;
  /**
   * Canvas drags and scrub fields call this at pointer-down (true) and pointer-up (false).
   * While on, the preview reuses layer pixels for x / y / rotZ / scale / opacity changes and
   * renders changed 3D at reduced resolution (Engine.setInteractive); switching off redraws
   * once at full quality.
   */
  setInteractive: (on: boolean) => void;
}

// Kept across dev HMR re-executions so every importer sees the live engine.
const hotData = import.meta.hot?.data as { engineHost?: EngineHost } | undefined;
export const engineHost: EngineHost = hotData?.engineHost ?? {
  engine: null,
  invalidate: () => {},
  setInteractive: (on) => {
    engineHost.engine?.setInteractive(on);
    if (!on) engineHost.invalidate();
  },
};
if (hotData) hotData.engineHost = engineHost;

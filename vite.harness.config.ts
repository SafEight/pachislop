import { defineConfig, mergeConfig } from 'vite';
import app from './vite.config.ts';

// Dev server of the golden / perf harness (playwright.config.ts): the app's config without HMR
// or file watching, so a run renders one consistent snapshot of the sources even while they are
// being edited (a reload mid-run would lose the page), with the harness page among the entries
// scanned for dependencies up front (a late dependency optimisation also reloads the page).
export default mergeConfig(
  app,
  defineConfig({
    server: { hmr: false, watch: null },
    optimizeDeps: { entries: ['index.html', 'tests/harness/index.html'] },
  }),
);

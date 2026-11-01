import react from '@vitejs/plugin-react'
import { readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { defineConfig, type Plugin } from 'vite'

/** Build id: the service worker URL carries it, so every build installs a fresh offline cache. */
const BUILD_ID = Date.now().toString(36)

/** Every file under `dir`, as URL paths relative to it. */
function filesIn(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? filesIn(path).map((f) => `${name}/${f}`) : [relative(dir, path)]
  })
}

/**
 * Offline PWA: emits `precache-manifest.json` listing every built file (JS, CSS, index.html) and
 * every public file (fonts, HDRI, icons, manifest) for `public/sw.js` to cache on install.
 */
function precacheManifest(): Plugin {
  let publicDir = ''
  return {
    name: 'pslot-precache-manifest',
    apply: 'build',
    configResolved(config) {
      publicDir = config.publicDir
    },
    generateBundle(_, bundle) {
      const built = Object.keys(bundle).filter((f) => !f.endsWith('.map'))
      const shipped = publicDir ? filesIn(publicDir).filter((f) => f !== 'sw.js') : []
      const files = ['./', ...new Set([...built, ...shipped])]
      this.emitFile({ type: 'asset', fileName: 'precache-manifest.json', source: JSON.stringify({ version: BUILD_ID, files }) })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  // GitHub Pages serves the app from /<repo>/: the workflow sets BASE_PATH=/pachislop/
  base: process.env.BASE_PATH ?? '/',
  plugins: [react(), precacheManifest()],
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
  build: {
    rolldownOptions: {
      output: {
        // Stable chunks: a vendor chunk's hash only changes with the dependency, so app updates
        // don't re-download it. `$initial` keeps a group to the first-paint graph; lazily imported
        // code (export, PS import, GLTFLoader, EXRLoader, dialogs) stays in the chunks that load it.
        codeSplitting: {
          groups: [
            { name: 'react', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/, tags: ['$initial'], priority: 6 },
            // three ships as two files (three.module.js = WebGLRenderer, three.core.js shared with
            // the WebGPU build); kept apart, as published, each stays under the 500 kB warning.
            { name: 'three-core', test: /node_modules[\\/]three[\\/]build[\\/]three\.core\.js$/, tags: ['$initial'], priority: 5 },
            { name: 'three', test: /node_modules[\\/]three[\\/]build[\\/]/, tags: ['$initial'], priority: 4 },
            { name: 'three-addons', test: /node_modules[\\/]three[\\/]examples[\\/]/, tags: ['$initial'], priority: 3 },
            { name: 'vendor', test: /node_modules[\\/]/, tags: ['$initial'], priority: 2 },
            // Only reached through the lazy export / PS style import chunks.
            { name: 'ag-psd', test: /node_modules[\\/](ag-psd|pako|base64-js)[\\/]/, priority: 2 },
            // App code: the Japanese UI tables, the effect and generator library, and the renderer
            // (engine with its model, text and asset dependencies), which change independently of
            // the UI around them.
            { name: 'i18n', test: /[\\/]src[\\/]ui[\\/]i18n[\\/]/, tags: ['$initial'], priority: 1 },
            { name: 'effects', test: /[\\/]src[\\/](effects|generators)[\\/]/, tags: ['$initial'], priority: 1 },
            { name: 'engine', test: /[\\/]src[\\/]engine[\\/]/, tags: ['$initial'], priority: 1 },
          ],
        },
      },
    },
  },
})

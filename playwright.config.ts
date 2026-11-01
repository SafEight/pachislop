import { defineConfig } from '@playwright/test';

// Golden renders and speed budgets (npm run test:golden / test:perf, through tests/run.mjs).
// Both drive tests/harness/index.html on a Vite dev server of their own port. Chromium's new
// headless mode (channel 'chromium') renders on the GPU; the headless shell falls back to
// SwiftShader, which is slower and renders differently from what users see.

const PORT = 5299;

export default defineConfig({
  testMatch: '*.spec.ts',
  outputDir: 'tests/.results',
  workers: 1,
  fullyParallel: false,
  reporter: 'list',
  timeout: 20 * 60_000,
  use: {
    baseURL: `http://localhost:${PORT}`,
    channel: 'chromium',
    headless: true,
  },
  projects: [
    { name: 'golden', testDir: 'tests/golden' },
    { name: 'perf', testDir: 'tests/perf' },
  ],
  webServer: {
    command: `npx vite --config vite.harness.config.ts --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/tests/harness/index.html`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});

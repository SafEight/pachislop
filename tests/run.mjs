#!/usr/bin/env node
// `npm run test:golden` / `npm run test:perf`: runs that Playwright project. `-- --update`
// rewrites the golden references / perf budgets (Playwright has no such flag, so it is passed as
// PSLOT_UPDATE=1); every other argument goes to `playwright test`.
import { spawnSync } from 'node:child_process';

const [suite, ...rest] = process.argv.slice(2);
if (suite !== 'golden' && suite !== 'perf') {
  console.error('usage: node tests/run.mjs golden|perf [--update] [playwright args]');
  process.exit(2);
}
const update = rest.includes('--update');
const args = rest.filter((a) => a !== '--update');
const r = spawnSync('npx', ['playwright', 'test', `--project=${suite}`, ...args], {
  stdio: 'inherit',
  env: update ? { ...process.env, PSLOT_UPDATE: '1' } : process.env,
});
process.exit(r.status ?? 1);

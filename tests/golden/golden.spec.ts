import { expect, test, type Page } from '@playwright/test';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { PNG } from 'pngjs';
import type { Rendered } from '../harness/main';
import { openHarness, UPDATE } from '../harness/open';
import { compare, fails, formatStats, pngFromRgba, THRESHOLDS, writePng } from './compare';

// Golden renders (see README, Testing): every case of tests/harness/cases.ts is built and
// rendered twice through the PNG export path, the two renders must be identical, and the first
// is compared with tests/golden/refs/<id>.png. Failures write <id>.diff.png (expected | actual |
// difference) and <id>.png to tests/golden/out/.

const REFS = join(import.meta.dirname, 'refs');
const OUT = join(import.meta.dirname, 'out');
const GROUPS = ['template', 'look', 'generator', 'effect', 'scene'] as const;
/** `GOLDEN_ONLY=<regex>`: run only the case ids it matches (references of the others are left alone). */
const ONLY = process.env.GOLDEN_ONLY ? new RegExp(process.env.GOLDEN_ONLY) : null;

const toPng = (r: Rendered) => pngFromRgba(r.width, r.height, Buffer.from(r.rgba, 'base64'));

/** Every reference PNG under refs/<group>/, as case ids. */
function refIds(group: string): string[] {
  const dir = join(REFS, group);
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.png')).map((f) => `${group}/${f.slice(0, -4)}`) : [];
}

let page: Page;
let errors: string[];
let ids: string[];

test.beforeAll(async ({ browser }) => {
  ({ page, errors } = await openHarness(browser));
  ids = await page.evaluate(() => window.harness!.goldenIds());
});

test.afterAll(async () => {
  await page?.close();
});

for (const group of GROUPS) {
  test(`${group}s`, async () => {
    test.setTimeout(20 * 60_000);
    const all = ids.filter((id) => id.startsWith(`${group}/`));
    expect(all.length, `no ${group} cases`).toBeGreaterThan(0);
    const cases = ONLY ? all.filter((id) => ONLY.test(id)) : all;
    test.skip(cases.length === 0, `GOLDEN_ONLY matches no ${group} case`);
    rmSync(join(OUT, group), { recursive: true, force: true });
    const problems: string[] = [];
    /** Cases that differ from their reference at all (within the thresholds or not), and the largest difference seen. */
    let differing = 0;
    let worst = 0;
    const started = Date.now();
    for (const id of cases) {
      const r = await page.evaluate((id) => window.harness!.renderGolden(id), id);
      const actual = toPng(r.image);
      if (r.image.warning) problems.push(`${id}: render warning ${r.image.warning}`);
      if (r.rerender) {
        const { stats, sheet } = compare(actual, toPng(r.rerender));
        writePng(join(OUT, `${id}.nondeterministic.png`), sheet);
        problems.push(`${id}: NONDETERMINISTIC, a second render differs: ${formatStats(stats)}`);
      }
      const refPath = join(REFS, `${id}.png`);
      if (UPDATE) {
        writePng(refPath, actual);
        continue;
      }
      if (!existsSync(refPath)) {
        writePng(join(OUT, `${id}.png`), actual);
        problems.push(`${id}: no reference (run npm run test:golden -- --update)`);
        continue;
      }
      const { stats, sheet } = compare(PNG.sync.read(readFileSync(refPath)), actual);
      if (stats.max > 0 || stats.sizeMismatch) differing++;
      worst = Math.max(worst, stats.max);
      if (fails(stats)) {
        writePng(join(OUT, `${id}.png`), actual);
        writePng(join(OUT, `${id}.diff.png`), sheet);
        problems.push(`${id}: ${formatStats(stats)} → ${relative(process.cwd(), join(OUT, `${id}.diff.png`))}`);
      }
    }
    const stale = ONLY ? [] : refIds(group).filter((id) => !all.includes(id));
    for (const id of stale) {
      if (UPDATE) rmSync(join(REFS, `${id}.png`));
      else problems.push(`${id}: reference without a case (run npm run test:golden -- --update to delete it)`);
    }
    problems.push(...errors.splice(0).map((e) => `page error: ${e}`));
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    const vsRefs = UPDATE ? `references written${stale.length ? `, ${stale.length} stale removed` : ''}` : `${differing} differ from their reference, largest channel difference ${worst}/255`;
    console.log(`${group}s: ${cases.length} cases in ${secs} s (${vsRefs})`);
    expect(problems, `${problems.length} problem(s); thresholds max ${THRESHOLDS.max}, mean ${THRESHOLDS.mean}, ${THRESHOLDS.pct} %`).toEqual([]);
  });
}

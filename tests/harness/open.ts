import type { Browser, Page } from '@playwright/test';

/** `--update` given to `npm run test:golden` / `test:perf` (tests/run.mjs): rewrite references / budgets. */
export const UPDATE = process.env.PSLOT_UPDATE === '1';

/**
 * Opens the render harness (tests/harness/index.html) and waits for `window.harness`; fails at
 * once when the page reports an error before that (a module that doesn't compile). Later page
 * errors are collected in `errors`.
 */
export async function openHarness(browser: Browser): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.stack ?? e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`${m.text()} (${m.location().url})`);
  });
  await page.goto('/tests/harness/index.html');
  const deadline = Date.now() + 120_000;
  while (!(await page.evaluate(() => window.harness !== undefined))) {
    if (errors.length) throw new Error(`render harness failed to load:\n${errors.join('\n')}`);
    if (Date.now() > deadline) throw new Error('render harness did not load within 120 s');
    await page.waitForTimeout(100);
  }
  return { page, errors };
}

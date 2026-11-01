import { expect, test } from '@playwright/test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openHarness, UPDATE } from '../harness/open';

// Speed budgets (see README, Testing): each case of tests/harness/perf.ts runs WARMUP times
// untimed, then RUNS times timed (GPU work waited for). The MEDIAN must stay within its budget in
// tests/perf/budgets.json; the p90 may exceed its budget by up to P90_SLACK, because on a fanless
// laptop thermal throttling and other GPU work stretch the tail of whole runs while a real
// regression moves the median. A case over budget is measured again, up to ATTEMPTS times in
// all, and passes when one measurement is within budget. `--update` rewrites the budgets as the
// measured values × HEADROOM, at least MIN_HEADROOM_MS more: frames of a few ms jitter by a few
// tenths (timer coarsening, scheduling), which 30 % of 2 ms does not cover.

const BUDGETS = join(import.meta.dirname, 'budgets.json');
// 20 runs: p90 is the 18th fastest, so it takes three stray slow frames (another process on the
// GPU) to move it; 5 warm-ups let shader compiles and pool growth settle.
const RUNS = Number(process.env.PERF_RUNS ?? 20);
const WARMUP = 5;
const ATTEMPTS = 3;
const HEADROOM = 1.3;
const MIN_HEADROOM_MS = 1;
const P90_SLACK = 1.5;

interface Budget {
  median: number;
  p90: number;
}

/** Nearest-rank percentile `p` (0..1) of `xs`. */
function percentile(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))];
}

const ms = (x: number) => x.toFixed(1).padStart(8);

test('speed budgets', async ({ browser }) => {
  test.setTimeout(20 * 60_000);
  const { page, errors } = await openHarness(browser);
  const budgets: Record<string, Budget> = existsSync(BUDGETS) ? JSON.parse(readFileSync(BUDGETS, 'utf8')) : {};
  const names = await page.evaluate(() => window.harness!.perfNames());
  const measured: Record<string, Budget> = {};
  const over: string[] = [];
  const rows: string[] = [];
  /** RUNS timed runs of case `name` after WARMUP untimed ones. */
  const measure = async (name: string): Promise<{ median: number; p90: number; times: number[] }> => {
    await page.evaluate(([n, w]) => window.harness!.perfSetup(n, w), [name, WARMUP] as const);
    const times: number[] = [];
    for (let i = 0; i < RUNS; i++) times.push(await page.evaluate((n) => window.harness!.perfRun(n), name));
    await page.evaluate((n) => window.harness!.perfTeardown(n), name);
    return { median: percentile(times, 0.5), p90: percentile(times, 0.9), times };
  };
  for (const name of names) {
    const b = budgets[name];
    const within = (m: Budget) => !!b && m.median <= b.median && m.p90 <= b.p90 * P90_SLACK;
    let m = await measure(name);
    let attempts = 1;
    while (!UPDATE && b && !within(m) && attempts < ATTEMPTS) {
      m = await measure(name);
      attempts++;
    }
    measured[name] = { median: m.median, p90: m.p90 };
    const status = !b ? 'NO BUDGET' : within(m) ? 'ok' : 'OVER';
    if (!UPDATE && status !== 'ok') {
      const runs = m.times.map((t) => t.toFixed(1)).join(', ');
      over.push(`${name}: ${status} (median ${m.median.toFixed(1)} / ${b?.median ?? '-'} ms, p90 ${m.p90.toFixed(1)} / ${b?.p90 ?? '-'} ms, ${attempts} attempts; last runs in order: ${runs})`);
    }
    const retried = attempts > 1 ? ` (attempt ${attempts})` : '';
    rows.push(`${name.padEnd(52)}${ms(m.median)}${ms(m.p90)}${b ? ms(b.median) + ms(b.p90) : '       -       -'}  ${UPDATE ? 'measured' : status}${retried}`);
  }
  console.log(`\n${'case'.padEnd(52)}  median     p90  budget  budget\n${' '.repeat(52)}      ms      ms  median     p90   (${RUNS} runs, ${WARMUP} warm-up)\n${rows.join('\n')}\n`);
  if (UPDATE) {
    const round = (x: number) => Math.ceil(Math.max(x * HEADROOM, x + MIN_HEADROOM_MS) * 10) / 10;
    const next = Object.fromEntries(Object.entries(measured).map(([n, m]) => [n, { median: round(m.median), p90: round(m.p90) }]));
    writeFileSync(BUDGETS, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`budgets written to ${BUDGETS} (measured × ${HEADROOM}, at least +${MIN_HEADROOM_MS} ms)`);
  }
  await page.close();
  expect(errors, 'page errors').toEqual([]);
  expect(over, 'cases over budget').toEqual([]);
});

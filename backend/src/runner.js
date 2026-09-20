import { config } from './config.js';
import { db } from './db.js';
import { launchBrowser } from './scraper/browser.js';
import { scrapeProduct } from './scraper/scrape.js';

// A single in-process lock: two Chromium instances at once would exhaust the 512MB
// free tier. Overlapping triggers get a clear "already running" answer instead.
let running = false;
export const isRunning = () => running;

const STALE_RUN_MS = 30 * 60 * 1000;

async function scrapeAndRecord(browser, product, trigger) {
  const result = await scrapeProduct(browser, product.store_product_id);
  try {
    const outcome = await db.recordScrape(product, result, trigger);
    console.log(`[scrape] #${product.store_product_id} ${outcome} (${result.attempts.length} attempt(s), ${result.durationMs}ms)`);
    return outcome;
  } catch (e) {
    // Could not even write the log. Nothing else to do but shout; the run row will
    // show fewer results than products, which is itself the signal.
    console.error(`[scrape] #${product.store_product_id} could not record result:`, e.message);
    return 'failed';
  }
}

/** Browser could not start (or similar): every product still gets an honest failed log row. */
async function recordInfraFailure(product, error, trigger) {
  const now = new Date();
  const result = {
    ok: false,
    outcome: 'failed',
    observation: null,
    error: { code: 'BROWSER_LAUNCH_FAILED', message: String(error?.message ?? error).split('\n')[0] },
    attempts: [{ attempt: 1, ok: false, code: 'BROWSER_LAUNCH_FAILED', message: String(error?.message ?? error).split('\n')[0], ms: 0 }],
    startedAt: now,
    finishedAt: now,
    durationMs: 0,
  };
  await db.recordScrape(product, result, trigger).catch((e) => console.error('[run] could not record infra failure:', e.message));
}

async function pool(items, size, worker) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(size, queue.length) }, async () => {
      while (queue.length) await worker(queue.shift());
    }),
  );
}

/** Scrape every active tracked product. Safe to call while another run is active. */
export async function runAll(trigger = 'cron') {
  if (running) return { started: false, reason: 'already_running' };
  running = true;
  let run = null;
  let browser = null;
  const counts = { total: 0, succeeded: 0, failed: 0 };
  let status = 'finished';
  let note = null;
  try {
    await db.abandonStaleRuns(STALE_RUN_MS).catch((e) => console.error('[run] stale check failed:', e.message));
    run = await db.startRun(trigger);
    const products = await db.listTracked({ activeOnly: true });
    counts.total = products.length;
    if (products.length) {
      try {
        browser = await launchBrowser(config.scrape);
      } catch (e) {
        for (const p of products) await recordInfraFailure(p, e, trigger);
        counts.failed = products.length;
        throw e;
      }
      await pool(products, config.scrape.concurrency, async (p) => {
        const outcome = await scrapeAndRecord(browser, p, trigger);
        if (outcome === 'failed') counts.failed++;
        else counts.succeeded++;
      });
    }
  } catch (e) {
    status = 'error';
    note = e.message;
    console.error('[run] failed:', e);
  } finally {
    await browser?.close().catch(() => {});
    if (run) {
      await db.finishRun(run.id, { ...counts, status, note }).catch((e) => console.error('[run] could not close run row:', e.message));
    }
    running = false;
  }
  return { started: true, ...counts, status };
}

/** Scrape a single tracked product (manual "Scrape now", or right after tracking it). */
export async function runOne(product, trigger = 'manual') {
  if (running) return { started: false, reason: 'already_running' };
  running = true;
  let browser = null;
  try {
    try {
      browser = await launchBrowser(config.scrape);
    } catch (e) {
      await recordInfraFailure(product, e, trigger);
      return { started: true, outcome: 'failed' };
    }
    const outcome = await scrapeAndRecord(browser, product, trigger);
    return { started: true, outcome };
  } catch (e) {
    console.error('[runOne] failed:', e);
    return { started: true, outcome: 'failed' };
  } finally {
    await browser?.close().catch(() => {});
    running = false;
  }
}

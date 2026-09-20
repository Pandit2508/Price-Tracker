import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { productUrl, assertStoreUrl } from '../store/store.js';
import { readRaw as defaultReadRaw, prepare as defaultPrepare } from '../store/selectors.js';
import { ScrapeError, classify } from './errors.js';
import { parsePrice, parseStock, cleanText, crossCheckDiscount } from './validate.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Errors that just mean "the page has not finished rendering yet". These are polled
// inside one attempt. Anything else (network, browser, unexpected) FAILS the attempt so
// it shows up as a retry in the log instead of being quietly absorbed.
const CONTENT_NOT_READY = new Set([
  'PARSE_PRICE',
  'PARSE_STOCK',
  'AMBIGUOUS_PRICE',
  'IMPLAUSIBLE_PRICE',
  'AMBIGUOUS_STOCK',
  'PRICE_CROSSCHECK_FAILED',
  'SELECTOR_MISSING',
]);

/** Exponential backoff with jitter: base, 2*base, 4*base ... (+0-25%). */
export function backoffMs(attempt, baseMs) {
  return Math.round(baseMs * 2 ** (attempt - 1) * (1 + Math.random() * 0.25));
}

/**
 * Fault injection for the headed demo video. Applies to the FIRST attempt only, so
 * you can watch the scraper hit a failure, back off, and recover on attempt 2.
 *   abort: every fetch/XHR request from the page is dropped
 *   slow : every fetch/XHR request is delayed by 8 seconds
 */
async function installFault(page, mode) {
  await page.route('**/*', async (route) => {
    const type = route.request().resourceType();
    if (type !== 'fetch' && type !== 'xhr') return route.continue();
    if (mode === 'abort') return route.abort('connectionreset');
    await sleep(8000);
    return route.continue().catch(() => {});
  });
}

/**
 * Read until we get the same parseable value twice in a row. This is what protects us
 * from content that "loads late" or shifts: a half-rendered page, a placeholder such
 * as "Loading...", or a value that is still settling is never accepted on first sight.
 */
async function readStable(page, s, read) {
  const deadline = Date.now() + s.priceWaitMs;
  let lastKey = null;
  let streak = 0;
  let reads = 0;
  let lastError = null;
  do {
    try {
      reads++;
      const raw = await read(page, { priceWaitMs: s.priceWaitMs });
      const price = parsePrice(raw.priceText);
      crossCheckDiscount({ price: price.amount, mrpText: raw.mrpText, discountPct: raw.discountPct });
      const stock = parseStock(raw.stockText);
      const key = `${price.amount}|${price.currency}|${stock.status}|${stock.quantity}`;
      streak = key === lastKey ? streak + 1 : 1;
      lastKey = key;
      lastError = null;
      if (streak >= s.stableReads) return { raw, price, stock, reads };
    } catch (e) {
      const err = classify(e);
      if (!CONTENT_NOT_READY.has(err.code)) throw err;
      lastError = err;
      streak = 0;
      lastKey = null;
    }
    await sleep(s.stableGapMs);
  } while (Date.now() < deadline);
  throw lastError ?? new ScrapeError('UNSTABLE_CONTENT', 'Value kept changing and never settled');
}

async function doAttempt(page, url, attemptNo, s, read) {
  if (s.simulate && attemptNo === 1) await installFault(page, s.simulate);

  // Belt and braces: block any navigation away from the store.
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) assertStoreUrl(frame.url());
  });

  const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: s.navTimeoutMs });
  const status = response?.status();
  if (status === 404) {
    throw new ScrapeError('PRODUCT_NOT_FOUND', `Store returned 404 for ${url}`, { retryable: false });
  }
  if (status && status >= 400) {
    throw new ScrapeError(`HTTP_${status}`, `Store returned HTTP ${status}`, {
      retryable: status >= 500 || status === 429 || status === 408,
    });
  }

  await (s.prepare ?? defaultPrepare)(page, s); // e.g. reveal a hidden price, once per attempt
  const { raw, price, stock, reads } = await readStable(page, s, read);
  return {
    price: price.amount,
    currency: price.currency,
    stockStatus: stock.status,
    stockQuantity: stock.quantity,
    name: raw.nameText ? cleanText(raw.nameText) : null,
    rawPriceText: cleanText(raw.priceText),
    rawStockText: cleanText(raw.stockText),
    reads,
  };
}

async function dumpDebug(page, dir, id, attemptNo) {
  try {
    await fs.mkdir(dir, { recursive: true });
    const base = path.join(dir, `${id}-attempt${attemptNo}`);
    await fs.writeFile(`${base}.html`, await page.content());
    await page.screenshot({ path: `${base}.png`, fullPage: true });
  } catch {
    /* debug output must never mask the real error */
  }
}

/** One attempt in a brand-new browser context, with a hard deadline that cannot be outlived. */
async function runAttempt(browser, url, storeProductId, attemptNo, s, read) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  let timer;
  try {
    const page = await context.newPage();
    const work = doAttempt(page, url, attemptNo, s, read).catch(async (e) => {
      if (s.debugDir) await dumpDebug(page, s.debugDir, storeProductId, attemptNo);
      throw e;
    });
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new ScrapeError('ATTEMPT_TIMEOUT', `Attempt exceeded ${s.attemptHardTimeoutMs}ms`)),
        s.attemptHardTimeoutMs,
      );
    });
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
    await context.close().catch(() => {}); // also aborts any hung work above
  }
}

/**
 * Scrape one product. NEVER throws and NEVER returns a partial value:
 *   { ok: true,  outcome: 'success' | 'retried', observation, attempts, ... }
 *   { ok: false, outcome: 'failed', error: { code, message }, attempts, ... }
 * `attempts` lists every try (including the failed ones) for the scrape log.
 */
export async function scrapeProduct(browser, storeProductId, opts = {}) {
  const s = { ...config.scrape, ...opts };
  const read = s.readRaw ?? defaultReadRaw;
  const startedAt = new Date();
  const attempts = [];
  let url;
  try {
    url = productUrl(storeProductId);
  } catch (e) {
    const err = classify(e);
    return finish(false, startedAt, attempts, { code: 'INVALID_INPUT', message: err.message });
  }

  let lastError = null;
  for (let n = 1; n <= s.maxAttempts; n++) {
    const t0 = Date.now();
    try {
      const observation = await runAttempt(browser, url, storeProductId, n, s, read);
      attempts.push({ attempt: n, ok: true, ms: Date.now() - t0, reads: observation.reads });
      s.onAttempt?.({ attempt: n, ok: true });
      return finish(true, startedAt, attempts, null, observation);
    } catch (e) {
      const err = classify(e);
      lastError = err;
      const willRetry = err.retryable && n < s.maxAttempts;
      const waitMs = willRetry ? backoffMs(n, s.baseDelayMs) : 0;
      attempts.push({ attempt: n, ok: false, code: err.code, message: err.message, ms: Date.now() - t0 });
      s.onAttempt?.({ attempt: n, ok: false, code: err.code, message: err.message, willRetry, waitMs });
      if (!willRetry) break;
      await sleep(waitMs);
    }
  }
  return finish(false, startedAt, attempts, { code: lastError.code, message: lastError.message });
}

function finish(ok, startedAt, attempts, error, observation = null) {
  const finishedAt = new Date();
  return {
    ok,
    outcome: !ok ? 'failed' : attempts.length > 1 ? 'retried' : 'success',
    observation,
    error,
    attempts,
    startedAt,
    finishedAt,
    durationMs: finishedAt - startedAt,
  };
}

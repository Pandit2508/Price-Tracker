import test from 'node:test';
import assert from 'node:assert/strict';
import { scrapeProduct } from '../src/scraper/scrape.js';
import { productUrl, assertStoreUrl } from '../src/store/store.js';
import { ScrapeError } from '../src/scraper/errors.js';

// A fake Playwright browser: no network, no Chromium. What the "page" shows is decided by `readRaw`.
const fakePage = () => ({
  on() {},
  route: async () => {},
  goto: async () => ({ status: () => 200 }),
  content: async () => '',
  screenshot: async () => {},
});
const fakeBrowser = () => ({
  newContext: async () => ({ newPage: async () => fakePage(), close: async () => {} }),
});

const FAST = {
  maxAttempts: 4,
  baseDelayMs: 1,
  stableReads: 2,
  stableGapMs: 1,
  priceWaitMs: 60,
  attemptHardTimeoutMs: 500,
  prepare: async () => {},
};
const good = { priceText: 'Rs. 12,723.00', stockText: 'In stock', nameText: 'Thing' };

test('first-try success is logged as "success" with one attempt', async () => {
  const r = await scrapeProduct(fakeBrowser(), 733, { ...FAST, readRaw: async () => good });
  assert.equal(r.ok, true);
  assert.equal(r.outcome, 'success');
  assert.equal(r.attempts.length, 1);
  assert.equal(r.observation.price, 12723);
  assert.equal(r.observation.currency, 'INR');
  assert.equal(r.observation.stockStatus, 'in_stock');
});

test('recovers from transient failures and reports "retried" with every attempt listed', async () => {
  let calls = 0;
  const flaky = async () => {
    calls++;
    if (calls <= 2) throw new ScrapeError('NETWORK', 'connection reset');
    return good;
  };
  const r = await scrapeProduct(fakeBrowser(), 733, { ...FAST, readRaw: flaky });
  assert.equal(r.ok, true);
  assert.equal(r.outcome, 'retried');
  assert.ok(r.attempts.length >= 2);
  assert.equal(r.attempts.at(-1).ok, true);
  assert.ok(r.attempts.slice(0, -1).every((a) => a.ok === false), 'failed attempts must stay visible');
});

test('page stuck on a placeholder: fails honestly, returns NO observation', async () => {
  const r = await scrapeProduct(fakeBrowser(), 733, {
    ...FAST,
    maxAttempts: 2,
    readRaw: async () => ({ priceText: 'Rs. 12,723.00', stockText: 'Loading…' }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.outcome, 'failed');
  assert.equal(r.observation, null);
  assert.equal(r.error.code, 'PARSE_STOCK');
  assert.equal(r.attempts.length, 2);
});

test('decoy-style price text is rejected, not guessed', async () => {
  const r = await scrapeProduct(fakeBrowser(), 733, {
    ...FAST,
    maxAttempts: 1,
    readRaw: async () => ({ priceText: 'Was 1999 Now 1499', stockText: 'In stock' }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.observation, null);
  assert.equal(r.error.code, 'AMBIGUOUS_PRICE');
});

test('a value that never settles is not stored', async () => {
  let n = 100;
  const r = await scrapeProduct(fakeBrowser(), 733, {
    ...FAST,
    maxAttempts: 1,
    readRaw: async () => ({ priceText: `Rs. ${n++}.00`, stockText: 'In stock' }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'UNSTABLE_CONTENT');
});

test('a hung page is cut off by the hard deadline instead of hanging forever', async () => {
  const r = await scrapeProduct(fakeBrowser(), 733, {
    ...FAST,
    maxAttempts: 2,
    attemptHardTimeoutMs: 40,
    readRaw: () => new Promise(() => {}), // never settles
  });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'ATTEMPT_TIMEOUT');
  assert.equal(r.attempts.length, 2);
});

test('non-retryable errors are not retried and store nothing', async () => {
  const r = await scrapeProduct(fakeBrowser(), 733, {
    ...FAST,
    readRaw: async () => {
      throw new ScrapeError('AMBIGUOUS_SELECTOR', 'matched 2 elements', { retryable: false });
    },
  });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'AMBIGUOUS_SELECTOR');
  assert.equal(r.attempts.length, 1);
  assert.equal(r.observation, null);
});

test('a price that contradicts MRP and the discount badge is never stored', async () => {
  const r = await scrapeProduct(fakeBrowser(), 733, {
    ...FAST,
    maxAttempts: 1,
    // 34,078 is the hidden decoy from the real page; MRP 62,265 with 19% off means ~50,435
    readRaw: async () => ({ priceText: '₹34,078', mrpText: '₹62,265', discountPct: 19, stockText: '12 in stock' }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.observation, null);
  assert.equal(r.error.code, 'PRICE_CROSSCHECK_FAILED');
});

test('a price that matches MRP and the discount badge is accepted', async () => {
  const r = await scrapeProduct(fakeBrowser(), 733, {
    ...FAST,
    readRaw: async () => ({ priceText: `₹5${'\u200B'}0,435`, mrpText: '₹62,265', discountPct: 19, stockText: '12 in stock' }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.observation.price, 50435);
  assert.equal(r.observation.stockQuantity, 12);
});

test('a failure while revealing the price is retried and logged, then recovers', async () => {
  let calls = 0;
  const r = await scrapeProduct(fakeBrowser(), 733, {
    ...FAST,
    prepare: async () => {
      calls++;
      if (calls === 1) throw new ScrapeError('STORE_ERROR', 'The store reported an error while loading the price');
    },
    readRaw: async () => good,
  });
  assert.equal(r.ok, true);
  assert.equal(r.outcome, 'retried');
  assert.equal(r.attempts[0].code, 'STORE_ERROR');
  assert.equal(r.attempts.at(-1).ok, true);
});

test('scraper only accepts numeric ids and only the store origin', async () => {
  assert.equal(productUrl('733'), 'https://demo.inelabteamdev.com/product/733');
  assert.throws(() => productUrl('https://evil.example/x'));
  assert.throws(() => productUrl(-1));
  assert.throws(() => assertStoreUrl('https://example.com/product/1'));
  assert.doesNotThrow(() => assertStoreUrl('https://demo.inelabteamdev.com/product/1'));

  const r = await scrapeProduct(fakeBrowser(), 'https://evil.example', FAST);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'INVALID_INPUT');
});

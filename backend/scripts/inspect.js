#!/usr/bin/env node
/**
 * Discovery tool for finding the right selectors. Does NOT touch the database.
 *
 *   node scripts/inspect.js 733          (product id, default 733)
 *   node scripts/inspect.js 733 10000    (optional: how long to watch the page, in ms)
 *
 * It opens a visible browser on the product page, then records:
 *   - every fetch/XHR call the page makes (method, status, timing, response body)
 *   - what the visible text of the page looked like at several moments after load
 *     (this is how late-loading content and placeholder text show up)
 * Everything is printed here AND saved to debug/inspect-<id>.json / .html / .png.
 * The browser then stays open so you can use its DevTools; press Enter to close it.
 */
import fs from 'node:fs/promises';
import { launchBrowser } from '../src/scraper/browser.js';
import { productUrl } from '../src/store/store.js';

const id = Number(process.argv[2] || 733);
const watchMs = Number(process.argv[3] || 9000);
const url = productUrl(id);
const t0 = Date.now();
const since = () => Date.now() - t0;

await fs.mkdir('debug', { recursive: true });
const browser = await launchBrowser({ headed: true, slowMoMs: 0 });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();

const calls = [];
page.on('response', async (res) => {
  const req = res.request();
  if (!['fetch', 'xhr'].includes(req.resourceType())) return;
  let body = null;
  try {
    body = (await res.text()).slice(0, 4000);
  } catch {
    /* body not available (e.g. redirect) */
  }
  calls.push({
    atMs: since(),
    method: req.method(),
    status: res.status(),
    url: res.url(),
    requestHeaderNames: Object.keys(req.headers()),
    postData: req.postData()?.slice(0, 500) ?? null,
    body,
  });
});
page.on('requestfailed', (req) => {
  calls.push({ atMs: since(), method: req.method(), status: 'FAILED', url: req.url(), error: req.failure()?.errorText });
});

console.log(`\nOpening ${url} ...`);
await page.goto(url, { waitUntil: 'domcontentloaded' });

// Visible text at several moments, so we can see content that appears late.
const snapshots = [];
const checkpoints = [500, 2000, 4000, watchMs].filter((m, i, a) => a.indexOf(m) === i).sort((a, b) => a - b);
for (const at of checkpoints) {
  const wait = at - since();
  if (wait > 0) await page.waitForTimeout(wait);
  const text = await page.evaluate(() => document.body.innerText).catch(() => '');
  snapshots.push({ atMs: since(), text: text.slice(0, 3000) });
}

const html = await page.content();
await fs.writeFile(`debug/inspect-${id}.html`, html);
await page.screenshot({ path: `debug/inspect-${id}.png`, fullPage: true });
await fs.writeFile(`debug/inspect-${id}.json`, JSON.stringify({ url, calls, snapshots }, null, 2));

console.log('\n================ NETWORK CALLS (fetch/XHR) ================');
if (!calls.length) console.log('(none seen)');
for (const c of calls) {
  console.log(`\n[+${c.atMs}ms] ${c.method} ${c.status} ${c.url}`);
  if (c.requestHeaderNames) console.log(`  request header names: ${c.requestHeaderNames.join(', ')}`);
  if (c.postData) console.log(`  request body: ${c.postData}`);
  if (c.body) console.log(`  response: ${c.body.slice(0, 700)}${c.body.length > 700 ? ' ...' : ''}`);
  if (c.error) console.log(`  error: ${c.error}`);
}

console.log('\n================ VISIBLE PAGE TEXT OVER TIME ================');
for (const s of snapshots) {
  console.log(`\n--- at +${s.atMs}ms ---\n${s.text.slice(0, 1200)}`);
}

console.log(`\nSaved: debug/inspect-${id}.json, debug/inspect-${id}.html, debug/inspect-${id}.png`);
console.log('The browser is still open: right-click the price -> Inspect to see its element.');
console.log('Press Enter here to close it.');
await new Promise((resolve) => process.stdin.once('data', resolve));
await browser.close();
process.exit(0);

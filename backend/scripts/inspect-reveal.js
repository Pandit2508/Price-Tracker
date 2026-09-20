import fs from 'node:fs/promises';
import { launchBrowser } from '../src/scraper/browser.js';
import { productUrl } from '../src/store/store.js';

const id = Number(process.argv[2] || 733);
const url = productUrl(id);
const t0 = Date.now();
const since = () => Date.now() - t0;

await fs.mkdir('debug', { recursive: true });
const browser = await launchBrowser({ headed: true, slowMoMs: 0 });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();

let phase = 'load';
const calls = [];
page.on('response', async (res) => {
  const req = res.request();
  if (!['fetch', 'xhr'].includes(req.resourceType())) return;
  let body = null;
  try { body = (await res.text()).slice(0, 3000); } catch {}
  calls.push({ phase, atMs: since(), method: req.method(), status: res.status(), url: res.url(),
    headerNames: Object.keys(req.headers()), postData: req.postData()?.slice(0, 500) ?? null, body });
});

const topText = async (n = 1400) => (await page.evaluate(() => document.body.innerText).catch(() => '')).slice(0, n);
const show = (title, text) => console.log(`\n=== ${title} ===\n${text}`);
const showCalls = (p) => {
  const list = calls.filter((c) => c.phase === p);
  console.log(`\n=== NETWORK CALLS DURING "${p}" (${list.length}) ===`);
  for (const c of list) {
    console.log(`\n[+${c.atMs}ms] ${c.method} ${c.status} ${c.url}`);
    console.log(`  request header names: ${c.headerNames.join(', ')}`);
    if (c.postData) console.log(`  request body: ${c.postData}`);
    if (c.body) console.log(`  response: ${c.body.slice(0, 900)}`);
  }
};

await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);

const btn = page.getByRole('button', { name: /reveal price/i });
console.log(`\nReveal button found: ${await btn.count()}`);
if (await btn.count()) {
  const before = await btn.first().evaluate((el) => (el.parentElement?.parentElement ?? el.parentElement).outerHTML.slice(0, 3000));
  show('HTML AROUND THE PRICE AREA BEFORE REVEAL', before);
}

phase = 'hover';
if (await btn.count()) await btn.first().hover();
await page.waitForTimeout(3500);
showCalls('hover');
show('PAGE TEXT AFTER HOVER', await topText());

const stillHidden = /price hidden/i.test(await topText(3000));
if (stillHidden && (await btn.count())) {
  phase = 'click';
  await btn.first().click();
  await page.waitForTimeout(3500);
  showCalls('click');
  show('PAGE TEXT AFTER CLICKING REVEAL', await topText());
}

// Does the value change while we watch? (prices are said to change frequently)
for (let i = 1; i <= 3; i++) {
  await page.waitForTimeout(2500);
  show(`PAGE TEXT AGAIN (+${i * 2.5}s)`, await topText(700));
}

const html = await page.evaluate(() => document.body.innerHTML);
const context = (re, label, max = 5, radius = 350) => {
  console.log(`\n=== HTML AROUND "${label}" ===`);
  let m, n = 0;
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  while ((m = g.exec(html)) && n < max) {
    console.log(`\n--- match ${++n} ---\n${html.slice(Math.max(0, m.index - radius), m.index + radius)}`);
  }
  if (!n) console.log('(no match)');
};
context(/₹|&#8377;|\bRs\.?\s?\d|\$\s?\d|\bINR\b|\bUSD\b/, 'currency / price');
context(/in stock|out of stock|only \d+ left|low stock|sold out|unavailable/i, 'stock text', 3);

await fs.writeFile(`debug/reveal-${id}.html`, html);
await fs.writeFile(`debug/reveal-${id}.json`, JSON.stringify(calls, null, 2));
await page.screenshot({ path: `debug/reveal-${id}.png`, fullPage: true });
console.log(`\nSaved debug/reveal-${id}.html / .json / .png`);
console.log('Browser still open. Press Enter here to close it.');
await new Promise((r) => process.stdin.once('data', r));
await browser.close();
process.exit(0);

#!/usr/bin/env node
/**
 * Run the scraper from the terminal WITHOUT touching the database.
 *
 *   npm run scrape:headed -- --id 733
 *   npm run scrape:headed -- --id 733 --simulate abort     # attempt 1 loses its network calls
 *   npm run scrape:headed -- --id 733 --simulate slow      # attempt 1 is delayed 8s
 *   npm run scrape -- --id 733 --id 42 --debug             # headless, save HTML+screenshot on failure
 *
 * Flags: --id <n> (repeatable) | --headed | --slowmo <ms> | --simulate abort|slow | --debug
 */
import { config } from '../src/config.js';
import { launchBrowser } from '../src/scraper/browser.js';
import { scrapeProduct } from '../src/scraper/scrape.js';

const args = process.argv.slice(2);
const ids = [];
let headed = config.scrape.headed;
let slowMoMs = config.scrape.slowMoMs;
let simulate = null;
let debug = false;

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--id') ids.push(Number(args[++i]));
  else if (a === '--headed') headed = true;
  else if (a === '--slowmo') slowMoMs = Number(args[++i]);
  else if (a === '--simulate') simulate = args[++i];
  else if (a === '--debug') debug = true;
  else if (/^\d+$/.test(a)) ids.push(Number(a));
  else {
    console.error(`Unknown argument: ${a}`);
    process.exit(2);
  }
}
if (!ids.length) {
  console.error('Give at least one product id, e.g.  npm run scrape:headed -- --id 733');
  process.exit(2);
}
if (simulate && !['abort', 'slow'].includes(simulate)) {
  console.error('--simulate must be "abort" or "slow"');
  process.exit(2);
}

const stamp = () => new Date().toISOString().slice(11, 19);
const browser = await launchBrowser({ headed, slowMoMs });
let failures = 0;
try {
  for (const id of ids) {
    console.log(`\n[${stamp()}] Scraping product ${id}${simulate ? `  (fault injection: ${simulate} on attempt 1)` : ''}`);
    const result = await scrapeProduct(browser, id, {
      simulate,
      debugDir: debug ? './debug' : config.scrape.debugDir,
      onStep: (m) => console.log(`[${stamp()}]     ${m}`),
      onAttempt: (e) => {
        if (e.ok) console.log(`[${stamp()}]   attempt ${e.attempt}: OK`);
        else
          console.log(
            `[${stamp()}]   attempt ${e.attempt}: FAILED ${e.code} - ${e.message}` +
              (e.willRetry ? `  -> retrying in ${e.waitMs}ms` : '  -> giving up'),
          );
      },
    });
    if (result.ok) {
      const o = result.observation;
      console.log(`[${stamp()}]   RESULT ${result.outcome.toUpperCase()}: price=${o.price} ${o.currency ?? ''} stock=${o.stockStatus}${o.stockQuantity != null ? ` (${o.stockQuantity})` : ''}  [raw: "${o.rawPriceText}" / "${o.rawStockText}"]`);
    } else {
      failures++;
      console.log(`[${stamp()}]   RESULT FAILED: ${result.error.code} - ${result.error.message}  (nothing would be stored)`);
    }
  }
} finally {
  await browser.close();
}
process.exit(failures ? 1 : 0);

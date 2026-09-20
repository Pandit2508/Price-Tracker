# Walkthrough (read this before the interview)

The brief says you may be asked to modify the code live. You need to be able to explain every part. This file is the map. It is for you and is not part of the submission unless you choose to include it.

## Life of a scheduled scrape

1. cron-job.org sends `POST /api/scrape/run` with the bearer token. (`backend/src/app.js`)
2. The handler checks the token, replies `202` immediately, then calls `runAll('cron')`. (`app.js` to `runner.js`)
3. `runAll` takes the in-process lock, marks stale runs abandoned, opens a `scrape_runs` row, loads tracked products (stalest first), launches Chromium. (`runner.js`, `db.js`)
4. For each product, `scrapeProduct` (`scraper/scrape.js`) loops up to 4 attempts. Each attempt: new browser context, navigate to `/product/<id>`, poll until two identical parseable reads, return an observation.
5. Errors are classified (`scraper/errors.js`) as retryable or not; retryable ones wait with exponential backoff and try again.
6. `db.recordScrape` writes `price_history` only on success, always writes `scrape_log`, and updates the product's "latest" fields.
7. The run row is closed with counts, and the lock is released in a `finally`.

## File map

| File | Job |
|---|---|
| `store/selectors.js` | The only store-specific file: `prepare` reveals the hidden price, `extractInPage` picks the real price and stock |
| `store/store.js` | Builds product URLs from ids, enforces the store origin |
| `scraper/validate.js` | Parses price and stock text and rejects anything ambiguous |
| `scraper/scrape.js` | Attempts, retries, backoff, hard timeout, stable reads, fault injection |
| `scraper/errors.js` | Error codes and the retryable flag |
| `runner.js` | Run lock, worker pool, cleanup, run bookkeeping |
| `db.js` | All Supabase access |
| `catalog.js` | Catalog fetch, normalise, search |
| `app.js` | REST API, cron endpoint |
| `scripts/scrape-cli.js` | Headed runs and fault injection for the demo |
| `frontend/src/components/*` | Search, list, detail, chart, log |

## Changes an interviewer might ask for, and where to make them

| Request | Where |
|---|---|
| Change retries or timeouts | env vars, or defaults in `config.js` |
| Change the schedule | cron-job.org only; nothing in code |
| Per-product frequency (bonus) | add `interval_minutes` and `next_due_at` to `tracked_products`; in `runAll` filter to due products; cron then runs more often (e.g. every 15 min) |
| Add a field, e.g. rating or brand | read it in `readRaw` (`selectors.js`), parse in `validate.js`, add a column in `schema.sql`, write it in `db.recordScrape` |
| Price-drop alert (bonus) | in `recordScrape`, compare `obs.price` to the previous `last_price` before updating; send an email or set a flag |
| Flag a structure change (bonus) | count consecutive `SELECTOR_MISSING` failures per product; surface in the UI |
| Add a new failure type | add a code in `errors.js`; decide retryable or not; add it to `CONTENT_NOT_READY` in `scrape.js` if it means "still rendering" |
| Make the stock parser understand a new phrase | `parseStock` in `validate.js` plus a test in `test/validate.test.js` |

## Questions you should be able to answer

* Why a headless browser here? (Empty HTML shell; the price is hidden until hover + Reveal, which triggers a challenge and token exchange run by the page's own JS.) Why not for search? (The catalog is a plain request.)
* How do you avoid the decoy prices? (Visible, not struck through, currency-shaped, innermost element, exactly one distinct value; class names rotate so they are never used; then cross-checked against MRP and the discount badge.)
* Why does the cron endpoint return `202` before finishing? (cron-job.org's ~30 s timeout; work continues while the instance is awake.)
* What is the difference between a retried attempt and content that is "not ready"? (Not-ready is polled inside an attempt; everything else fails the attempt and is logged.)
* Why is an unknown stock label an error rather than "out of stock"? (Storing a guess is storing wrong data.)
* What happens if the DB insert fails after a good scrape? (It is logged as failed with `DB_WRITE_FAILED`, so history and log agree.)
* What happens if Render restarts mid-run? (The run row stays `running`, and the next run marks it `abandoned`; the next cron tick scrapes again.)

## Before submitting

- [ ] Run `npm run scrape:headed -- --id 733` and confirm the price and stock match the page; try several ids (`npm run scrape -- --id 1 --id 2 --id 733`).
- [ ] Create the Supabase project and run `schema.sql`.
- [ ] Deploy backend (Render, Docker) and frontend (Vercel); set env vars; put the live URLs in the README.
- [ ] Track 3 to 5 products, set up the cron-job.org job, and confirm a scheduled run appears in the log.
- [ ] Record the 2 to 4 minute headed run, including `--simulate abort` or `--simulate slow`.
- [ ] Add your own entries to the design note. Push to a public GitHub repo.
- [ ] Email `sstephen@ine.com`, cc `ssingh@ine.com`. Subject: `First Round: Software Engineer Intern Assignment - <Your Name>`. Attach the PDF resume. Deadline: Sunday 20 September 2026, 11:59 PM IST.

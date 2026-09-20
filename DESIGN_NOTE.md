# Design note

> **Draft.** The reliability section describes what the code actually does. The "what AI got wrong" section lists real corrections from building this with an AI assistant; **add your own from testing against the live store**, and edit everything into your own words before submitting.

## The problem in one paragraph

The store renders its product pages in the browser, so the server's HTML contains no price. The task is not "get a price once"; it is "keep producing correct rows over hundreds of unattended runs while the store is slow, flaky, and deliberately misleading". So the design optimises for one property: **a wrong or empty value must never reach the database, and a failure must always reach the log.**

## How scraping is made reliable

1. **Headless browser only where needed.** Catalog search uses the store's own catalog request (plain HTTP, no browser). Only the product page uses Playwright: its HTML is an empty shell, and the price is hidden until the pointer dwells over the price area and a Reveal button is clicked, which triggers a challenge and a short-lived-token price request that the page's own JavaScript handles. The scraper drives the UI like a person (hover, wait for the button to enable, click) rather than reimplementing that exchange. One Chromium instance is shared across a run; each *attempt* gets a fresh browser context, so a poisoned page state cannot leak into the next attempt.
2. **Parse strictly, never guess.** `validate.js` strips zero-width characters, understands formats like `Rs. 12,723.00` and `1.299,50`, and **throws** on ambiguity: two different numbers in one element (a "was/now" or decoy price), an empty or placeholder value, zero, or an absurd magnitude. An unrecognised stock label throws; it is never recorded as "out of stock".
3. **Wait for late content, but only for content that is late.** After navigation the scraper polls until it reads the same parseable price and stock twice in a row. That covers async content ("Loading…", half-rendered pages) and values that are still settling. Only "not ready yet" errors are polled inside an attempt; anything else fails the attempt so it is counted and logged as a retry.
4. **Retries with exponential backoff and jitter** (up to 4 attempts, 1.5 s base). Errors carry a `retryable` flag: timeouts, network errors and 5xx/429 are retried; a 404, an unconfigured extractor, or a selector matching several elements is not, because retrying cannot fix them.
5. **A hard per-attempt deadline** (45 s) that races the attempt and force-closes its browser context. Playwright's own timeouts do not cover every hang, and one hung page must not stall the whole run.
6. **Pick the real price by what is visible, not by class name.** After the reveal the price block holds four look-alikes: two hidden decoys (`display:none`, one tagged `data-price="true"`), a struck-through MRP, and the real price drawn as one span per character with zero-width characters between them. The store also rotates its class names via `/api/layout`. So the extractor keeps only innermost, currency-shaped elements that are visible and not struck through, requires exactly one distinct value, and never uses a class name. A missing price block is reported as `SELECTOR_MISSING`, which is the visible "page structure changed" signal.
   **Independent cross-check:** the price must agree with the MRP and the "N% off" badge; a value that does not fit is never stored (`PRICE_CROSSCHECK_FAILED`). Limit: the badge has whole-percent precision, so this catches decoys and gross misreads but not a tiny digit swap.
7. **Honest persistence.** `price_history` is written only for validated observations, and the schema enforces `price > 0` and a valid stock enum. `scrape_log` is written for every run: `success`, `retried` (succeeded after at least one failed attempt), or `failed`, with every attempt's error code, message and duration. If the history insert itself fails, the run is logged as failed, so history and log always agree. If Chromium cannot even launch, each product still gets a failed log entry.
8. **Never silently stop.** A `scrape_runs` row is opened and closed around every scheduled run; runs that died mid-way are marked `abandoned` on the next run. Products are processed stalest-first so a cut-short run still favours the most overdue ones. Unhandled rejections are logged instead of crashing the process.
9. **Scheduling that survives free-tier sleep.** No in-process timer. cron-job.org calls an authenticated endpoint (timing-safe token check) every 2 hours; the endpoint replies `202` at once (the cron service times out after ~30 s) and finishes the work in the background. An in-process lock stops overlapping runs from starting two Chromiums on a 512 MB instance.
10. **Scope safety.** The scraper accepts only a numeric product id; URLs are built server-side and every navigation is checked against the store's origin.

## Trade-offs

* **Browser vs. HTTP.** A browser is slower and heavier. Here it is the pragmatic choice: the price only exists after an interaction plus a challenge exchange, and the alternative is reimplementing that exchange, which is brittle and defeats the point of reading what a user sees. Cost: about 30 s per product (the reveal is slow by design), so the run is sequential and the timeouts are generous.
* **Stability check vs. speed.** Requiring two identical reads costs about half a second per product and protects against half-rendered values. If the store's price legitimately ticks constantly, `SCRAPE_STABLE_READS=1` disables it.
* **Sequential scraping.** Concurrency 1 makes a run slower but keeps memory inside the free tier. It is configurable.
* **Public, unauthenticated API.** Acceptable for the assignment; mitigated with caps and a cooldown rather than accounts.
* **One log row per run, attempts in JSON.** Keeps the log readable (one entry per scrape) while still exposing every retry on demand.

## What the AI tools got wrong, and how it was corrected

*Real corrections from building this project with an AI assistant. Replace or extend with your own.*

1. **Retries were being hidden.** The first version of the stability loop caught *every* retryable error and kept polling inside a single attempt. A test that simulated two network failures followed by a good read reported plain `success` with one attempt, so flaky runs would have looked perfect in the log. Fix: only "content not ready" errors (placeholder text, missing element, half-rendered price) are polled inside an attempt; everything else fails the attempt and is logged as a retry. The test that caught it now guards the behaviour.
2. **Adjacent numbers were merged into one price.** The first number tokenizer allowed spaces inside a number, so `1999 1499` (two prices) would have parsed as `19991499`. Fix: whitespace is not allowed inside a number, so it is now read as two values and rejected as ambiguous. Covered by a test.
3. **Tooling assumptions.** The first test script (`node --test test/`) failed on Node 22, which treats the path as a module rather than a directory; the shell's brace expansion also did not work in the sandbox and silently created the wrong folders. Both were caught by running the code instead of trusting it.
4. **Store details that could not be guessed.** The AI could not open the JS-rendered store, so it did not invent selectors; the first build shipped the extractor as an explicit, fail-safe stub until real DevTools evidence existed.
5. **The first plan assumed the price was in the page.** The first discovery script (and the plan built on it) recorded the page after load, which showed "Price hidden" and no price. Only a second script that hovered and clicked Reveal exposed the interaction, the challenge/token requests, the decoy prices and the zero-width characters. Fix: a one-time `prepare` step that reveals the price, and an extractor rewritten around the observed DOM instead of a simple selector.
6. **Over-claiming in a test.** A test asserted that the discount cross-check would catch a swapped-digit price (50,534 vs 50,435). It failed because that value is 18.84% off, which rounds to the same 19% badge. Fix: the test now states what the check can and cannot catch, and the limit is documented above.

*Your own entries:* ____________________________________________

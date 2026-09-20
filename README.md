# Price Tracker for the INE mock store

Search the INE mock store (https://demo.inelabteamdev.com), track a product, and have its price and stock scraped every 2 hours. The dashboard shows the price and stock history and a scrape log for every attempt, including the failed ones.

| Part | Tech | Hosted on |
|---|---|---|
| Frontend | React (Vite), Recharts | Vercel |
| Backend | Node.js, Express, Playwright | Render (Docker) |
| Database | PostgreSQL | Supabase |
| Scheduler | cron-job.org calling the backend | cron-job.org |

Live site: `https://price-tracker-delta-flame.vercel.app/`

> ## Status
> The extractor is written from what the store's product page actually does (hidden price, reveal step, look-alike prices; see `backend/src/store/selectors.js`). Its selection logic is unit-tested against the real HTML captured from a browser, but a **live run against the store is the final check**: run `npm run scrape:headed -- --id 733` and confirm it prints the same price you see on the page. Also confirm search works (the catalog endpoint is `CATALOG_URL`).

## How it works

```
cron-job.org --POST every 2h--> Render backend --Playwright--> demo store /product/<id>
                                     |                                  (JS-rendered page)
Vercel frontend --REST--> backend --supabase-js--> Supabase: tracked_products, price_history, scrape_log, scrape_runs
```

* **Why a headless browser:** the store's HTML is a ~459-byte shell rendered client-side, and the price is hidden until the pointer dwells over the price area and "Reveal price" is clicked, which makes the page run its own challenge and token request before drawing the price. Reimplementing that would be brittle; a browser lets the page's own code do it while we drive the UI like a person. Catalog search does *not* need a browser; it uses the store's catalog request directly.
* **Scheduling:** free-tier backends sleep, so there is no in-process timer. cron-job.org calls `POST /api/scrape/run` every 2 hours; that request wakes the instance, which replies `202` immediately (cron-job.org gives up after ~30 s) and keeps scraping in the background.
* **Reliability details** are in [DESIGN_NOTE.md](DESIGN_NOTE.md).

## Run it locally

Requirements: Node 20+, a Supabase project.

```bash
# 1. Database: paste supabase/schema.sql into the Supabase SQL editor and run it.

# 2. Backend
cd backend
cp .env.example .env            # fill in SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET
npm install
npx playwright install chromium
npm test                        # 28 unit tests, no network or browser needed
npm run dev                     # http://localhost:3001

# 3. Frontend (second terminal)
cd frontend
cp .env.example .env            # VITE_API_BASE_URL=http://localhost:3001/api
npm install
npm run dev                     # http://localhost:5173
```

## Environment variables

**Backend** (`backend/.env`; on Render, set these in the dashboard)

| Variable | Required | Purpose |
|---|---|---|
| `SUPABASE_URL` | yes | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Server-side key. Never expose it in the frontend |
| `CRON_SECRET` | yes | Bearer token cron-job.org must send to `/api/scrape/run` |
| `FRONTEND_URL` | yes in prod | Allowed CORS origin(s), comma-separated (your Vercel URL) |
| `PORT` | no | Set by Render automatically. Default 3001 |
| `CATALOG_URL` | verify | Store catalog endpoint. Default is `https://demo.inelabteamdev.com/api/catalog`, which is a **guess**: confirm the real path and JSON shape in the browser Network tab (request named `catalog`) and adjust `normalizeCatalog()` in `backend/src/catalog.js` if needed |
| `HEADED`, `SLOW_MO_MS` | no | Show the browser window (local only) |
| `BROWSER_CHANNEL` | no | Local only: `chrome` uses your installed Google Chrome instead of downloading Chromium. Leave unset on Render |
| `SCRAPE_MAX_ATTEMPTS` (4), `SCRAPE_BASE_DELAY_MS` (1500) | no | Retry count and backoff base |
| `SCRAPE_NAV_TIMEOUT_MS` (20000), `SCRAPE_PRICE_WAIT_MS` (15000), `SCRAPE_REVEAL_WAIT_MS` (45000), `SCRAPE_AFTER_CLICK_WAIT_MS` (30000), `SCRAPE_ATTEMPT_HARD_TIMEOUT_MS` (120000) | no | Timeouts: page render, wait for the Reveal button to enable, wait for the price after clicking, and the hard per-attempt cap. A scrape takes roughly 30 s per product because the reveal is slow by design |
| `SCRAPE_CONCURRENCY` (1) | no | Parallel products per run. Keep at 1 on the 512 MB free tier |
| `SCRAPE_STABLE_READS` (2), `SCRAPE_STABLE_GAP_MS` (500) | no | Require N identical reads before accepting a value (1 disables) |
| `DEBUG_DIR` | no | Save page HTML + screenshot when an attempt fails |

**Frontend** (`frontend/.env`; on Vercel, set in project settings)

| Variable | Purpose |
|---|---|
| `VITE_API_BASE_URL` | Backend API base, e.g. `https://your-app.onrender.com/api` |

## How the extractor works (and what to do if the store changes)

`backend/src/store/selectors.js` is the only store-specific file.

1. **Reveal:** wait for the `.price-block` area, move the pointer around inside it until the "Reveal price" button enables, click it, and wait for the block to reach its success state (`price-success`). The store's own JS performs the challenge and price request.
2. **Read:** among the elements inside the price block, keep those whose whole text looks like a price, then drop hidden ones (`display:none`, zero opacity, etc.) and struck-through ones (the MRP). Exactly one distinct visible value must remain, otherwise the scrape fails as ambiguous. Class names are never used, because the store rotates them.
3. **Verify:** the price must agree with MRP and the "N% off" badge (`crossCheckDiscount` in `scraper/validate.js`), and stock text must be recognised.

If the store changes its markup, scrapes fail with `SELECTOR_MISSING`, `PARSE_PRICE` or `PRICE_NOT_REVEALED` (visible in the scrape log, nothing stored). To investigate: `node scripts/inspect-reveal.js 733` opens the page, reveals the price and prints the network calls and the HTML around the price and stock; `node scripts/inspect.js 733` records the page before the reveal.

## Headed (observable) run, for the screen recording

```bash
cd backend
npm run scrape:headed -- --id 733                       # watch it work
npm run scrape:headed -- --id 733 --simulate abort      # attempt 1: network calls dropped -> retry -> recovery
npm run scrape:headed -- --id 733 --simulate slow       # attempt 1: calls delayed 8 s -> timeout/retry -> recovery
```

The terminal prints every attempt, the failure code, the backoff wait, and the final result. Nothing is written to the database in CLI mode. Suggested recording (2 to 4 min): one normal run, one `--simulate abort` run showing the retry, then the dashboard's scrape log showing a real retried entry.

## Scraping schedule

Every **2 hours**, triggered externally.

cron-job.org, new cron job:

* URL: `https://<your-backend>.onrender.com/api/scrape/run`
* Schedule: every 2 hours (`0 */2 * * *`)
* Request method: `POST`
* Header: `Authorization: Bearer <CRON_SECRET>`
* Expect: `202` (started) or `409` (a run is still going; this is fine)

Optional keep-warm: a second job calling `GET /api/health` every 10 minutes. It is not required, because the scheduled call itself wakes the instance.

## Deployment

**Supabase:** run `supabase/schema.sql`. RLS is enabled with no policies, so the public anon key can read nothing; only the backend's service-role key is used.

**Render (backend):** New, Web Service, connect the repo. Root directory `backend`, runtime **Docker** (needed for Chromium's system libraries). Set the env vars above. Free instances have 512 MB RAM, so keep `SCRAPE_CONCURRENCY=1`. Keep the Dockerfile's image tag in sync with the `playwright` version in `package.json`.

**Vercel (frontend):** import the repo, root directory `frontend`, framework Vite, set `VITE_API_BASE_URL`.

## API

| Method and path | Purpose |
|---|---|
| `GET /api/catalog/search?q=` | Search the store's catalog by partial or full name, brand or SKU |
| `GET /api/products` | Tracked products with latest state |
| `POST /api/products` | Track `{ storeProductId }` (triggers a first scrape) |
| `DELETE /api/products/:id` | Stop tracking (history is deleted with it) |
| `GET /api/products/:id/history` | Price and stock history |
| `GET /api/products/:id/logs` | Scrape log |
| `POST /api/products/:id/scrape` | Manual scrape (60 s cooldown per product) |
| `POST /api/scrape/run` | Scheduled scrape of all products (Bearer `CRON_SECRET`) |
| `GET /api/health`, `GET /api/status` | Liveness, and whether a scrape is running |

## Known limitations

* The backend is public and unauthenticated (fine for the assignment): anyone with the link can track or remove products. Mitigations: 50 product cap, manual-scrape cooldown, and scraping is restricted to the store origin.
* Bonus features not implemented: alerts, per-product frequency, page-structure change detection (repeated `SELECTOR_MISSING` in the log is the current signal).

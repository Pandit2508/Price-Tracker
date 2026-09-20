import 'dotenv/config';

const int = (v, d) => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) ? n : d;
};
const bool = (v, d = false) =>
  v == null || v === '' ? d : ['1', 'true', 'yes'].includes(String(v).toLowerCase());

// Hard-coded on purpose: the assignment allows scraping ONLY this store, so the
// origin is not configurable. Every URL the scraper visits is checked against it.
const STORE_ORIGIN = 'https://demo.inelabteamdev.com';

export const config = {
  port: int(process.env.PORT, 3001),
  frontendOrigins: (process.env.FRONTEND_URL || 'http://localhost:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseServiceKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  cronSecret: process.env.CRON_SECRET,
  maxTrackedProducts: 50,
  manualScrapeCooldownMs: 60_000,

  store: {
    origin: STORE_ORIGIN,
    // TODO(verify): the Network tab shows a request named "catalog"; confirm its real path/params.
    catalogUrl: process.env.CATALOG_URL || `${STORE_ORIGIN}/api/catalog`,
  },

  scrape: {
    headed: bool(process.env.HEADED),
    slowMoMs: int(process.env.SLOW_MO_MS, 250),
    maxAttempts: int(process.env.SCRAPE_MAX_ATTEMPTS, 4),
    baseDelayMs: int(process.env.SCRAPE_BASE_DELAY_MS, 1500),
    navTimeoutMs: int(process.env.SCRAPE_NAV_TIMEOUT_MS, 20_000),
    priceWaitMs: int(process.env.SCRAPE_PRICE_WAIT_MS, 15_000), // page must render its price area within this
    revealWaitMs: int(process.env.SCRAPE_REVEAL_WAIT_MS, 45_000), // Reveal button may take a while to enable
    afterClickWaitMs: int(process.env.SCRAPE_AFTER_CLICK_WAIT_MS, 30_000), // challenge + price request
    attemptHardTimeoutMs: int(process.env.SCRAPE_ATTEMPT_HARD_TIMEOUT_MS, 120_000),
    concurrency: int(process.env.SCRAPE_CONCURRENCY, 1), // Render free tier has 512MB RAM
    stableReads: int(process.env.SCRAPE_STABLE_READS, 2), // set 1 to disable the stability check
    stableGapMs: int(process.env.SCRAPE_STABLE_GAP_MS, 500),
    debugDir: process.env.DEBUG_DIR || null,
    simulate: null, // 'abort' | 'slow' | null  (fault injection for the demo video; CLI only)
  },
};

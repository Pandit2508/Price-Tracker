import { ScrapeError } from '../scraper/errors.js';

/**
 * ===========================================================================
 *  THE ONLY FILE THAT KNOWS HOW THE STORE'S PRODUCT PAGE WORKS.
 *
 *  What the store does (observed in a real browser with DevTools):
 *   1. /product/<id> returns an empty shell; the page is rendered by JavaScript.
 *   2. The price is HIDDEN ("Price hidden - hover over the price area"). The
 *      "Reveal price" button is disabled until the pointer has dwelt over the price
 *      area. Clicking it makes the page run its own challenge
 *      (/api/challenge -> /api/session -> /api/products/<id>/price, with a
 *      short-lived token) and then draw the price. We do NOT reimplement any of
 *      that: the page's own code runs in the browser and we only drive the UI the
 *      way a person would (hover, wait for the button, click).
 *   3. Once revealed, the price block contains several look-alike prices:
 *        - hidden ones (display:none), one of them tagged data-price="true"
 *        - a struck-through MRP
 *        - the real selling price, drawn as one <span> per character with
 *          invisible zero-width characters between them
 *   4. Class names such as pw-k2 / pv-k2 come from /api/layout and ROTATE, so this
 *      file never selects by them. It selects by what a person can see: visible,
 *      not struck through, currency-shaped, innermost element. The result is then
 *      cross-checked against MRP and the "N% off" badge (see validate.js).
 *
 *  Stable hooks we DO rely on (a change here shows up as SELECTOR_MISSING in the
 *  scrape log, which is the "page structure changed" signal):
 *    .price-block                 the wrapper around price, stock and status
 *    .price-block.price-success   state after a successful reveal
 *    button labelled "Reveal price"
 * ===========================================================================
 */
const ROOT = '.price-block';

/**
 * Runs INSIDE the browser page (via page.evaluate) - so it must be fully
 * self-contained. It is also unit-tested against the real HTML in
 * test/extract.test.js by passing a jsdom document.
 */
export function extractInPage({ requireLayout = true, doc = document } = {}) {
  const win = doc.defaultView;
  const INVISIBLE = /[\u200B-\u200D\u2060\uFEFF\u00AD]/g;
  const clean = (s) =>
    String(s ?? '').replace(INVISIBLE, '').replace(/[\u00A0\u2007\u202F]/g, ' ').replace(/\s+/g, ' ').trim();
  const PRICE_RE = /^(?:₹|Rs\.?|INR|\$|USD|€|£)\s?\d[\d,]*(?:\.\d{1,2})?$/i;
  const STOCK_RE = /\b(?:in stock|out of stock|sold out|unavailable|low stock|\d+\s+left)\b/i;
  const DISCOUNT_RE = /^(\d{1,2}(?:\.\d+)?)\s*%\s*off$/i;

  const root = doc.querySelector('.price-block');
  if (!root) return { error: { code: 'SELECTOR_MISSING', message: 'No .price-block element on the page' } };

  // Hidden if it, or any ancestor, is not displayed / invisible / transparent / zero-sized.
  const isHidden = (el) => {
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const cs = win.getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return true;
      if (Number.parseFloat(cs.opacity) === 0 || n.hasAttribute('hidden')) return true;
      const fs = Number.parseFloat(cs.fontSize);
      if (Number.isFinite(fs) && fs < 8) return true;
    }
    if (requireLayout) {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return true;
    }
    return false;
  };
  const isStruck = (el) => {
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const cs = win.getComputedStyle(n);
      if (`${cs.textDecorationLine ?? ''} ${cs.textDecoration ?? ''}`.includes('line-through')) return true;
      if (n === root) break;
    }
    return false;
  };
  // Keep only innermost matches (drop wrappers that merely contain another match).
  const innermost = (els) => els.filter((el) => !els.some((o) => o !== el && el.contains(o)));

  const all = [...root.querySelectorAll('*')];

  // ---- price ---------------------------------------------------------------
  const priceLeaves = innermost(all.filter((el) => PRICE_RE.test(clean(el.textContent))));
  const ignored = [];
  const visible = [];
  const struck = [];
  for (const el of priceLeaves) {
    const text = clean(el.textContent);
    if (isHidden(el)) ignored.push(`${text} (hidden)`);
    else if (isStruck(el)) struck.push(text);
    else visible.push(text);
  }
  const visibleDistinct = [...new Set(visible)];
  if (visibleDistinct.length === 0) {
    return { error: { code: 'PARSE_PRICE', message: `No visible, non-struck-through price yet (ignored: ${ignored.concat(struck).join(', ') || 'none'})` } };
  }
  if (visibleDistinct.length > 1) {
    return { error: { code: 'AMBIGUOUS_PRICE', message: `Several visible prices: ${visibleDistinct.join(', ')}` } };
  }

  // ---- discount badge and MRP (used only to cross-check the price) ----------
  const badge = all.find((el) => !isHidden(el) && DISCOUNT_RE.test(clean(el.textContent)));
  const discountPct = badge ? Number.parseFloat(clean(badge.textContent).match(DISCOUNT_RE)[1]) : null;

  // ---- stock ---------------------------------------------------------------
  const stockLeaves = innermost(
    all.filter((el) => {
      const t = clean(el.textContent);
      return t.length > 0 && t.length <= 40 && STOCK_RE.test(t);
    }),
  ).filter((el) => !isHidden(el));
  const stockDistinct = [...new Set(stockLeaves.map((el) => clean(el.textContent)))];
  if (stockDistinct.length === 0) return { error: { code: 'PARSE_STOCK', message: 'No visible stock label yet' } };
  if (stockDistinct.length > 1) {
    return { error: { code: 'AMBIGUOUS_STOCK', message: `Several stock labels: ${stockDistinct.join(' | ')}` } };
  }

  return {
    ok: true,
    priceText: visibleDistinct[0],
    mrpText: struck[0] ?? null,
    discountPct,
    stockText: stockDistinct[0],
    nameText: doc.querySelector('h1') ? clean(doc.querySelector('h1').textContent) : null,
    ignored,
  };
}

/**
 * Get the page from "Price hidden" to "price shown", once per attempt.
 * Steps are reported through s.onStep so the headed demo can narrate them.
 */
export async function prepare(page, s) {
  const step = (m) => s.onStep?.(m);
  const t0 = Date.now();
  const block = page.locator(ROOT).first();
  try {
    await block.waitFor({ state: 'visible', timeout: s.priceWaitMs });
  } catch {
    throw new ScrapeError(
      'SELECTOR_MISSING',
      `No visible ${ROOT} within ${s.priceWaitMs}ms (the page did not render, or its structure changed)`,
    );
  }
  step('price area rendered');

  const revealed = () => block.evaluate((el) => el.classList.contains('price-success')).catch(() => false);
  // true = enabled, false = disabled, null = no such button
  const buttonState = () =>
    block
      .evaluate((el) => {
        const b = [...el.querySelectorAll('button')].find((x) => /reveal price/i.test(x.getAttribute('aria-label') || x.textContent || ''));
        return b ? !b.disabled : null;
      })
      .catch(() => null);

  if (!(await revealed())) {
    // The store enables the button only after the pointer has dwelt over the price area,
    // so keep moving the pointer around inside it until the button is enabled.
    step('hovering over the price area until the Reveal button enables');
    const deadline = Date.now() + s.revealWaitMs;
    let state;
    while ((state = await buttonState()) !== true) {
      if (await revealed()) break;
      if (Date.now() > deadline) {
        throw new ScrapeError(
          'REVEAL_NOT_ENABLED',
          state === null ? 'No "Reveal price" button found in the price area' : `Reveal button stayed disabled for ${s.revealWaitMs}ms`,
        );
      }
      const box = await block.boundingBox();
      if (box) {
        await page.mouse.move(box.x + box.width * (0.2 + Math.random() * 0.6), box.y + box.height * (0.3 + Math.random() * 0.4), { steps: 6 });
      }
      await page.waitForTimeout(400);
    }
    if (!(await revealed())) {
      step(`Reveal button enabled after ${Date.now() - t0}ms, clicking`);
      await block.getByRole('button', { name: /reveal price/i }).click({ timeout: 10_000 });
    }
  }

  // Wait for the store's own challenge + price request to finish.
  const end = Date.now() + s.afterClickWaitMs;
  let errorSince = null;
  let last = { status: '', classes: '' };
  while (Date.now() < end) {
    const st = await page
      .evaluate(() => {
        const b = document.querySelector('.price-block');
        if (!b) return { state: 'missing', status: '', classes: '' };
        const status = (b.querySelector('.price-status')?.textContent ?? '').trim();
        const classes = b.className;
        if (b.classList.contains('price-success')) return { state: 'success', status, classes };
        const err = [...b.classList].some((c) => /^price-(error|fail|failed|timeout|blocked)$/.test(c));
        return { state: err ? 'error' : 'pending', status, classes };
      })
      .catch(() => ({ state: 'missing', status: '', classes: '' }));
    last = st;
    if (st.state === 'success') {
      step(`price revealed after ${Date.now() - t0}ms`);
      return;
    }
    if (st.state === 'error') {
      errorSince ??= Date.now();
      if (Date.now() - errorSince > 3000) {
        throw new ScrapeError('STORE_ERROR', `The store reported an error while loading the price: "${st.status}"`);
      }
    } else {
      errorSince = null;
    }
    await page.waitForTimeout(300);
  }
  throw new ScrapeError(
    'PRICE_NOT_REVEALED',
    `Price did not appear within ${s.afterClickWaitMs}ms (last status "${last.status}", classes "${last.classes}")`,
  );
}

/** Read the raw texts from the revealed page. Parsing/validation live in scraper/validate.js. */
export async function readRaw(page) {
  const r = await page.evaluate(extractInPage, { requireLayout: true });
  if (r.error) throw new ScrapeError(r.error.code, r.error.message);
  return r;
}

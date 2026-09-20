import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { extractInPage } from '../src/store/selectors.js';
import { parsePrice, parseStock, crossCheckDiscount } from '../src/scraper/validate.js';

const Z = '\u200B'; // zero-width space, hidden between the characters of the real price

/**
 * The price block as observed in the real browser for product 733 (revealed state):
 *  - a hidden decoy (display:none)                          Rs 34,078
 *  - a struck-through MRP                                   Rs 62,265
 *  - the REAL price, one <span> per character + zero-width  Rs 50,435
 *  - a discount badge                                       19% off
 *  - a second hidden decoy tagged data-price="true"         Rs 40,763
 *  - a stock badge                                          12 in stock
 * `cls` lets tests swap the rotating class names.
 */
function priceBlock(cls = { wrap: 'pw-k2', mrp: 'mr-k2', value: 'v92usvc pv-k2', badge: 'bd-k2', stock: 'st-k2' }, extra = '') {
  return `
  <h1>Ironwood Convertible X</h1>
  <div class="price-block price-success ${cls.wrap}" aria-live="polite">
    <div class="price-main">
      <span class="price-value" aria-hidden="true" style="display: none;">₹34,078</span>
      <span class="${cls.mrp}" style="text-decoration: line-through; opacity: 0.55; margin-right: 10px;">₹62,265</span>
      <div class="${cls.value}" style="font-size: 2.4rem; font-weight: 700; opacity: 1;"><span>₹${Z}</span><span>5${Z}</span><span>0${Z}</span><span>,${Z}</span><span>4${Z}</span><span>3${Z}</span><span>5</span></div>
      <span class="${cls.badge}" style="margin-left: 10px;">19% off</span>
      <span class="amount" data-price="true" aria-hidden="true" style="display: none;">₹40,763</span>
    </div>
    <div class="price-facets">
      <div class="${cls.stock}"><span class="stock-badge in-stock">12 in stock</span></div>
      <div class="dl-k2"><small>Get it by Mon, 21 Sept</small></div>
      <div class="sr-k2">Sold by Nor${Z}thwind Retail</div>
      <p>Loaded in 1 attempt</p>
    </div>
    ${extra}
  </div>`;
}

const run = (html) => extractInPage({ doc: new JSDOM(`<body>${html}</body>`).window.document, requireLayout: false });

test('picks the real price, not the hidden decoys or the struck-through MRP', () => {
  const r = run(priceBlock());
  assert.equal(r.ok, true);
  assert.equal(parsePrice(r.priceText).amount, 50435);
  assert.equal(parsePrice(r.priceText).currency, 'INR');
  assert.equal(r.mrpText, '₹62,265');
  assert.equal(r.discountPct, 19);
  assert.ok(r.ignored.some((t) => t.includes('34,078')));
  assert.ok(r.ignored.some((t) => t.includes('40,763')));
});

test('reads stock from the visible badge', () => {
  const r = run(priceBlock());
  assert.deepEqual(parseStock(r.stockText), { status: 'in_stock', quantity: 12 });
});

test('still works after the store rotates its class names', () => {
  const r = run(priceBlock({ wrap: 'qq-77', mrp: 'zz-1', value: 'abc pv-77', badge: 'b-9', stock: 'stx-3' }));
  assert.equal(r.ok, true);
  assert.equal(parsePrice(r.priceText).amount, 50435);
  assert.equal(r.discountPct, 19);
});

test('the extracted price passes the MRP x discount cross-check', () => {
  const r = run(priceBlock());
  assert.doesNotThrow(() =>
    crossCheckDiscount({ price: parsePrice(r.priceText).amount, mrpText: r.mrpText, discountPct: r.discountPct }),
  );
});

test('cross-check rejects a decoy value that does not fit the MRP and badge', () => {
  assert.throws(() => crossCheckDiscount({ price: 34078, mrpText: '₹62,265', discountPct: 19 }), { code: 'PRICE_CROSSCHECK_FAILED' });
  assert.throws(() => crossCheckDiscount({ price: 40763, mrpText: '₹62,265', discountPct: 19 }), { code: 'PRICE_CROSSCHECK_FAILED' });
  assert.throws(() => crossCheckDiscount({ price: 70000, mrpText: '₹62,265', discountPct: 19 }), { code: 'PRICE_CROSSCHECK_FAILED' });
  // a grossly wrong reading (e.g. digits scrambled into 45,053) is caught too
  assert.throws(() => crossCheckDiscount({ price: 45053, mrpText: '₹62,265', discountPct: 19 }), { code: 'PRICE_CROSSCHECK_FAILED' });
  // KNOWN LIMIT: the badge only has whole-percent precision, so a tiny error such as 50,534
  // (18.84% off, which rounds to 19%) cannot be told apart from 50,435 by this check.
  assert.doesNotThrow(() => crossCheckDiscount({ price: 50534, mrpText: '₹62,265', discountPct: 19 }));
});

test('cross-check is skipped when there is no discount information', () => {
  assert.doesNotThrow(() => crossCheckDiscount({ price: 999, mrpText: null, discountPct: null }));
  assert.doesNotThrow(() => crossCheckDiscount({ price: 999, mrpText: '₹1,000', discountPct: null }));
});

test('two different visible prices are reported as ambiguous, not guessed', () => {
  const r = run(priceBlock(undefined, '<div style="font-size: 20px;">₹12,999</div>'));
  assert.equal(r.error.code, 'AMBIGUOUS_PRICE');
});

test('before the reveal there is no price and nothing is returned', () => {
  const idle = `<div class="price-block price-idle pw-k2"><p class="price-status">Price hidden</p><button aria-label="Reveal price" disabled>Reveal price</button></div>`;
  assert.equal(run(idle).error.code, 'PARSE_PRICE');
});

test('missing price block is reported as a structure change', () => {
  assert.equal(run('<div>nothing here</div>').error.code, 'SELECTOR_MISSING');
});

test('a low-stock and an out-of-stock label are recognised', () => {
  const low = run(priceBlock().replace('12 in stock', 'Only 3 left'));
  assert.deepEqual(parseStock(low.stockText), { status: 'low_stock', quantity: 3 });
  const out = run(priceBlock().replace('12 in stock', 'Out of stock'));
  assert.equal(parseStock(out.stockText).status, 'out_of_stock');
});

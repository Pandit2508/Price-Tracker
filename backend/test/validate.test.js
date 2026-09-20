import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePrice, parseStock, cleanText } from '../src/scraper/validate.js';

test('parsePrice handles common formats', () => {
  assert.deepEqual(parsePrice('Rs. 12,723.00'), { amount: 12723, currency: 'INR' });
  assert.deepEqual(parsePrice('₹1,299'), { amount: 1299, currency: 'INR' });
  assert.deepEqual(parsePrice('$1,299.99'), { amount: 1299.99, currency: 'USD' });
  assert.deepEqual(parsePrice('12.723,00 €'), { amount: 12723, currency: 'EUR' });
  assert.equal(parsePrice('12,5').amount, 12.5);
  assert.equal(parsePrice('999').amount, 999);
  assert.equal(parsePrice('999').currency, null);
});

test('parsePrice strips zero-width characters hidden inside digits', () => {
  assert.equal(parsePrice('₹1\u200B,2\u200C9\u200D9').amount, 1299);
  assert.equal(cleanText('  a\u00A0\u00A0b\uFEFF '), 'a b');
});

test('parsePrice refuses ambiguous text instead of guessing (decoy / struck-through prices)', () => {
  assert.throws(() => parsePrice('Was 1999 Now 1499'), { code: 'AMBIGUOUS_PRICE' });
  assert.throws(() => parsePrice('₹14,000 ₹12,500'), { code: 'AMBIGUOUS_PRICE' });
  assert.throws(() => parsePrice('1999 1499'), { code: 'AMBIGUOUS_PRICE' });
});

test('parsePrice refuses empty, placeholder, zero and absurd values', () => {
  assert.throws(() => parsePrice(''), { code: 'PARSE_PRICE' });
  assert.throws(() => parsePrice('Loading...'), { code: 'PARSE_PRICE' });
  assert.throws(() => parsePrice('₹0.00'), { code: 'IMPLAUSIBLE_PRICE' });
  assert.throws(() => parsePrice('₹999999999999'), { code: 'IMPLAUSIBLE_PRICE' });
});

test('parseStock recognises the common phrasings', () => {
  assert.deepEqual(parseStock('In stock'), { status: 'in_stock', quantity: null });
  assert.deepEqual(parseStock('5 units available'), { status: 'in_stock', quantity: 5 });
  assert.deepEqual(parseStock('Only 3 left'), { status: 'low_stock', quantity: 3 });
  assert.deepEqual(parseStock('Out of stock'), { status: 'out_of_stock', quantity: 0 });
  assert.deepEqual(parseStock('Sold out'), { status: 'out_of_stock', quantity: 0 });
});

test('"not in stock" is out of stock, not in stock', () => {
  assert.equal(parseStock('Not in stock').status, 'out_of_stock');
  assert.equal(parseStock('Currently unavailable').status, 'out_of_stock');
});

test('unknown or empty stock text throws - a missing label is NOT "out of stock"', () => {
  assert.throws(() => parseStock(''), { code: 'PARSE_STOCK' });
  assert.throws(() => parseStock('Loading…'), { code: 'PARSE_STOCK' });
  assert.throws(() => parseStock('???'), { code: 'PARSE_STOCK' });
});

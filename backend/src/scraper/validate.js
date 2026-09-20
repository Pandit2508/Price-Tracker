import { ScrapeError } from './errors.js';

// Zero-width / invisible characters that can be hidden inside digits or words.
const INVISIBLE = /[\u200B-\u200D\u2060\uFEFF\u00AD]/g;

export function cleanText(s) {
  return String(s ?? '')
    .replace(INVISIBLE, '')
    .replace(/[\u00A0\u2007\u202F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const CURRENCIES = [
  [/(?:₹|\brs\.?|\binr\b|\brupees?\b)/i, 'INR'],
  [/(?:\$|\busd\b)/i, 'USD'],
  [/(?:€|\beur\b)/i, 'EUR'],
  [/(?:£|\bgbp\b)/i, 'GBP'],
];

/** Convert one numeric token like "12,723.00", "1.299,50" or "1299" to a Number. */
function toNumber(token) {
  const t = token.replace(/\s/g, '');
  const lastDot = t.lastIndexOf('.');
  const lastComma = t.lastIndexOf(',');
  let decimalSep = null;
  if (lastDot !== -1 && lastComma !== -1) {
    decimalSep = lastDot > lastComma ? '.' : ',';
  } else if (lastDot !== -1 || lastComma !== -1) {
    const sep = lastDot !== -1 ? '.' : ',';
    const digitsAfter = t.length - t.lastIndexOf(sep) - 1;
    const count = t.split(sep).length - 1;
    // "12,723" (3 digits after, or repeated) is a thousands separator; "12,5"/"12.50" is decimal.
    decimalSep = count === 1 && digitsAfter <= 2 ? sep : null;
  }
  if (decimalSep) {
    const thousands = decimalSep === '.' ? ',' : '.';
    return Number(t.split(thousands).join('').replace(decimalSep, '.'));
  }
  return Number(t.replace(/[.,]/g, ''));
}

/**
 * Parse displayed price text into { amount, currency }.
 * Throws (never guesses) when the text has no number, or more than one distinct number
 * (e.g. "Was 1999, now 1499"), because that is how decoy/struck-through prices look.
 */
export function parsePrice(rawText) {
  const text = cleanText(rawText);
  if (!text) throw new ScrapeError('PARSE_PRICE', 'Price element was empty');

  // No whitespace inside a number: "1999 1499" must read as TWO numbers (ambiguous), not 19991499.
  const tokens = text.match(/\d[\d.,]*\d|\d/g) ?? [];
  const values = [...new Set(tokens.map(toNumber).filter(Number.isFinite))];
  if (values.length === 0) {
    throw new ScrapeError('PARSE_PRICE', `No number found in price text "${text}"`);
  }
  if (values.length > 1) {
    throw new ScrapeError('AMBIGUOUS_PRICE', `More than one price in "${text}"`);
  }

  const amount = Math.round(values[0] * 100) / 100;
  if (!(amount > 0) || amount > 100_000_000) {
    throw new ScrapeError('IMPLAUSIBLE_PRICE', `Price ${amount} is outside the plausible range`);
  }
  const currency = CURRENCIES.find(([re]) => re.test(text))?.[1] ?? null;
  return { amount, currency };
}

/**
 * Parse stock text into { status, quantity }.
 * IMPORTANT: unknown text throws. A missing or unrecognised stock label must never be
 * recorded as "out of stock" - that would be storing a wrong value.
 */
export function parseStock(rawText) {
  const text = cleanText(rawText).toLowerCase();
  if (!text) throw new ScrapeError('PARSE_STOCK', 'Stock element was empty');

  const qty = text.match(/(\d+)\s*(?:units?|items?|pcs|left|in stock|available|remaining)/)?.[1];
  const quantity = qty != null ? Number(qty) : null;

  // Negatives first: "not in stock" contains "in stock".
  if (/(out of stock|sold out|unavailable|not in stock|not available)/.test(text)) {
    return { status: 'out_of_stock', quantity: 0 };
  }
  if (/(low stock|only\s+\d+\s+left|few left|limited stock|hurry)/.test(text)) {
    return { status: 'low_stock', quantity };
  }
  if (/(in stock|available|ready to ship|ships)/.test(text)) {
    return { status: 'in_stock', quantity };
  }
  throw new ScrapeError('PARSE_STOCK', `Unrecognised stock text "${cleanText(rawText)}"`);
}

/**
 * Independent check on the price: the page shows an MRP and an "N% off" badge, so the
 * selling price must be about MRP x (1 - N/100). If it is not, we probably picked a decoy or
 * read the digits in the wrong order, and we must not store it. Skipped when either value
 * is missing (for example a product with no discount).
 */
export function crossCheckDiscount({ price, mrpText, discountPct }) {
  if (!mrpText || discountPct == null) return;
  let mrp;
  try {
    mrp = parsePrice(mrpText).amount;
  } catch {
    return;
  }
  if (price > mrp) {
    throw new ScrapeError('PRICE_CROSSCHECK_FAILED', `Price ${price} is higher than the MRP ${mrp}`);
  }
  const implied = Math.round((1 - price / mrp) * 100);
  if (Math.abs(implied - discountPct) > 1) {
    throw new ScrapeError(
      'PRICE_CROSSCHECK_FAILED',
      `Price ${price} vs MRP ${mrp} implies ${implied}% off, but the page says ${discountPct}% off`,
    );
  }
}

import { config } from '../config.js';

export const STORE_ORIGIN = config.store.origin;

/** Throws unless `href` is on the one allowed origin. Used for every navigation. */
export function assertStoreUrl(href) {
  let url;
  try {
    url = new URL(href);
  } catch {
    throw new Error(`Blocked: not a valid URL: ${href}`);
  }
  if (url.origin !== STORE_ORIGIN) {
    throw new Error(`Blocked: ${url.origin} is not the allowed store origin`);
  }
  return url.href;
}

/**
 * The scraper only ever accepts a numeric product id, never a URL, so callers
 * (including the public API) cannot point it at another site.
 * Product pages look like https://demo.inelabteamdev.com/product/733
 */
export function productUrl(storeProductId) {
  const id = Number(storeProductId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(`Invalid product id: ${storeProductId}`);
  }
  return assertStoreUrl(new URL(`/product/${id}`, STORE_ORIGIN).href);
}

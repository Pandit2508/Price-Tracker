import { config } from './config.js';

const TTL_MS = 10 * 60 * 1000;
let cache = { at: 0, items: null };

/**
 * Convert whatever the store's "catalog" request returns into our own shape.
 *
 * TODO(verify against the real response): field names below are best guesses covering
 * the usual conventions. Open the "catalog" request in the browser Network tab,
 * compare its JSON with this function, and adjust. If the endpoint is paginated
 * (page/pageSize params), extend getCatalog() to loop over pages.
 */
export function normalizeCatalog(json) {
  const list = Array.isArray(json)
    ? json
    : (json?.items ?? json?.products ?? json?.data ?? json?.results ?? null);
  if (!Array.isArray(list)) {
    throw new Error('Unrecognised catalog format: expected an array of products');
  }
  const items = list
    .map((p) => ({
      storeProductId: Number(p.id ?? p.productId ?? p.product_id),
      name: String(p.name ?? p.title ?? '').trim(),
      brand: p.brand ?? null,
      sku: p.sku ?? null,
      category: p.category ?? null,
    }))
    .filter((p) => Number.isInteger(p.storeProductId) && p.storeProductId > 0 && p.name);
  if (list.length > 0 && items.length === 0) {
    throw new Error('Unrecognised catalog format: no product had a usable id and name');
  }
  return items;
}

async function fetchWithRetry(url, { attempts = 3, timeoutMs = 15_000 } = {}) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`Catalog responded HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 500 * 2 ** (i - 1)));
    }
  }
  throw lastErr;
}

export async function getCatalog() {
  if (cache.items && Date.now() - cache.at < TTL_MS) return cache.items;
  const json = await fetchWithRetry(config.store.catalogUrl);
  cache = { at: Date.now(), items: normalizeCatalog(json) };
  return cache.items;
}

/** Partial or full, case-insensitive match on name, brand or SKU. */
export async function searchCatalog(query, limit = 20) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const items = await getCatalog();
  return items
    .filter((p) => `${p.name} ${p.brand ?? ''} ${p.sku ?? ''}`.toLowerCase().includes(q))
    .slice(0, limit);
}

export async function findInCatalog(storeProductId) {
  const items = await getCatalog();
  return items.find((p) => p.storeProductId === storeProductId) ?? null;
}

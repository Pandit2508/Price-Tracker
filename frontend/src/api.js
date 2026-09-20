const BASE = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001/api').replace(/\/$/, '');

async function request(path, options = {}) {
  let res;
  try {
    res = await fetch(BASE + path, {
      headers: { 'content-type': 'application/json' },
      ...options,
    });
  } catch {
    throw new Error('Could not reach the server. It may still be waking up; try again in a moment.');
  }
  if (res.status === 204) return null;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

export const api = {
  products: () => request('/products').then((b) => b.products),
  search: (q) => request(`/catalog/search?q=${encodeURIComponent(q)}`).then((b) => b.results),
  track: (item) =>
    request('/products', {
      method: 'POST',
      body: JSON.stringify({ storeProductId: item.storeProductId, name: item.name }),
    }).then((b) => b.product),
  untrack: (id) => request(`/products/${id}`, { method: 'DELETE' }),
  history: (id) => request(`/products/${id}/history`).then((b) => b.history),
  logs: (id) => request(`/products/${id}/logs`).then((b) => b.logs),
  scrapeNow: (id) => request(`/products/${id}/scrape`, { method: 'POST' }),
  status: () => request('/status'),
};

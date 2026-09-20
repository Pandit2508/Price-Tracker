import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import Search from './components/Search.jsx';
import TrackedList from './components/TrackedList.jsx';
import ProductDetail from './components/ProductDetail.jsx';

export default function App() {
  const [products, setProducts] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [scraping, setScraping] = useState(false);
  const [slowLoad, setSlowLoad] = useState(false);
  const watching = useRef(false);

  const loadProducts = useCallback(async () => {
    try {
      const list = await api.products();
      setProducts(list);
      setLoadError(null);
      setSelectedId((cur) => (list.some((p) => p.id === cur) ? cur : (list[0]?.id ?? null)));
    } catch (e) {
      setLoadError(e.message);
    }
  }, []);

  useEffect(() => {
    const slow = setTimeout(() => setSlowLoad(true), 4000);
    loadProducts().finally(() => clearTimeout(slow));
    const t = setInterval(loadProducts, 60_000);
    return () => {
      clearInterval(t);
      clearTimeout(slow);
    };
  }, [loadProducts]);

  // After a scrape is started, poll the server until it finishes, then refresh everything.
  const watchScrape = useCallback(async () => {
    if (watching.current) return;
    watching.current = true;
    setScraping(true);
    try {
      await new Promise((r) => setTimeout(r, 1500));
      for (let i = 0; i < 60; i++) {
        const { running } = await api.status().catch(() => ({ running: true }));
        if (!running) break;
        await new Promise((r) => setTimeout(r, 3000));
      }
    } finally {
      watching.current = false;
      setScraping(false);
      setRefreshKey((k) => k + 1);
      loadProducts();
    }
  }, [loadProducts]);

  const selected = products?.find((p) => p.id === selectedId) ?? null;

  return (
    <div className="shell">
      <header className="topbar">
        <h1 className="brand">Price Tracker</h1>
        <Search
          trackedStoreIds={new Set((products ?? []).map((p) => p.store_product_id))}
          onTracked={async (p) => {
            await loadProducts();
            setSelectedId(p.id);
            watchScrape();
          }}
        />
      </header>

      <main className="layout">
        <aside className="rail" aria-label="Tracked products">
          {products === null && !loadError && (
            <p className="note">
              Loading tracked products…
              {slowLoad && ' The free-tier server sleeps when idle and can take up to a minute to wake up.'}
            </p>
          )}
          {loadError && (
            <div className="alert" role="alert">
              {loadError} <button className="link" onClick={loadProducts}>Try again</button>
            </div>
          )}
          {products && products.length === 0 && (
            <p className="note">Nothing tracked yet. Search for a product above and choose Track.</p>
          )}
          {products && products.length > 0 && (
            <TrackedList products={products} selectedId={selectedId} onSelect={setSelectedId} />
          )}
        </aside>

        <section className="detail" aria-live="polite">
          {selected ? (
            <ProductDetail
              key={selected.id}
              product={selected}
              refreshKey={refreshKey}
              scraping={scraping}
              onScrapeStarted={watchScrape}
              onUntracked={async () => {
                setSelectedId(null);
                await loadProducts();
              }}
            />
          ) : (
            products &&
            products.length > 0 && <p className="note">Choose a product from the list.</p>
          )}
        </section>
      </main>
    </div>
  );
}

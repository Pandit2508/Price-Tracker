import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

export default function Search({ trackedStoreIds, onTracked }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(null);
  const [error, setError] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [open, setOpen] = useState(false);
  const box = useRef(null);

  // Debounced search: wait for a pause in typing, and ignore answers that arrive out of order.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults(null);
      setError(null);
      return;
    }
    let stale = false;
    const t = setTimeout(async () => {
      try {
        const r = await api.search(q);
        if (!stale) {
          setResults(r);
          setError(null);
        }
      } catch (e) {
        if (!stale) {
          setResults(null);
          setError(e.message);
        }
      }
    }, 300);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [query]);

  useEffect(() => {
    const close = (e) => box.current && !box.current.contains(e.target) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  async function track(item) {
    setBusyId(item.storeProductId);
    setError(null);
    try {
      const product = await api.track(item);
      setOpen(false);
      setQuery('');
      await onTracked(product);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="search" ref={box}>
      <label className="sr-only" htmlFor="q">Search the store by product name</label>
      <input
        id="q"
        type="search"
        value={query}
        placeholder="Search the store, e.g. “monitor” or “Nordkraft”"
        autoComplete="off"
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
      />
      {open && query.trim().length >= 2 && (
        <div className="results" role="region" aria-label="Search results">
          {error && <p className="alert" role="alert">{error}</p>}
          {!error && results === null && <p className="note pad">Searching…</p>}
          {!error && results && results.length === 0 && (
            <p className="note pad">No products match “{query.trim()}”. Try part of the name or the brand.</p>
          )}
          {results?.map((item) => {
            const tracked = trackedStoreIds.has(item.storeProductId);
            return (
              <div className="result" key={item.storeProductId}>
                <div>
                  <div className="result-name">{item.name}</div>
                  <div className="meta">{[item.brand, item.category, item.sku].filter(Boolean).join(', ')}</div>
                </div>
                <button
                  className="btn"
                  disabled={tracked || busyId === item.storeProductId}
                  onClick={() => track(item)}
                >
                  {tracked ? 'Tracking' : busyId === item.storeProductId ? 'Adding…' : 'Track'}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { formatPrice, formatTime, STOCK_LABEL } from '../format.js';
import PriceChart from './PriceChart.jsx';
import ScrapeLog from './ScrapeLog.jsx';

export default function ProductDetail({ product, refreshKey, scraping, onScrapeStarted, onUntracked }) {
  const [history, setHistory] = useState(null);
  const [logs, setLogs] = useState(null);
  const [error, setError] = useState(null);
  const [view, setView] = useState('chart');
  const [actionError, setActionError] = useState(null);
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  const load = useCallback(async () => {
    try {
      const [h, l] = await Promise.all([api.history(product.id), api.logs(product.id)]);
      setHistory(h);
      setLogs(l);
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }, [product.id]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  async function scrapeNow() {
    setActionError(null);
    try {
      await api.scrapeNow(product.id);
      onScrapeStarted();
    } catch (e) {
      setActionError(e.message);
    }
  }

  async function remove() {
    setActionError(null);
    try {
      await api.untrack(product.id);
      await onUntracked();
    } catch (e) {
      setActionError(e.message);
    }
  }

  const latest = history?.at(-1) ?? null;
  const failedScrapes = (logs ?? []).filter((l) => l.outcome === 'failed');

  return (
    <article>
      <header className="detail-head">
        <div>
          <h2>{product.name}</h2>
          <p className="meta">{[product.brand, product.category, product.sku].filter(Boolean).join(', ')}</p>
        </div>
        <div className="actions">
          <button className="btn" onClick={scrapeNow} disabled={scraping}>
            {scraping ? 'Scraping…' : 'Scrape now'}
          </button>
          {confirmingRemove ? (
            <>
              <button className="btn danger" onClick={remove}>Confirm stop tracking</button>
              <button className="btn quiet" onClick={() => setConfirmingRemove(false)}>Cancel</button>
            </>
          ) : (
            <button className="btn quiet" onClick={() => setConfirmingRemove(true)}>Stop tracking</button>
          )}
        </div>
      </header>

      {actionError && <p className="alert" role="alert">{actionError}</p>}
      {error && <p className="alert" role="alert">{error} <button className="link" onClick={load}>Try again</button></p>}

      <section className="now" aria-label="Latest observation">
        {latest ? (
          <>
            <div className="now-price">{formatPrice(latest.price, latest.currency)}</div>
            <div className="now-side">
              <span className={`stock ${latest.stock_status}`}>{STOCK_LABEL[latest.stock_status]}</span>
              {latest.stock_quantity != null && latest.stock_status !== 'out_of_stock' && (
                <span className="meta">{latest.stock_quantity} units</span>
              )}
              <span className="meta">Last successful check {formatTime(latest.scraped_at)}</span>
            </div>
          </>
        ) : (
          <p className="note">
            {history === null
              ? 'Loading…'
              : failedScrapes.length
                ? 'No price has been recorded yet. Every scrape so far has failed; see the log below for why.'
                : 'No price recorded yet. The first scrape runs right after you start tracking.'}
          </p>
        )}
      </section>

      <section aria-label="Price history">
        <div className="section-head">
          <h3>Price and stock history</h3>
          <div className="segmented" role="tablist" aria-label="History view">
            {['chart', 'table'].map((v) => (
              <button key={v} role="tab" aria-selected={view === v} className={view === v ? 'on' : ''} onClick={() => setView(v)}>
                {v === 'chart' ? 'Chart' : 'Table'}
              </button>
            ))}
          </div>
        </div>
        {history && view === 'chart' && <PriceChart history={history} failedLogs={failedScrapes} />}
        {history && view === 'table' && <HistoryTable history={history} />}
      </section>

      <section aria-label="Scrape log">
        <h3>Scrape log</h3>
        <ScrapeLog logs={logs} />
      </section>
    </article>
  );
}

function HistoryTable({ history }) {
  if (history.length === 0) return <p className="note">No successful scrapes yet.</p>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th scope="col">Checked</th>
            <th scope="col" className="num">Price</th>
            <th scope="col">Stock</th>
          </tr>
        </thead>
        <tbody>
          {[...history].reverse().map((h) => (
            <tr key={h.id}>
              <td>{formatTime(h.scraped_at)}</td>
              <td className="num">{formatPrice(h.price, h.currency)}</td>
              <td>
                {STOCK_LABEL[h.stock_status]}
                {h.stock_quantity != null && h.stock_status !== 'out_of_stock' ? `, ${h.stock_quantity} units` : ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

import { formatDuration, formatPrice, formatTime, OUTCOME_LABEL, STOCK_LABEL } from '../format.js';

const TRIGGER_LABEL = { cron: 'Scheduled', manual: 'Manual', track: 'On tracking' };

export default function ScrapeLog({ logs }) {
  if (logs === null) return <p className="note">Loading…</p>;
  if (logs.length === 0) return <p className="note">No scrape attempts yet.</p>;

  const count = (o) => logs.filter((l) => l.outcome === o).length;

  return (
    <>
      <p className="log-summary">
        Last {logs.length} scrapes:{' '}
        <span className="tag success">{count('success')} succeeded</span>{' '}
        <span className="tag retried">{count('retried')} after retries</span>{' '}
        <span className="tag failed">{count('failed')} failed</span>
      </p>
      <ol className="ledger">
        {logs.map((l) => {
          const attempts = Array.isArray(l.attempt_details) ? l.attempt_details : [];
          const showDetails = l.outcome !== 'success' && attempts.length > 0;
          return (
            <li key={l.id} className={`entry ${l.outcome}`}>
              <div className="entry-head">
                <strong>{OUTCOME_LABEL[l.outcome]}</strong>
                <span className="meta">
                  {formatTime(l.started_at)}, {TRIGGER_LABEL[l.trigger] ?? l.trigger}, {l.attempts} {l.attempts === 1 ? 'attempt' : 'attempts'}, {formatDuration(l.duration_ms)}
                </span>
              </div>
              {l.outcome === 'failed' ? (
                <p className="entry-body">
                  <code>{l.error_code}</code> {l.error_message} Nothing was saved to the price history.
                </p>
              ) : (
                <p className="entry-body">
                  Recorded {formatPrice(l.price, null)}, {STOCK_LABEL[l.stock_status]}.
                </p>
              )}
              {showDetails && (
                <details>
                  <summary>Show each attempt</summary>
                  <ul className="attempts">
                    {attempts.map((a) => (
                      <li key={a.attempt}>
                        Attempt {a.attempt}: {a.ok ? 'worked' : <>failed with <code>{a.code}</code> {a.message}</>} ({formatDuration(a.ms)})
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </li>
          );
        })}
      </ol>
    </>
  );
}

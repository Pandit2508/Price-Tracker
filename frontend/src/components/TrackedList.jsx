import { formatPrice, OUTCOME_LABEL, timeAgo } from '../format.js';

export default function TrackedList({ products, selectedId, onSelect }) {
  return (
    <ul className="tracked">
      {products.map((p) => (
        <li key={p.id}>
          <button
            className={`tracked-item${p.id === selectedId ? ' is-selected' : ''}`}
            onClick={() => onSelect(p.id)}
            aria-current={p.id === selectedId}
          >
            <span className={`dot ${p.last_status ?? 'none'}`} title={p.last_status ? OUTCOME_LABEL[p.last_status] : 'Not scraped yet'} />
            <span className="tracked-main">
              <span className="tracked-name">{p.name}</span>
              <span className="meta">
                {p.last_scraped_at ? `Checked ${timeAgo(p.last_scraped_at)}` : 'Waiting for first scrape'}
              </span>
            </span>
            <span className="tracked-price">{p.last_price != null ? formatPrice(p.last_price, p.last_currency) : ''}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

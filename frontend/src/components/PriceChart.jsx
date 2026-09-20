import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { formatPrice, formatTime, STOCK_LABEL } from '../format.js';

const dayTick = (t) => new Date(t).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric' });

function ChartTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="tip">
      <strong>{formatPrice(d.price, d.currency)}</strong>
      <span>{STOCK_LABEL[d.stock]}</span>
      <span className="meta">{formatTime(d.t)}</span>
    </div>
  );
}

/**
 * Price is drawn as a step line (a price holds until the next observation).
 * Every FAILED scrape is a red tick on the same time axis, so a gap in the line
 * is visibly "we tried and failed", not "nothing happened".
 */
export default function PriceChart({ history, failedLogs }) {
  if (history.length === 0) {
    return <p className="note">The chart appears after the first successful scrape.</p>;
  }
  const data = history.map((h) => ({
    t: new Date(h.scraped_at).getTime(),
    price: Number(h.price),
    currency: h.currency,
    stock: h.stock_status,
  }));
  const failedTimes = failedLogs.map((l) => new Date(l.started_at).getTime());
  const all = [...data.map((d) => d.t), ...failedTimes];
  const min = Math.min(...all);
  const max = Math.max(...all);
  const span = max - min;

  // Stock strip: each observation's status holds until the next one.
  const segments = data.map((d, i) => {
    const start = d.t;
    const end = i < data.length - 1 ? data[i + 1].t : max;
    return {
      key: d.t,
      stock: d.stock,
      left: span ? ((start - min) / span) * 100 : 0,
      width: span ? Math.max(((end - start) / span) * 100, 0.6) : 100,
    };
  });

  return (
    <figure className="chart">
      <div className="chart-box">
        <ResponsiveContainer width="100%" height={260}>
          <LineChart data={data} margin={{ top: 12, right: 16, bottom: 4, left: 4 }}>
            <CartesianGrid stroke="var(--line)" vertical={false} />
            <XAxis
              dataKey="t"
              type="number"
              scale="time"
              domain={[min, span ? max : max + 3_600_000]}
              tickFormatter={dayTick}
              tick={{ fontSize: 12, fill: 'var(--muted)' }}
              tickLine={false}
              axisLine={{ stroke: 'var(--line)' }}
              minTickGap={48}
            />
            <YAxis
              domain={['auto', 'auto']}
              tick={{ fontSize: 12, fill: 'var(--muted)' }}
              tickLine={false}
              axisLine={false}
              width={64}
              tickFormatter={(v) => Number(v).toLocaleString()}
            />
            <Tooltip content={<ChartTooltip />} />
            {failedTimes.map((t, i) => (
              <ReferenceLine key={`${t}-${i}`} x={t} stroke="var(--failed)" strokeDasharray="3 3" strokeOpacity={0.7} />
            ))}
            <Line type="stepAfter" dataKey="price" stroke="var(--accent)" strokeWidth={2.5} dot={{ r: 3 }} activeDot={{ r: 5 }} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div className="strip" role="img" aria-label="Stock status over the same period">
        {segments.map((s) => (
          <span key={s.key} className={`seg ${s.stock}`} style={{ left: `${s.left}%`, width: `${s.width}%` }} title={STOCK_LABEL[s.stock]} />
        ))}
      </div>

      <figcaption className="legend">
        <span><i className="sw line" /> Price</span>
        <span><i className="sw failed" /> Failed scrape ({failedTimes.length})</span>
        <span><i className="sw in_stock" /> In stock</span>
        <span><i className="sw low_stock" /> Low stock</span>
        <span><i className="sw out_of_stock" /> Out of stock</span>
      </figcaption>
    </figure>
  );
}

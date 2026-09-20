import { createClient } from '@supabase/supabase-js';
import { config } from './config.js';

let client;
function sb() {
  if (!client) {
    if (!config.supabaseUrl || !config.supabaseServiceKey) {
      throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
    }
    client = createClient(config.supabaseUrl, config.supabaseServiceKey, {
      auth: { persistSession: false },
    });
  }
  return client;
}

/** Unwrap a supabase-js response or throw, so DB errors are never silently ignored. */
function must({ data, error }) {
  if (error) throw new Error(`Database error: ${error.message}`);
  return data;
}

export const db = {
  async listTracked({ activeOnly = false } = {}) {
    let q = sb().from('tracked_products').select('*');
    if (activeOnly) q = q.eq('active', true);
    // Stalest first, so if a run is ever cut short the most overdue products go first.
    return must(await q.order('last_scraped_at', { ascending: true, nullsFirst: true }));
  },

  async getTracked(id) {
    return must(await sb().from('tracked_products').select('*').eq('id', id).maybeSingle());
  },

  async countTracked() {
    const { count, error } = await sb().from('tracked_products').select('id', { count: 'exact', head: true });
    if (error) throw new Error(`Database error: ${error.message}`);
    return count ?? 0;
  },

  async insertTracked(row) {
    const { data, error } = await sb().from('tracked_products').insert(row).select().single();
    if (error) {
      const err = new Error(error.message);
      err.code = error.code; // '23505' = already tracked
      throw err;
    }
    return data;
  },

  async deleteTracked(id) {
    must(await sb().from('tracked_products').delete().eq('id', id));
  },

  async history(productId, limit = 500) {
    const rows = must(
      await sb()
        .from('price_history')
        .select('id, price, currency, stock_status, stock_quantity, scraped_at')
        .eq('product_id', productId)
        .order('scraped_at', { ascending: false })
        .limit(limit),
    );
    return rows.reverse(); // oldest first for charting
  },

  async logs(productId, limit = 100) {
    return must(
      await sb()
        .from('scrape_log')
        .select('*')
        .eq('product_id', productId)
        .order('started_at', { ascending: false })
        .limit(limit),
    );
  },

  /**
   * Persist the result of one scrape. Order matters:
   *  1. price_history only on ok=true (never on failure, never with empty values)
   *  2. scrape_log ALWAYS
   *  3. denormalised "latest" fields on the product
   * If step 1 fails we still write a failed log entry so the history and log agree.
   */
  async recordScrape(product, result, trigger) {
    let outcome = result.outcome;
    let error = result.error;
    const obs = result.observation;

    if (result.ok) {
      try {
        must(
          await sb().from('price_history').insert({
            product_id: product.id,
            price: obs.price,
            currency: obs.currency,
            stock_status: obs.stockStatus,
            stock_quantity: obs.stockQuantity,
            raw_price_text: obs.rawPriceText,
            raw_stock_text: obs.rawStockText,
            scraped_at: result.finishedAt.toISOString(),
          }),
        );
      } catch (e) {
        outcome = 'failed';
        error = { code: 'DB_WRITE_FAILED', message: e.message };
      }
    }

    const saved = outcome !== 'failed';
    must(
      await sb().from('scrape_log').insert({
        product_id: product.id,
        started_at: result.startedAt.toISOString(),
        finished_at: result.finishedAt.toISOString(),
        outcome,
        attempts: result.attempts.length,
        error_code: saved ? null : error?.code ?? 'UNKNOWN',
        error_message: saved ? null : error?.message ?? null,
        attempt_details: result.attempts,
        duration_ms: result.durationMs,
        trigger,
        price: saved ? obs.price : null,
        stock_status: saved ? obs.stockStatus : null,
      }),
    );

    const patch = { last_scraped_at: result.finishedAt.toISOString(), last_status: outcome };
    if (saved) {
      patch.last_price = obs.price;
      patch.last_currency = obs.currency;
      patch.last_stock = obs.stockStatus;
    }
    must(await sb().from('tracked_products').update(patch).eq('id', product.id));
    return outcome;
  },

  async startRun(trigger) {
    return must(await sb().from('scrape_runs').insert({ trigger }).select().single());
  },

  async finishRun(id, patch) {
    must(await sb().from('scrape_runs').update({ finished_at: new Date().toISOString(), ...patch }).eq('id', id));
  },

  /** A run still "running" long after it started means the process died mid-run. */
  async abandonStaleRuns(olderThanMs) {
    const cutoff = new Date(Date.now() - olderThanMs).toISOString();
    must(
      await sb()
        .from('scrape_runs')
        .update({ status: 'abandoned', finished_at: new Date().toISOString(), note: 'Process stopped before this run finished' })
        .eq('status', 'running')
        .lt('started_at', cutoff),
    );
  },
};

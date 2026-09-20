import crypto from 'node:crypto';
import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import { db } from './db.js';
import { searchCatalog, findInCatalog } from './catalog.js';
import { runAll, runOne, isRunning } from './runner.js';

const lastManual = new Map(); // productId -> timestamp, per-product cooldown

function safeEqual(a, b) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => {
    console.error(`[api] ${req.method} ${req.path}:`, e.message);
    res.status(500).json({ error: e.message });
  });

const parseId = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

export function createApp() {
  const app = express();
  app.use(express.json({ limit: '10kb' }));
  app.use(
    cors({
      origin: (origin, cb) => cb(null, !origin || config.frontendOrigins.includes(origin)),
    }),
  );

  // Cheap endpoint for "keep warm" pings and for the UI to show scrape progress.
  app.get('/api/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));
  app.get('/api/status', (_req, res) => res.json({ running: isRunning() }));

  // ---- Search the store's catalog by partial or full name -------------------
  app.get(
    '/api/catalog/search',
    wrap(async (req, res) => {
      const q = String(req.query.q ?? '').trim();
      if (q.length < 2) return res.json({ results: [] });
      try {
        res.json({ results: await searchCatalog(q) });
      } catch (e) {
        res.status(502).json({ error: `Could not load the store catalog: ${e.message}` });
      }
    }),
  );

  // ---- Tracked products -----------------------------------------------------
  app.get('/api/products', wrap(async (_req, res) => res.json({ products: await db.listTracked() })));

  app.post(
    '/api/products',
    wrap(async (req, res) => {
      const storeProductId = parseId(req.body?.storeProductId);
      if (!storeProductId) return res.status(400).json({ error: 'storeProductId must be a positive integer' });
      if ((await db.countTracked()) >= config.maxTrackedProducts) {
        return res.status(400).json({ error: `Limit of ${config.maxTrackedProducts} tracked products reached` });
      }

      // Prefer the store's own catalog record; fall back to the client's name if the catalog is down.
      let meta = null;
      try {
        meta = await findInCatalog(storeProductId);
      } catch {
        /* handled below */
      }
      const name = meta?.name ?? String(req.body?.name ?? '').trim().slice(0, 200);
      if (!name) return res.status(400).json({ error: 'Product not found in the store catalog' });

      try {
        const product = await db.insertTracked({
          store_product_id: storeProductId,
          name,
          brand: meta?.brand ?? null,
          sku: meta?.sku ?? null,
          category: meta?.category ?? null,
        });
        res.status(201).json({ product });
        runOne(product, 'track').catch(() => {}); // first data point right away; the schedule takes over after
      } catch (e) {
        if (e.code === '23505') return res.status(409).json({ error: 'Already tracking this product' });
        throw e;
      }
    }),
  );

  app.delete(
    '/api/products/:id',
    wrap(async (req, res) => {
      const id = parseId(req.params.id);
      if (!id) return res.status(400).json({ error: 'Invalid id' });
      await db.deleteTracked(id);
      res.status(204).end();
    }),
  );

  app.get(
    '/api/products/:id/history',
    wrap(async (req, res) => {
      const id = parseId(req.params.id);
      if (!id) return res.status(400).json({ error: 'Invalid id' });
      res.json({ history: await db.history(id) });
    }),
  );

  app.get(
    '/api/products/:id/logs',
    wrap(async (req, res) => {
      const id = parseId(req.params.id);
      if (!id) return res.status(400).json({ error: 'Invalid id' });
      res.json({ logs: await db.logs(id) });
    }),
  );

  // ---- Manual scrape (UI "Scrape now") --------------------------------------
  app.post(
    '/api/products/:id/scrape',
    wrap(async (req, res) => {
      const id = parseId(req.params.id);
      if (!id) return res.status(400).json({ error: 'Invalid id' });
      const product = await db.getTracked(id);
      if (!product) return res.status(404).json({ error: 'Not tracked' });
      const last = lastManual.get(id) ?? 0;
      if (Date.now() - last < config.manualScrapeCooldownMs) {
        return res.status(429).json({ error: 'Please wait a minute between manual scrapes of the same product' });
      }
      if (isRunning()) return res.status(409).json({ error: 'A scrape is already in progress' });
      lastManual.set(id, Date.now());
      res.status(202).json({ started: true });
      runOne(product, 'manual').catch(() => {});
    }),
  );

  // ---- Scheduled scrape (called by cron-job.org every 2 hours) --------------
  // Answers 202 immediately: cron-job.org times out after ~30s, but a full run takes longer.
  // The request itself wakes the sleeping free-tier instance; work continues after the reply.
  app.post(
    '/api/scrape/run',
    wrap(async (req, res) => {
      const token = (req.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
      if (!config.cronSecret || !safeEqual(token, config.cronSecret)) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      if (isRunning()) return res.status(409).json({ started: false, reason: 'already_running' });
      res.status(202).json({ started: true });
      runAll('cron').catch((e) => console.error('[cron] run crashed:', e));
    }),
  );

  return app;
}

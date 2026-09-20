-- Run this once in the Supabase SQL Editor.

create table if not exists tracked_products (
  id               bigint generated always as identity primary key,
  store_product_id integer not null unique,
  name             text not null,
  brand            text,
  sku              text,
  category         text,
  active           boolean not null default true,
  created_at       timestamptz not null default now(),
  -- denormalised "latest state" so the list view needs a single query
  last_scraped_at  timestamptz,
  last_status      text check (last_status in ('success','retried','failed')),
  last_price       numeric(12,2),
  last_currency    text,
  last_stock       text
);

-- Only successful, validated observations are ever written here.
create table if not exists price_history (
  id             bigint generated always as identity primary key,
  product_id     bigint not null references tracked_products(id) on delete cascade,
  price          numeric(12,2) not null check (price > 0),
  currency       text,
  stock_status   text not null check (stock_status in ('in_stock','low_stock','out_of_stock')),
  stock_quantity integer,
  raw_price_text text,
  raw_stock_text text,
  scraped_at     timestamptz not null default now()
);
create index if not exists price_history_product_time on price_history (product_id, scraped_at desc);

-- One row per scrape run for a product, including failures. attempt_details keeps
-- every individual try (code, message, duration) so retries are visible, not hidden.
create table if not exists scrape_log (
  id              bigint generated always as identity primary key,
  product_id      bigint not null references tracked_products(id) on delete cascade,
  started_at      timestamptz not null,
  finished_at     timestamptz not null,
  outcome         text not null check (outcome in ('success','retried','failed')),
  attempts        integer not null,
  error_code      text,
  error_message   text,
  attempt_details jsonb not null default '[]'::jsonb,
  duration_ms     integer,
  trigger         text not null default 'cron' check (trigger in ('cron','manual','track')),
  price           numeric(12,2),
  stock_status    text
);
create index if not exists scrape_log_product_time on scrape_log (product_id, started_at desc);

-- One row per scheduled run, so a run that dies half-way is visible afterwards.
create table if not exists scrape_runs (
  id          bigint generated always as identity primary key,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  trigger     text not null,
  total       integer not null default 0,
  succeeded   integer not null default 0,
  failed      integer not null default 0,
  status      text not null default 'running' check (status in ('running','finished','abandoned','error')),
  note        text
);

-- The browser never talks to Supabase directly; only the backend (service-role key) does.
-- Enabling RLS with no policies blocks the public anon key from reading or writing anything.
alter table tracked_products enable row level security;
alter table price_history    enable row level security;
alter table scrape_log       enable row level security;
alter table scrape_runs      enable row level security;

-- Let the backend's service_role key use these tables (newer Supabase projects do not grant this
-- automatically for tables created through the SQL editor). RLS stays on, so anon/public still cannot.
grant usage on schema public to service_role;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant all on sequences to service_role;

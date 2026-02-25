-- Migration 0006: BTC Price Snapshots
-- Tracks BTC/USD price for display/reporting purposes only.
-- All internal accounting remains in sats.

CREATE TABLE IF NOT EXISTS "btc_price_snapshots" (
  "id" text PRIMARY KEY NOT NULL,
  "price_usd" text NOT NULL,
  "source" text NOT NULL DEFAULT 'coingecko',
  "reason" text NOT NULL DEFAULT 'scheduled',
  "captured_at" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_btc_price_snapshots_captured" ON "btc_price_snapshots" ("captured_at");

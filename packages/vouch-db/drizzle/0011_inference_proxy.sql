-- Migration 0011: Inference Proxy
-- Per-token billing, credit system, privacy tokens, and usage metering
-- for the Engram → Vouch Gateway → Provider inference pipeline.

-- 1. Create inference-specific enums
DO $$ BEGIN
  CREATE TYPE credit_deposit_status AS ENUM ('pending', 'confirmed', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE token_batch_status AS ENUM ('active', 'exhausted', 'expired');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 2. Credit balances (one per user, keyed by Nostr npub)
CREATE TABLE IF NOT EXISTS credit_balances (
  user_npub TEXT PRIMARY KEY,
  balance_sats BIGINT NOT NULL DEFAULT 0,
  lifetime_deposited_sats BIGINT NOT NULL DEFAULT 0,
  lifetime_spent_sats BIGINT NOT NULL DEFAULT 0,
  daily_limit_sats BIGINT,
  weekly_limit_sats BIGINT,
  monthly_limit_sats BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT check_balance_non_negative CHECK (balance_sats >= 0),
  CONSTRAINT check_lifetime_deposited_non_negative CHECK (lifetime_deposited_sats >= 0),
  CONSTRAINT check_lifetime_spent_non_negative CHECK (lifetime_spent_sats >= 0)
);

-- 3. Credit deposit records (Lightning payments)
CREATE TABLE IF NOT EXISTS credit_deposits (
  id TEXT PRIMARY KEY,
  user_npub TEXT NOT NULL,
  amount_sats BIGINT NOT NULL,
  payment_hash TEXT UNIQUE,
  bolt11 TEXT,
  status credit_deposit_status NOT NULL DEFAULT 'pending',
  confirmed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT check_deposit_amount_positive CHECK (amount_sats > 0)
);
CREATE INDEX IF NOT EXISTS idx_credit_deposits_user ON credit_deposits (user_npub);
CREATE INDEX IF NOT EXISTS idx_credit_deposits_status ON credit_deposits (status) WHERE status = 'pending';

-- 4. Token batches (for private mode — prepaid anonymous inference)
CREATE TABLE IF NOT EXISTS token_batches (
  batch_hash TEXT PRIMARY KEY,
  budget_sats BIGINT NOT NULL,
  spent_sats BIGINT NOT NULL DEFAULT 0,
  token_count INTEGER NOT NULL,
  tokens_spent INTEGER NOT NULL DEFAULT 0,
  status token_batch_status NOT NULL DEFAULT 'active',
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT check_batch_budget_positive CHECK (budget_sats > 0),
  CONSTRAINT check_batch_spent_within_budget CHECK (spent_sats <= budget_sats),
  CONSTRAINT check_batch_tokens_within_count CHECK (tokens_spent <= token_count)
);

-- 5. Spent tokens (double-spend prevention for Privacy Pass tokens)
CREATE TABLE IF NOT EXISTS spent_tokens (
  token_hash TEXT PRIMARY KEY,
  batch_hash TEXT REFERENCES token_batches(batch_hash),
  cost_sats BIGINT,
  redeemed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_spent_tokens_redeemed ON spent_tokens (redeemed_at);
CREATE INDEX IF NOT EXISTS idx_spent_tokens_batch ON spent_tokens (batch_hash);

-- 6. Usage records (per-request metering from the gateway)
CREATE TABLE IF NOT EXISTS usage_records (
  id TEXT PRIMARY KEY,
  user_npub TEXT,
  batch_hash TEXT,
  model TEXT NOT NULL,
  provider TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cost_sats BIGINT NOT NULL,
  raw_cost_sats BIGINT NOT NULL,
  margin_sats BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT check_tokens_non_negative CHECK (input_tokens >= 0 AND output_tokens >= 0),
  CONSTRAINT check_cost_non_negative CHECK (cost_sats >= 0 AND raw_cost_sats >= 0),
  CONSTRAINT check_has_billing_target CHECK (user_npub IS NOT NULL OR batch_hash IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_usage_records_user ON usage_records (user_npub, created_at) WHERE user_npub IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_usage_records_batch ON usage_records (batch_hash) WHERE batch_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_usage_records_created ON usage_records (created_at);

-- 7. Model pricing (reference table for cost calculation)
CREATE TABLE IF NOT EXISTS model_pricing (
  model_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  input_cost_per_million NUMERIC NOT NULL,
  output_cost_per_million NUMERIC NOT NULL,
  pl_input_price_per_million NUMERIC NOT NULL,
  pl_output_price_per_million NUMERIC NOT NULL,
  margin_bps INTEGER NOT NULL DEFAULT 1500,
  is_active BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT check_costs_non_negative CHECK (
    input_cost_per_million >= 0 AND
    output_cost_per_million >= 0 AND
    pl_input_price_per_million >= 0 AND
    pl_output_price_per_million >= 0
  ),
  CONSTRAINT check_margin_bounds CHECK (margin_bps BETWEEN 0 AND 10000)
);

-- 8. Seed initial model pricing (illustrative, will be updated)
INSERT INTO model_pricing (model_id, provider, input_cost_per_million, output_cost_per_million, pl_input_price_per_million, pl_output_price_per_million, margin_bps)
VALUES
  ('claude-3-5-haiku-20241022', 'anthropic', 0.25, 1.25, 0.30, 1.50, 2000),
  ('claude-sonnet-4-20250514', 'anthropic', 3.00, 15.00, 3.45, 17.25, 1500),
  ('claude-opus-4-20250514', 'anthropic', 15.00, 75.00, 17.25, 86.25, 1500),
  ('gpt-4o-mini', 'openai', 0.15, 0.60, 0.18, 0.72, 2000),
  ('gpt-4o', 'openai', 2.50, 10.00, 2.88, 11.50, 1500)
ON CONFLICT (model_id) DO NOTHING;

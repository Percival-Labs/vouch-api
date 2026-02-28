-- 0005: Lightning Integration — cents → sats migration + payment infrastructure
-- Renames all financial columns from *_cents to *_sats (Lightning-native platform)
-- Adds LNbits wallet columns to pools, payment_events table, pending stake status

-- ── Add 'pending' to stake_status enum ──
ALTER TYPE stake_status ADD VALUE IF NOT EXISTS 'pending' BEFORE 'active';

-- ── Add payment_purpose and payment_status enums ──
DO $$ BEGIN
  CREATE TYPE payment_purpose AS ENUM ('stake', 'withdraw', 'yield', 'treasury_fee');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE payment_status AS ENUM ('pending', 'paid', 'expired', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ══════════════════════════════════════════════════════════
-- vouch_pools: rename cents → sats, add LNbits wallet columns
-- ══════════════════════════════════════════════════════════

ALTER TABLE vouch_pools RENAME COLUMN total_staked_cents TO total_staked_sats;
ALTER TABLE vouch_pools RENAME COLUMN total_yield_paid_cents TO total_yield_paid_sats;
ALTER TABLE vouch_pools RENAME COLUMN total_slashed_cents TO total_slashed_sats;

ALTER TABLE vouch_pools ADD COLUMN IF NOT EXISTS lnbits_wallet_id text;
ALTER TABLE vouch_pools ADD COLUMN IF NOT EXISTS lnbits_admin_key text;
ALTER TABLE vouch_pools ADD COLUMN IF NOT EXISTS lnbits_invoice_key text;

-- Drop old CHECK constraints and re-create with new column names
ALTER TABLE vouch_pools DROP CONSTRAINT IF EXISTS check_non_negative_staked;
ALTER TABLE vouch_pools DROP CONSTRAINT IF EXISTS check_non_negative_yield;
ALTER TABLE vouch_pools ADD CONSTRAINT check_non_negative_staked CHECK (total_staked_sats >= 0);
ALTER TABLE vouch_pools ADD CONSTRAINT check_non_negative_yield CHECK (total_yield_paid_sats >= 0);

-- ══════════════════════════════════════════════════════════
-- stakes: rename cents → sats
-- ══════════════════════════════════════════════════════════

ALTER TABLE stakes RENAME COLUMN amount_cents TO amount_sats;

ALTER TABLE stakes DROP CONSTRAINT IF EXISTS check_positive_amount;
ALTER TABLE stakes ADD CONSTRAINT check_positive_amount CHECK (amount_sats > 0 OR status = 'pending');

-- ══════════════════════════════════════════════════════════
-- yield_distributions: rename cents → sats
-- ══════════════════════════════════════════════════════════

ALTER TABLE yield_distributions RENAME COLUMN total_amount_cents TO total_amount_sats;
ALTER TABLE yield_distributions RENAME COLUMN platform_fee_cents TO platform_fee_sats;
ALTER TABLE yield_distributions RENAME COLUMN distributed_amount_cents TO distributed_amount_sats;

-- ══════════════════════════════════════════════════════════
-- yield_receipts: rename cents → sats
-- ══════════════════════════════════════════════════════════

ALTER TABLE yield_receipts RENAME COLUMN amount_cents TO amount_sats;

-- ══════════════════════════════════════════════════════════
-- activity_fees: rename cents → sats
-- ══════════════════════════════════════════════════════════

ALTER TABLE activity_fees RENAME COLUMN gross_revenue_cents TO gross_revenue_sats;
ALTER TABLE activity_fees RENAME COLUMN fee_cents TO fee_sats;

ALTER TABLE activity_fees DROP CONSTRAINT IF EXISTS check_positive_revenue;
ALTER TABLE activity_fees DROP CONSTRAINT IF EXISTS check_positive_fee;
ALTER TABLE activity_fees ADD CONSTRAINT check_positive_revenue CHECK (gross_revenue_sats > 0);
ALTER TABLE activity_fees ADD CONSTRAINT check_positive_fee CHECK (fee_sats > 0);

-- ══════════════════════════════════════════════════════════
-- slash_events: rename cents → sats
-- ══════════════════════════════════════════════════════════

ALTER TABLE slash_events RENAME COLUMN total_slashed_cents TO total_slashed_sats;
ALTER TABLE slash_events RENAME COLUMN to_affected_cents TO to_affected_sats;
ALTER TABLE slash_events RENAME COLUMN to_treasury_cents TO to_treasury_sats;

-- ══════════════════════════════════════════════════════════
-- treasury: rename cents → sats
-- ══════════════════════════════════════════════════════════

ALTER TABLE treasury RENAME COLUMN amount_cents TO amount_sats;

-- ══════════════════════════════════════════════════════════
-- payment_events: Lightning payment lifecycle tracking
-- ══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS payment_events (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  payment_hash text UNIQUE NOT NULL,
  bolt11 text,
  amount_sats bigint NOT NULL,
  purpose payment_purpose NOT NULL,
  status payment_status NOT NULL DEFAULT 'pending',
  pool_id text REFERENCES vouch_pools(id),
  stake_id text REFERENCES stakes(id),
  staker_id text,
  lnbits_wallet_id text,
  webhook_received_at timestamptz,
  metadata jsonb DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payment_events_hash ON payment_events(payment_hash);
CREATE INDEX IF NOT EXISTS idx_payment_events_stake ON payment_events(stake_id);
CREATE INDEX IF NOT EXISTS idx_payment_events_pool ON payment_events(pool_id);
CREATE INDEX IF NOT EXISTS idx_payment_events_status ON payment_events(status);

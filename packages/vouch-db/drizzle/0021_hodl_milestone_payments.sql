-- 0021_hodl_milestone_payments.sql
-- HODL invoice support for contract milestone payments.
-- Adds enum values for hold-lock payment flow and columns
-- for tracking funding invoices, preimages, and agent payouts.

-- ============================================================
-- 1. Enum extensions (idempotent)
-- ============================================================

DO $$ BEGIN
  ALTER TYPE payment_purpose ADD VALUE IF NOT EXISTS 'hold_lock';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TYPE payment_purpose ADD VALUE IF NOT EXISTS 'agent_payout';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TYPE payment_status ADD VALUE IF NOT EXISTS 'held';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ============================================================
-- 2. contract_milestones — HODL invoice + payout columns
-- ============================================================

ALTER TABLE contract_milestones
  ADD COLUMN IF NOT EXISTS hold_payment_hash  TEXT,
  ADD COLUMN IF NOT EXISTS hold_preimage      TEXT,
  ADD COLUMN IF NOT EXISTS agent_bolt11       TEXT,
  ADD COLUMN IF NOT EXISTS agent_payment_hash TEXT,
  ADD COLUMN IF NOT EXISTS payout_method      TEXT    DEFAULT 'lightning',
  ADD COLUMN IF NOT EXISTS fee_sats           BIGINT  DEFAULT 0,
  ADD COLUMN IF NOT EXISTS net_payout_sats    BIGINT  DEFAULT 0;

-- ============================================================
-- 3. contract_bids — payout preference
-- ============================================================

ALTER TABLE contract_bids
  ADD COLUMN IF NOT EXISTS payout_preference TEXT DEFAULT 'lightning';

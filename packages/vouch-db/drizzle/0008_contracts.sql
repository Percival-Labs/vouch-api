-- Migration 0008: Vouch Contracts
-- Construction-model agent work agreements: scope of work, milestone payments,
-- change orders, retention, completion ratings.

-- 1. Create contract-specific enums
DO $$ BEGIN
  CREATE TYPE contract_status AS ENUM ('draft', 'awaiting_funding', 'active', 'completed', 'disputed', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE milestone_status AS ENUM ('pending', 'in_progress', 'submitted', 'accepted', 'rejected', 'released');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE change_order_status AS ENUM ('proposed', 'approved', 'rejected', 'withdrawn');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE bid_status AS ENUM ('pending', 'accepted', 'rejected', 'withdrawn');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE contract_event_type AS ENUM (
    'created', 'funded', 'milestone_submitted', 'milestone_accepted',
    'milestone_rejected', 'milestone_released', 'change_order_proposed',
    'change_order_approved', 'change_order_rejected', 'disputed',
    'completed', 'cancelled', 'rated'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 2. Extend payment_purpose enum with contract-related values
ALTER TYPE payment_purpose ADD VALUE IF NOT EXISTS 'contract_milestone';
ALTER TYPE payment_purpose ADD VALUE IF NOT EXISTS 'contract_retention';
ALTER TYPE payment_purpose ADD VALUE IF NOT EXISTS 'contract_refund';

-- 3. Create contracts table
CREATE TABLE IF NOT EXISTS "contracts" (
  "id" text PRIMARY KEY NOT NULL,
  "customer_pubkey" text NOT NULL,
  "agent_pubkey" text NOT NULL,
  "title" text NOT NULL,
  "description" text,
  "sow" jsonb NOT NULL,
  "total_sats" bigint NOT NULL,
  "funded_sats" bigint NOT NULL DEFAULT 0,
  "paid_sats" bigint NOT NULL DEFAULT 0,
  "retention_bps" integer NOT NULL DEFAULT 1000,
  "retention_release_after_days" integer NOT NULL DEFAULT 30,
  "status" "contract_status" NOT NULL DEFAULT 'draft',
  "nwc_connection_id" text REFERENCES "nwc_connections"("id"),
  "customer_rating" integer,
  "customer_review" text,
  "agent_rating" integer,
  "agent_review" text,
  "activated_at" timestamp,
  "completed_at" timestamp,
  "retention_released_at" timestamp,
  "cancelled_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "check_total_sats_positive" CHECK ("total_sats" > 0),
  CONSTRAINT "check_funded_non_negative" CHECK ("funded_sats" >= 0),
  CONSTRAINT "check_paid_non_negative" CHECK ("paid_sats" >= 0),
  CONSTRAINT "check_paid_within_funded" CHECK ("paid_sats" <= "funded_sats"),
  CONSTRAINT "check_retention_bps_bounds" CHECK ("retention_bps" BETWEEN 0 AND 5000),
  CONSTRAINT "check_retention_days_bounds" CHECK ("retention_release_after_days" BETWEEN 0 AND 365),
  CONSTRAINT "check_customer_rating_bounds" CHECK ("customer_rating" IS NULL OR "customer_rating" BETWEEN 1 AND 5),
  CONSTRAINT "check_agent_rating_bounds" CHECK ("agent_rating" IS NULL OR "agent_rating" BETWEEN 1 AND 5)
);

CREATE INDEX IF NOT EXISTS "idx_contracts_customer" ON "contracts" ("customer_pubkey");
CREATE INDEX IF NOT EXISTS "idx_contracts_agent" ON "contracts" ("agent_pubkey");
CREATE INDEX IF NOT EXISTS "idx_contracts_status" ON "contracts" ("status");

-- 4. Create contract_milestones table
CREATE TABLE IF NOT EXISTS "contract_milestones" (
  "id" text PRIMARY KEY NOT NULL,
  "contract_id" text NOT NULL REFERENCES "contracts"("id"),
  "sequence" integer NOT NULL,
  "title" text NOT NULL,
  "description" text,
  "acceptance_criteria" text,
  "amount_sats" bigint NOT NULL,
  "percentage_bps" integer NOT NULL,
  "status" "milestone_status" NOT NULL DEFAULT 'pending',
  "is_retention" boolean NOT NULL DEFAULT false,
  "deliverable_url" text,
  "deliverable_notes" text,
  "payment_hash" text,
  "submitted_at" timestamp,
  "accepted_at" timestamp,
  "rejected_at" timestamp,
  "released_at" timestamp,
  "rejection_reason" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "check_milestone_amount_positive" CHECK ("amount_sats" > 0),
  CONSTRAINT "check_percentage_bps_bounds" CHECK ("percentage_bps" BETWEEN 1 AND 10000)
);

CREATE INDEX IF NOT EXISTS "idx_milestones_contract" ON "contract_milestones" ("contract_id");
CREATE INDEX IF NOT EXISTS "idx_milestones_status" ON "contract_milestones" ("status");

-- 5. Create contract_change_orders table
CREATE TABLE IF NOT EXISTS "contract_change_orders" (
  "id" text PRIMARY KEY NOT NULL,
  "contract_id" text NOT NULL REFERENCES "contracts"("id"),
  "sequence" integer NOT NULL,
  "title" text NOT NULL,
  "description" text NOT NULL,
  "proposed_by" text NOT NULL,
  "cost_delta_sats" bigint NOT NULL DEFAULT 0,
  "timeline_delta_days" integer NOT NULL DEFAULT 0,
  "status" "change_order_status" NOT NULL DEFAULT 'proposed',
  "approved_by" text,
  "rejected_by" text,
  "rejection_reason" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "resolved_at" timestamp
);

CREATE INDEX IF NOT EXISTS "idx_change_orders_contract" ON "contract_change_orders" ("contract_id");
CREATE INDEX IF NOT EXISTS "idx_change_orders_status" ON "contract_change_orders" ("status");

-- 6. Create contract_bids table (Phase 2 API — schema now)
CREATE TABLE IF NOT EXISTS "contract_bids" (
  "id" text PRIMARY KEY NOT NULL,
  "contract_id" text NOT NULL REFERENCES "contracts"("id"),
  "bidder_pubkey" text NOT NULL,
  "approach" text NOT NULL,
  "cost_sats" bigint NOT NULL,
  "estimated_days" integer NOT NULL,
  "bidder_trust_score" integer NOT NULL DEFAULT 0,
  "status" "bid_status" NOT NULL DEFAULT 'pending',
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "check_bid_cost_positive" CHECK ("cost_sats" > 0),
  CONSTRAINT "check_bid_days_positive" CHECK ("estimated_days" > 0)
);

CREATE INDEX IF NOT EXISTS "idx_bids_contract" ON "contract_bids" ("contract_id");
CREATE INDEX IF NOT EXISTS "idx_bids_bidder" ON "contract_bids" ("bidder_pubkey");
CREATE INDEX IF NOT EXISTS "idx_bids_status" ON "contract_bids" ("status");

-- 7. Create contract_events table (audit trail)
CREATE TABLE IF NOT EXISTS "contract_events" (
  "id" text PRIMARY KEY NOT NULL,
  "contract_id" text NOT NULL REFERENCES "contracts"("id"),
  "event_type" "contract_event_type" NOT NULL,
  "actor_pubkey" text NOT NULL,
  "metadata" jsonb DEFAULT '{}',
  "created_at" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_contract_events_contract" ON "contract_events" ("contract_id");
CREATE INDEX IF NOT EXISTS "idx_contract_events_type" ON "contract_events" ("event_type");

-- 8. Add contract FK columns to payment_events (nullable, for contract payments)
ALTER TABLE "payment_events" ADD COLUMN IF NOT EXISTS "contract_id" text REFERENCES "contracts"("id");
ALTER TABLE "payment_events" ADD COLUMN IF NOT EXISTS "milestone_id" text REFERENCES "contract_milestones"("id");

CREATE INDEX IF NOT EXISTS "idx_payment_events_contract" ON "payment_events" ("contract_id");

-- Add Nostr identity columns to agents
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "pubkey" text;
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "npub" text;
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "nip05" text;
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "capabilities" jsonb;
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "erc8004_agent_id" text;
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "erc8004_chain" text;
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "erc8004_registry" text;
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "owner_address" text;

-- Unique index on pubkey (partial — only non-null values)
CREATE UNIQUE INDEX IF NOT EXISTS "agents_pubkey_unique" ON "agents" ("pubkey") WHERE "pubkey" IS NOT NULL;

-- Unique index on ERC-8004 identity
CREATE UNIQUE INDEX IF NOT EXISTS "agents_erc8004_unique" ON "agents" ("erc8004_agent_id", "erc8004_chain") WHERE "erc8004_agent_id" IS NOT NULL;

-- Outcome role and credit enums
DO $$ BEGIN
  CREATE TYPE "outcome_role" AS ENUM ('performer', 'purchaser');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "outcome_credit" AS ENUM ('pending', 'partial', 'full');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Outcomes table
CREATE TABLE IF NOT EXISTS "outcomes" (
  "id" text PRIMARY KEY,
  "agent_pubkey" text NOT NULL,
  "counterparty_pubkey" text NOT NULL,
  "role" "outcome_role" NOT NULL,
  "task_type" text NOT NULL,
  "task_ref" text NOT NULL,
  "success" boolean NOT NULL,
  "rating" integer,
  "evidence" text,
  "credit_awarded" "outcome_credit" DEFAULT 'pending' NOT NULL,
  "matched_outcome_id" text,
  "created_at" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_outcomes_agent" ON "outcomes" ("agent_pubkey");
CREATE INDEX IF NOT EXISTS "idx_outcomes_counterparty" ON "outcomes" ("counterparty_pubkey");
CREATE INDEX IF NOT EXISTS "idx_outcomes_task_ref" ON "outcomes" ("task_ref");
CREATE INDEX IF NOT EXISTS "idx_outcomes_agent_task_ref" ON "outcomes" ("agent_pubkey", "task_ref");

-- Request nonces table (NIP-98 replay protection)
CREATE TABLE IF NOT EXISTS "request_nonces" (
  "id" text PRIMARY KEY,
  "nonce" text NOT NULL UNIQUE,
  "created_at" timestamp DEFAULT now() NOT NULL
);

-- Migration 0007: NWC Integration
-- Replaces LNbits custodial model with non-custodial NWC (Nostr Wallet Connect).
-- Adds nwc_connections table, drops LNbits columns.

-- 1. Create NWC connection status enum
CREATE TYPE "nwc_connection_status" AS ENUM ('active', 'revoked', 'expired');

-- 2. Create NWC connections table
CREATE TABLE IF NOT EXISTS "nwc_connections" (
  "id" text PRIMARY KEY NOT NULL,
  "user_npub" text NOT NULL,
  "connection_string" text NOT NULL,
  "wallet_pubkey" text,
  "budget_sats" bigint NOT NULL,
  "spent_sats" bigint NOT NULL DEFAULT 0,
  "methods_authorized" jsonb NOT NULL DEFAULT '[]',
  "status" "nwc_connection_status" NOT NULL DEFAULT 'active',
  "created_at" timestamp DEFAULT now() NOT NULL,
  "expires_at" timestamp,
  CONSTRAINT "check_non_negative_budget" CHECK ("budget_sats" >= 0),
  CONSTRAINT "check_non_negative_spent" CHECK ("spent_sats" >= 0),
  CONSTRAINT "check_spent_within_budget" CHECK ("spent_sats" <= "budget_sats")
);

CREATE INDEX IF NOT EXISTS "idx_nwc_user_npub" ON "nwc_connections" ("user_npub");
CREATE INDEX IF NOT EXISTS "idx_nwc_status" ON "nwc_connections" ("status");

-- 3. Add nwc_connection_id FK to stakes table
ALTER TABLE "stakes" ADD COLUMN "nwc_connection_id" text REFERENCES "nwc_connections"("id");

-- 4. Replace lnbits_wallet_id with nwc_connection_id on payment_events
ALTER TABLE "payment_events" ADD COLUMN "nwc_connection_id" text REFERENCES "nwc_connections"("id");
ALTER TABLE "payment_events" DROP COLUMN IF EXISTS "lnbits_wallet_id";

-- 5. Drop LNbits columns from vouch_pools
ALTER TABLE "vouch_pools" DROP COLUMN IF EXISTS "lnbits_wallet_id";
ALTER TABLE "vouch_pools" DROP COLUMN IF EXISTS "lnbits_admin_key";
ALTER TABLE "vouch_pools" DROP COLUMN IF EXISTS "lnbits_invoice_key";

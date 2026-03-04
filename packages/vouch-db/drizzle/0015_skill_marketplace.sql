-- Migration 0015: Skill Marketplace
-- Agent skill commerce: purchasable capabilities with creator royalties,
-- community staking, and purchase tracking for the compound capability flywheel.

-- 1. Create skill-specific enum
DO $$ BEGIN
  CREATE TYPE skill_status AS ENUM ('active', 'suspended', 'delisted');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 2. Create skills table
CREATE TABLE IF NOT EXISTS "skills" (
  "id" text PRIMARY KEY NOT NULL,
  "creator_pubkey" text NOT NULL,
  "name" text NOT NULL,
  "slug" text NOT NULL UNIQUE,
  "description" text NOT NULL,
  "version" text NOT NULL DEFAULT '1.0.0',
  "price_sats" integer NOT NULL,
  "royalty_rate_bps" integer NOT NULL DEFAULT 1000,
  "creator_stake_sats" integer NOT NULL DEFAULT 0,
  "community_stake_sats" integer NOT NULL DEFAULT 0,
  "purchase_count" integer NOT NULL DEFAULT 0,
  "avg_rating" real,
  "rating_count" integer NOT NULL DEFAULT 0,
  "tags" jsonb NOT NULL DEFAULT '[]',
  "status" "skill_status" NOT NULL DEFAULT 'active',
  "content_hash" text,
  "source_url" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "check_price_sats_positive" CHECK ("price_sats" > 0),
  CONSTRAINT "check_royalty_rate_bps_bounds" CHECK ("royalty_rate_bps" BETWEEN 0 AND 5000),
  CONSTRAINT "check_creator_stake_non_negative" CHECK ("creator_stake_sats" >= 0),
  CONSTRAINT "check_community_stake_non_negative" CHECK ("community_stake_sats" >= 0),
  CONSTRAINT "check_purchase_count_non_negative" CHECK ("purchase_count" >= 0),
  CONSTRAINT "check_avg_rating_bounds" CHECK ("avg_rating" IS NULL OR "avg_rating" BETWEEN 1.0 AND 5.0),
  CONSTRAINT "check_rating_count_non_negative" CHECK ("rating_count" >= 0)
);

CREATE INDEX IF NOT EXISTS "idx_skills_slug" ON "skills" ("slug");
CREATE INDEX IF NOT EXISTS "idx_skills_creator" ON "skills" ("creator_pubkey");
CREATE INDEX IF NOT EXISTS "idx_skills_status" ON "skills" ("status");
CREATE INDEX IF NOT EXISTS "idx_skills_tags" ON "skills" USING gin ("tags");

-- 3. Create skill_purchases table
CREATE TABLE IF NOT EXISTS "skill_purchases" (
  "id" text PRIMARY KEY NOT NULL,
  "skill_id" text NOT NULL REFERENCES "skills"("id"),
  "buyer_pubkey" text NOT NULL,
  "price_paid_sats" integer NOT NULL,
  "payment_hash" text,
  "rating" integer,
  "rated_at" timestamp,
  "contracts_using_skill" integer NOT NULL DEFAULT 0,
  "revenue_from_skill_sats" integer NOT NULL DEFAULT 0,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "check_price_paid_positive" CHECK ("price_paid_sats" > 0),
  CONSTRAINT "check_rating_bounds" CHECK ("rating" IS NULL OR "rating" BETWEEN 1 AND 5),
  CONSTRAINT "check_contracts_using_non_negative" CHECK ("contracts_using_skill" >= 0),
  CONSTRAINT "check_revenue_non_negative" CHECK ("revenue_from_skill_sats" >= 0)
);

CREATE INDEX IF NOT EXISTS "idx_skill_purchases_skill" ON "skill_purchases" ("skill_id");
CREATE INDEX IF NOT EXISTS "idx_skill_purchases_buyer" ON "skill_purchases" ("buyer_pubkey");

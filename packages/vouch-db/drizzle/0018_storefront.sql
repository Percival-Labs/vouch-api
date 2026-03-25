-- Migration 0018: Storefront
-- Digital asset marketplace: NIP-99 compatible listings for STL files, SVGs,
-- GCode, digital art, ebooks, and other assets. Lightning-native purchases
-- with download token gating and trust-score-compounding ratings.

-- 1. Create storefront enums
DO $$ BEGIN
  CREATE TYPE storefront_status AS ENUM ('active', 'suspended', 'closed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE listing_status AS ENUM ('active', 'delisted', 'suspended');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE storefront_event_type AS ENUM (
    'listing_created', 'listing_updated', 'listing_delisted',
    'purchase_completed', 'purchase_refunded', 'rating_submitted',
    'storefront_created', 'storefront_updated'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 2. Add asset_purchase to payment_purpose enum
ALTER TYPE "payment_purpose" ADD VALUE IF NOT EXISTS 'asset_purchase';

-- 3. Create storefronts table
CREATE TABLE IF NOT EXISTS "storefronts" (
  "id" text PRIMARY KEY NOT NULL,
  "owner_pubkey" text NOT NULL,
  "name" text NOT NULL,
  "slug" text NOT NULL UNIQUE,
  "description" text,
  "logo_url" text,
  "banner_url" text,
  "relay_urls" jsonb NOT NULL DEFAULT '["wss://relay.damus.io"]',
  "settings" jsonb NOT NULL DEFAULT '{}',
  "status" "storefront_status" NOT NULL DEFAULT 'active',
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_storefronts_owner" ON "storefronts" ("owner_pubkey");
CREATE INDEX IF NOT EXISTS "idx_storefronts_slug" ON "storefronts" ("slug");
CREATE INDEX IF NOT EXISTS "idx_storefronts_status" ON "storefronts" ("status");

-- 4. Create asset_listings table
CREATE TABLE IF NOT EXISTS "asset_listings" (
  "id" text PRIMARY KEY NOT NULL,
  "storefront_id" text NOT NULL REFERENCES "storefronts"("id"),
  "creator_pubkey" text NOT NULL,
  "nostr_event_id" text,
  "title" text NOT NULL,
  "slug" text NOT NULL,
  "description" text NOT NULL,
  "price_sats" integer NOT NULL,
  "price_usd_cents" integer,
  "currency" text NOT NULL DEFAULT 'sats',
  "category" text NOT NULL,
  "file_hash" text NOT NULL,
  "file_url" text NOT NULL,
  "file_size_bytes" bigint,
  "preview_urls" jsonb NOT NULL DEFAULT '[]',
  "metadata" jsonb NOT NULL DEFAULT '{}',
  "tags" jsonb NOT NULL DEFAULT '[]',
  "purchase_count" integer NOT NULL DEFAULT 0,
  "avg_rating" real,
  "rating_count" integer NOT NULL DEFAULT 0,
  "status" "listing_status" NOT NULL DEFAULT 'active',
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "check_listing_price_positive" CHECK ("price_sats" > 0)
);

CREATE INDEX IF NOT EXISTS "idx_listings_storefront" ON "asset_listings" ("storefront_id");
CREATE INDEX IF NOT EXISTS "idx_listings_creator" ON "asset_listings" ("creator_pubkey");
CREATE INDEX IF NOT EXISTS "idx_listings_category" ON "asset_listings" ("category");
CREATE INDEX IF NOT EXISTS "idx_listings_status" ON "asset_listings" ("status");
CREATE INDEX IF NOT EXISTS "idx_listings_tags" ON "asset_listings" USING gin ("tags");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_listing_storefront_slug" ON "asset_listings" ("storefront_id", "slug");

-- 5. Create asset_purchases table
CREATE TABLE IF NOT EXISTS "asset_purchases" (
  "id" text PRIMARY KEY NOT NULL,
  "listing_id" text NOT NULL REFERENCES "asset_listings"("id"),
  "buyer_pubkey" text NOT NULL,
  "price_paid_sats" integer NOT NULL,
  "payment_method" text NOT NULL,
  "payment_hash" text UNIQUE,
  "strike_payment_id" text,
  "download_token" text,
  "download_count" integer NOT NULL DEFAULT 0,
  "max_downloads" integer NOT NULL DEFAULT 5,
  "rating" integer,
  "rated_at" timestamp,
  "expires_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "check_purchase_price_positive" CHECK ("price_paid_sats" > 0),
  CONSTRAINT "check_rating_bounds" CHECK ("rating" IS NULL OR "rating" BETWEEN 1 AND 5),
  CONSTRAINT "check_download_count_non_negative" CHECK ("download_count" >= 0),
  CONSTRAINT "check_max_downloads_positive" CHECK ("max_downloads" > 0)
);

CREATE INDEX IF NOT EXISTS "idx_purchases_listing" ON "asset_purchases" ("listing_id");
CREATE INDEX IF NOT EXISTS "idx_purchases_buyer" ON "asset_purchases" ("buyer_pubkey");
CREATE INDEX IF NOT EXISTS "idx_purchases_payment_hash" ON "asset_purchases" ("payment_hash");

-- 6. Create storefront_events table (audit trail)
CREATE TABLE IF NOT EXISTS "storefront_events" (
  "id" text PRIMARY KEY NOT NULL,
  "storefront_id" text NOT NULL REFERENCES "storefronts"("id"),
  "event_type" "storefront_event_type" NOT NULL,
  "actor_pubkey" text NOT NULL,
  "metadata" jsonb NOT NULL DEFAULT '{}',
  "created_at" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_storefront_events_storefront" ON "storefront_events" ("storefront_id");
CREATE INDEX IF NOT EXISTS "idx_storefront_events_type" ON "storefront_events" ("event_type");

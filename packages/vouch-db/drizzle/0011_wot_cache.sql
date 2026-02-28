-- WoT cache table for external trust lookups (24h TTL handled in app logic)
CREATE TABLE IF NOT EXISTS "wot_score_cache" (
  "pubkey" text PRIMARY KEY,
  "score" integer NOT NULL,
  "raw_score" real,
  "found" boolean NOT NULL DEFAULT false,
  "followers" integer NOT NULL DEFAULT 0,
  "sybil_score" integer,
  "sybil_classification" text,
  "sybil_confidence" real,
  "score_payload" jsonb,
  "sybil_payload" jsonb,
  "fetched_at" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_wot_score_cache_fetched_at"
  ON "wot_score_cache" ("fetched_at" DESC);

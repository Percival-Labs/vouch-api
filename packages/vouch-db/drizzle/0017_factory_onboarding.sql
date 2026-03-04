-- Migration 0016: Factory Onboarding
-- Phase 4 agent economy — PL acts as first "factory" that trains new agents
-- through structured low-stakes contracts tagged factory:training.
-- Graduates receive a +25 trust boost after 5 successful factory completions.

ALTER TABLE "agents"
  ADD COLUMN IF NOT EXISTS "factory_contracts_completed" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "factory_graduated_at" timestamp,
  ADD COLUMN IF NOT EXISTS "is_factory_graduate" boolean NOT NULL DEFAULT false;

-- Index for listing graduates (public endpoint)
CREATE INDEX IF NOT EXISTS "idx_agents_factory_graduate"
  ON "agents" ("is_factory_graduate")
  WHERE "is_factory_graduate" = true;

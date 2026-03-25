-- 0023: Stripe trust integration tables for Vouch for Stripe app.
-- Adds: stripe_installations, stripe_agent_links, stripe_assessments, stripe_outcomes.

CREATE TABLE IF NOT EXISTS stripe_installations (
  id              TEXT PRIMARY KEY,
  stripe_account_id TEXT NOT NULL UNIQUE,
  app_user_id     TEXT,
  tier            TEXT NOT NULL DEFAULT 'free',
  settings        JSONB NOT NULL DEFAULT '{}',
  installed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  uninstalled_at  TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS stripe_agent_links (
  id              TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES stripe_installations(id),
  stripe_customer_id TEXT NOT NULL,
  vouch_agent_id  TEXT NOT NULL,
  label           TEXT,
  linked_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  unlinked_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(installation_id, stripe_customer_id)
);

CREATE INDEX IF NOT EXISTS idx_stripe_agent_links_agent ON stripe_agent_links(vouch_agent_id);
CREATE INDEX IF NOT EXISTS idx_stripe_agent_links_customer ON stripe_agent_links(stripe_customer_id);

CREATE TABLE IF NOT EXISTS stripe_assessments (
  id              TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES stripe_installations(id),
  payment_intent_id TEXT NOT NULL,
  vouch_agent_id  TEXT NOT NULL,
  composite_score INTEGER,
  tier            TEXT,
  domain          TEXT NOT NULL DEFAULT 'financial',
  threshold       INTEGER NOT NULL DEFAULT 400,
  threshold_met   BOOLEAN,
  recommendation  TEXT NOT NULL DEFAULT 'proceed',
  amount_cents    INTEGER,
  currency        TEXT,
  assessed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stripe_assessments_pi ON stripe_assessments(payment_intent_id);
CREATE INDEX IF NOT EXISTS idx_stripe_assessments_agent ON stripe_assessments(vouch_agent_id);
CREATE INDEX IF NOT EXISTS idx_stripe_assessments_date ON stripe_assessments(assessed_at);

CREATE TABLE IF NOT EXISTS stripe_outcomes (
  id              TEXT PRIMARY KEY,
  assessment_id   TEXT REFERENCES stripe_assessments(id),
  installation_id TEXT NOT NULL REFERENCES stripe_installations(id),
  payment_intent_id TEXT NOT NULL,
  vouch_agent_id  TEXT NOT NULL,
  score_at_time   INTEGER,
  outcome         TEXT NOT NULL,
  dispute_reason  TEXT,
  dispute_amount_cents INTEGER,
  refund_amount_cents INTEGER,
  stripe_event_id TEXT UNIQUE,
  trust_event_emitted BOOLEAN NOT NULL DEFAULT FALSE,
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stripe_outcomes_agent ON stripe_outcomes(vouch_agent_id);
CREATE INDEX IF NOT EXISTS idx_stripe_outcomes_date ON stripe_outcomes(occurred_at);
CREATE INDEX IF NOT EXISTS idx_stripe_outcomes_outcome ON stripe_outcomes(outcome);

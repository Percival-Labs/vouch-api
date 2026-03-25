-- ACP Checkout Sessions — Stripe Agent Commerce Protocol seller checkout flow.
-- Tracks checkout lifecycle from creation through payment and AgentKey provisioning.

-- Enum for checkout status
DO $$ BEGIN
  CREATE TYPE acp_checkout_status AS ENUM ('pending', 'processing', 'completed', 'cancelled', 'expired');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Checkout sessions table
CREATE TABLE IF NOT EXISTS acp_checkout_sessions (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  buyer_address TEXT NOT NULL,
  status acp_checkout_status NOT NULL DEFAULT 'pending',
  price_usdc_cents INTEGER NOT NULL,
  payment_token TEXT,
  stripe_payment_intent_id TEXT,
  provisioned_agent_key TEXT,
  provisioned_agent_id TEXT,
  metadata JSONB,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMP NOT NULL
);

CREATE INDEX IF NOT EXISTS acp_checkout_buyer ON acp_checkout_sessions (buyer_address);
CREATE INDEX IF NOT EXISTS acp_checkout_status ON acp_checkout_sessions (status);
CREATE INDEX IF NOT EXISTS acp_checkout_product ON acp_checkout_sessions (product_id);
CREATE INDEX IF NOT EXISTS acp_checkout_stripe_pi ON acp_checkout_sessions (stripe_payment_intent_id);

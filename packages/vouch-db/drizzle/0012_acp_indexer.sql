-- Virtuals Protocol ACP on-chain indexer tables
-- Stores job lifecycle events, memo events, and computed agent trust scores
-- from Base L2 (chain ID 8453). All data from public blockchain — no registration required.

-- Enums
DO $$ BEGIN
  CREATE TYPE acp_job_phase AS ENUM ('request', 'negotiation', 'transaction', 'evaluation', 'completed', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE acp_memo_type AS ENUM ('request', 'negotiation', 'transaction', 'deliverable', 'evaluation', 'general');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Indexer cursor (tracks sync progress per chain)
CREATE TABLE IF NOT EXISTS acp_indexer_cursor (
  chain_id TEXT PRIMARY KEY,
  last_block INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- ACP Jobs (one row per on-chain job)
CREATE TABLE IF NOT EXISTS acp_jobs (
  id TEXT PRIMARY KEY,
  on_chain_job_id INTEGER NOT NULL,
  account_id INTEGER,
  client_address TEXT NOT NULL,
  provider_address TEXT NOT NULL,
  evaluator_address TEXT,
  budget_usdc NUMERIC(20,6) DEFAULT '0',
  payment_token TEXT,
  phase acp_job_phase NOT NULL DEFAULT 'request',
  is_x402 BOOLEAN DEFAULT FALSE,
  created_block INTEGER NOT NULL,
  created_tx TEXT NOT NULL,
  completed_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS acp_jobs_on_chain_id ON acp_jobs (on_chain_job_id);
CREATE INDEX IF NOT EXISTS acp_jobs_client ON acp_jobs (client_address);
CREATE INDEX IF NOT EXISTS acp_jobs_provider ON acp_jobs (provider_address);
CREATE INDEX IF NOT EXISTS acp_jobs_phase ON acp_jobs (phase);

-- ACP Memos (deliverables, approvals, payments)
CREATE TABLE IF NOT EXISTS acp_memos (
  id TEXT PRIMARY KEY,
  on_chain_memo_id INTEGER NOT NULL,
  on_chain_job_id INTEGER NOT NULL,
  sender_address TEXT NOT NULL,
  memo_type acp_memo_type,
  approved BOOLEAN,
  reason TEXT,
  amount_usdc NUMERIC(20,6),
  block_number INTEGER NOT NULL,
  tx_hash TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS acp_memos_on_chain_id ON acp_memos (on_chain_memo_id, tx_hash);
CREATE INDEX IF NOT EXISTS acp_memos_job ON acp_memos (on_chain_job_id);
CREATE INDEX IF NOT EXISTS acp_memos_sender ON acp_memos (sender_address);

-- ACP Agent Stats (materialized aggregates, recomputed on events)
CREATE TABLE IF NOT EXISTS acp_agent_stats (
  address TEXT PRIMARY KEY,
  total_jobs_client INTEGER NOT NULL DEFAULT 0,
  total_jobs_provider INTEGER NOT NULL DEFAULT 0,
  total_jobs_evaluator INTEGER NOT NULL DEFAULT 0,
  completed_as_provider INTEGER NOT NULL DEFAULT 0,
  failed_as_provider INTEGER NOT NULL DEFAULT 0,
  total_earned_usdc NUMERIC(20,6) NOT NULL DEFAULT '0',
  total_spent_usdc NUMERIC(20,6) NOT NULL DEFAULT '0',
  unique_clients INTEGER NOT NULL DEFAULT 0,
  unique_providers INTEGER NOT NULL DEFAULT 0,
  first_seen_at TIMESTAMP,
  last_active_at TIMESTAMP,
  acp_trust_score INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

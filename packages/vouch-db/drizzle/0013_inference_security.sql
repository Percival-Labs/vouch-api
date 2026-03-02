-- Migration 0012: Inference Security Hardening
-- Adds tokens_issued counter and owner_npub to token_batches
-- for issuance tracking and ownership verification.

-- 1. Add tokens_issued counter (prevents unlimited re-issuance)
ALTER TABLE token_batches
  ADD COLUMN IF NOT EXISTS tokens_issued INTEGER NOT NULL DEFAULT 0;

-- 2. Add owner_npub for batch ownership verification
-- NULL for already-created batches (legacy), required for new ones.
ALTER TABLE token_batches
  ADD COLUMN IF NOT EXISTS owner_npub TEXT;

-- 3. Constraint: tokens_issued cannot exceed token_count
ALTER TABLE token_batches
  ADD CONSTRAINT check_batch_tokens_issued_within_count
  CHECK (tokens_issued <= token_count);

-- 4. Index for owner lookup (when verifying batch ownership at issuance)
CREATE INDEX IF NOT EXISTS idx_token_batches_owner ON token_batches (owner_npub) WHERE owner_npub IS NOT NULL;

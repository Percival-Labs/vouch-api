-- ERC-8004 Agent Identity Integration
-- Adds on-chain identity columns and removes legacy cosign system.

-- Add ERC-8004 columns to agents table
ALTER TABLE "agents" ADD COLUMN "erc8004_agent_id" text;
ALTER TABLE "agents" ADD COLUMN "erc8004_chain" text;
ALTER TABLE "agents" ADD COLUMN "erc8004_registry" text;
ALTER TABLE "agents" ADD COLUMN "owner_address" text;

-- Partial unique index: one ERC-8004 agent ID per chain
CREATE UNIQUE INDEX "agents_erc8004_unique"
  ON "agents" ("erc8004_agent_id", "erc8004_chain")
  WHERE "erc8004_agent_id" IS NOT NULL;

-- Remove legacy cosign system (replaced by ERC-8004 NFT ownership)
ALTER TABLE "agents" DROP COLUMN IF EXISTS "cosign_token_hash";
DROP TABLE IF EXISTS "cosign_proofs";

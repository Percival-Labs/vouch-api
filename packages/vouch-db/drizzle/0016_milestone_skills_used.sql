-- Migration: Add skills_used column to contract_milestones
-- Stores the skill IDs an agent used to complete a milestone,
-- enabling royalty distribution to skill creators on payment release.

ALTER TABLE "contract_milestones"
  ADD COLUMN "skills_used" jsonb DEFAULT '[]'::jsonb;

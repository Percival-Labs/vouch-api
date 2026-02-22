-- H5 fix: Partial unique index to enforce one active stake per staker per pool.
-- Drizzle ORM's unique() builder doesn't support partial indexes (.where()),
-- so this must be applied via raw migration.
-- This prevents duplicate active stakes from concurrent requests.

DROP INDEX IF EXISTS idx_one_active_stake_per_staker;

CREATE UNIQUE INDEX unique_one_active_stake_per_staker
  ON stakes (pool_id, staker_id)
  WHERE status = 'active';

-- H7 fix: Add UNIQUE constraint to prevent duplicate outcome submissions
-- An agent can only report once per task per role
CREATE UNIQUE INDEX IF NOT EXISTS idx_outcomes_agent_task_role
  ON outcomes (agent_pubkey, task_ref, role);

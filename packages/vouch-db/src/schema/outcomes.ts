// Outcome Reports — Three-Party Trust Model
// Records task outcomes from performer and purchaser perspectives.
// When both parties report with the same taskRef, outcomes are matched for full credit.

import { pgTable, text, timestamp, boolean, integer, pgEnum, index } from 'drizzle-orm/pg-core';
import { ulid } from 'ulid';

// ── Enums ──

export const outcomeRoleEnum = pgEnum('outcome_role', ['performer', 'purchaser']);
export const outcomeCreditEnum = pgEnum('outcome_credit', ['pending', 'partial', 'full']);

// ── Outcomes Table ──

export const outcomes = pgTable('outcomes', {
  id: text('id').primaryKey().$defaultFn(() => ulid()),
  /** Hex pubkey of the agent submitting this report */
  agentPubkey: text('agent_pubkey').notNull(),
  /** Hex pubkey of the counterparty */
  counterpartyPubkey: text('counterparty_pubkey').notNull(),
  /** Reporter's role in the interaction */
  role: outcomeRoleEnum('role').notNull(),
  /** Task category (e.g. code_review, trading, analysis) */
  taskType: text('task_type').notNull(),
  /** Shared reference — both parties use the same taskRef for matching */
  taskRef: text('task_ref').notNull(),
  /** Whether the task succeeded */
  success: boolean('success').notNull(),
  /** Rating 1-5, typically from purchaser */
  rating: integer('rating'),
  /** Free-form evidence or description */
  evidence: text('evidence'),
  /** Credit level based on matching status */
  creditAwarded: outcomeCreditEnum('credit_awarded').default('pending').notNull(),
  /** Links to the counterparty's matching outcome report */
  matchedOutcomeId: text('matched_outcome_id'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  index('idx_outcomes_agent').on(table.agentPubkey),
  index('idx_outcomes_counterparty').on(table.counterpartyPubkey),
  index('idx_outcomes_task_ref').on(table.taskRef),
  index('idx_outcomes_agent_task_ref').on(table.agentPubkey, table.taskRef),
]);

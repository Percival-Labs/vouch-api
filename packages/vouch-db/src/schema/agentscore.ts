import { boolean, integer, jsonb, pgTable, real, text, timestamp } from 'drizzle-orm/pg-core';

export const agentscoreCache = pgTable('agentscore_cache', {
  /** Moltbook agent name (primary lookup key) */
  agentName: text('agent_name').primaryKey(),
  /** Optional Vouch agent ID for cross-referencing */
  vouchAgentId: text('vouch_agent_id'),
  /** Composite score 0-100 */
  score: integer('score').notNull(),
  /** Individual dimension scores (each 0-20) */
  identity: integer('identity'),
  activity: integer('activity'),
  reputation: integer('reputation'),
  workHistory: integer('work_history'),
  consistency: integer('consistency'),
  /** Whether the agent was found in AgentScore */
  found: boolean('found').notNull().default(false),
  /** Raw API response for debugging */
  rawPayload: jsonb('raw_payload').$type<Record<string, unknown>>(),
  /** When this cache entry was last fetched */
  fetchedAt: timestamp('fetched_at').defaultNow().notNull(),
});

import { boolean, integer, jsonb, pgTable, real, text, timestamp } from 'drizzle-orm/pg-core';

export const wotScoreCache = pgTable('wot_score_cache', {
  pubkey: text('pubkey').primaryKey(),
  score: integer('score').notNull(),
  rawScore: real('raw_score'),
  found: boolean('found').notNull().default(false),
  followers: integer('followers').notNull().default(0),
  sybilScore: integer('sybil_score'),
  sybilClassification: text('sybil_classification'),
  sybilConfidence: real('sybil_confidence'),
  scorePayload: jsonb('score_payload').$type<Record<string, unknown>>(),
  sybilPayload: jsonb('sybil_payload').$type<Record<string, unknown>>(),
  fetchedAt: timestamp('fetched_at').defaultNow().notNull(),
});

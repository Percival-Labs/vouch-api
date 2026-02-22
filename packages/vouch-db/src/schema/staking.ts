import { pgTable, text, timestamp, integer, bigint, pgEnum, unique, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { agents } from './agents';
import { authorTypeEnum } from './tables';
import { chivalryViolations } from './moderation';
import { ulid } from 'ulid';

// ── Enums ──

export const poolStatusEnum = pgEnum('pool_status', ['active', 'frozen', 'dissolved']);
export const stakeStatusEnum = pgEnum('stake_status', ['active', 'unstaking', 'withdrawn', 'slashed']);
export const snapshotReasonEnum = pgEnum('snapshot_reason', ['daily', 'stake_change', 'slash', 'milestone']);
export const treasurySourceEnum = pgEnum('treasury_source', ['slash', 'platform_fee', 'donation']);

// ── Staking Pools (one per agent) ──

export const vouchPools = pgTable('vouch_pools', {
  id: text('id').primaryKey().$defaultFn(() => ulid()),
  agentId: text('agent_id').references(() => agents.id).notNull().unique(),
  totalStakedCents: bigint('total_staked_cents', { mode: 'number' }).default(0).notNull(),
  totalStakers: integer('total_stakers').default(0).notNull(),
  totalYieldPaidCents: bigint('total_yield_paid_cents', { mode: 'number' }).default(0).notNull(),
  totalSlashedCents: bigint('total_slashed_cents', { mode: 'number' }).default(0).notNull(),
  activityFeeRateBps: integer('activity_fee_rate_bps').default(500).notNull(), // 5% default
  status: poolStatusEnum('status').default('active').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  check('check_non_negative_staked', sql`${table.totalStakedCents} >= 0`),
  check('check_non_negative_stakers', sql`${table.totalStakers} >= 0`),
  check('check_non_negative_yield', sql`${table.totalYieldPaidCents} >= 0`),
  check('check_fee_rate_bounds', sql`${table.activityFeeRateBps} BETWEEN 200 AND 1000`),
]);

// ── Individual Stakes ──

export const stakes = pgTable('stakes', {
  id: text('id').primaryKey().$defaultFn(() => ulid()),
  poolId: text('pool_id').references(() => vouchPools.id).notNull(),
  stakerId: text('staker_id').notNull(),
  stakerType: authorTypeEnum('staker_type').notNull(), // 'user' | 'agent'
  amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
  stakerTrustAtStake: integer('staker_trust_at_stake').notNull(), // snapshot of staker's trust score
  status: stakeStatusEnum('status').default('active').notNull(),
  stakedAt: timestamp('staked_at').defaultNow().notNull(),
  unstakeRequestedAt: timestamp('unstake_requested_at'),
  withdrawnAt: timestamp('withdrawn_at'),
}, (table) => [
  check('check_positive_amount', sql`${table.amountCents} > 0`),
  // H5 fix: UNIQUE INDEX to enforce one active stake per staker per pool
  // Drizzle's unique() doesn't support partial (.where()), so we use a raw SQL unique index.
  // This must also be created via migration:
  //   CREATE UNIQUE INDEX unique_one_active_stake_per_staker ON stakes (pool_id, staker_id) WHERE status = 'active';
  index('idx_active_stakes_lookup').on(table.poolId, table.stakerId),
]);

// ── Yield Distributions (periodic batch) ──

export const yieldDistributions = pgTable('yield_distributions', {
  id: text('id').primaryKey().$defaultFn(() => ulid()),
  poolId: text('pool_id').references(() => vouchPools.id).notNull(),
  totalAmountCents: bigint('total_amount_cents', { mode: 'number' }).notNull(),
  platformFeeCents: bigint('platform_fee_cents', { mode: 'number' }).notNull(),
  distributedAmountCents: bigint('distributed_amount_cents', { mode: 'number' }).notNull(),
  periodStart: timestamp('period_start').notNull(),
  periodEnd: timestamp('period_end').notNull(),
  stakerCount: integer('staker_count').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// ── Per-Staker Yield Receipts ──

export const yieldReceipts = pgTable('yield_receipts', {
  id: text('id').primaryKey().$defaultFn(() => ulid()),
  distributionId: text('distribution_id').references(() => yieldDistributions.id).notNull(),
  stakeId: text('stake_id').references(() => stakes.id).notNull(),
  amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
  stakeProportionBps: integer('stake_proportion_bps').notNull(), // staker's share in basis points
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// ── Activity Fees (what generates yield) ──

export const activityFees = pgTable('activity_fees', {
  id: text('id').primaryKey().$defaultFn(() => ulid()),
  poolId: text('pool_id').references(() => vouchPools.id).notNull(),
  agentId: text('agent_id').references(() => agents.id).notNull(),
  actionType: text('action_type').notNull(), // 'content_creation', 'transaction', 'service', etc.
  grossRevenueCents: bigint('gross_revenue_cents', { mode: 'number' }).notNull(),
  feeCents: bigint('fee_cents', { mode: 'number' }).notNull(), // activity_fee_rate * gross_revenue
  distributionId: text('distribution_id').references(() => yieldDistributions.id), // null = undistributed (C4 fix)
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  check('check_positive_revenue', sql`${table.grossRevenueCents} > 0`),
  check('check_positive_fee', sql`${table.feeCents} > 0`),
]);

// ── Slashing Events ──

export const slashEvents = pgTable('slash_events', {
  id: text('id').primaryKey().$defaultFn(() => ulid()),
  poolId: text('pool_id').references(() => vouchPools.id).notNull(),
  reason: text('reason').notNull(),
  evidenceHash: text('evidence_hash').notNull(), // SHA-256 of evidence
  totalSlashedCents: bigint('total_slashed_cents', { mode: 'number' }).notNull(),
  toAffectedCents: bigint('to_affected_cents', { mode: 'number' }).notNull(), // 50% to affected parties
  toTreasuryCents: bigint('to_treasury_cents', { mode: 'number' }).notNull(), // 50% to community treasury
  violationId: text('violation_id').references(() => chivalryViolations.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// ── Vouch Score Snapshots (historical tracking) ──

export const vouchScoreHistory = pgTable('vouch_score_history', {
  id: text('id').primaryKey().$defaultFn(() => ulid()),
  subjectId: text('subject_id').notNull(),
  subjectType: authorTypeEnum('subject_type').notNull(),
  score: integer('score').notNull(),
  verificationComponent: integer('verification_component').notNull(),
  tenureComponent: integer('tenure_component').notNull(),
  performanceComponent: integer('performance_component').notNull(),
  backingComponent: integer('backing_component').notNull(),
  communityComponent: integer('community_component').notNull(),
  snapshotReason: snapshotReasonEnum('snapshot_reason').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// ── Community Treasury ──

export const treasury = pgTable('treasury', {
  id: text('id').primaryKey().$defaultFn(() => ulid()),
  amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
  sourceType: treasurySourceEnum('source_type').notNull(),
  sourceId: text('source_id'), // reference to slash_event or distribution
  description: text('description'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// ── Request Nonces (replay protection, H1) ──

export const requestNonces = pgTable('request_nonces', {
  id: text('id').primaryKey().$defaultFn(() => ulid()),
  agentId: text('agent_id').references(() => agents.id).notNull(),
  nonce: text('nonce').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  // Unique constraint ensures atomic duplicate detection
  unique('unique_agent_nonce').on(table.agentId, table.nonce),
  index('idx_nonce_expires').on(table.expiresAt),
]);

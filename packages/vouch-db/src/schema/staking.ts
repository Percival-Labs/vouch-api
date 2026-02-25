import { pgTable, text, timestamp, integer, bigint, pgEnum, unique, index, check, jsonb } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { agents } from './agents';
import { authorTypeEnum } from './tables';
import { chivalryViolations } from './moderation';
import { ulid } from 'ulid';

// ── Enums ──

export const poolStatusEnum = pgEnum('pool_status', ['active', 'frozen', 'dissolved']);
export const stakeStatusEnum = pgEnum('stake_status', ['pending', 'active', 'unstaking', 'withdrawn', 'slashed']);
export const snapshotReasonEnum = pgEnum('snapshot_reason', ['daily', 'stake_change', 'slash', 'milestone']);
export const treasurySourceEnum = pgEnum('treasury_source', ['slash', 'platform_fee', 'donation']);
export const paymentPurposeEnum = pgEnum('payment_purpose', ['stake', 'withdraw', 'yield', 'treasury_fee', 'contract_milestone', 'contract_retention', 'contract_refund']);
export const paymentStatusEnum = pgEnum('payment_status', ['pending', 'paid', 'expired', 'failed']);
export const nwcConnectionStatusEnum = pgEnum('nwc_connection_status', ['active', 'revoked', 'expired']);

// ── Staking Pools (one per agent) ──

export const vouchPools = pgTable('vouch_pools', {
  id: text('id').primaryKey().$defaultFn(() => ulid()),
  agentId: text('agent_id').references(() => agents.id).notNull().unique(),
  totalStakedSats: bigint('total_staked_sats', { mode: 'number' }).default(0).notNull(),
  totalStakers: integer('total_stakers').default(0).notNull(),
  totalYieldPaidSats: bigint('total_yield_paid_sats', { mode: 'number' }).default(0).notNull(),
  totalSlashedSats: bigint('total_slashed_sats', { mode: 'number' }).default(0).notNull(),
  activityFeeRateBps: integer('activity_fee_rate_bps').default(500).notNull(), // 5% default
  status: poolStatusEnum('status').default('active').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  check('check_non_negative_staked', sql`${table.totalStakedSats} >= 0`),
  check('check_non_negative_stakers', sql`${table.totalStakers} >= 0`),
  check('check_non_negative_yield', sql`${table.totalYieldPaidSats} >= 0`),
  check('check_fee_rate_bounds', sql`${table.activityFeeRateBps} BETWEEN 200 AND 1000`),
]);

// ── NWC Connections (non-custodial wallet links) ──

export const nwcConnections = pgTable('nwc_connections', {
  id: text('id').primaryKey().$defaultFn(() => ulid()),
  userNpub: text('user_npub').notNull(),
  connectionString: text('connection_string').notNull(), // AES-256-GCM encrypted
  walletPubkey: text('wallet_pubkey'),
  budgetSats: bigint('budget_sats', { mode: 'number' }).notNull(),
  spentSats: bigint('spent_sats', { mode: 'number' }).default(0).notNull(),
  methodsAuthorized: jsonb('methods_authorized').default([]).notNull(), // ['pay_invoice', 'make_invoice', ...]
  status: nwcConnectionStatusEnum('status').default('active').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  expiresAt: timestamp('expires_at'),
}, (table) => [
  check('check_non_negative_budget', sql`${table.budgetSats} >= 0`),
  check('check_non_negative_spent', sql`${table.spentSats} >= 0`),
  check('check_spent_within_budget', sql`${table.spentSats} <= ${table.budgetSats}`),
  index('idx_nwc_user_npub').on(table.userNpub),
  index('idx_nwc_status').on(table.status),
]);

// ── Individual Stakes ──

export const stakes = pgTable('stakes', {
  id: text('id').primaryKey().$defaultFn(() => ulid()),
  poolId: text('pool_id').references(() => vouchPools.id).notNull(),
  stakerId: text('staker_id').notNull(),
  stakerType: authorTypeEnum('staker_type').notNull(), // 'user' | 'agent'
  amountSats: bigint('amount_sats', { mode: 'number' }).notNull(),
  stakerTrustAtStake: integer('staker_trust_at_stake').notNull(), // snapshot of staker's trust score
  status: stakeStatusEnum('status').default('active').notNull(),
  nwcConnectionId: text('nwc_connection_id').references(() => nwcConnections.id),
  stakedAt: timestamp('staked_at').defaultNow().notNull(),
  unstakeRequestedAt: timestamp('unstake_requested_at'),
  withdrawnAt: timestamp('withdrawn_at'),
}, (table) => [
  check('check_positive_amount', sql`${table.amountSats} > 0 OR ${table.status} = 'pending'`),
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
  totalAmountSats: bigint('total_amount_sats', { mode: 'number' }).notNull(),
  platformFeeSats: bigint('platform_fee_sats', { mode: 'number' }).notNull(),
  distributedAmountSats: bigint('distributed_amount_sats', { mode: 'number' }).notNull(),
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
  amountSats: bigint('amount_sats', { mode: 'number' }).notNull(),
  stakeProportionBps: integer('stake_proportion_bps').notNull(), // staker's share in basis points
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// ── Activity Fees (what generates yield) ──

export const activityFees = pgTable('activity_fees', {
  id: text('id').primaryKey().$defaultFn(() => ulid()),
  poolId: text('pool_id').references(() => vouchPools.id).notNull(),
  agentId: text('agent_id').references(() => agents.id).notNull(),
  actionType: text('action_type').notNull(), // 'content_creation', 'transaction', 'service', etc.
  grossRevenueSats: bigint('gross_revenue_sats', { mode: 'number' }).notNull(),
  feeSats: bigint('fee_sats', { mode: 'number' }).notNull(), // activity_fee_rate * gross_revenue
  distributionId: text('distribution_id').references(() => yieldDistributions.id), // null = undistributed (C4 fix)
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  check('check_positive_revenue', sql`${table.grossRevenueSats} > 0`),
  check('check_positive_fee', sql`${table.feeSats} > 0`),
]);

// ── Slashing Events ──

export const slashEvents = pgTable('slash_events', {
  id: text('id').primaryKey().$defaultFn(() => ulid()),
  poolId: text('pool_id').references(() => vouchPools.id).notNull(),
  reason: text('reason').notNull(),
  evidenceHash: text('evidence_hash').notNull(), // SHA-256 of evidence
  totalSlashedSats: bigint('total_slashed_sats', { mode: 'number' }).notNull(),
  toAffectedSats: bigint('to_affected_sats', { mode: 'number' }).notNull(), // 50% to affected parties
  toTreasurySats: bigint('to_treasury_sats', { mode: 'number' }).notNull(), // 50% to community treasury
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
  amountSats: bigint('amount_sats', { mode: 'number' }).notNull(),
  sourceType: treasurySourceEnum('source_type').notNull(),
  sourceId: text('source_id'), // reference to slash_event or distribution
  description: text('description'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// ── Payment Events (Lightning payment lifecycle) ──

export const paymentEvents = pgTable('payment_events', {
  id: text('id').primaryKey().$defaultFn(() => ulid()),
  paymentHash: text('payment_hash').unique().notNull(),
  bolt11: text('bolt11'),
  amountSats: bigint('amount_sats', { mode: 'number' }).notNull(),
  purpose: paymentPurposeEnum('purpose').notNull(),
  status: paymentStatusEnum('status').default('pending').notNull(),
  poolId: text('pool_id').references(() => vouchPools.id),
  stakeId: text('stake_id').references(() => stakes.id),
  stakerId: text('staker_id'),
  nwcConnectionId: text('nwc_connection_id').references(() => nwcConnections.id),
  contractId: text('contract_id'), // FK enforced at DB level (references contracts.id)
  milestoneId: text('milestone_id'), // FK enforced at DB level (references contract_milestones.id)
  webhookReceivedAt: timestamp('webhook_received_at'),
  metadata: jsonb('metadata').default({}),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => [
  index('idx_payment_events_hash').on(table.paymentHash),
  index('idx_payment_events_stake').on(table.stakeId),
  index('idx_payment_events_pool').on(table.poolId),
  index('idx_payment_events_status').on(table.status),
  index('idx_payment_events_contract').on(table.contractId),
]);

// ── BTC Price Snapshots (display/reporting only — all accounting stays in sats) ──

export const btcPriceSnapshots = pgTable('btc_price_snapshots', {
  id: text('id').primaryKey().$defaultFn(() => ulid()),
  priceUsd: text('price_usd').notNull(), // stored as text for decimal precision
  source: text('source').notNull().default('coingecko'),
  reason: text('reason').notNull().default('scheduled'), // 'scheduled' | 'yield_distribution' | 'manual'
  capturedAt: timestamp('captured_at').defaultNow().notNull(),
}, (table) => [
  index('idx_btc_price_snapshots_captured').on(table.capturedAt),
]);

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

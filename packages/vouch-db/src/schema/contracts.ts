// Vouch Contracts — Construction-Model Agent Work Agreements
// Scope of work, milestone-based payment gates, change orders, retention, completion ratings.
// Maps construction contracting patterns to the agent economy.

import { pgTable, text, timestamp, integer, bigint, pgEnum, index, check, jsonb, boolean } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { ulid } from 'ulid';
import { paymentPurposeEnum, paymentStatusEnum, nwcConnections } from './staking';

// ── Enums ──

export const contractStatusEnum = pgEnum('contract_status', [
  'draft', 'awaiting_funding', 'active', 'completed', 'disputed', 'cancelled',
]);

export const milestoneStatusEnum = pgEnum('milestone_status', [
  'pending', 'in_progress', 'submitted', 'accepted', 'rejected', 'released',
]);

export const changeOrderStatusEnum = pgEnum('change_order_status', [
  'proposed', 'approved', 'rejected', 'withdrawn',
]);

export const bidStatusEnum = pgEnum('bid_status', [
  'pending', 'accepted', 'rejected', 'withdrawn',
]);

export const contractEventTypeEnum = pgEnum('contract_event_type', [
  'created', 'funded', 'milestone_submitted', 'milestone_accepted',
  'milestone_rejected', 'milestone_released', 'change_order_proposed',
  'change_order_approved', 'change_order_rejected', 'disputed',
  'completed', 'cancelled', 'rated',
]);

// ── Contracts ──

export const contracts = pgTable('contracts', {
  id: text('id').primaryKey().$defaultFn(() => ulid()),
  customerPubkey: text('customer_pubkey').notNull(),
  agentPubkey: text('agent_pubkey').notNull(),
  title: text('title').notNull(),
  description: text('description'),
  sow: jsonb('sow').notNull(), // { deliverables, acceptance_criteria, exclusions, tools_required, timeline_description }
  totalSats: bigint('total_sats', { mode: 'number' }).notNull(),
  fundedSats: bigint('funded_sats', { mode: 'number' }).default(0).notNull(),
  paidSats: bigint('paid_sats', { mode: 'number' }).default(0).notNull(),
  retentionBps: integer('retention_bps').default(1000).notNull(), // 10% default retention
  retentionReleaseAfterDays: integer('retention_release_after_days').default(30).notNull(),
  status: contractStatusEnum('status').default('draft').notNull(),
  nwcConnectionId: text('nwc_connection_id').references(() => nwcConnections.id),
  // Ratings (filled after completion)
  customerRating: integer('customer_rating'), // customer rates agent (1-5)
  customerReview: text('customer_review'),
  agentRating: integer('agent_rating'), // agent rates customer (1-5)
  agentReview: text('agent_review'),
  activatedAt: timestamp('activated_at'),
  completedAt: timestamp('completed_at'),
  retentionReleasedAt: timestamp('retention_released_at'),
  cancelledAt: timestamp('cancelled_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => [
  check('check_total_sats_positive', sql`${table.totalSats} > 0`),
  check('check_funded_non_negative', sql`${table.fundedSats} >= 0`),
  check('check_paid_non_negative', sql`${table.paidSats} >= 0`),
  check('check_paid_within_funded', sql`${table.paidSats} <= ${table.fundedSats}`),
  check('check_retention_bps_bounds', sql`${table.retentionBps} BETWEEN 0 AND 5000`), // 0-50%
  check('check_retention_days_bounds', sql`${table.retentionReleaseAfterDays} BETWEEN 0 AND 365`),
  check('check_customer_rating_bounds', sql`${table.customerRating} IS NULL OR ${table.customerRating} BETWEEN 1 AND 5`),
  check('check_agent_rating_bounds', sql`${table.agentRating} IS NULL OR ${table.agentRating} BETWEEN 1 AND 5`),
  index('idx_contracts_customer').on(table.customerPubkey),
  index('idx_contracts_agent').on(table.agentPubkey),
  index('idx_contracts_status').on(table.status),
]);

// ── Contract Milestones ──

export const contractMilestones = pgTable('contract_milestones', {
  id: text('id').primaryKey().$defaultFn(() => ulid()),
  contractId: text('contract_id').references(() => contracts.id).notNull(),
  sequence: integer('sequence').notNull(),
  title: text('title').notNull(),
  description: text('description'),
  acceptanceCriteria: text('acceptance_criteria'),
  amountSats: bigint('amount_sats', { mode: 'number' }).notNull(),
  percentageBps: integer('percentage_bps').notNull(), // basis points of total
  status: milestoneStatusEnum('status').default('pending').notNull(),
  isRetention: boolean('is_retention').default(false).notNull(),
  deliverableUrl: text('deliverable_url'),
  deliverableNotes: text('deliverable_notes'),
  iscCriteria: jsonb('isc_criteria'), // MilestoneISC structure
  skillsUsed: jsonb('skills_used').default([]), // skill IDs used to complete this milestone
  paymentHash: text('payment_hash'),
  submittedAt: timestamp('submitted_at'),
  acceptedAt: timestamp('accepted_at'),
  rejectedAt: timestamp('rejected_at'),
  releasedAt: timestamp('released_at'),
  rejectionReason: text('rejection_reason'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  check('check_milestone_amount_positive', sql`${table.amountSats} > 0`),
  check('check_percentage_bps_bounds', sql`${table.percentageBps} BETWEEN 1 AND 10000`),
  index('idx_milestones_contract').on(table.contractId),
  index('idx_milestones_status').on(table.status),
]);

// ── Change Orders ──

export const contractChangeOrders = pgTable('contract_change_orders', {
  id: text('id').primaryKey().$defaultFn(() => ulid()),
  contractId: text('contract_id').references(() => contracts.id).notNull(),
  sequence: integer('sequence').notNull(),
  title: text('title').notNull(),
  description: text('description').notNull(),
  proposedBy: text('proposed_by').notNull(), // pubkey of proposer
  costDeltaSats: bigint('cost_delta_sats', { mode: 'number' }).default(0).notNull(),
  timelineDeltaDays: integer('timeline_delta_days').default(0).notNull(),
  status: changeOrderStatusEnum('status').default('proposed').notNull(),
  approvedBy: text('approved_by'),
  rejectedBy: text('rejected_by'),
  rejectionReason: text('rejection_reason'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  resolvedAt: timestamp('resolved_at'),
}, (table) => [
  index('idx_change_orders_contract').on(table.contractId),
  index('idx_change_orders_status').on(table.status),
]);

// ── Bids (Phase 2 — table now, API later) ──

export const contractBids = pgTable('contract_bids', {
  id: text('id').primaryKey().$defaultFn(() => ulid()),
  contractId: text('contract_id').references(() => contracts.id).notNull(),
  bidderPubkey: text('bidder_pubkey').notNull(),
  approach: text('approach').notNull(),
  costSats: bigint('cost_sats', { mode: 'number' }).notNull(),
  estimatedDays: integer('estimated_days').notNull(),
  bidderTrustScore: integer('bidder_trust_score').default(0).notNull(),
  status: bidStatusEnum('status').default('pending').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  check('check_bid_cost_positive', sql`${table.costSats} > 0`),
  check('check_bid_days_positive', sql`${table.estimatedDays} > 0`),
  index('idx_bids_contract').on(table.contractId),
  index('idx_bids_bidder').on(table.bidderPubkey),
  index('idx_bids_status').on(table.status),
]);

// ── Contract Events (Audit Trail) ──

export const contractEvents = pgTable('contract_events', {
  id: text('id').primaryKey().$defaultFn(() => ulid()),
  contractId: text('contract_id').references(() => contracts.id).notNull(),
  eventType: contractEventTypeEnum('event_type').notNull(),
  actorPubkey: text('actor_pubkey').notNull(),
  metadata: jsonb('metadata').default({}),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  index('idx_contract_events_contract').on(table.contractId),
  index('idx_contract_events_type').on(table.eventType),
]);

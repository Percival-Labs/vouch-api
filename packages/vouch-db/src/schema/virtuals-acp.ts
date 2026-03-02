// Virtuals Protocol ACP — On-chain indexer schema
// Stores ACP job lifecycle events, memo events, and computed agent trust scores.
// All data sourced from Base L2 public blockchain — no agent registration required.

import { pgTable, text, timestamp, integer, bigint, boolean, numeric, pgEnum, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { ulid } from 'ulid';

// ── Enums ──

export const acpJobPhaseEnum = pgEnum('acp_job_phase', [
  'request',
  'negotiation',
  'transaction',
  'evaluation',
  'completed',
  'cancelled',
  'rejected',
  'expired',
]);

// ── Indexer Cursor (tracks sync progress per chain) ──

export const acpIndexerCursor = pgTable('acp_indexer_cursor', {
  chainId: text('chain_id').primaryKey(), // "eip155:8453"
  lastBlock: integer('last_block').notNull().default(0),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// ── ACP Jobs (one row per on-chain job) ──

export const acpJobs = pgTable('acp_jobs', {
  id: text('id').primaryKey().$defaultFn(() => ulid()),
  onChainJobId: integer('on_chain_job_id').notNull(),
  accountId: integer('account_id'),
  clientAddress: text('client_address').notNull(),   // buyer wallet, lowercase
  providerAddress: text('provider_address').notNull(), // seller wallet, lowercase
  evaluatorAddress: text('evaluator_address'),         // nullable (optional in ACP v2)
  budgetUsdc: numeric('budget_usdc', { precision: 20, scale: 6 }).default('0'),
  paymentToken: text('payment_token'),                 // token contract address
  phase: acpJobPhaseEnum('phase').default('request').notNull(),
  isX402: boolean('is_x402').default(false),
  createdBlock: integer('created_block').notNull(),
  createdTx: text('created_tx').notNull(),
  completedAt: timestamp('completed_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  uniqueIndex('acp_jobs_on_chain_id').on(table.onChainJobId),
  index('acp_jobs_client').on(table.clientAddress),
  index('acp_jobs_provider').on(table.providerAddress),
  index('acp_jobs_phase').on(table.phase),
]);

// ── ACP Memos (deliverables, approvals, payments) ──

export const acpMemos = pgTable('acp_memos', {
  id: text('id').primaryKey().$defaultFn(() => ulid()),
  onChainMemoId: integer('on_chain_memo_id').notNull(),
  onChainJobId: integer('on_chain_job_id').notNull(),  // denormalized for query speed
  senderAddress: text('sender_address').notNull(),
  memoType: text('memo_type'),
  approved: boolean('approved'),                        // null until signed
  reason: text('reason'),
  amountUsdc: numeric('amount_usdc', { precision: 20, scale: 6 }),
  blockNumber: integer('block_number').notNull(),
  txHash: text('tx_hash').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  uniqueIndex('acp_memos_on_chain_id').on(table.onChainMemoId, table.txHash),
  index('acp_memos_job').on(table.onChainJobId),
  index('acp_memos_sender').on(table.senderAddress),
]);

// ── ACP Agent Stats (materialized aggregates, recomputed on events) ──

export const acpAgentStats = pgTable('acp_agent_stats', {
  address: text('address').primaryKey(),                // wallet address, lowercase
  totalJobsClient: integer('total_jobs_client').default(0).notNull(),
  totalJobsProvider: integer('total_jobs_provider').default(0).notNull(),
  totalJobsEvaluator: integer('total_jobs_evaluator').default(0).notNull(),
  completedAsProvider: integer('completed_as_provider').default(0).notNull(),
  failedAsProvider: integer('failed_as_provider').default(0).notNull(),
  totalEarnedUsdc: numeric('total_earned_usdc', { precision: 20, scale: 6 }).default('0').notNull(),
  totalSpentUsdc: numeric('total_spent_usdc', { precision: 20, scale: 6 }).default('0').notNull(),
  uniqueClients: integer('unique_clients').default(0).notNull(),
  uniqueProviders: integer('unique_providers').default(0).notNull(),
  firstSeenAt: timestamp('first_seen_at'),
  lastActiveAt: timestamp('last_active_at'),
  acpTrustScore: integer('acp_trust_score').default(0).notNull(), // 0-1000
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

import { pgTable, text, timestamp, integer, bigint, pgEnum, boolean, numeric, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { ulid } from 'ulid';

// ── Enums ──

export const creditDepositStatusEnum = pgEnum('credit_deposit_status', ['pending', 'confirmed', 'failed']);
export const tokenBatchStatusEnum = pgEnum('token_batch_status', ['active', 'exhausted', 'expired']);

// ── Credit Balances (one per user) ──

export const creditBalances = pgTable('credit_balances', {
  userNpub: text('user_npub').primaryKey(),
  balanceSats: bigint('balance_sats', { mode: 'number' }).default(0).notNull(),
  lifetimeDepositedSats: bigint('lifetime_deposited_sats', { mode: 'number' }).default(0).notNull(),
  lifetimeSpentSats: bigint('lifetime_spent_sats', { mode: 'number' }).default(0).notNull(),
  dailyLimitSats: bigint('daily_limit_sats', { mode: 'number' }),
  weeklyLimitSats: bigint('weekly_limit_sats', { mode: 'number' }),
  monthlyLimitSats: bigint('monthly_limit_sats', { mode: 'number' }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => [
  check('check_balance_non_negative', sql`${table.balanceSats} >= 0`),
  check('check_lifetime_deposited_non_negative', sql`${table.lifetimeDepositedSats} >= 0`),
  check('check_lifetime_spent_non_negative', sql`${table.lifetimeSpentSats} >= 0`),
]);

// ── Credit Deposits (Lightning payment records) ──

export const creditDeposits = pgTable('credit_deposits', {
  id: text('id').primaryKey().$defaultFn(() => ulid()),
  userNpub: text('user_npub').notNull(),
  amountSats: bigint('amount_sats', { mode: 'number' }).notNull(),
  paymentHash: text('payment_hash').unique(),
  bolt11: text('bolt11'),
  status: creditDepositStatusEnum('status').default('pending').notNull(),
  confirmedAt: timestamp('confirmed_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  check('check_deposit_amount_positive', sql`${table.amountSats} > 0`),
  index('idx_credit_deposits_user').on(table.userNpub),
]);

// ── Token Batches (prepaid anonymous inference) ──

export const tokenBatches = pgTable('token_batches', {
  batchHash: text('batch_hash').primaryKey(),
  ownerNpub: text('owner_npub'),
  budgetSats: bigint('budget_sats', { mode: 'number' }).notNull(),
  spentSats: bigint('spent_sats', { mode: 'number' }).default(0).notNull(),
  tokenCount: integer('token_count').notNull(),
  tokensSpent: integer('tokens_spent').default(0).notNull(),
  tokensIssued: integer('tokens_issued').default(0).notNull(),
  status: tokenBatchStatusEnum('status').default('active').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  check('check_batch_budget_positive', sql`${table.budgetSats} > 0`),
  check('check_batch_spent_within_budget', sql`${table.spentSats} <= ${table.budgetSats}`),
  check('check_batch_tokens_within_count', sql`${table.tokensSpent} <= ${table.tokenCount}`),
  check('check_batch_tokens_issued_within_count', sql`${table.tokensIssued} <= ${table.tokenCount}`),
  index('idx_token_batches_owner').on(table.ownerNpub),
]);

// ── Spent Tokens (double-spend prevention) ──

export const spentTokens = pgTable('spent_tokens', {
  tokenHash: text('token_hash').primaryKey(),
  batchHash: text('batch_hash').references(() => tokenBatches.batchHash),
  costSats: bigint('cost_sats', { mode: 'number' }),
  redeemedAt: timestamp('redeemed_at').defaultNow().notNull(),
}, (table) => [
  index('idx_spent_tokens_redeemed').on(table.redeemedAt),
  index('idx_spent_tokens_batch').on(table.batchHash),
]);

// ── Usage Records (per-request metering) ──

export const usageRecords = pgTable('usage_records', {
  id: text('id').primaryKey().$defaultFn(() => ulid()),
  userNpub: text('user_npub'),
  batchHash: text('batch_hash'),
  model: text('model').notNull(),
  provider: text('provider').notNull(),
  inputTokens: integer('input_tokens').notNull(),
  outputTokens: integer('output_tokens').notNull(),
  costSats: bigint('cost_sats', { mode: 'number' }).notNull(),
  rawCostSats: bigint('raw_cost_sats', { mode: 'number' }).notNull(),
  marginSats: bigint('margin_sats', { mode: 'number' }).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  check('check_tokens_non_negative', sql`${table.inputTokens} >= 0 AND ${table.outputTokens} >= 0`),
  check('check_cost_non_negative', sql`${table.costSats} >= 0 AND ${table.rawCostSats} >= 0`),
  index('idx_usage_records_user').on(table.userNpub, table.createdAt),
  index('idx_usage_records_batch').on(table.batchHash),
  index('idx_usage_records_created').on(table.createdAt),
]);

// ── Model Pricing (reference table) ──

export const modelPricing = pgTable('model_pricing', {
  modelId: text('model_id').primaryKey(),
  provider: text('provider').notNull(),
  inputCostPerMillion: numeric('input_cost_per_million').notNull(),
  outputCostPerMillion: numeric('output_cost_per_million').notNull(),
  plInputPricePerMillion: numeric('pl_input_price_per_million').notNull(),
  plOutputPricePerMillion: numeric('pl_output_price_per_million').notNull(),
  marginBps: integer('margin_bps').default(1500).notNull(),
  isActive: boolean('is_active').default(true).notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => [
  check('check_costs_non_negative', sql`
    ${table.inputCostPerMillion} >= 0 AND
    ${table.outputCostPerMillion} >= 0 AND
    ${table.plInputPricePerMillion} >= 0 AND
    ${table.plOutputPricePerMillion} >= 0
  `),
  check('check_margin_bounds', sql`${table.marginBps} BETWEEN 0 AND 10000`),
]);

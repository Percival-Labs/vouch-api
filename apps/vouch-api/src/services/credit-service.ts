// Credit Service — deposit, balance, debit, spend limits, and token batch management.
// All credit operations use DB transactions for atomicity.
// Lightning deposits via Alby Hub (NWC). Spend limits enforced server-side.

import { eq, and, sql, gte } from 'drizzle-orm';
import {
  db,
  creditBalances,
  creditDeposits,
  tokenBatches,
  usageRecords,
} from '@percival/vouch-db';
import { createInvoice } from './albyhub-service';
import { recordActivityFee } from './staking-service';
import { ulid } from 'ulid';
import { createHash } from 'crypto';

// ── Constants ──

const DEPOSIT_FEE_BPS = 100; // 1% activity fee on deposits → staking yield pool
const MIN_DEPOSIT_SATS = 1000; // ~$1
const MAX_DEPOSIT_SATS = 10_000_000; // ~$10K
const MIN_BATCH_BUDGET_SATS = 100;
const MAX_BATCH_BUDGET_SATS = 1_000_000;
const DEFAULT_BATCH_TTL_HOURS = 24 * 7; // 7 days
const MAX_TOKENS_PER_BATCH = 100;

// ── Types ──

export interface CreditBalance {
  balanceSats: number;
  lifetimeDepositedSats: number;
  lifetimeSpentSats: number;
  dailyLimitSats: number | null;
  weeklyLimitSats: number | null;
  monthlyLimitSats: number | null;
}

export interface DepositResult {
  depositId: string;
  amountSats: number;
  feeSats: number;
  netCreditSats: number;
  bolt11: string;
  paymentHash: string;
}

export interface SpendLimits {
  dailyLimitSats?: number | null;
  weeklyLimitSats?: number | null;
  monthlyLimitSats?: number | null;
}

export interface SpendCheck {
  allowed: boolean;
  remaining: {
    daily: number | null;
    weekly: number | null;
    monthly: number | null;
    balance: number;
  };
  periodUsed: {
    daily: number;
    weekly: number;
    monthly: number;
  };
}

export interface BatchResult {
  batchHash: string;
  budgetSats: number;
  tokenCount: number;
  expiresAt: Date;
}

export interface UsageSummary {
  totalCostSats: number;
  totalRawCostSats: number;
  totalMarginSats: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  requestCount: number;
}

// ── Balance Management ──

/**
 * Get or create credit balance for a user.
 */
export async function getBalance(userNpub: string): Promise<CreditBalance> {
  const [existing] = await db.select().from(creditBalances)
    .where(eq(creditBalances.userNpub, userNpub)).limit(1);

  if (existing) {
    return {
      balanceSats: existing.balanceSats,
      lifetimeDepositedSats: existing.lifetimeDepositedSats,
      lifetimeSpentSats: existing.lifetimeSpentSats,
      dailyLimitSats: existing.dailyLimitSats,
      weeklyLimitSats: existing.weeklyLimitSats,
      monthlyLimitSats: existing.monthlyLimitSats,
    };
  }

  // Auto-create balance record
  const [created] = await db.insert(creditBalances).values({
    userNpub,
  }).onConflictDoNothing().returning();

  if (created) {
    return {
      balanceSats: 0,
      lifetimeDepositedSats: 0,
      lifetimeSpentSats: 0,
      dailyLimitSats: null,
      weeklyLimitSats: null,
      monthlyLimitSats: null,
    };
  }

  // Race condition: someone else created it
  return getBalance(userNpub);
}

// ── Deposits ──

/**
 * Create a Lightning invoice for a credit deposit.
 * Returns the invoice details. Caller must pay the invoice, then call confirmDeposit.
 */
export async function createDeposit(userNpub: string, amountSats: number): Promise<DepositResult> {
  if (amountSats < MIN_DEPOSIT_SATS) {
    throw new Error(`Minimum deposit is ${MIN_DEPOSIT_SATS} sats`);
  }
  if (amountSats > MAX_DEPOSIT_SATS) {
    throw new Error(`Maximum deposit is ${MAX_DEPOSIT_SATS} sats`);
  }

  // Ensure balance record exists
  await getBalance(userNpub);

  const feeSats = Math.ceil(amountSats * DEPOSIT_FEE_BPS / 10000);
  const netCreditSats = amountSats - feeSats;

  // Create Lightning invoice via Alby Hub
  const invoice = await createInvoice(amountSats, `Vouch inference credit deposit — ${amountSats} sats`);

  const depositId = ulid();
  await db.insert(creditDeposits).values({
    id: depositId,
    userNpub,
    amountSats,
    paymentHash: invoice.paymentHash,
    bolt11: invoice.paymentRequest,
    status: 'pending',
  });

  return {
    depositId,
    amountSats,
    feeSats,
    netCreditSats,
    bolt11: invoice.paymentRequest,
    paymentHash: invoice.paymentHash,
  };
}

/**
 * Confirm a deposit after Lightning payment is received.
 * Credits the user's balance and records the activity fee.
 * Requires the requesting user's npub to verify ownership.
 */
export async function confirmDeposit(depositId: string, requestingNpub: string): Promise<CreditBalance> {
  return db.transaction(async (tx) => {
    const [deposit] = await tx.select().from(creditDeposits)
      .where(and(
        eq(creditDeposits.id, depositId),
        eq(creditDeposits.status, 'pending'),
      ))
      .limit(1);

    if (!deposit) {
      throw new Error('Deposit not found or already processed');
    }

    // Verify the requesting user owns this deposit
    if (deposit.userNpub !== requestingNpub) {
      throw new Error('Deposit not found or already processed');
    }

    const feeSats = Math.ceil(deposit.amountSats * DEPOSIT_FEE_BPS / 10000);
    const netCreditSats = deposit.amountSats - feeSats;

    // Mark deposit confirmed
    await tx.update(creditDeposits)
      .set({ status: 'confirmed', confirmedAt: new Date() })
      .where(eq(creditDeposits.id, depositId));

    // Credit user's balance
    await tx.update(creditBalances)
      .set({
        balanceSats: sql`${creditBalances.balanceSats} + ${netCreditSats}`,
        lifetimeDepositedSats: sql`${creditBalances.lifetimeDepositedSats} + ${netCreditSats}`,
        updatedAt: new Date(),
      })
      .where(eq(creditBalances.userNpub, deposit.userNpub));

    // Get updated balance
    const [updated] = await tx.select().from(creditBalances)
      .where(eq(creditBalances.userNpub, deposit.userNpub)).limit(1);

    if (!updated) throw new Error('Balance record missing after deposit confirmation');

    return {
      balanceSats: updated.balanceSats,
      lifetimeDepositedSats: updated.lifetimeDepositedSats,
      lifetimeSpentSats: updated.lifetimeSpentSats,
      dailyLimitSats: updated.dailyLimitSats,
      weeklyLimitSats: updated.weeklyLimitSats,
      monthlyLimitSats: updated.monthlyLimitSats,
    };
  });
}

// ── Spend Limits ──

/**
 * Set spend limits for a user. Pass null to remove a limit.
 * Values must be positive integers or null.
 */
export async function setLimits(userNpub: string, limits: SpendLimits): Promise<CreditBalance> {
  // Validate limit values — must be positive integers or null
  for (const [key, value] of Object.entries(limits)) {
    if (value === undefined) continue;
    if (value === null) continue;
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
      throw new Error(`Invalid limit value for ${key}: must be a positive integer or null`);
    }
  }

  await getBalance(userNpub); // ensure exists

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (limits.dailyLimitSats !== undefined) updates.dailyLimitSats = limits.dailyLimitSats;
  if (limits.weeklyLimitSats !== undefined) updates.weeklyLimitSats = limits.weeklyLimitSats;
  if (limits.monthlyLimitSats !== undefined) updates.monthlyLimitSats = limits.monthlyLimitSats;

  await db.update(creditBalances).set(updates).where(eq(creditBalances.userNpub, userNpub));

  return getBalance(userNpub);
}

/**
 * Check if a proposed spend is within limits.
 */
export async function checkLimits(userNpub: string, proposedSpendSats: number): Promise<SpendCheck> {
  const balance = await getBalance(userNpub);

  // Get period usage
  const now = new Date();
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weekStart = new Date(dayStart);
  weekStart.setDate(weekStart.getDate() - weekStart.getDay());
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const [periodUsage] = await db.select({
    daily: sql<number>`COALESCE(SUM(CASE WHEN ${usageRecords.createdAt} >= ${dayStart.toISOString()} THEN ${usageRecords.costSats} ELSE 0 END), 0)`,
    weekly: sql<number>`COALESCE(SUM(CASE WHEN ${usageRecords.createdAt} >= ${weekStart.toISOString()} THEN ${usageRecords.costSats} ELSE 0 END), 0)`,
    monthly: sql<number>`COALESCE(SUM(CASE WHEN ${usageRecords.createdAt} >= ${monthStart.toISOString()} THEN ${usageRecords.costSats} ELSE 0 END), 0)`,
  }).from(usageRecords)
    .where(eq(usageRecords.userNpub, userNpub));

  const dailyUsed = Number(periodUsage?.daily ?? 0);
  const weeklyUsed = Number(periodUsage?.weekly ?? 0);
  const monthlyUsed = Number(periodUsage?.monthly ?? 0);

  // Check each limit
  let allowed = balance.balanceSats >= proposedSpendSats;

  if (balance.dailyLimitSats !== null && (dailyUsed + proposedSpendSats) > balance.dailyLimitSats) {
    allowed = false;
  }
  if (balance.weeklyLimitSats !== null && (weeklyUsed + proposedSpendSats) > balance.weeklyLimitSats) {
    allowed = false;
  }
  if (balance.monthlyLimitSats !== null && (monthlyUsed + proposedSpendSats) > balance.monthlyLimitSats) {
    allowed = false;
  }

  return {
    allowed,
    remaining: {
      daily: balance.dailyLimitSats !== null ? Math.max(0, balance.dailyLimitSats - dailyUsed) : null,
      weekly: balance.weeklyLimitSats !== null ? Math.max(0, balance.weeklyLimitSats - weeklyUsed) : null,
      monthly: balance.monthlyLimitSats !== null ? Math.max(0, balance.monthlyLimitSats - monthlyUsed) : null,
      balance: balance.balanceSats,
    },
    periodUsed: {
      daily: dailyUsed,
      weekly: weeklyUsed,
      monthly: monthlyUsed,
    },
  };
}

// ── Debiting ──

/**
 * Debit a user's credit balance for a transparent-mode inference request.
 * Atomic: checks balance + spend limits within the same transaction.
 * Activity fee is recorded by metering-service (not here, to avoid double-recording).
 */
export async function debit(userNpub: string, amountSats: number, usageRecordId: string): Promise<void> {
  await db.transaction(async (tx) => {
    // Lock the balance row
    const [balance] = await tx.select().from(creditBalances)
      .where(eq(creditBalances.userNpub, userNpub))
      .for('update');

    if (!balance) {
      throw new Error('Insufficient credits for this request');
    }
    if (balance.balanceSats < amountSats) {
      throw new Error('Insufficient credits for this request');
    }

    // Enforce spend limits atomically within the same transaction
    const now = new Date();
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekStart = new Date(dayStart);
    weekStart.setDate(weekStart.getDate() - weekStart.getDay());
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    if (balance.dailyLimitSats !== null || balance.weeklyLimitSats !== null || balance.monthlyLimitSats !== null) {
      const [periodUsage] = await tx.select({
        daily: sql<number>`COALESCE(SUM(CASE WHEN ${usageRecords.createdAt} >= ${dayStart.toISOString()} THEN ${usageRecords.costSats} ELSE 0 END), 0)`,
        weekly: sql<number>`COALESCE(SUM(CASE WHEN ${usageRecords.createdAt} >= ${weekStart.toISOString()} THEN ${usageRecords.costSats} ELSE 0 END), 0)`,
        monthly: sql<number>`COALESCE(SUM(CASE WHEN ${usageRecords.createdAt} >= ${monthStart.toISOString()} THEN ${usageRecords.costSats} ELSE 0 END), 0)`,
      }).from(usageRecords)
        .where(eq(usageRecords.userNpub, userNpub));

      const dailyUsed = Number(periodUsage?.daily ?? 0);
      const weeklyUsed = Number(periodUsage?.weekly ?? 0);
      const monthlyUsed = Number(periodUsage?.monthly ?? 0);

      if (balance.dailyLimitSats !== null && (dailyUsed + amountSats) > balance.dailyLimitSats) {
        throw new Error('Daily spend limit exceeded');
      }
      if (balance.weeklyLimitSats !== null && (weeklyUsed + amountSats) > balance.weeklyLimitSats) {
        throw new Error('Weekly spend limit exceeded');
      }
      if (balance.monthlyLimitSats !== null && (monthlyUsed + amountSats) > balance.monthlyLimitSats) {
        throw new Error('Monthly spend limit exceeded');
      }
    }

    await tx.update(creditBalances)
      .set({
        balanceSats: sql`${creditBalances.balanceSats} - ${amountSats}`,
        lifetimeSpentSats: sql`${creditBalances.lifetimeSpentSats} + ${amountSats}`,
        updatedAt: new Date(),
      })
      .where(eq(creditBalances.userNpub, userNpub));
  });
}

// ── Token Batches (Private Mode) ──

/**
 * Purchase a token batch for private/anonymous inference.
 * Debits from credit balance, creates batch record.
 */
export async function purchaseBatch(
  userNpub: string,
  budgetSats: number,
  tokenCount: number,
): Promise<BatchResult> {
  if (budgetSats < MIN_BATCH_BUDGET_SATS) {
    throw new Error(`Minimum batch budget is ${MIN_BATCH_BUDGET_SATS} sats`);
  }
  if (budgetSats > MAX_BATCH_BUDGET_SATS) {
    throw new Error(`Maximum batch budget is ${MAX_BATCH_BUDGET_SATS} sats`);
  }
  if (tokenCount < 1 || tokenCount > MAX_TOKENS_PER_BATCH) {
    throw new Error(`Token count must be between 1 and ${MAX_TOKENS_PER_BATCH}`);
  }

  const expiresAt = new Date(Date.now() + DEFAULT_BATCH_TTL_HOURS * 60 * 60 * 1000);

  // Generate batch hash from metadata
  const batchHash = createHash('sha256')
    .update(`${userNpub}:${budgetSats}:${tokenCount}:${Date.now()}:${ulid()}`)
    .digest('hex');

  await db.transaction(async (tx) => {
    // Lock and check balance
    const [balance] = await tx.select().from(creditBalances)
      .where(eq(creditBalances.userNpub, userNpub))
      .for('update');

    if (!balance) {
      throw new Error('Insufficient credits for this purchase');
    }
    if (balance.balanceSats < budgetSats) {
      throw new Error('Insufficient credits for this purchase');
    }

    // Debit balance
    await tx.update(creditBalances)
      .set({
        balanceSats: sql`${creditBalances.balanceSats} - ${budgetSats}`,
        lifetimeSpentSats: sql`${creditBalances.lifetimeSpentSats} + ${budgetSats}`,
        updatedAt: new Date(),
      })
      .where(eq(creditBalances.userNpub, userNpub));

    // Create batch record with owner for ownership verification at issuance
    await tx.insert(tokenBatches).values({
      batchHash,
      ownerNpub: userNpub,
      budgetSats,
      tokenCount,
      expiresAt,
    });
  });

  // Activity fee on batch purchase (non-blocking)
  const feeSats = Math.ceil(budgetSats * DEPOSIT_FEE_BPS / 10000);
  if (feeSats > 0) {
    try {
      await recordActivityFee('inference-proxy', 'batch_purchase', budgetSats);
    } catch (e) {
      console.error('[credit-service] Batch activity fee recording failed:', e);
    }
  }

  return {
    batchHash,
    budgetSats,
    tokenCount,
    expiresAt,
  };
}

/**
 * Debit a token batch for a private-mode inference request.
 */
export async function debitBatch(batchHash: string, costSats: number): Promise<void> {
  await db.transaction(async (tx) => {
    const [batch] = await tx.select().from(tokenBatches)
      .where(and(
        eq(tokenBatches.batchHash, batchHash),
        eq(tokenBatches.status, 'active'),
      ))
      .for('update');

    if (!batch) {
      throw new Error('Token batch not found or expired');
    }

    if (new Date() > batch.expiresAt) {
      await tx.update(tokenBatches)
        .set({ status: 'expired' })
        .where(eq(tokenBatches.batchHash, batchHash));
      throw new Error('Token batch has expired');
    }

    const remainingBudget = batch.budgetSats - batch.spentSats;
    if (costSats > remainingBudget) {
      throw new Error('Insufficient batch budget for this request');
    }

    const newSpent = batch.spentSats + costSats;
    const newTokensSpent = batch.tokensSpent + 1;
    const isExhausted = newSpent >= batch.budgetSats || newTokensSpent >= batch.tokenCount;

    await tx.update(tokenBatches)
      .set({
        spentSats: newSpent,
        tokensSpent: newTokensSpent,
        status: isExhausted ? 'exhausted' : 'active',
      })
      .where(eq(tokenBatches.batchHash, batchHash));
  });
}

// ── Usage Queries ──

/**
 * Get usage summary for a user over a time period.
 */
export async function getUsageSummary(
  userNpub: string,
  since: Date,
): Promise<UsageSummary> {
  const [result] = await db.select({
    totalCostSats: sql<number>`COALESCE(SUM(${usageRecords.costSats}), 0)`,
    totalRawCostSats: sql<number>`COALESCE(SUM(${usageRecords.rawCostSats}), 0)`,
    totalMarginSats: sql<number>`COALESCE(SUM(${usageRecords.marginSats}), 0)`,
    totalInputTokens: sql<number>`COALESCE(SUM(${usageRecords.inputTokens}), 0)`,
    totalOutputTokens: sql<number>`COALESCE(SUM(${usageRecords.outputTokens}), 0)`,
    requestCount: sql<number>`COUNT(*)`,
  }).from(usageRecords)
    .where(and(
      eq(usageRecords.userNpub, userNpub),
      gte(usageRecords.createdAt, since),
    ));

  return {
    totalCostSats: Number(result?.totalCostSats ?? 0),
    totalRawCostSats: Number(result?.totalRawCostSats ?? 0),
    totalMarginSats: Number(result?.totalMarginSats ?? 0),
    totalInputTokens: Number(result?.totalInputTokens ?? 0),
    totalOutputTokens: Number(result?.totalOutputTokens ?? 0),
    requestCount: Number(result?.requestCount ?? 0),
  };
}

// ── Background Jobs ──

/**
 * Expire stale token batches (called hourly).
 */
export async function expireTokenBatches(): Promise<number> {
  const result = await db.update(tokenBatches)
    .set({ status: 'expired' })
    .where(and(
      eq(tokenBatches.status, 'active'),
      sql`${tokenBatches.expiresAt} < NOW()`,
    ));

  return (result as any).rowCount ?? 0;
}

// Vouch — Staking Engine
// Handles pool creation, staking, unstaking, yield distribution, and slashing.
// All financial operations use DB transactions for atomicity (C3 fix).
// All amounts are in sats (Lightning-native).

import { eq, and, sql, isNull } from 'drizzle-orm';
import {
  db,
  vouchPools,
  stakes,
  yieldDistributions,
  yieldReceipts,
  activityFees,
  slashEvents,
  treasury,
  vouchScoreHistory,
  agents,
  users,
  paymentEvents,
} from '@percival/vouch-db';

// ── Constants ──

const PLATFORM_FEE_BPS = 100; // 1% — lowest viable rate, covers infrastructure with thin margin
const STAKING_FEE_BPS = 0; // 0% — zero deposit fee, optimize for participation not extraction
const UNSTAKE_NOTICE_DAYS = 7;
const SLASH_TO_AFFECTED_BPS = 5000; // 50%
const SLASH_TO_TREASURY_BPS = 5000; // 50%
const MAX_STAKE_SATS = 100_000_000; // 1 BTC cap
const MIN_STAKE_SATS = 10_000; // ~$10 equivalent
const MAX_FEE_SATS = 100_000_000; // 1 BTC cap per fee record

// ── Types ──

export interface StakeResult {
  stakeId: string;
  poolId: string;
  amountSats: number;
  feeSats: number;
  netStakedSats: number;
}

export interface InitiateStakeResult {
  stakeId: string;
  poolId: string;
  paymentRequest: string;
  paymentHash: string;
  amountSats: number;
  feeSats: number;
}

export interface UnstakeResult {
  stakeId: string;
  withdrawableAt: Date;
}

export interface PoolSummary {
  id: string;
  agentId: string;
  agentName: string;
  totalStakedSats: number;
  totalStakers: number;
  totalYieldPaidSats: number;
  activityFeeRateBps: number;
  status: string;
  createdAt: Date;
}

export interface YieldDistributionResult {
  distributionId: string;
  poolId: string;
  totalAmountSats: number;
  platformFeeSats: number;
  distributedAmountSats: number;
  stakerCount: number;
}

// ── Pool Management ──

/** Create a staking pool for an agent. One pool per agent. Optionally provisions LNbits wallet. */
export async function createPool(agentId: string, activityFeeRateBps = 500): Promise<string> {
  // Try to create LNbits wallet for this pool
  let lnbitsWalletId: string | null = null;
  let lnbitsAdminKey: string | null = null;
  let lnbitsInvoiceKey: string | null = null;

  try {
    const { createUserWithWallet } = await import('./lnbits-service');
    const wallet = await createUserWithWallet(`pool-${agentId}`, agentId);
    lnbitsWalletId = wallet.id;
    lnbitsAdminKey = wallet.adminKey;
    lnbitsInvoiceKey = wallet.invoiceKey;
    console.log(`[staking] Created LNbits wallet for pool: ${wallet.id}`);
  } catch (err) {
    console.warn('[staking] Failed to create LNbits wallet (Lightning payments will be unavailable for this pool):', err instanceof Error ? err.message : err);
  }

  const [pool] = await db
    .insert(vouchPools)
    .values({
      agentId,
      activityFeeRateBps: Math.min(1000, Math.max(200, activityFeeRateBps)), // clamp 2-10%
      lnbitsWalletId,
      lnbitsAdminKey,
      lnbitsInvoiceKey,
    })
    .returning({ id: vouchPools.id });

  return pool!.id;
}

/** Get pool by agent ID (public-safe — excludes wallet keys) */
export async function getPoolByAgent(agentId: string) {
  const [pool] = await db
    .select({
      id: vouchPools.id,
      agentId: vouchPools.agentId,
      totalStakedSats: vouchPools.totalStakedSats,
      totalStakers: vouchPools.totalStakers,
      totalYieldPaidSats: vouchPools.totalYieldPaidSats,
      totalSlashedSats: vouchPools.totalSlashedSats,
      activityFeeRateBps: vouchPools.activityFeeRateBps,
      status: vouchPools.status,
      createdAt: vouchPools.createdAt,
    })
    .from(vouchPools)
    .where(eq(vouchPools.agentId, agentId))
    .limit(1);

  return pool ?? null;
}

/** Get pool by agent ID with wallet keys (internal use only — NEVER expose to API responses) */
export async function getPoolByAgentInternal(agentId: string) {
  const [pool] = await db
    .select()
    .from(vouchPools)
    .where(eq(vouchPools.agentId, agentId))
    .limit(1);

  return pool ?? null;
}

/** Get pool with agent info */
export async function getPoolSummary(poolId: string): Promise<PoolSummary | null> {
  const [row] = await db
    .select({
      id: vouchPools.id,
      agentId: vouchPools.agentId,
      agentName: agents.name,
      totalStakedSats: vouchPools.totalStakedSats,
      totalStakers: vouchPools.totalStakers,
      totalYieldPaidSats: vouchPools.totalYieldPaidSats,
      activityFeeRateBps: vouchPools.activityFeeRateBps,
      status: vouchPools.status,
      createdAt: vouchPools.createdAt,
    })
    .from(vouchPools)
    .innerJoin(agents, eq(agents.id, vouchPools.agentId))
    .where(eq(vouchPools.id, poolId))
    .limit(1);

  return row ?? null;
}

/** List all active pools with agent info */
export async function listPools(page = 1, limit = 25) {
  const offset = (page - 1) * limit;

  const rows = await db
    .select({
      id: vouchPools.id,
      agentId: vouchPools.agentId,
      agentName: agents.name,
      totalStakedSats: vouchPools.totalStakedSats,
      totalStakers: vouchPools.totalStakers,
      totalYieldPaidSats: vouchPools.totalYieldPaidSats,
      activityFeeRateBps: vouchPools.activityFeeRateBps,
      status: vouchPools.status,
      createdAt: vouchPools.createdAt,
    })
    .from(vouchPools)
    .innerJoin(agents, eq(agents.id, vouchPools.agentId))
    .where(eq(vouchPools.status, 'active'))
    .orderBy(sql`${vouchPools.totalStakedSats} DESC`)
    .limit(limit)
    .offset(offset);

  const countResult = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(vouchPools)
    .where(eq(vouchPools.status, 'active'));

  const count = countResult[0]?.count ?? 0;

  return {
    data: rows,
    meta: { page, limit, total: count, has_more: offset + limit < count },
  };
}

// ── Validation Helpers ──

function assertPositiveInt(value: number, name: string, max?: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  if (max !== undefined && value > max) {
    throw new Error(`${name} exceeds maximum of ${max}`);
  }
}

async function assertPoolActive(poolId: string, txDb: typeof db = db): Promise<void> {
  const [pool] = await txDb
    .select({ status: vouchPools.status })
    .from(vouchPools)
    .where(eq(vouchPools.id, poolId))
    .limit(1);

  if (!pool) throw new Error('Pool not found');
  if (pool.status !== 'active') throw new Error(`Pool is ${pool.status} — operation not allowed`);
}

// ── Staking ──

/** Stake funds to back an agent. Atomic transaction. */
export async function stake(
  poolId: string,
  stakerId: string,
  stakerType: 'user' | 'agent',
  amountSats: number,
  stakerTrustScore: number,
): Promise<StakeResult> {
  assertPositiveInt(amountSats, 'amount_sats', MAX_STAKE_SATS);
  if (amountSats < MIN_STAKE_SATS) throw new Error(`Minimum stake is ${MIN_STAKE_SATS} sats`);

  const feeSats = Math.round((amountSats * STAKING_FEE_BPS) / 10000);
  const netStakedSats = amountSats - feeSats;

  return await db.transaction(async (tx) => {
    // Lock pool row and verify active status
    const [pool] = await tx
      .select({ id: vouchPools.id, status: vouchPools.status })
      .from(vouchPools)
      .where(eq(vouchPools.id, poolId))
      .for('update');

    if (!pool) throw new Error('Pool not found');
    if (pool.status !== 'active') throw new Error(`Pool is ${pool.status} — staking not allowed`);

    const stakeRows = await tx
      .insert(stakes)
      .values({
        poolId,
        stakerId,
        stakerType,
        amountSats: netStakedSats,
        stakerTrustAtStake: stakerTrustScore,
      })
      .returning({ id: stakes.id });

    const stakeId = stakeRows[0]!.id;

    // Update pool totals
    await tx
      .update(vouchPools)
      .set({
        totalStakedSats: sql`${vouchPools.totalStakedSats} + ${netStakedSats}`,
        totalStakers: sql`${vouchPools.totalStakers} + 1`,
      })
      .where(eq(vouchPools.id, poolId));

    // Record platform fee in treasury
    if (feeSats > 0) {
      await tx.insert(treasury).values({
        amountSats: feeSats,
        sourceType: 'platform_fee',
        sourceId: stakeId,
        description: `Staking fee: ${stakerId} → pool ${poolId}`,
      });
    }

    return {
      stakeId,
      poolId,
      amountSats,
      feeSats,
      netStakedSats,
    };
  });
}

/**
 * Initiate a stake with a pending Lightning payment.
 * Creates a pending stake + LNbits invoice. Finalized by webhook.
 */
export async function initiateStake(
  poolId: string,
  stakerId: string,
  stakerType: 'user' | 'agent',
  amountSats: number,
  stakerTrustScore: number,
  createInvoiceFn: (invoiceKey: string, amount: number, memo: string, webhookPath?: string) => Promise<{ paymentHash: string; paymentRequest: string }>,
): Promise<InitiateStakeResult> {
  assertPositiveInt(amountSats, 'amount_sats', MAX_STAKE_SATS);
  if (amountSats < MIN_STAKE_SATS) throw new Error(`Minimum stake is ${MIN_STAKE_SATS} sats`);

  const feeSats = Math.round((amountSats * STAKING_FEE_BPS) / 10000);

  return await db.transaction(async (tx) => {
    // Lock pool row and verify active + has wallet
    const [pool] = await tx
      .select({
        id: vouchPools.id,
        status: vouchPools.status,
        lnbitsInvoiceKey: vouchPools.lnbitsInvoiceKey,
      })
      .from(vouchPools)
      .where(eq(vouchPools.id, poolId))
      .for('update');

    if (!pool) throw new Error('Pool not found');
    if (pool.status !== 'active') throw new Error(`Pool is ${pool.status} — staking not allowed`);
    if (!pool.lnbitsInvoiceKey) throw new Error('Pool has no Lightning wallet configured');

    // Create pending stake
    const stakeRows = await tx
      .insert(stakes)
      .values({
        poolId,
        stakerId,
        stakerType,
        amountSats: amountSats, // full amount; fee deducted on finalization
        stakerTrustAtStake: stakerTrustScore,
        status: 'pending',
      })
      .returning({ id: stakes.id });

    const stakeId = stakeRows[0]!.id;

    // Create LNbits invoice on pool wallet
    // Webhook URL does NOT include the secret — auth uses HMAC-SHA256 signature header
    const invoice = await createInvoiceFn(
      pool.lnbitsInvoiceKey,
      amountSats,
      `Vouch stake: ${stakerId} → pool ${poolId}`,
      '/v1/webhooks/lnbits/stake-confirmed',
    );

    // Record payment event
    await tx.insert(paymentEvents).values({
      paymentHash: invoice.paymentHash,
      bolt11: invoice.paymentRequest,
      amountSats,
      purpose: 'stake',
      status: 'pending',
      poolId,
      stakeId,
      stakerId,
      lnbitsWalletId: null,
    });

    return {
      stakeId,
      poolId,
      paymentRequest: invoice.paymentRequest,
      paymentHash: invoice.paymentHash,
      amountSats,
      feeSats,
    };
  });
}

/**
 * Finalize a stake after Lightning payment confirmed (called by webhook).
 * Idempotent — returns early if already finalized.
 * Verifies payment amount against LNbits before activating.
 */
export async function finalizeStake(paymentHash: string): Promise<StakeResult | null> {
  return await db.transaction(async (tx) => {
    // Lock payment event
    const [payment] = await tx
      .select()
      .from(paymentEvents)
      .where(eq(paymentEvents.paymentHash, paymentHash))
      .for('update');

    if (!payment) return null;
    if (payment.status === 'paid') return null; // already processed (idempotent)
    if (payment.purpose !== 'stake') return null;

    // S4 fix: Verify payment amount against LNbits
    // Cross-check that the actual paid amount matches what we expected
    try {
      const { getPaymentStatus } = await import('./lnbits-service');
      // Use the pool's invoice key to check payment status
      const [pool] = await tx
        .select({ lnbitsInvoiceKey: vouchPools.lnbitsInvoiceKey })
        .from(vouchPools)
        .where(eq(vouchPools.id, payment.poolId!))
        .limit(1);

      if (pool?.lnbitsInvoiceKey) {
        const lnbitsStatus = await getPaymentStatus(pool.lnbitsInvoiceKey, paymentHash);
        if (!lnbitsStatus.paid) {
          console.warn(`[staking] finalizeStake: LNbits says payment ${paymentHash} is NOT paid — rejecting`);
          return null;
        }
        if (lnbitsStatus.amount !== payment.amountSats) {
          console.error(`[staking] AMOUNT MISMATCH: expected ${payment.amountSats} sats, LNbits reports ${lnbitsStatus.amount} sats for payment ${paymentHash}`);
          // Mark payment as failed — do not activate stake
          await tx
            .update(paymentEvents)
            .set({ status: 'failed', updatedAt: new Date(), metadata: sql`jsonb_set(COALESCE(${paymentEvents.metadata}, '{}'), '{amount_mismatch}', 'true')` })
            .where(eq(paymentEvents.id, payment.id));
          return null;
        }
      }
    } catch (err) {
      // If LNbits is unreachable, fail safe — don't activate stake without verification
      console.error(`[staking] Cannot verify payment ${paymentHash} with LNbits — failing safe:`, err instanceof Error ? err.message : err);
      return null;
    }

    // Mark payment as paid
    await tx
      .update(paymentEvents)
      .set({
        status: 'paid',
        webhookReceivedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(paymentEvents.id, payment.id));

    // Lock and activate the stake
    const [stakeRecord] = await tx
      .select()
      .from(stakes)
      .where(and(eq(stakes.id, payment.stakeId!), eq(stakes.status, 'pending')))
      .for('update');

    if (!stakeRecord) return null;

    const feeSats = Math.round((payment.amountSats * STAKING_FEE_BPS) / 10000);
    const netStakedSats = payment.amountSats - feeSats;

    // Activate stake with net amount
    await tx
      .update(stakes)
      .set({
        status: 'active',
        amountSats: netStakedSats,
        stakedAt: new Date(),
      })
      .where(eq(stakes.id, stakeRecord.id));

    // Update pool totals
    await tx
      .update(vouchPools)
      .set({
        totalStakedSats: sql`${vouchPools.totalStakedSats} + ${netStakedSats}`,
        totalStakers: sql`${vouchPools.totalStakers} + 1`,
      })
      .where(eq(vouchPools.id, payment.poolId!));

    // Record staking fee in treasury
    if (feeSats > 0) {
      await tx.insert(treasury).values({
        amountSats: feeSats,
        sourceType: 'platform_fee',
        sourceId: stakeRecord.id,
        description: `Staking fee: ${payment.stakerId} → pool ${payment.poolId}`,
      });
    }

    return {
      stakeId: stakeRecord.id,
      poolId: payment.poolId!,
      amountSats: payment.amountSats,
      feeSats,
      netStakedSats,
    };
  });
}

/** Request unstake — begins 7-day notice period. Atomic. */
export async function requestUnstake(stakeId: string, stakerId: string): Promise<UnstakeResult> {
  return await db.transaction(async (tx) => {
    // Lock the stake row
    const [stakeRecord] = await tx
      .select()
      .from(stakes)
      .where(and(eq(stakes.id, stakeId), eq(stakes.stakerId, stakerId), eq(stakes.status, 'active')))
      .for('update');

    if (!stakeRecord) {
      throw new Error('Active stake not found');
    }

    const withdrawableAt = new Date(Date.now() + UNSTAKE_NOTICE_DAYS * 24 * 60 * 60 * 1000);

    await tx
      .update(stakes)
      .set({
        status: 'unstaking',
        unstakeRequestedAt: new Date(),
      })
      .where(eq(stakes.id, stakeId));

    return { stakeId, withdrawableAt };
  });
}

export interface WithdrawResult {
  amountSats: number;
  paymentStatus: 'paid' | 'pending' | 'no_lightning';
}

/**
 * Complete withdrawal after notice period. Atomic with row lock to prevent double-withdraw.
 * Attempts to send sats back via Lightning. If Lightning unavailable, marks as pending.
 * @param bolt11 Optional BOLT11 invoice from the staker for withdrawal
 */
export async function withdraw(stakeId: string, stakerId: string, bolt11?: string): Promise<WithdrawResult> {
  const { amountSats, poolId } = await db.transaction(async (tx) => {
    // Lock the stake row — prevents concurrent withdrawals (C3 fix)
    const [stakeRecord] = await tx
      .select()
      .from(stakes)
      .where(and(eq(stakes.id, stakeId), eq(stakes.stakerId, stakerId), eq(stakes.status, 'unstaking')))
      .for('update');

    if (!stakeRecord) {
      throw new Error('Unstaking stake not found');
    }

    if (!stakeRecord.unstakeRequestedAt) {
      throw new Error('No unstake request found');
    }

    const withdrawableAt = new Date(stakeRecord.unstakeRequestedAt.getTime() + UNSTAKE_NOTICE_DAYS * 24 * 60 * 60 * 1000);
    if (new Date() < withdrawableAt) {
      throw new Error(`Cannot withdraw until ${withdrawableAt.toISOString()}`);
    }

    await tx
      .update(stakes)
      .set({ status: 'withdrawn', withdrawnAt: new Date() })
      .where(eq(stakes.id, stakeId));

    // Lock pool row, then update totals
    await tx
      .select({ id: vouchPools.id })
      .from(vouchPools)
      .where(eq(vouchPools.id, stakeRecord.poolId))
      .for('update');

    await tx
      .update(vouchPools)
      .set({
        totalStakedSats: sql`GREATEST(${vouchPools.totalStakedSats} - ${stakeRecord.amountSats}, 0)`,
        totalStakers: sql`GREATEST(${vouchPools.totalStakers} - 1, 0)`,
      })
      .where(eq(vouchPools.id, stakeRecord.poolId));

    return { amountSats: stakeRecord.amountSats, poolId: stakeRecord.poolId };
  });

  // After DB transaction: attempt Lightning transfer
  const paymentStatus = await executeWithdrawalPayout(stakeId, stakerId, amountSats, poolId, bolt11);

  return { amountSats, paymentStatus };
}

/**
 * Send sats back to staker after withdrawal. Non-blocking on Lightning failure.
 */
async function executeWithdrawalPayout(
  stakeId: string,
  stakerId: string,
  amountSats: number,
  poolId: string,
  bolt11?: string,
): Promise<'paid' | 'pending' | 'no_lightning'> {
  try {
    const { internalTransfer, payInvoice } = await import('./lnbits-service');

    // Get pool's admin key
    const [pool] = await db
      .select({ lnbitsAdminKey: vouchPools.lnbitsAdminKey })
      .from(vouchPools)
      .where(eq(vouchPools.id, poolId))
      .limit(1);

    if (!pool?.lnbitsAdminKey) {
      return 'no_lightning';
    }

    // Option 1: Staker provided a BOLT11 invoice — pay it directly
    if (bolt11) {
      try {
        const payment = await payInvoice(pool.lnbitsAdminKey, bolt11);
        await db.insert(paymentEvents).values({
          paymentHash: payment.paymentHash,
          bolt11,
          amountSats,
          purpose: 'withdraw',
          status: 'paid',
          poolId,
          stakeId,
          stakerId,
          webhookReceivedAt: new Date(),
        });
        return 'paid';
      } catch (err) {
        console.error(`[staking] Withdrawal payment failed for stake ${stakeId}:`, err instanceof Error ? err.message : err);
        await db.insert(paymentEvents).values({
          paymentHash: `withdraw-${stakeId}-${Date.now()}`,
          bolt11,
          amountSats,
          purpose: 'withdraw',
          status: 'pending',
          poolId,
          stakeId,
          stakerId,
          metadata: { error: err instanceof Error ? err.message : String(err) },
        });
        return 'pending';
      }
    }

    // Option 2: Staker is an agent with their own pool wallet — internal transfer
    const [stakerPool] = await db
      .select({ lnbitsInvoiceKey: vouchPools.lnbitsInvoiceKey })
      .from(vouchPools)
      .where(eq(vouchPools.agentId, stakerId))
      .limit(1);

    if (stakerPool?.lnbitsInvoiceKey) {
      try {
        const payment = await internalTransfer(
          pool.lnbitsAdminKey,
          stakerPool.lnbitsInvoiceKey,
          amountSats,
          `Withdrawal: stake ${stakeId}`,
        );
        await db.insert(paymentEvents).values({
          paymentHash: payment.paymentHash,
          amountSats,
          purpose: 'withdraw',
          status: 'paid',
          poolId,
          stakeId,
          stakerId,
          webhookReceivedAt: new Date(),
        });
        return 'paid';
      } catch (err) {
        console.error(`[staking] Internal withdrawal transfer failed for stake ${stakeId}:`, err instanceof Error ? err.message : err);
      }
    }

    // No way to send — record as pending
    await db.insert(paymentEvents).values({
      paymentHash: `withdraw-${stakeId}-${Date.now()}`,
      amountSats,
      purpose: 'withdraw',
      status: 'pending',
      poolId,
      stakeId,
      stakerId,
      metadata: { reason: 'no_wallet_or_invoice' },
    });
    return 'pending';
  } catch (err) {
    console.warn('[staking] Lightning withdrawal unavailable:', err instanceof Error ? err.message : err);
    return 'no_lightning';
  }
}

/** Get active stakes for a staker */
export async function getStakerPositions(stakerId: string, stakerType: 'user' | 'agent') {
  return db
    .select({
      stakeId: stakes.id,
      poolId: stakes.poolId,
      agentId: vouchPools.agentId,
      agentName: agents.name,
      amountSats: stakes.amountSats,
      status: stakes.status,
      stakedAt: stakes.stakedAt,
      unstakeRequestedAt: stakes.unstakeRequestedAt,
    })
    .from(stakes)
    .innerJoin(vouchPools, eq(vouchPools.id, stakes.poolId))
    .innerJoin(agents, eq(agents.id, vouchPools.agentId))
    .where(and(eq(stakes.stakerId, stakerId), eq(stakes.stakerType, stakerType)));
}

/** Get payment status for a stake */
export async function getStakePaymentStatus(stakeId: string) {
  const [payment] = await db
    .select({
      paymentHash: paymentEvents.paymentHash,
      status: paymentEvents.status,
      amountSats: paymentEvents.amountSats,
      createdAt: paymentEvents.createdAt,
      webhookReceivedAt: paymentEvents.webhookReceivedAt,
    })
    .from(paymentEvents)
    .where(and(eq(paymentEvents.stakeId, stakeId), eq(paymentEvents.purpose, 'stake')))
    .limit(1);

  return payment ?? null;
}

// ── Activity Fees ──

/** Record an activity fee from an agent's revenue. Validates pool is active. */
export async function recordActivityFee(
  agentId: string,
  actionType: string,
  grossRevenueSats: number,
): Promise<number> {
  assertPositiveInt(grossRevenueSats, 'gross_revenue_sats', MAX_FEE_SATS);

  const pool = await getPoolByAgent(agentId);
  if (!pool) return 0;
  if (pool.status !== 'active') throw new Error(`Pool is ${pool.status} — cannot record fees`);

  const feeSats = Math.round((grossRevenueSats * pool.activityFeeRateBps) / 10000);
  if (feeSats <= 0) return 0;

  await db.insert(activityFees).values({
    poolId: pool.id,
    agentId,
    actionType,
    grossRevenueSats,
    feeSats,
  });

  return feeSats;
}

// ── Yield Distribution ──

/**
 * Distribute accumulated activity fees to stakers for a pool.
 * Atomic transaction. Only distributes fees not yet linked to a distribution (C4 fix).
 * Uses integer-only largest-remainder method for rounding (H11 fix).
 */
export async function distributeYield(
  poolId: string,
  periodStart: Date,
  periodEnd: Date,
): Promise<YieldDistributionResult | null> {
  const result = await db.transaction(async (tx) => {
    // Lock pool row and verify active status
    const [pool] = await tx
      .select({ id: vouchPools.id, status: vouchPools.status })
      .from(vouchPools)
      .where(eq(vouchPools.id, poolId))
      .for('update');

    if (!pool) throw new Error('Pool not found');
    if (pool.status !== 'active') throw new Error(`Pool is ${pool.status} — distribution not allowed`);

    // Sum UNDISTRIBUTED activity fees for this period (C4 fix: only where distributionId IS NULL)
    const feeSumRows = await tx
      .select({ total: sql<number>`COALESCE(SUM(${activityFees.feeSats}), 0)::int` })
      .from(activityFees)
      .where(
        and(
          eq(activityFees.poolId, poolId),
          isNull(activityFees.distributionId),
          sql`${activityFees.createdAt} >= ${periodStart}`,
          sql`${activityFees.createdAt} < ${periodEnd}`,
        ),
      );

    const totalAmountSats = feeSumRows[0]?.total ?? 0;
    if (totalAmountSats <= 0) return null;

    const platformFeeSats = Math.round((totalAmountSats * PLATFORM_FEE_BPS) / 10000);
    const distributedAmountSats = totalAmountSats - platformFeeSats;

    // Get active stakes in this pool
    const activeStakes = await tx
      .select()
      .from(stakes)
      .where(and(eq(stakes.poolId, poolId), eq(stakes.status, 'active')));

    if (activeStakes.length === 0) return null;

    const totalStaked = activeStakes.reduce((sum, s) => sum + s.amountSats, 0);
    if (totalStaked <= 0) return null;

    // Create distribution record
    const distRows = await tx
      .insert(yieldDistributions)
      .values({
        poolId,
        totalAmountSats,
        platformFeeSats,
        distributedAmountSats,
        periodStart,
        periodEnd,
        stakerCount: activeStakes.length,
      })
      .returning({ id: yieldDistributions.id });

    const distId = distRows[0]!.id;

    // Mark fees as distributed (C4 fix: prevents replay)
    await tx
      .update(activityFees)
      .set({ distributionId: distId })
      .where(
        and(
          eq(activityFees.poolId, poolId),
          isNull(activityFees.distributionId),
          sql`${activityFees.createdAt} >= ${periodStart}`,
          sql`${activityFees.createdAt} < ${periodEnd}`,
        ),
      );

    // Integer-only largest-remainder distribution (H11 fix)
    // Step 1: compute each staker's raw share using integer division
    const shares = activeStakes.map((s) => {
      const rawSats = Math.floor((distributedAmountSats * s.amountSats) / totalStaked);
      const remainder = (distributedAmountSats * s.amountSats) % totalStaked;
      return { stake: s, rawSats, remainder };
    });

    // Step 2: distribute remaining sats to largest remainders
    let distributed = shares.reduce((sum, s) => sum + s.rawSats, 0);
    let remaining = distributedAmountSats - distributed;

    // Sort by remainder descending, then by stake ID for determinism
    shares.sort((a, b) => b.remainder - a.remainder || a.stake.id.localeCompare(b.stake.id));

    for (const share of shares) {
      if (remaining <= 0) break;
      share.rawSats += 1;
      remaining -= 1;
    }

    // Step 3: insert receipts
    for (const share of shares) {
      const proportionBps = Math.round((share.stake.amountSats / totalStaked) * 10000);
      await tx.insert(yieldReceipts).values({
        distributionId: distId,
        stakeId: share.stake.id,
        amountSats: share.rawSats,
        stakeProportionBps: proportionBps,
      });
    }

    // Update pool yield total
    await tx
      .update(vouchPools)
      .set({
        totalYieldPaidSats: sql`${vouchPools.totalYieldPaidSats} + ${distributedAmountSats}`,
      })
      .where(eq(vouchPools.id, poolId));

    // Record platform fee in treasury
    if (platformFeeSats > 0) {
      await tx.insert(treasury).values({
        amountSats: platformFeeSats,
        sourceType: 'platform_fee',
        sourceId: distId,
        description: `Yield distribution fee: pool ${poolId}`,
      });
    }

    return {
      distributionId: distId,
      poolId,
      totalAmountSats,
      platformFeeSats,
      distributedAmountSats,
      stakerCount: activeStakes.length,
    };
  });

  // After DB transaction completes, attempt Lightning payouts (non-blocking)
  if (result) {
    executeYieldPayouts(result.distributionId, result.poolId, result.platformFeeSats).catch((err) => {
      console.error('[staking] executeYieldPayouts error:', err);
    });
  }

  return result;
}

// ── Lightning Yield Payout ──

/**
 * After yield receipts are computed in DB, attempt to move actual sats.
 * Called after distributeYield() completes its DB transaction.
 * Non-blocking — if Lightning transfers fail, yields are still recorded.
 */
async function executeYieldPayouts(
  distributionId: string,
  poolId: string,
  platformFeeSats: number,
): Promise<{ paid: number; pending: number; failed: number }> {
  let paid = 0;
  let pending = 0;
  let failed = 0;

  try {
    const { internalTransfer } = await import('./lnbits-service');
    const { getTreasuryInvoiceKey } = await import('./treasury-service');

    // Get the pool's admin key (needed to send sats OUT of the pool)
    const [pool] = await db
      .select({
        lnbitsAdminKey: vouchPools.lnbitsAdminKey,
        lnbitsInvoiceKey: vouchPools.lnbitsInvoiceKey,
      })
      .from(vouchPools)
      .where(eq(vouchPools.id, poolId))
      .limit(1);

    if (!pool?.lnbitsAdminKey) {
      console.warn(`[staking] Pool ${poolId} has no LNbits admin key — all payouts pending`);
      return { paid: 0, pending: 0, failed: 0 };
    }

    // Get all yield receipts for this distribution with stake info
    const receipts = await db
      .select({
        receiptId: yieldReceipts.id,
        stakeId: yieldReceipts.stakeId,
        amountSats: yieldReceipts.amountSats,
        stakerId: stakes.stakerId,
        stakerType: stakes.stakerType,
      })
      .from(yieldReceipts)
      .innerJoin(stakes, eq(stakes.id, yieldReceipts.stakeId))
      .where(eq(yieldReceipts.distributionId, distributionId));

    // Process each staker's payout
    for (const receipt of receipts) {
      if (receipt.amountSats <= 0) continue;

      // Try to find a wallet for this staker
      // If staker is an agent, check if they have their own pool with a wallet
      let stakerInvoiceKey: string | null = null;

      if (receipt.stakerType === 'agent') {
        const [stakerPool] = await db
          .select({ lnbitsInvoiceKey: vouchPools.lnbitsInvoiceKey })
          .from(vouchPools)
          .where(eq(vouchPools.agentId, receipt.stakerId))
          .limit(1);

        stakerInvoiceKey = stakerPool?.lnbitsInvoiceKey ?? null;
      }

      if (stakerInvoiceKey) {
        // Staker has an LNbits wallet — transfer sats
        try {
          await internalTransfer(
            pool.lnbitsAdminKey,
            stakerInvoiceKey,
            receipt.amountSats,
            `Yield payout: distribution ${distributionId}`,
          );

          // Record successful payout
          await db.insert(paymentEvents).values({
            paymentHash: `yield-${distributionId}-${receipt.stakeId}`,
            amountSats: receipt.amountSats,
            purpose: 'yield',
            status: 'paid',
            poolId,
            stakeId: receipt.stakeId,
            stakerId: receipt.stakerId,
            webhookReceivedAt: new Date(),
          });

          paid++;
        } catch (err) {
          console.error(`[staking] Yield payout failed for staker ${receipt.stakerId}:`, err instanceof Error ? err.message : err);
          // Record as pending — can retry later
          await db.insert(paymentEvents).values({
            paymentHash: `yield-${distributionId}-${receipt.stakeId}`,
            amountSats: receipt.amountSats,
            purpose: 'yield',
            status: 'pending',
            poolId,
            stakeId: receipt.stakeId,
            stakerId: receipt.stakerId,
            metadata: { error: err instanceof Error ? err.message : String(err) },
          });
          failed++;
        }
      } else {
        // No wallet — record pending payout for later claim
        await db.insert(paymentEvents).values({
          paymentHash: `yield-${distributionId}-${receipt.stakeId}`,
          amountSats: receipt.amountSats,
          purpose: 'yield',
          status: 'pending',
          poolId,
          stakeId: receipt.stakeId,
          stakerId: receipt.stakerId,
          metadata: { reason: 'no_wallet' },
        });
        pending++;
      }
    }

    // Transfer platform fee to treasury wallet
    if (platformFeeSats > 0) {
      try {
        const treasuryInvoiceKey = getTreasuryInvoiceKey();
        await internalTransfer(
          pool.lnbitsAdminKey,
          treasuryInvoiceKey,
          platformFeeSats,
          `Platform fee: distribution ${distributionId}`,
        );
        console.log(`[staking] Platform fee ${platformFeeSats} sats transferred to treasury`);
      } catch (err) {
        console.error('[staking] Platform fee transfer to treasury failed:', err instanceof Error ? err.message : err);
      }
    }
  } catch (err) {
    console.warn('[staking] Lightning yield payouts unavailable:', err instanceof Error ? err.message : err);
  }

  console.log(`[staking] Yield payouts for dist ${distributionId}: ${paid} paid, ${pending} pending, ${failed} failed`);
  return { paid, pending, failed };
}

// ── Slashing ──

/** Slash a pool due to agent misconduct. Atomic transaction with bounds checking. */
export async function slashPool(
  poolId: string,
  reason: string,
  evidenceHash: string,
  slashBps: number,
  violationId?: string,
): Promise<{ totalSlashed: number; affectedStakers: number }> {
  // H8 fix: bound slashBps to 0-10000
  if (!Number.isInteger(slashBps) || slashBps < 1 || slashBps > 10000) {
    throw new Error('slashBps must be an integer between 1 and 10000');
  }

  return await db.transaction(async (tx) => {
    // Lock pool row
    const [pool] = await tx
      .select()
      .from(vouchPools)
      .where(eq(vouchPools.id, poolId))
      .for('update');

    if (!pool) throw new Error('Pool not found');

    // Cap slash to actual pool balance (prevents negative balances)
    const maxSlashSats = pool.totalStakedSats;
    const rawSlashSats = Math.round((pool.totalStakedSats * slashBps) / 10000);
    const totalSlashedSats = Math.min(rawSlashSats, maxSlashSats);

    if (totalSlashedSats <= 0) {
      return { totalSlashed: 0, affectedStakers: 0 };
    }

    const toAffectedSats = Math.round((totalSlashedSats * SLASH_TO_AFFECTED_BPS) / 10000);
    const toTreasurySats = totalSlashedSats - toAffectedSats;

    // Record slash event
    await tx.insert(slashEvents).values({
      poolId,
      reason,
      evidenceHash,
      totalSlashedSats,
      toAffectedSats,
      toTreasurySats,
      violationId,
    });

    // Lock and reduce each active stake proportionally
    const activeStakes = await tx
      .select()
      .from(stakes)
      .where(and(eq(stakes.poolId, poolId), eq(stakes.status, 'active')))
      .for('update');

    for (const s of activeStakes) {
      const stakeLoss = Math.min(
        Math.round((s.amountSats * slashBps) / 10000),
        s.amountSats, // never slash more than the stake holds
      );
      await tx
        .update(stakes)
        .set({ amountSats: sql`GREATEST(${stakes.amountSats} - ${stakeLoss}, 0)` })
        .where(eq(stakes.id, s.id));
    }

    // Update pool totals
    await tx
      .update(vouchPools)
      .set({
        totalStakedSats: sql`GREATEST(${vouchPools.totalStakedSats} - ${totalSlashedSats}, 0)`,
        totalSlashedSats: sql`${vouchPools.totalSlashedSats} + ${totalSlashedSats}`,
      })
      .where(eq(vouchPools.id, poolId));

    // Record treasury income
    if (toTreasurySats > 0) {
      await tx.insert(treasury).values({
        amountSats: toTreasurySats,
        sourceType: 'slash',
        sourceId: poolId,
        description: `Slash: ${reason}`,
      });
    }

    return { totalSlashed: totalSlashedSats, affectedStakers: activeStakes.length };
  });
}

// ── Vouch Score (Enhanced Trust Score) ──

/**
 * Compute the backing component for Vouch score.
 * Based on total backing amount + quality of stakers.
 * Returns 0-1000 range.
 */
export async function computeBackingComponent(subjectId: string, subjectType: 'user' | 'agent'): Promise<number> {
  if (subjectType === 'user') return 0; // Users don't have backing pools (yet)

  const pool = await getPoolByAgent(subjectId);
  if (!pool) return 0;

  // Amount component: log scale, caps at ~1 BTC backing
  const amountScore = Math.min(500, Math.round(100 * Math.log10(pool.totalStakedSats / 10000 + 1)));

  // Staker quality: average trust score of active stakers (weighted by stake)
  const activeStakes = await db
    .select({ amountSats: stakes.amountSats, stakerTrust: stakes.stakerTrustAtStake })
    .from(stakes)
    .where(and(eq(stakes.poolId, pool.id), eq(stakes.status, 'active')));

  let qualityScore = 0;
  if (activeStakes.length > 0) {
    const totalStaked = activeStakes.reduce((sum, s) => sum + s.amountSats, 0);
    const weightedTrust = activeStakes.reduce((sum, s) => sum + s.stakerTrust * (s.amountSats / totalStaked), 0);
    qualityScore = Math.min(500, Math.round(weightedTrust / 2)); // half of avg staker trust, max 500
  }

  return Math.min(1000, amountScore + qualityScore);
}

// ── Pending Stake Cleanup (S9 fix) ──

const PENDING_STAKE_EXPIRY_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Expire pending stakes and their payment events older than 15 minutes.
 * Called by a periodic cron. Prevents orphaned pending stakes from accumulating.
 */
export async function cleanupExpiredPendingStakes(): Promise<number> {
  const cutoff = new Date(Date.now() - PENDING_STAKE_EXPIRY_MS);

  // Find expired pending stakes
  const expiredStakes = await db
    .select({ id: stakes.id })
    .from(stakes)
    .where(and(eq(stakes.status, 'pending'), sql`${stakes.stakedAt} < ${cutoff}`));

  if (expiredStakes.length === 0) return 0;

  const expiredIds = expiredStakes.map(s => s.id);

  // Mark corresponding payment events as expired
  for (const stakeId of expiredIds) {
    await db
      .update(paymentEvents)
      .set({ status: 'expired', updatedAt: new Date() })
      .where(and(eq(paymentEvents.stakeId, stakeId), eq(paymentEvents.status, 'pending')));
  }

  // Delete the pending stakes (they never held real funds)
  for (const stakeId of expiredIds) {
    await db
      .update(stakes)
      .set({ status: 'withdrawn' }) // mark as withdrawn rather than deleting for audit trail
      .where(and(eq(stakes.id, stakeId), eq(stakes.status, 'pending')));
  }

  console.log(`[staking] Expired ${expiredIds.length} pending stake(s) older than 15 minutes`);
  return expiredIds.length;
}

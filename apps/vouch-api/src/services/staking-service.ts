// Vouch — Staking Engine (NWC / Alby Hub)
// Handles pool creation, staking, unstaking, yield distribution, and slashing.
// All financial operations use DB transactions for atomicity (C3 fix).
// All amounts are in sats (Lightning-native).
// NON-CUSTODIAL: Stake locks = NWC budget authorizations. Funds stay in user wallets.

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
  nwcConnections,
} from '@percival/vouch-db';

// ── Constants ──

const PLATFORM_FEE_BPS = 100; // 1% — lowest viable rate, covers infrastructure with thin margin
const STAKING_FEE_BPS = 0; // 0% — zero deposit fee, optimize for participation not extraction
const UNSTAKE_NOTICE_DAYS = 7;
const SLASH_TO_AFFECTED_BPS = 10000; // 100% to damaged party
const SLASH_TO_TREASURY_BPS = 0; // PL takes 0% of slashes — revenue comes from activity fees, not bad events
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
  amountSats: number;
  feeSats: number;
  nwcRequired: true;
  budgetSats: number;
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

/** Create a staking pool for an agent. One pool per agent. No per-pool wallets needed (non-custodial). */
export async function createPool(agentId: string, activityFeeRateBps = 500): Promise<string> {
  const [pool] = await db
    .insert(vouchPools)
    .values({
      agentId,
      activityFeeRateBps: Math.min(1000, Math.max(200, activityFeeRateBps)), // clamp 2-10%
    })
    .returning({ id: vouchPools.id });

  console.log(`[staking] Created pool for agent ${agentId}: ${pool!.id}`);
  return pool!.id;
}

/** Get pool by agent ID (public-safe) */
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

// ── Staking (NWC-based non-custodial flow) ──

/** Direct stake — used for PL treasury auto-staking and test/migration paths. Atomic transaction. */
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
 * Initiate a stake — NWC non-custodial flow.
 * Creates a pending stake. Client must then connect wallet via NWC to finalize.
 * No Lightning invoice is created — the NWC budget authorization IS the commitment.
 */
export async function initiateStake(
  poolId: string,
  stakerId: string,
  stakerType: 'user' | 'agent',
  amountSats: number,
  stakerTrustScore: number,
): Promise<InitiateStakeResult> {
  assertPositiveInt(amountSats, 'amount_sats', MAX_STAKE_SATS);
  if (amountSats < MIN_STAKE_SATS) throw new Error(`Minimum stake is ${MIN_STAKE_SATS} sats`);

  const feeSats = Math.round((amountSats * STAKING_FEE_BPS) / 10000);

  return await db.transaction(async (tx) => {
    // Lock pool row and verify active
    const [pool] = await tx
      .select({ id: vouchPools.id, status: vouchPools.status })
      .from(vouchPools)
      .where(eq(vouchPools.id, poolId))
      .for('update');

    if (!pool) throw new Error('Pool not found');
    if (pool.status !== 'active') throw new Error(`Pool is ${pool.status} — staking not allowed`);

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

    return {
      stakeId,
      poolId,
      amountSats,
      feeSats,
      nwcRequired: true as const,
      budgetSats: amountSats, // user must authorize at least this much
    };
  });
}

/**
 * Finalize a stake after NWC wallet connection is established.
 * Verifies the NWC connection has sufficient budget authorization, then activates the stake.
 * Idempotent — returns early if already finalized.
 */
export async function finalizeStake(stakeId: string, nwcConnectionId: string): Promise<StakeResult | null> {
  return await db.transaction(async (tx) => {
    // Lock the pending stake
    const [stakeRecord] = await tx
      .select()
      .from(stakes)
      .where(and(eq(stakes.id, stakeId), eq(stakes.status, 'pending')))
      .for('update');

    if (!stakeRecord) return null;

    // Verify NWC connection is active and has sufficient budget
    const [conn] = await tx
      .select()
      .from(nwcConnections)
      .where(and(eq(nwcConnections.id, nwcConnectionId), eq(nwcConnections.status, 'active')))
      .limit(1);

    if (!conn) throw new Error('NWC connection not found or inactive');

    const remainingBudget = conn.budgetSats - conn.spentSats;
    if (remainingBudget < stakeRecord.amountSats) {
      throw new Error(`NWC budget insufficient: ${remainingBudget} sats remaining, need ${stakeRecord.amountSats}`);
    }

    const feeSats = Math.round((stakeRecord.amountSats * STAKING_FEE_BPS) / 10000);
    const netStakedSats = stakeRecord.amountSats - feeSats;

    // Activate stake with NWC connection reference
    await tx
      .update(stakes)
      .set({
        status: 'active',
        amountSats: netStakedSats,
        nwcConnectionId,
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
      .where(eq(vouchPools.id, stakeRecord.poolId));

    // Record staking fee in treasury
    if (feeSats > 0) {
      await tx.insert(treasury).values({
        amountSats: feeSats,
        sourceType: 'platform_fee',
        sourceId: stakeRecord.id,
        description: `Staking fee: ${stakeRecord.stakerId} → pool ${stakeRecord.poolId}`,
      });
    }

    return {
      stakeId: stakeRecord.id,
      poolId: stakeRecord.poolId,
      amountSats: stakeRecord.amountSats,
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
  paymentStatus: 'completed' | 'no_yield';
}

/**
 * Complete withdrawal after notice period. Non-custodial: principal is already in user's wallet.
 * Only yield (if any) needs to be paid from treasury to user via NWC.
 */
export async function withdraw(stakeId: string, stakerId: string): Promise<WithdrawResult> {
  const { amountSats, poolId, nwcConnectionId } = await db.transaction(async (tx) => {
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

    return {
      amountSats: stakeRecord.amountSats,
      poolId: stakeRecord.poolId,
      nwcConnectionId: stakeRecord.nwcConnectionId,
    };
  });

  // Revoke the NWC connection after withdrawal completes
  if (nwcConnectionId) {
    try {
      const { revokeConnection } = await import('./nwc-service');
      await revokeConnection(nwcConnectionId);
    } catch (err) {
      console.warn(`[staking] Failed to revoke NWC connection ${nwcConnectionId}:`, err instanceof Error ? err.message : err);
    }
  }

  // Non-custodial: principal was never moved, so nothing to send back.
  // Any accumulated yield would have been paid via NWC during yield distributions.
  return { amountSats, paymentStatus: 'completed' };
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

/** Get stake status (for polling during NWC connection flow) */
export async function getStakeStatus(stakeId: string) {
  const [stakeRecord] = await db
    .select({
      id: stakes.id,
      status: stakes.status,
      amountSats: stakes.amountSats,
      nwcConnectionId: stakes.nwcConnectionId,
      stakedAt: stakes.stakedAt,
    })
    .from(stakes)
    .where(eq(stakes.id, stakeId))
    .limit(1);

  return stakeRecord ?? null;
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
    const shares = activeStakes.map((s) => {
      const rawSats = Math.floor((distributedAmountSats * s.amountSats) / totalStaked);
      const remainder = (distributedAmountSats * s.amountSats) % totalStaked;
      return { stake: s, rawSats, remainder };
    });

    let remaining = distributedAmountSats - shares.reduce((sum, s) => sum + s.rawSats, 0);
    shares.sort((a, b) => b.remainder - a.remainder || a.stake.id.localeCompare(b.stake.id));

    for (const share of shares) {
      if (remaining <= 0) break;
      share.rawSats += 1;
      remaining -= 1;
    }

    // Insert receipts
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

  // After DB transaction completes, attempt NWC yield payouts (non-blocking)
  if (result) {
    executeYieldPayouts(result.distributionId, result.poolId, result.platformFeeSats).catch((err) => {
      console.error('[staking] executeYieldPayouts error:', err);
    });
  }

  return result;
}

// ── NWC Yield Payout ──

/**
 * After yield receipts are computed in DB, attempt to send actual sats via NWC.
 * For each staker with an NWC connection: make_invoice on their wallet, platform pays.
 * Non-blocking — if NWC payments fail, yields are still recorded in DB.
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
    const { payYield } = await import('./nwc-service');

    // Get all yield receipts for this distribution with stake + NWC info
    const receipts = await db
      .select({
        receiptId: yieldReceipts.id,
        stakeId: yieldReceipts.stakeId,
        amountSats: yieldReceipts.amountSats,
        stakerId: stakes.stakerId,
        stakerType: stakes.stakerType,
        nwcConnectionId: stakes.nwcConnectionId,
      })
      .from(yieldReceipts)
      .innerJoin(stakes, eq(stakes.id, yieldReceipts.stakeId))
      .where(eq(yieldReceipts.distributionId, distributionId));

    for (const receipt of receipts) {
      if (receipt.amountSats <= 0) continue;

      if (receipt.nwcConnectionId) {
        try {
          const result = await payYield(receipt.nwcConnectionId, receipt.amountSats);

          await db.insert(paymentEvents).values({
            paymentHash: result.paymentHash,
            amountSats: receipt.amountSats,
            purpose: 'yield',
            status: 'paid',
            poolId,
            stakeId: receipt.stakeId,
            stakerId: receipt.stakerId,
            nwcConnectionId: receipt.nwcConnectionId,
            webhookReceivedAt: new Date(),
          });

          paid++;
        } catch (err) {
          console.error(`[staking] NWC yield payout failed for staker ${receipt.stakerId}:`, err instanceof Error ? err.message : err);
          await db.insert(paymentEvents).values({
            paymentHash: `yield-${distributionId}-${receipt.stakeId}`,
            amountSats: receipt.amountSats,
            purpose: 'yield',
            status: 'pending',
            poolId,
            stakeId: receipt.stakeId,
            stakerId: receipt.stakerId,
            nwcConnectionId: receipt.nwcConnectionId,
            metadata: { error: err instanceof Error ? err.message : String(err) },
          });
          failed++;
        }
      } else {
        // No NWC connection — record as pending for later claim
        await db.insert(paymentEvents).values({
          paymentHash: `yield-${distributionId}-${receipt.stakeId}`,
          amountSats: receipt.amountSats,
          purpose: 'yield',
          status: 'pending',
          poolId,
          stakeId: receipt.stakeId,
          stakerId: receipt.stakerId,
          metadata: { reason: 'no_nwc_connection' },
        });
        pending++;
      }
    }

    // Platform fee goes to treasury (Alby Hub node balance)
    // Already recorded in DB by distributeYield(); no Lightning transfer needed
    // since treasury IS the Alby Hub node.
    if (platformFeeSats > 0) {
      console.log(`[staking] Platform fee ${platformFeeSats} sats recorded in treasury`);
    }
  } catch (err) {
    console.warn('[staking] NWC yield payouts unavailable:', err instanceof Error ? err.message : err);
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
        s.amountSats,
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

    // NOTE: PL takes 0% of slashes. 100% goes to damaged party.
    // Revenue comes from 1% activity fees on good behavior, not from bad events.
    // This aligns incentives with C > D: PL profits when agents work well.

    // Execute slash charges via NWC (non-blocking, after DB transaction)
    // The DB records the slash proportionally; actual Lightning charges happen asynchronously
    executeSlashCharges(activeStakes, slashBps, reason).catch((err) => {
      console.error('[staking] executeSlashCharges error:', err);
    });

    return { totalSlashed: totalSlashedSats, affectedStakers: activeStakes.length };
  });
}

/**
 * Charge stakers via NWC after a slash event.
 * Non-blocking — DB state is already updated, this moves actual sats.
 */
async function executeSlashCharges(
  slashedStakes: Array<{ id: string; stakerId: string; amountSats: number; nwcConnectionId: string | null }>,
  slashBps: number,
  reason: string,
): Promise<void> {
  try {
    const { executeSlash } = await import('./nwc-service');

    for (const s of slashedStakes) {
      if (!s.nwcConnectionId) continue;

      const chargeAmount = Math.min(
        Math.round((s.amountSats * slashBps) / 10000),
        s.amountSats,
      );
      if (chargeAmount <= 0) continue;

      try {
        const result = await executeSlash(s.nwcConnectionId, chargeAmount, reason);
        console.log(`[staking] Slash charge: ${chargeAmount} sats from staker ${s.stakerId}, hash: ${result.paymentHash}`);
      } catch (err) {
        console.error(`[staking] Slash charge failed for staker ${s.stakerId}:`, err instanceof Error ? err.message : err);
      }
    }
  } catch (err) {
    console.warn('[staking] NWC slash charges unavailable:', err instanceof Error ? err.message : err);
  }
}

// ── Vouch Score (Enhanced Trust Score) ──

/**
 * Compute the backing component for Vouch score.
 * Based on total backing amount + quality of stakers.
 * Returns 0-1000 range.
 */
export async function computeBackingComponent(subjectId: string, subjectType: 'user' | 'agent'): Promise<number> {
  if (subjectType === 'user') return 0;

  const pool = await getPoolByAgent(subjectId);
  if (!pool) return 0;

  const amountScore = Math.min(500, Math.round(100 * Math.log10(pool.totalStakedSats / 10000 + 1)));

  const activeStakes = await db
    .select({ amountSats: stakes.amountSats, stakerTrust: stakes.stakerTrustAtStake })
    .from(stakes)
    .where(and(eq(stakes.poolId, pool.id), eq(stakes.status, 'active')));

  let qualityScore = 0;
  if (activeStakes.length > 0) {
    const totalStaked = activeStakes.reduce((sum, s) => sum + s.amountSats, 0);
    const weightedTrust = activeStakes.reduce((sum, s) => sum + s.stakerTrust * (s.amountSats / totalStaked), 0);
    qualityScore = Math.min(500, Math.round(weightedTrust / 2));
  }

  return Math.min(1000, amountScore + qualityScore);
}

// ── Pending Stake Cleanup (S9 fix) ──

const PENDING_STAKE_EXPIRY_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Expire pending stakes older than 15 minutes.
 * Called by a periodic cron. Prevents orphaned pending stakes from accumulating.
 */
export async function cleanupExpiredPendingStakes(): Promise<number> {
  const cutoff = new Date(Date.now() - PENDING_STAKE_EXPIRY_MS);

  const expiredStakes = await db
    .select({ id: stakes.id })
    .from(stakes)
    .where(and(eq(stakes.status, 'pending'), sql`${stakes.stakedAt} < ${cutoff}`));

  if (expiredStakes.length === 0) return 0;

  const expiredIds = expiredStakes.map(s => s.id);

  for (const stakeId of expiredIds) {
    await db
      .update(stakes)
      .set({ status: 'withdrawn' })
      .where(and(eq(stakes.id, stakeId), eq(stakes.status, 'pending')));
  }

  console.log(`[staking] Expired ${expiredIds.length} pending stake(s) older than 15 minutes`);
  return expiredIds.length;
}

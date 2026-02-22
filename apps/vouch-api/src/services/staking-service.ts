// Vouch — Staking Engine
// Handles pool creation, staking, unstaking, yield distribution, and slashing.
// All financial operations use DB transactions for atomicity (C3 fix).

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
} from '@percival/vouch-db';

// ── Constants ──

const PLATFORM_FEE_BPS = 400; // 4%
const STAKING_FEE_BPS = 100; // 1%
const UNSTAKE_NOTICE_DAYS = 7;
const SLASH_TO_AFFECTED_BPS = 5000; // 50%
const SLASH_TO_TREASURY_BPS = 5000; // 50%
const MAX_STAKE_CENTS = 10_000_000; // $100K cap
const MAX_FEE_CENTS = 10_000_000; // $100K cap per fee record

// ── Types ──

export interface StakeResult {
  stakeId: string;
  poolId: string;
  amountCents: number;
  feeCents: number;
  netStakedCents: number;
}

export interface UnstakeResult {
  stakeId: string;
  withdrawableAt: Date;
}

export interface PoolSummary {
  id: string;
  agentId: string;
  agentName: string;
  totalStakedCents: number;
  totalStakers: number;
  totalYieldPaidCents: number;
  activityFeeRateBps: number;
  status: string;
  createdAt: Date;
}

export interface YieldDistributionResult {
  distributionId: string;
  poolId: string;
  totalAmountCents: number;
  platformFeeCents: number;
  distributedAmountCents: number;
  stakerCount: number;
}

// ── Pool Management ──

/** Create a staking pool for an agent. One pool per agent. */
export async function createPool(agentId: string, activityFeeRateBps = 500): Promise<string> {
  const [pool] = await db
    .insert(vouchPools)
    .values({
      agentId,
      activityFeeRateBps: Math.min(1000, Math.max(200, activityFeeRateBps)), // clamp 2-10%
    })
    .returning({ id: vouchPools.id });

  return pool!.id;
}

/** Get pool by agent ID */
export async function getPoolByAgent(agentId: string) {
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
      totalStakedCents: vouchPools.totalStakedCents,
      totalStakers: vouchPools.totalStakers,
      totalYieldPaidCents: vouchPools.totalYieldPaidCents,
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
      totalStakedCents: vouchPools.totalStakedCents,
      totalStakers: vouchPools.totalStakers,
      totalYieldPaidCents: vouchPools.totalYieldPaidCents,
      activityFeeRateBps: vouchPools.activityFeeRateBps,
      status: vouchPools.status,
      createdAt: vouchPools.createdAt,
    })
    .from(vouchPools)
    .innerJoin(agents, eq(agents.id, vouchPools.agentId))
    .where(eq(vouchPools.status, 'active'))
    .orderBy(sql`${vouchPools.totalStakedCents} DESC`)
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
  amountCents: number,
  stakerTrustScore: number,
): Promise<StakeResult> {
  assertPositiveInt(amountCents, 'amount_cents', MAX_STAKE_CENTS);
  if (amountCents < 1000) throw new Error('Minimum stake is $10 (1000 cents)');

  const feeCents = Math.round((amountCents * STAKING_FEE_BPS) / 10000);
  const netStakedCents = amountCents - feeCents;

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
        amountCents: netStakedCents,
        stakerTrustAtStake: stakerTrustScore,
      })
      .returning({ id: stakes.id });

    const stakeId = stakeRows[0]!.id;

    // Update pool totals
    await tx
      .update(vouchPools)
      .set({
        totalStakedCents: sql`${vouchPools.totalStakedCents} + ${netStakedCents}`,
        totalStakers: sql`${vouchPools.totalStakers} + 1`,
      })
      .where(eq(vouchPools.id, poolId));

    // Record platform fee in treasury
    if (feeCents > 0) {
      await tx.insert(treasury).values({
        amountCents: feeCents,
        sourceType: 'platform_fee',
        sourceId: stakeId,
        description: `Staking fee: ${stakerId} → pool ${poolId}`,
      });
    }

    return {
      stakeId,
      poolId,
      amountCents,
      feeCents,
      netStakedCents,
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

/** Complete withdrawal after notice period. Atomic with row lock to prevent double-withdraw. */
export async function withdraw(stakeId: string, stakerId: string): Promise<number> {
  return await db.transaction(async (tx) => {
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
        totalStakedCents: sql`GREATEST(${vouchPools.totalStakedCents} - ${stakeRecord.amountCents}, 0)`,
        totalStakers: sql`GREATEST(${vouchPools.totalStakers} - 1, 0)`,
      })
      .where(eq(vouchPools.id, stakeRecord.poolId));

    return stakeRecord.amountCents;
  });
}

/** Get active stakes for a staker */
export async function getStakerPositions(stakerId: string, stakerType: 'user' | 'agent') {
  return db
    .select({
      stakeId: stakes.id,
      poolId: stakes.poolId,
      agentId: vouchPools.agentId,
      agentName: agents.name,
      amountCents: stakes.amountCents,
      status: stakes.status,
      stakedAt: stakes.stakedAt,
      unstakeRequestedAt: stakes.unstakeRequestedAt,
    })
    .from(stakes)
    .innerJoin(vouchPools, eq(vouchPools.id, stakes.poolId))
    .innerJoin(agents, eq(agents.id, vouchPools.agentId))
    .where(and(eq(stakes.stakerId, stakerId), eq(stakes.stakerType, stakerType)));
}

// ── Activity Fees ──

/** Record an activity fee from an agent's revenue. Validates pool is active. */
export async function recordActivityFee(
  agentId: string,
  actionType: string,
  grossRevenueCents: number,
): Promise<number> {
  assertPositiveInt(grossRevenueCents, 'gross_revenue_cents', MAX_FEE_CENTS);

  const pool = await getPoolByAgent(agentId);
  if (!pool) return 0;
  if (pool.status !== 'active') throw new Error(`Pool is ${pool.status} — cannot record fees`);

  const feeCents = Math.round((grossRevenueCents * pool.activityFeeRateBps) / 10000);
  if (feeCents <= 0) return 0;

  await db.insert(activityFees).values({
    poolId: pool.id,
    agentId,
    actionType,
    grossRevenueCents,
    feeCents,
  });

  return feeCents;
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
  return await db.transaction(async (tx) => {
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
      .select({ total: sql<number>`COALESCE(SUM(${activityFees.feeCents}), 0)::int` })
      .from(activityFees)
      .where(
        and(
          eq(activityFees.poolId, poolId),
          isNull(activityFees.distributionId),
          sql`${activityFees.createdAt} >= ${periodStart}`,
          sql`${activityFees.createdAt} < ${periodEnd}`,
        ),
      );

    const totalAmountCents = feeSumRows[0]?.total ?? 0;
    if (totalAmountCents <= 0) return null;

    const platformFeeCents = Math.round((totalAmountCents * PLATFORM_FEE_BPS) / 10000);
    const distributedAmountCents = totalAmountCents - platformFeeCents;

    // Get active stakes in this pool
    const activeStakes = await tx
      .select()
      .from(stakes)
      .where(and(eq(stakes.poolId, poolId), eq(stakes.status, 'active')));

    if (activeStakes.length === 0) return null;

    const totalStaked = activeStakes.reduce((sum, s) => sum + s.amountCents, 0);
    if (totalStaked <= 0) return null;

    // Create distribution record
    const distRows = await tx
      .insert(yieldDistributions)
      .values({
        poolId,
        totalAmountCents,
        platformFeeCents,
        distributedAmountCents,
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
      const rawCents = Math.floor((distributedAmountCents * s.amountCents) / totalStaked);
      const remainder = (distributedAmountCents * s.amountCents) % totalStaked;
      return { stake: s, rawCents, remainder };
    });

    // Step 2: distribute remaining cents to largest remainders
    let distributed = shares.reduce((sum, s) => sum + s.rawCents, 0);
    let remaining = distributedAmountCents - distributed;

    // Sort by remainder descending, then by stake ID for determinism
    shares.sort((a, b) => b.remainder - a.remainder || a.stake.id.localeCompare(b.stake.id));

    for (const share of shares) {
      if (remaining <= 0) break;
      share.rawCents += 1;
      remaining -= 1;
    }

    // Step 3: insert receipts
    for (const share of shares) {
      const proportionBps = Math.round((share.stake.amountCents / totalStaked) * 10000);
      await tx.insert(yieldReceipts).values({
        distributionId: distId,
        stakeId: share.stake.id,
        amountCents: share.rawCents,
        stakeProportionBps: proportionBps,
      });
    }

    // Update pool yield total
    await tx
      .update(vouchPools)
      .set({
        totalYieldPaidCents: sql`${vouchPools.totalYieldPaidCents} + ${distributedAmountCents}`,
      })
      .where(eq(vouchPools.id, poolId));

    // Record platform fee in treasury
    if (platformFeeCents > 0) {
      await tx.insert(treasury).values({
        amountCents: platformFeeCents,
        sourceType: 'platform_fee',
        sourceId: distId,
        description: `Yield distribution fee: pool ${poolId}`,
      });
    }

    return {
      distributionId: distId,
      poolId,
      totalAmountCents,
      platformFeeCents,
      distributedAmountCents,
      stakerCount: activeStakes.length,
    };
  });
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
    const maxSlashCents = pool.totalStakedCents;
    const rawSlashCents = Math.round((pool.totalStakedCents * slashBps) / 10000);
    const totalSlashedCents = Math.min(rawSlashCents, maxSlashCents);

    if (totalSlashedCents <= 0) {
      return { totalSlashed: 0, affectedStakers: 0 };
    }

    const toAffectedCents = Math.round((totalSlashedCents * SLASH_TO_AFFECTED_BPS) / 10000);
    const toTreasuryCents = totalSlashedCents - toAffectedCents;

    // Record slash event
    await tx.insert(slashEvents).values({
      poolId,
      reason,
      evidenceHash,
      totalSlashedCents,
      toAffectedCents,
      toTreasuryCents,
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
        Math.round((s.amountCents * slashBps) / 10000),
        s.amountCents, // never slash more than the stake holds
      );
      await tx
        .update(stakes)
        .set({ amountCents: sql`GREATEST(${stakes.amountCents} - ${stakeLoss}, 0)` })
        .where(eq(stakes.id, s.id));
    }

    // Update pool totals
    await tx
      .update(vouchPools)
      .set({
        totalStakedCents: sql`GREATEST(${vouchPools.totalStakedCents} - ${totalSlashedCents}, 0)`,
        totalSlashedCents: sql`${vouchPools.totalSlashedCents} + ${totalSlashedCents}`,
      })
      .where(eq(vouchPools.id, poolId));

    // Record treasury income
    if (toTreasuryCents > 0) {
      await tx.insert(treasury).values({
        amountCents: toTreasuryCents,
        sourceType: 'slash',
        sourceId: poolId,
        description: `Slash: ${reason}`,
      });
    }

    return { totalSlashed: totalSlashedCents, affectedStakers: activeStakes.length };
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

  // Amount component: log scale, caps at $50K backing
  const amountScore = Math.min(500, Math.round(100 * Math.log10(pool.totalStakedCents / 100 + 1)));

  // Staker quality: average trust score of active stakers (weighted by stake)
  const activeStakes = await db
    .select({ amountCents: stakes.amountCents, stakerTrust: stakes.stakerTrustAtStake })
    .from(stakes)
    .where(and(eq(stakes.poolId, pool.id), eq(stakes.status, 'active')));

  let qualityScore = 0;
  if (activeStakes.length > 0) {
    const totalStaked = activeStakes.reduce((sum, s) => sum + s.amountCents, 0);
    const weightedTrust = activeStakes.reduce((sum, s) => sum + s.stakerTrust * (s.amountCents / totalStaked), 0);
    qualityScore = Math.min(500, Math.round(weightedTrust / 2)); // half of avg staker trust, max 500
  }

  return Math.min(1000, amountScore + qualityScore);
}

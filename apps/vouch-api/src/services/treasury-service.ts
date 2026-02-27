// Treasury Service — manages the platform treasury via Alby Hub.
// Treasury = the platform's Alby Hub Lightning node balance.
// Income: yield distribution platform fees (1%), slash proceeds (charged via NWC).
// Outgoing: yield payments to stakers (via NWC).

import { getBalance, healthCheck, getNodeInfo } from './albyhub-service';
import { db, treasury, vouchPools, stakes, agents } from '@percival/vouch-db';
import { eq, and, sql } from 'drizzle-orm';
import { stake as stakeInPool } from './staking-service';

// ── Treasury Initialization ──

/**
 * Initialize the treasury — verify Alby Hub is reachable.
 * Call once at API startup.
 */
export async function initTreasury(): Promise<void> {
  const healthy = await healthCheck();
  if (healthy) {
    try {
      const info = await getNodeInfo();
      console.log(`[treasury] Alby Hub connected: ${info.alias} (${info.pubkey.slice(0, 16)}...) on ${info.network}`);
      const balance = await getBalance();
      console.log(`[treasury] Treasury balance: ${balance} sats`);
    } catch (err) {
      console.warn('[treasury] Alby Hub reachable but info unavailable:', err instanceof Error ? err.message : err);
    }
  } else {
    console.warn('[treasury] Alby Hub not reachable — treasury features will be limited');
    console.warn('[treasury] Set NWC_URL to connect (Nostr Wallet Connect string from Alby Hub)');
  }
}

/**
 * Reconcile treasury: compare DB-recorded total vs actual Alby Hub wallet balance.
 * Logs discrepancies but doesn't auto-correct (needs human review).
 */
export async function reconcileTreasury(): Promise<{
  dbTotal: number;
  walletBalance: number;
  discrepancy: number;
} | null> {
  try {
    // Sum all treasury records in DB
    const [row] = await db
      .select({ total: sql<number>`COALESCE(SUM(${treasury.amountSats}), 0)::int` })
      .from(treasury);

    const dbTotal = row?.total ?? 0;

    // Get actual Alby Hub node balance
    const walletBalance = await getBalance();

    const discrepancy = walletBalance - dbTotal;

    if (Math.abs(discrepancy) > 0) {
      console.warn(`[treasury] Reconciliation discrepancy: DB=${dbTotal} sats, Wallet=${walletBalance} sats, Diff=${discrepancy} sats`);
    } else {
      console.log(`[treasury] Reconciliation OK: ${walletBalance} sats`);
    }

    return { dbTotal, walletBalance, discrepancy };
  } catch (err) {
    console.error('[treasury] Reconciliation failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

// ── PL Treasury Auto-Staking (Sovereign Wealth Fund Model) ──

const PL_STAKER_ID = process.env.PL_STAKER_ID || 'pl-treasury';
const PL_OPERATING_RESERVE_SATS = parseInt(process.env.PL_OPERATING_RESERVE_SATS || '50000', 10);
const PL_MAX_POOL_CONCENTRATION_BPS = parseInt(process.env.PL_MAX_POOL_CONCENTRATION_BPS || '2000', 10);
const PL_EXTRACTION_THRESHOLD_SATS = parseInt(process.env.PL_EXTRACTION_THRESHOLD_SATS || '10000000', 10);
const PL_MIN_STAKE_SATS = 10_000;

export interface RebalanceResult {
  walletBalance: number;
  availableForStaking: number;
  stakesPlaced: number;
  totalStakedSats: number;
  allocations: Array<{ poolId: string; agentName: string; amountSats: number }>;
}

/**
 * PL Treasury Rebalance — the core of the Sovereign Wealth Fund model.
 * Call daily or on each yield cycle.
 */
export async function runTreasuryRebalance(): Promise<RebalanceResult | null> {
  try {
    // 1. Get available balance from Alby Hub
    const walletBalance = await getBalance();
    const availableForStaking = Math.max(0, walletBalance - PL_OPERATING_RESERVE_SATS);

    if (availableForStaking < PL_MIN_STAKE_SATS) {
      console.log(`[treasury] Rebalance: ${walletBalance} sats in wallet, ${availableForStaking} available after reserve — below minimum stake (${PL_MIN_STAKE_SATS})`);
      return {
        walletBalance,
        availableForStaking,
        stakesPlaced: 0,
        totalStakedSats: 0,
        allocations: [],
      };
    }

    // 2. Get top agent pools (active, sorted by total staked + yield)
    const eligiblePools = await db
      .select({
        id: vouchPools.id,
        agentId: vouchPools.agentId,
        agentName: agents.name,
        totalStakedSats: vouchPools.totalStakedSats,
        totalYieldPaidSats: vouchPools.totalYieldPaidSats,
        totalStakers: vouchPools.totalStakers,
      })
      .from(vouchPools)
      .innerJoin(agents, eq(agents.id, vouchPools.agentId))
      .where(eq(vouchPools.status, 'active'))
      .orderBy(sql`${vouchPools.totalYieldPaidSats} DESC, ${vouchPools.totalStakedSats} DESC`)
      .limit(20);

    if (eligiblePools.length === 0) {
      console.log('[treasury] Rebalance: no eligible pools found');
      return {
        walletBalance,
        availableForStaking,
        stakesPlaced: 0,
        totalStakedSats: 0,
        allocations: [],
      };
    }

    // 3. Check existing PL stakes to avoid over-concentrating
    const existingPlStakes = await db
      .select({
        poolId: stakes.poolId,
        amountSats: stakes.amountSats,
      })
      .from(stakes)
      .where(and(eq(stakes.stakerId, PL_STAKER_ID), eq(stakes.status, 'active')));

    const plStakeByPool = new Map<string, number>();
    let totalPlStaked = 0;
    for (const s of existingPlStakes) {
      const current = plStakeByPool.get(s.poolId) || 0;
      plStakeByPool.set(s.poolId, current + s.amountSats);
      totalPlStaked += s.amountSats;
    }

    // 4. Allocate across pools with concentration limits
    const allocations: Array<{ poolId: string; agentName: string; amountSats: number }> = [];
    let remaining = availableForStaking;
    const maxPerPool = Math.round((availableForStaking + totalPlStaked) * PL_MAX_POOL_CONCENTRATION_BPS / 10000);

    for (const pool of eligiblePools) {
      if (remaining < PL_MIN_STAKE_SATS) break;

      const existingInPool = plStakeByPool.get(pool.id) || 0;
      const roomInPool = Math.max(0, maxPerPool - existingInPool);
      if (roomInPool < PL_MIN_STAKE_SATS) continue;

      const targetPerPool = Math.round(availableForStaking / eligiblePools.length);
      const allocationAmount = Math.min(targetPerPool, roomInPool, remaining);

      if (allocationAmount >= PL_MIN_STAKE_SATS) {
        allocations.push({
          poolId: pool.id,
          agentName: pool.agentName || pool.agentId,
          amountSats: allocationAmount,
        });
        remaining -= allocationAmount;
      }
    }

    // 5. Execute stakes
    let stakesPlaced = 0;
    let totalStakedSats = 0;

    for (const alloc of allocations) {
      try {
        await stakeInPool(
          alloc.poolId,
          PL_STAKER_ID,
          'agent',
          alloc.amountSats,
          1000, // PL has max trust score
        );
        stakesPlaced++;
        totalStakedSats += alloc.amountSats;
        console.log(`[treasury] Staked ${alloc.amountSats} sats in pool ${alloc.poolId} (${alloc.agentName})`);
      } catch (err) {
        console.error(`[treasury] Failed to stake in pool ${alloc.poolId}:`, err instanceof Error ? err.message : err);
      }
    }

    console.log(`[treasury] Rebalance complete: ${stakesPlaced} stakes placed, ${totalStakedSats} sats deployed`);

    return {
      walletBalance,
      availableForStaking,
      stakesPlaced,
      totalStakedSats,
      allocations: allocations.slice(0, stakesPlaced),
    };
  } catch (err) {
    console.error('[treasury] Rebalance failed:', err);
    return null;
  }
}

/**
 * Check yield reinvestment status.
 */
export async function checkYieldReinvestment(): Promise<{
  totalPlStaked: number;
  totalPlYield: number;
  extractionAllowed: boolean;
}> {
  const [stakeRow] = await db
    .select({ total: sql<number>`COALESCE(SUM(${stakes.amountSats}), 0)::int` })
    .from(stakes)
    .where(and(eq(stakes.stakerId, PL_STAKER_ID), eq(stakes.status, 'active')));

  const totalPlStaked = stakeRow?.total ?? 0;

  const [treasuryRow] = await db
    .select({ total: sql<number>`COALESCE(SUM(${treasury.amountSats}), 0)::int` })
    .from(treasury);

  const totalPlYield = treasuryRow?.total ?? 0;

  const extractionAllowed = totalPlStaked >= PL_EXTRACTION_THRESHOLD_SATS;

  if (!extractionAllowed) {
    console.log(`[treasury] PL pool ${totalPlStaked} sats < extraction threshold ${PL_EXTRACTION_THRESHOLD_SATS} sats — 100% reinvestment`);
  }

  return { totalPlStaked, totalPlYield, extractionAllowed };
}

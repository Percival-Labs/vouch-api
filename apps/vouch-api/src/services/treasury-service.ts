// Treasury Service — manages the platform treasury Lightning wallet.
// Treasury wallet receives yield distribution platform fees (1%). No staking deposit fee.
// Singleton wallet, created once at startup, cached for the process lifetime.

import {
  createUserWithWallet,
  getWalletBalance,
  internalTransfer,
  type LnbitsWallet,
} from './lnbits-service';
import { db, treasury, vouchPools, stakes, agents, vouchScoreHistory } from '@percival/vouch-db';
import { eq, and, sql } from 'drizzle-orm';
import { stake as stakeInPool } from './staking-service';

// ── Cached Treasury Keys ──

let cachedTreasuryWallet: {
  walletId: string;
  adminKey: string;
  invoiceKey: string;
} | null = null;

/**
 * Get the treasury wallet's invoice key (for receiving payments).
 */
export function getTreasuryInvoiceKey(): string {
  if (!cachedTreasuryWallet) {
    throw new Error('Treasury not initialized — call initTreasury() at startup');
  }
  return cachedTreasuryWallet.invoiceKey;
}

/**
 * Get the treasury wallet's admin key (for sending payments).
 */
export function getTreasuryAdminKey(): string {
  if (!cachedTreasuryWallet) {
    throw new Error('Treasury not initialized — call initTreasury() at startup');
  }
  return cachedTreasuryWallet.adminKey;
}

/**
 * Initialize the treasury wallet.
 * Uses env vars if they exist (pre-created wallet), otherwise creates a new one.
 * Call once at API startup.
 */
export async function initTreasury(): Promise<void> {
  const walletId = process.env.TREASURY_LNBITS_WALLET_ID;
  const adminKey = process.env.TREASURY_LNBITS_ADMIN_KEY;
  const invoiceKey = process.env.TREASURY_LNBITS_INVOICE_KEY;

  if (walletId && adminKey && invoiceKey) {
    cachedTreasuryWallet = { walletId, adminKey, invoiceKey };
    console.log('[treasury] Loaded from env vars, wallet:', walletId);
    return;
  }

  // No env vars — create treasury wallet in LNbits
  console.log('[treasury] No env vars found, creating treasury wallet in LNbits...');
  try {
    const wallet = await createUserWithWallet('vouch-treasury', 'vouch-treasury');
    cachedTreasuryWallet = {
      walletId: wallet.id,
      adminKey: wallet.adminKey,
      invoiceKey: wallet.invoiceKey,
    };
    console.log('[treasury] Created new treasury wallet:', wallet.id);
    console.warn('[treasury] IMPORTANT: Set TREASURY_LNBITS_WALLET_ID, TREASURY_LNBITS_ADMIN_KEY, and TREASURY_LNBITS_INVOICE_KEY env vars for persistence.');
    console.warn('[treasury] Wallet keys have been generated — retrieve them from the LNbits admin UI.');
  } catch (err) {
    console.warn('[treasury] Failed to create wallet (LNbits may not be running):', err instanceof Error ? err.message : err);
    console.warn('[treasury] Treasury features will be unavailable until LNbits is configured');
  }
}

/**
 * Reconcile treasury: compare DB-recorded total vs actual LNbits wallet balance.
 * Logs discrepancies but doesn't auto-correct (needs human review).
 */
export async function reconcileTreasury(): Promise<{
  dbTotal: number;
  walletBalance: number;
  discrepancy: number;
} | null> {
  if (!cachedTreasuryWallet) {
    return null;
  }

  try {
    // Sum all treasury records in DB
    const [row] = await db
      .select({ total: sql<number>`COALESCE(SUM(${treasury.amountSats}), 0)::int` })
      .from(treasury);

    const dbTotal = row?.total ?? 0;

    // Get actual LNbits wallet balance
    const walletBalance = await getWalletBalance(cachedTreasuryWallet.adminKey);

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

// Configuration from env vars (with sensible defaults)
const PL_STAKER_ID = process.env.PL_STAKER_ID || 'pl-treasury';
const PL_OPERATING_RESERVE_SATS = parseInt(process.env.PL_OPERATING_RESERVE_SATS || '50000', 10); // ~$50
const PL_MAX_POOL_CONCENTRATION_BPS = parseInt(process.env.PL_MAX_POOL_CONCENTRATION_BPS || '2000', 10); // 20%
const PL_EXTRACTION_THRESHOLD_SATS = parseInt(process.env.PL_EXTRACTION_THRESHOLD_SATS || '10000000', 10); // 0.1 BTC
const PL_MIN_STAKE_SATS = 10_000; // Same as MIN_STAKE_SATS in staking service

export interface RebalanceResult {
  walletBalance: number;
  availableForStaking: number;
  stakesPlaced: number;
  totalStakedSats: number;
  allocations: Array<{ poolId: string; agentName: string; amountSats: number }>;
}

/**
 * PL Treasury Rebalance — the core of the Sovereign Wealth Fund model.
 *
 * 1. Check treasury wallet balance
 * 2. Deduct operating reserve
 * 3. Select top-performing agent pools (by Vouch Score + total staked)
 * 4. Stake available balance across pools (max 20% per pool for diversification)
 * 5. Record as PL stakes in the normal staking tables
 *
 * Call daily or on each yield cycle.
 */
export async function runTreasuryRebalance(): Promise<RebalanceResult | null> {
  if (!cachedTreasuryWallet) {
    console.warn('[treasury] Cannot rebalance — treasury not initialized');
    return null;
  }

  try {
    // 1. Get available balance
    const walletBalance = await getWalletBalance(cachedTreasuryWallet.adminKey);
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

    // 2. Get top agent pools (active, not PL's own, sorted by total staked + yield)
    const eligiblePools = await db
      .select({
        id: vouchPools.id,
        agentId: vouchPools.agentId,
        agentName: agents.name,
        totalStakedSats: vouchPools.totalStakedSats,
        totalYieldPaidSats: vouchPools.totalYieldPaidSats,
        totalStakers: vouchPools.totalStakers,
        lnbitsInvoiceKey: vouchPools.lnbitsInvoiceKey,
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

      // Equal-weight allocation across eligible pools, capped by concentration limit
      const targetPerPool = Math.round(availableForStaking / eligiblePools.length);
      const allocationAmount = Math.min(
        targetPerPool,
        roomInPool,
        remaining,
      );

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
          'agent', // PL stakes as an agent-type participant
          alloc.amountSats,
          1000, // PL has max trust score as platform operator
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
 * When PL receives yield as a staker, queue it for restaking on the next rebalance.
 * For now, yield already accumulates in the treasury wallet (via yield payout flow).
 * The rebalance job picks it up automatically on the next cycle.
 *
 * This function exists to log the reinvestment intent and check the extraction threshold.
 */
export async function checkYieldReinvestment(): Promise<{
  totalPlStaked: number;
  totalPlYield: number;
  extractionAllowed: boolean;
}> {
  // Sum all active PL stakes
  const [stakeRow] = await db
    .select({ total: sql<number>`COALESCE(SUM(${stakes.amountSats}), 0)::int` })
    .from(stakes)
    .where(and(eq(stakes.stakerId, PL_STAKER_ID), eq(stakes.status, 'active')));

  const totalPlStaked = stakeRow?.total ?? 0;

  // Sum all treasury records (PL's total accumulated fees)
  const [treasuryRow] = await db
    .select({ total: sql<number>`COALESCE(SUM(${treasury.amountSats}), 0)::int` })
    .from(treasury);

  const totalPlYield = treasuryRow?.total ?? 0;

  // Extraction only allowed when pool exceeds threshold
  const extractionAllowed = totalPlStaked >= PL_EXTRACTION_THRESHOLD_SATS;

  if (!extractionAllowed) {
    console.log(`[treasury] PL pool ${totalPlStaked} sats < extraction threshold ${PL_EXTRACTION_THRESHOLD_SATS} sats — 100% reinvestment`);
  }

  return { totalPlStaked, totalPlYield, extractionAllowed };
}

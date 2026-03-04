// Fee Distribution Service — Monthly platform fee pool distribution.
// Distributes accumulated platform fees (collected in the treasury) to stakers and ecosystem.
//
// Split: 60% PL treasury (retained) / 30% staker yield / 10% ecosystem fund
//
// Platform fees accumulate in the treasury table with sourceType = 'platform_fee'.
//
// The 60% treasury share requires no action — it's already in the Alby Hub node.
// The 30% staker share is distributed proportional to active stake weight across ALL pools.
// The 10% ecosystem share is tracked in paymentEvents for future ecosystem fund management.
//
// Distribution records are stored in paymentEvents with metadata.type = 'fee_distribution_record'.
// Per-staker payouts are individual paymentEvents with metadata.type = 'fee_pool_yield'.
//
// All amounts in sats (integers). Math.floor for splits — never distribute more than available.

import { eq, and, sql, desc } from 'drizzle-orm';
import { db, treasury, stakes, paymentEvents } from '@percival/vouch-db';
import { ulid } from 'ulid';

// ── Constants ──

const DUST_THRESHOLD_SATS = 100;
const TREASURY_SHARE_BPS = 6000;   // 60% retained in PL treasury
const STAKER_SHARE_BPS = 3000;     // 30% distributed to active stakers
const ECOSYSTEM_SHARE_BPS = 1000;  // 10% tracked for ecosystem fund

// ── Types ──

export interface FeePoolInfo {
  totalSats: number;
  periodStart: Date;
  periodEnd: Date;
}

export interface FeeDistributionResult {
  distributionId: string;
  totalFeePoolSats: number;
  treasuryRetainedSats: number;
  stakerDistributedSats: number;
  ecosystemFundSats: number;
  stakerCount: number;
  periodStart: Date;
  periodEnd: Date;
}

export interface DistributionHistoryEntry {
  distributionId: string;
  totalFeePoolSats: number;
  treasuryRetainedSats: number;
  stakerDistributedSats: number;
  ecosystemFundSats: number;
  stakerCount: number;
  periodStart: string;
  periodEnd: string;
  createdAt: Date;
}

// ── Fee Pool Calculation ──

/**
 * Calculate total platform fees collected since the last monthly distribution.
 * Queries the treasury table for platform_fee entries created after the last distribution.
 * Returns total sats available in the fee pool and the period window.
 */
export async function calculateFeePool(): Promise<FeePoolInfo> {
  const periodEnd = new Date();

  // Find the last fee distribution record in paymentEvents (metadata.type = 'fee_distribution_record').
  // If no prior distribution exists, use epoch (all-time fees).
  const lastDist = await db
    .select({ metadata: paymentEvents.metadata, createdAt: paymentEvents.createdAt })
    .from(paymentEvents)
    .where(
      sql`${paymentEvents.metadata}->>'type' = 'fee_distribution_record'`,
    )
    .orderBy(desc(paymentEvents.createdAt))
    .limit(1);

  const lastMeta = lastDist[0]?.metadata as Record<string, unknown> | undefined;
  const periodStart = lastMeta?.periodEnd
    ? new Date(lastMeta.periodEnd as string)
    : new Date(0); // epoch if no prior run

  // Sum platform fees in treasury since last distribution
  const [row] = await db
    .select({ total: sql<number>`COALESCE(SUM(${treasury.amountSats}), 0)::int` })
    .from(treasury)
    .where(
      and(
        eq(treasury.sourceType, 'platform_fee'),
        sql`${treasury.createdAt} >= ${periodStart}`,
        sql`${treasury.createdAt} < ${periodEnd}`,
      ),
    );

  const totalSats = row?.total ?? 0;

  return { totalSats, periodStart, periodEnd };
}

// ── Main Distribution ──

/**
 * Distribute accumulated platform fees according to the 60/30/10 split.
 * Called by the monthly cron. Idempotent per period — skips if below dust threshold.
 *
 * - 60% retained in treasury (already there — no action needed)
 * - 30% distributed proportionally to active stakers across ALL pools
 * - 10% tracked in paymentEvents as ecosystem fund (conceptual for now)
 *
 * Returns null if nothing to distribute (below dust threshold).
 */
export async function distributeFeePool(): Promise<FeeDistributionResult | null> {
  // Entire distribution runs inside a single transaction with an advisory lock
  // to prevent concurrent runs from double-distributing the same fee pool (FD-1 fix).
  const distId = ulid();

  const result = await db.transaction(async (tx) => {
    // Advisory lock prevents concurrent distribution runs (released on tx commit/rollback)
    await tx.execute(sql`SELECT pg_advisory_xact_lock(428701)`);

    // Calculate fee pool INSIDE the transaction (TOCTOU protection)
    const periodEnd = new Date();
    const lastDist = await tx
      .select({ metadata: paymentEvents.metadata, createdAt: paymentEvents.createdAt })
      .from(paymentEvents)
      .where(sql`${paymentEvents.metadata}->>'type' = 'fee_distribution_record'`)
      .orderBy(desc(paymentEvents.createdAt))
      .limit(1);

    const lastMeta = lastDist[0]?.metadata as Record<string, unknown> | undefined;
    const periodStart = lastMeta?.periodEnd
      ? new Date(lastMeta.periodEnd as string)
      : new Date(0);

    const [feeRow] = await tx
      .select({ total: sql<number>`COALESCE(SUM(${treasury.amountSats}), 0)::int` })
      .from(treasury)
      .where(
        and(
          eq(treasury.sourceType, 'platform_fee'),
          sql`${treasury.createdAt} >= ${periodStart}`,
          sql`${treasury.createdAt} < ${periodEnd}`,
        ),
      );

    const totalSats = feeRow?.total ?? 0;

    if (totalSats < DUST_THRESHOLD_SATS) {
      console.log(`[fee-distribution] Fee pool ${totalSats} sats below dust threshold (${DUST_THRESHOLD_SATS}) — skipping`);
      return null;
    }

    // Compute split amounts using Math.floor (never overspend)
    // M7 fix: Assign remainder to treasury so no sats are silently lost
    let treasuryRetainedSats = Math.floor((totalSats * TREASURY_SHARE_BPS) / 10000);
    const stakerDistributedSats = Math.floor((totalSats * STAKER_SHARE_BPS) / 10000);
    const ecosystemFundSats = Math.floor((totalSats * ECOSYSTEM_SHARE_BPS) / 10000);
    const remainder = totalSats - treasuryRetainedSats - stakerDistributedSats - ecosystemFundSats;
    treasuryRetainedSats += remainder;

    console.log(`[fee-distribution] Fee pool: ${totalSats} sats | treasury: ${treasuryRetainedSats} | stakers: ${stakerDistributedSats} | ecosystem: ${ecosystemFundSats}`);
    // Get all active stakes across all pools for proportional distribution
    const activeStakes = await tx
      .select({
        id: stakes.id,
        poolId: stakes.poolId,
        stakerId: stakes.stakerId,
        stakerType: stakes.stakerType,
        amountSats: stakes.amountSats,
        nwcConnectionId: stakes.nwcConnectionId,
      })
      .from(stakes)
      .where(eq(stakes.status, 'active'));

    const totalStakedSats = activeStakes.reduce((sum, s) => sum + s.amountSats, 0);

    if (activeStakes.length === 0 || totalStakedSats <= 0) {
      console.log('[fee-distribution] No active stakers — skipping staker yield distribution');
    }

    // Record the distribution as a paymentEvent (source of truth for history + period tracking)
    await tx.insert(paymentEvents).values({
      paymentHash: `fee-dist-${distId}`,
      amountSats: totalSats,
      purpose: 'treasury_fee',
      status: 'paid',
      metadata: {
        type: 'fee_distribution_record',
        distributionId: distId,
        treasuryRetainedSats,
        stakerDistributedSats,
        ecosystemFundSats,
        stakerCount: activeStakes.length,
        periodStart: periodStart.toISOString(),
        periodEnd: periodEnd.toISOString(),
      },
    });

    // Compute per-staker shares using integer-only largest-remainder method
    const stakerPayouts: Array<{ stake: typeof activeStakes[0]; sats: number }> = [];

    if (activeStakes.length > 0 && totalStakedSats > 0 && stakerDistributedSats > 0) {
      const shares = activeStakes.map((s) => {
        const rawSats = Math.floor((stakerDistributedSats * s.amountSats) / totalStakedSats);
        const remainder = (stakerDistributedSats * s.amountSats) % totalStakedSats;
        return { stake: s, rawSats, remainder };
      });

      // Distribute remainder sats to highest-remainder stakers (deterministic tie-break by id)
      let remaining = stakerDistributedSats - shares.reduce((sum, s) => sum + s.rawSats, 0);
      shares.sort((a, b) => b.remainder - a.remainder || a.stake.id.localeCompare(b.stake.id));

      for (const share of shares) {
        if (remaining <= 0) break;
        share.rawSats += 1;
        remaining -= 1;
      }

      for (const share of shares) {
        if (share.rawSats <= 0) continue;
        stakerPayouts.push({ stake: share.stake, sats: share.rawSats });
      }
    }

    // Track ecosystem fund allocation
    if (ecosystemFundSats > 0) {
      await tx.insert(paymentEvents).values({
        paymentHash: `ecosystem-fee-dist-${distId}`,
        amountSats: ecosystemFundSats,
        purpose: 'treasury_fee',
        status: 'pending', // pending = earmarked, not yet deployed to an external address
        metadata: {
          type: 'ecosystem_fund',
          distributionId: distId,
          periodStart: periodStart.toISOString(),
          periodEnd: periodEnd.toISOString(),
          note: 'Ecosystem fund — awaiting Phase 2 deployment mechanism',
        },
      });
    }

    return {
      distributionId: distId,
      totalFeePoolSats: totalSats,
      treasuryRetainedSats,
      stakerDistributedSats,
      ecosystemFundSats,
      stakerCount: activeStakes.length,
      periodStart,
      periodEnd,
      stakerPayouts,
    };
  });

  if (!result) return null;

  // After DB transaction, attempt NWC yield payouts to stakers (non-blocking)
  if (result.stakerPayouts.length > 0) {
    executeStakerPayouts(distId, result.stakerPayouts).catch((err) => {
      console.error('[fee-distribution] executeStakerPayouts error:', err);
    });
  }

  console.log(
    `[fee-distribution] Distribution ${distId} complete: ` +
    `${result.stakerCount} stakers, ${result.stakerDistributedSats} sats yield, ` +
    `${result.ecosystemFundSats} sats ecosystem`,
  );

  return result;
}

// ── NWC Staker Payouts ──

/**
 * After DB transaction, attempt to send actual sats to stakers via NWC.
 * Non-blocking — distribution record already saved; Lightning payouts are best-effort.
 * Failed payouts remain as pending paymentEvents for manual retry or future claim.
 */
async function executeStakerPayouts(
  distributionId: string,
  payouts: Array<{ stake: { id: string; poolId: string; stakerId: string; stakerType: string; nwcConnectionId: string | null }; sats: number }>,
): Promise<{ paid: number; pending: number; failed: number }> {
  let paid = 0;
  let pending = 0;
  let failed = 0;

  try {
    const { payYield } = await import('./nwc-service');

    for (const { stake, sats } of payouts) {
      if (sats <= 0) continue;

      if (stake.nwcConnectionId) {
        try {
          const result = await payYield(stake.nwcConnectionId, sats);

          await db.insert(paymentEvents).values({
            paymentHash: result.paymentHash,
            amountSats: sats,
            purpose: 'yield',
            status: 'paid',
            poolId: stake.poolId,
            stakeId: stake.id,
            stakerId: stake.stakerId,
            nwcConnectionId: stake.nwcConnectionId,
            webhookReceivedAt: new Date(),
            metadata: { distributionId, type: 'fee_pool_yield' },
          });

          paid++;
        } catch (err) {
          console.error(
            `[fee-distribution] NWC payout failed for staker ${stake.stakerId}:`,
            err instanceof Error ? err.message : err,
          );

          await db.insert(paymentEvents).values({
            paymentHash: `fee-yield-${distributionId}-${stake.id}`,
            amountSats: sats,
            purpose: 'yield',
            status: 'pending',
            poolId: stake.poolId,
            stakeId: stake.id,
            stakerId: stake.stakerId,
            nwcConnectionId: stake.nwcConnectionId,
            metadata: {
              distributionId,
              type: 'fee_pool_yield',
              error: err instanceof Error ? err.message : String(err),
            },
          });

          failed++;
        }
      } else {
        // No NWC connection — record as pending for later claim
        await db.insert(paymentEvents).values({
          paymentHash: `fee-yield-${distributionId}-${stake.id}`,
          amountSats: sats,
          purpose: 'yield',
          status: 'pending',
          poolId: stake.poolId,
          stakeId: stake.id,
          stakerId: stake.stakerId,
          metadata: {
            distributionId,
            type: 'fee_pool_yield',
            reason: 'no_nwc_connection',
          },
        });
        pending++;
      }
    }
  } catch (err) {
    console.warn('[fee-distribution] NWC payouts unavailable:', err instanceof Error ? err.message : err);
  }

  console.log(
    `[fee-distribution] Payouts for dist ${distributionId}: ${paid} paid, ${pending} pending, ${failed} failed`,
  );

  return { paid, pending, failed };
}

// ── Distribution History ──

/**
 * Fetch past fee pool distributions for dashboard display.
 * Returns paginated list ordered by most recent first.
 */
export async function getDistributionHistory(
  page = 1,
  limit = 25,
): Promise<{
  data: DistributionHistoryEntry[];
  meta: { page: number; limit: number; total: number; has_more: boolean };
}> {
  const safeLimit = Math.min(limit, 100);
  const offset = (page - 1) * safeLimit;

  const rows = await db
    .select({
      metadata: paymentEvents.metadata,
      createdAt: paymentEvents.createdAt,
    })
    .from(paymentEvents)
    .where(
      sql`${paymentEvents.metadata}->>'type' = 'fee_distribution_record'`,
    )
    .orderBy(desc(paymentEvents.createdAt))
    .limit(safeLimit)
    .offset(offset);

  const countResult = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(paymentEvents)
    .where(
      sql`${paymentEvents.metadata}->>'type' = 'fee_distribution_record'`,
    );

  const total = countResult[0]?.count ?? 0;

  const data: DistributionHistoryEntry[] = rows.map((row) => {
    const meta = row.metadata as Record<string, unknown>;
    return {
      distributionId: meta.distributionId as string,
      totalFeePoolSats: (meta.totalFeePoolSats as number) ?? 0,
      treasuryRetainedSats: meta.treasuryRetainedSats as number,
      stakerDistributedSats: meta.stakerDistributedSats as number,
      ecosystemFundSats: meta.ecosystemFundSats as number,
      stakerCount: meta.stakerCount as number,
      periodStart: meta.periodStart as string,
      periodEnd: meta.periodEnd as string,
      createdAt: row.createdAt,
    };
  });

  return {
    data,
    meta: { page, limit: safeLimit, total, has_more: offset + safeLimit < total },
  };
}

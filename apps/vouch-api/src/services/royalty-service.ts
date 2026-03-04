// Vouch -- Royalty Engine (Phase 4 Compounding Mechanics)
// When a contract milestone is accepted and paid, if the performing agent used
// purchased skills to complete the work, a royalty (percentage of the milestone
// payment) flows to the skill creator. This is the compound capability flywheel.
//
// Flow: milestone paid -> calculateRoyalties -> recordRoyalties -> executeRoyaltyPayments
// All DB writes are atomic via db.transaction(). Lightning payouts are non-blocking.

import { eq, and, sql } from 'drizzle-orm';
import {
  db,
  skills,
  skillPurchases,
  royaltyPayments,
} from '@percival/vouch-db';

// -- Constants --

const MAX_ROYALTY_BPS = 5000; // 50% hard cap -- matches skills table constraint
const MIN_ROYALTY_SATS = 1; // dust threshold -- skip sub-sat royalties
const MAX_PAYMENT_SATS = 100_000_000; // 1 BTC sanity cap

// -- Types --

export interface RoyaltyCalculation {
  skillId: string;
  creatorPubkey: string;
  purchaseId: string;
  royaltyRateBps: number;
  royaltySats: number;
}

export interface RoyaltyRecord {
  id: string;
  skillId: string;
  creatorPubkey: string;
  royaltySats: number;
  status: string;
}

export interface RoyaltyStats {
  totalEarnedSats: number;
  totalPendingSats: number;
  uniqueContracts: number;
  bySkill: Array<{
    skillId: string;
    skillName: string;
    totalEarnedSats: number;
    totalPendingSats: number;
    royaltyCount: number;
  }>;
}

export interface FlywheelStats {
  totalSkillsListed: number;
  totalPurchases: number;
  totalContractRevenueSats: number;
  averageCapabilityRoi: number; // revenue_from_skill / price_paid across all purchases
  flywheelVelocityDays: number; // avg days from purchase to first revenue
}

// -- Validation --

function assertPositiveInt(value: number, name: string, max?: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  if (max !== undefined && value > max) {
    throw new Error(`${name} exceeds maximum of ${max}`);
  }
}

// -- 1. Calculate Royalties --

/**
 * For each skill used in a milestone, calculate the royalty owed to the skill creator.
 * Looks up the skill's royaltyRateBps and the agent's purchase record.
 * Skips skills with sub-sat royalties (dust).
 * Pure calculation -- no DB writes.
 */
export async function calculateRoyalties(
  contractId: string,
  milestoneId: string,
  agentPubkey: string,
  paymentSats: number,
  skillsUsed: string[],
): Promise<RoyaltyCalculation[]> {
  if (!contractId) throw new Error('contractId is required');
  if (!milestoneId) throw new Error('milestoneId is required');
  if (!agentPubkey) throw new Error('agentPubkey is required');
  assertPositiveInt(paymentSats, 'paymentSats', MAX_PAYMENT_SATS);
  if (!skillsUsed.length) return [];

  // Deduplicate skill IDs
  const uniqueSkillIds = [...new Set(skillsUsed)];

  const calculations: RoyaltyCalculation[] = [];

  for (const skillId of uniqueSkillIds) {
    // Look up the skill to get royalty rate and creator
    const [skill] = await db
      .select({
        id: skills.id,
        creatorPubkey: skills.creatorPubkey,
        royaltyRateBps: skills.royaltyRateBps,
        status: skills.status,
      })
      .from(skills)
      .where(eq(skills.id, skillId))
      .limit(1);

    if (!skill) {
      console.warn(`[royalty] Skill ${skillId} not found, skipping`);
      continue;
    }

    if (skill.status !== 'active') {
      console.warn(`[royalty] Skill ${skillId} is ${skill.status}, skipping royalty`);
      continue;
    }

    if (skill.royaltyRateBps <= 0 || skill.royaltyRateBps > MAX_ROYALTY_BPS) {
      console.warn(`[royalty] Skill ${skillId} has invalid royaltyRateBps ${skill.royaltyRateBps}, skipping`);
      continue;
    }

    // Look up the performing agent's purchase of this skill
    // Must verify the agent actually bought it — prevents royalty fraud via false skill claims
    const [purchase] = await db
      .select({
        id: skillPurchases.id,
        buyerPubkey: skillPurchases.buyerPubkey,
      })
      .from(skillPurchases)
      .where(
        and(
          eq(skillPurchases.skillId, skillId),
          eq(skillPurchases.buyerPubkey, agentPubkey),
        ),
      )
      .limit(1);

    if (!purchase) {
      console.warn(`[royalty] Agent ${agentPubkey.slice(0, 8)}... has no purchase for skill ${skillId}, skipping`);
      continue;
    }

    // Calculate royalty: (paymentSats * rateBps) / 10000
    // Use Math.floor to guarantee total royalties never exceed payment (RY-2 fix)
    const royaltySats = Math.floor((paymentSats * skill.royaltyRateBps) / 10000);

    // Skip dust -- sub-sat royalties are not worth the Lightning overhead
    if (royaltySats < MIN_ROYALTY_SATS) {
      console.log(`[royalty] Skill ${skillId} royalty ${royaltySats} sats below dust threshold, skipping`);
      continue;
    }

    calculations.push({
      skillId: skill.id,
      creatorPubkey: skill.creatorPubkey,
      purchaseId: purchase.id,
      royaltyRateBps: skill.royaltyRateBps,
      royaltySats,
    });
  }

  // Aggregate royalty cap: total royalties must not exceed the milestone payment (RY-3 fix).
  // With multiple skills, independent percentages can sum above 100%.
  const totalRoyalties = calculations.reduce((sum, c) => sum + c.royaltySats, 0);
  if (totalRoyalties > paymentSats) {
    const scale = paymentSats / totalRoyalties;
    for (const calc of calculations) {
      calc.royaltySats = Math.floor(calc.royaltySats * scale);
    }
  }

  return calculations;
}

// -- 2. Record Royalties --

/**
 * Persist royalty calculations to the database.
 * Inserts royalty_payments rows with status 'pending'.
 * Updates skillPurchases tracking fields (revenueFromSkillSats, contractsUsingSkill).
 * All writes in a single atomic transaction.
 *
 * @returns Array of royalty payment IDs
 */
export async function recordRoyalties(
  contractId: string,
  milestoneId: string,
  grossRevenueSats: number,
  calculations: RoyaltyCalculation[],
): Promise<string[]> {
  if (!contractId) throw new Error('contractId is required');
  if (!milestoneId) throw new Error('milestoneId is required');
  assertPositiveInt(grossRevenueSats, 'grossRevenueSats', MAX_PAYMENT_SATS);
  if (!calculations.length) return [];

  return await db.transaction(async (tx) => {
    const royaltyIds: string[] = [];

    for (const calc of calculations) {
      // Insert royalty payment record
      const [row] = await tx
        .insert(royaltyPayments)
        .values({
          skillId: calc.skillId,
          creatorPubkey: calc.creatorPubkey,
          contractId,
          milestoneId,
          purchaseId: calc.purchaseId,
          grossRevenueSats,
          royaltyRateBps: calc.royaltyRateBps,
          royaltySats: calc.royaltySats,
          status: 'pending',
        })
        .returning({ id: royaltyPayments.id });

      royaltyIds.push(row!.id);

      // Update skillPurchases.revenueFromSkillSats
      await tx
        .update(skillPurchases)
        .set({
          revenueFromSkillSats: sql`${skillPurchases.revenueFromSkillSats} + ${grossRevenueSats}`,
        })
        .where(eq(skillPurchases.id, calc.purchaseId));

      // Update skillPurchases.contractsUsingSkill -- only increment if this is the
      // first milestone for this contract+purchase combo (avoid double-counting)
      const [existingRoyalty] = await tx
        .select({ id: royaltyPayments.id })
        .from(royaltyPayments)
        .where(
          and(
            eq(royaltyPayments.contractId, contractId),
            eq(royaltyPayments.purchaseId, calc.purchaseId),
            sql`${royaltyPayments.id} != ${row!.id}`, // exclude the one we just inserted
          ),
        )
        .limit(1);

      if (!existingRoyalty) {
        // First royalty for this contract+purchase -- increment contract count
        await tx
          .update(skillPurchases)
          .set({
            contractsUsingSkill: sql`${skillPurchases.contractsUsingSkill} + 1`,
          })
          .where(eq(skillPurchases.id, calc.purchaseId));
      }
    }

    console.log(`[royalty] Recorded ${royaltyIds.length} royalties for contract ${contractId} milestone ${milestoneId}`);
    return royaltyIds;
  });
}

// -- 3. Execute Royalty Payments --

/**
 * Attempt to pay pending royalties via Lightning (NWC).
 * For each pending royalty: create invoice to creator, pay from treasury.
 * On success: update status to 'paid', set paymentHash and paidAt.
 * On failure: update status to 'failed', log error.
 *
 * Non-blocking -- call after DB transaction completes (same pattern as executeYieldPayouts).
 */
export async function executeRoyaltyPayments(
  royaltyIds: string[],
): Promise<{ paid: number; failed: number }> {
  let paid = 0;
  let failed = 0;

  if (!royaltyIds.length) return { paid, failed };

  try {
    const { payYield } = await import('./nwc-service');

    for (const royaltyId of royaltyIds) {
      // Fetch the pending royalty record
      const [royalty] = await db
        .select({
          id: royaltyPayments.id,
          creatorPubkey: royaltyPayments.creatorPubkey,
          royaltySats: royaltyPayments.royaltySats,
          status: royaltyPayments.status,
        })
        .from(royaltyPayments)
        .where(and(eq(royaltyPayments.id, royaltyId), eq(royaltyPayments.status, 'pending')))
        .limit(1);

      if (!royalty) {
        console.warn(`[royalty] Royalty ${royaltyId} not found or not pending, skipping`);
        continue;
      }

      // Look up the creator's NWC connection for receiving payment
      // payYield creates an invoice on the recipient's wallet and pays it from treasury
      // For royalties, we need the creator's NWC connection
      // If the creator doesn't have one, we mark as failed and they can claim later
      try {
        const { getActiveConnection } = await import('./nwc-service');
        const creatorConn = await getActiveConnection(royalty.creatorPubkey);

        if (!creatorConn) {
          console.warn(`[royalty] Creator ${royalty.creatorPubkey} has no active NWC connection, marking pending`);
          // Leave as pending -- creator can claim when they connect a wallet
          continue;
        }

        const result = await payYield(creatorConn.id, royalty.royaltySats);

        // Update to paid
        await db
          .update(royaltyPayments)
          .set({
            status: 'paid',
            paymentHash: result.paymentHash,
            paidAt: new Date(),
          })
          .where(eq(royaltyPayments.id, royaltyId));

        console.log(`[royalty] Paid ${royalty.royaltySats} sats to creator ${royalty.creatorPubkey}, hash: ${result.paymentHash}`);
        paid++;
      } catch (err) {
        console.error(`[royalty] Payment failed for royalty ${royaltyId}:`, err instanceof Error ? err.message : err);

        await db
          .update(royaltyPayments)
          .set({ status: 'failed' })
          .where(eq(royaltyPayments.id, royaltyId));

        failed++;
      }
    }
  } catch (err) {
    console.warn('[royalty] NWC royalty payments unavailable:', err instanceof Error ? err.message : err);
    failed += royaltyIds.length;
  }

  console.log(`[royalty] Payment execution complete: ${paid} paid, ${failed} failed`);
  return { paid, failed };
}

// -- 4. Get Royalty Stats (for a skill creator) --

/**
 * Returns royalty earnings stats for a skill creator.
 * Total earned, total pending, by-skill breakdown, unique contract count.
 */
export async function getRoyaltyStats(creatorPubkey: string): Promise<RoyaltyStats> {
  if (!creatorPubkey) throw new Error('creatorPubkey is required');

  // Total earned (paid)
  const [earnedRow] = await db
    .select({ total: sql<number>`COALESCE(SUM(${royaltyPayments.royaltySats}), 0)::int` })
    .from(royaltyPayments)
    .where(and(eq(royaltyPayments.creatorPubkey, creatorPubkey), eq(royaltyPayments.status, 'paid')));

  // Total pending
  const [pendingRow] = await db
    .select({ total: sql<number>`COALESCE(SUM(${royaltyPayments.royaltySats}), 0)::int` })
    .from(royaltyPayments)
    .where(and(eq(royaltyPayments.creatorPubkey, creatorPubkey), eq(royaltyPayments.status, 'pending')));

  // Unique contracts
  const [contractCountRow] = await db
    .select({ count: sql<number>`COUNT(DISTINCT ${royaltyPayments.contractId})::int` })
    .from(royaltyPayments)
    .where(eq(royaltyPayments.creatorPubkey, creatorPubkey));

  // By-skill breakdown
  const bySkillRows = await db
    .select({
      skillId: royaltyPayments.skillId,
      skillName: skills.name,
      totalEarnedSats: sql<number>`COALESCE(SUM(CASE WHEN ${royaltyPayments.status} = 'paid' THEN ${royaltyPayments.royaltySats} ELSE 0 END), 0)::int`,
      totalPendingSats: sql<number>`COALESCE(SUM(CASE WHEN ${royaltyPayments.status} = 'pending' THEN ${royaltyPayments.royaltySats} ELSE 0 END), 0)::int`,
      royaltyCount: sql<number>`COUNT(*)::int`,
    })
    .from(royaltyPayments)
    .innerJoin(skills, eq(skills.id, royaltyPayments.skillId))
    .where(eq(royaltyPayments.creatorPubkey, creatorPubkey))
    .groupBy(royaltyPayments.skillId, skills.name);

  return {
    totalEarnedSats: earnedRow?.total ?? 0,
    totalPendingSats: pendingRow?.total ?? 0,
    uniqueContracts: contractCountRow?.count ?? 0,
    bySkill: bySkillRows,
  };
}

// -- 5. Get Flywheel Stats (global marketplace) --

/**
 * Returns global marketplace flywheel metrics.
 * Total skills, purchases, contract revenue attributed to skills,
 * average Capability ROI, and flywheel velocity.
 */
export async function getFlywheelStats(): Promise<FlywheelStats> {
  // Total skills listed (active)
  const [skillsRow] = await db
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(skills)
    .where(eq(skills.status, 'active'));

  // Total purchases
  const [purchasesRow] = await db
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(skillPurchases);

  // Total contract revenue attributed to skills (sum of revenueFromSkillSats)
  const [revenueRow] = await db
    .select({ total: sql<number>`COALESCE(SUM(${skillPurchases.revenueFromSkillSats}), 0)::int` })
    .from(skillPurchases);

  // Average Capability ROI = avg(revenueFromSkillSats / pricePaidSats) across purchases with revenue
  // Only count purchases that have generated revenue (avoid division by zero noise)
  const [roiRow] = await db
    .select({
      avgRoi: sql<number>`COALESCE(AVG(
        CASE WHEN ${skillPurchases.revenueFromSkillSats} > 0 AND ${skillPurchases.pricePaidSats} > 0
          THEN ${skillPurchases.revenueFromSkillSats}::float / ${skillPurchases.pricePaidSats}::float
          ELSE NULL
        END
      ), 0)::float`,
    })
    .from(skillPurchases);

  // Flywheel velocity = avg days from purchase to first royalty payment
  // For each purchase that has generated royalties, compute
  // MIN(royalty.createdAt) - purchase.createdAt, then average
  const [velocityRow] = await db
    .select({
      avgDays: sql<number>`COALESCE(AVG(
        EXTRACT(EPOCH FROM (first_royalty - purchase_date)) / 86400.0
      ), 0)::float`,
    })
    .from(
      sql`(
        SELECT
          ${skillPurchases.id} AS purchase_id,
          ${skillPurchases.createdAt} AS purchase_date,
          MIN(${royaltyPayments.createdAt}) AS first_royalty
        FROM ${skillPurchases}
        INNER JOIN ${royaltyPayments} ON ${royaltyPayments.purchaseId} = ${skillPurchases.id}
        GROUP BY ${skillPurchases.id}, ${skillPurchases.createdAt}
      ) AS velocity_data`,
    );

  return {
    totalSkillsListed: skillsRow?.count ?? 0,
    totalPurchases: purchasesRow?.count ?? 0,
    totalContractRevenueSats: revenueRow?.total ?? 0,
    averageCapabilityRoi: Math.round((roiRow?.avgRoi ?? 0) * 100) / 100, // 2 decimal places
    flywheelVelocityDays: Math.round((velocityRow?.avgDays ?? 0) * 10) / 10, // 1 decimal place
  };
}

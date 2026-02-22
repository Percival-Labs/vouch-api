// Vouch — Outcome Service
// Implements three-party trust model: performer (agent doing work), purchaser (client hiring agent),
// and staker (backer). Handles outcome reporting, cross-party matching, and performance computation.
// All matching operations use DB transactions for atomicity.

import { eq, and, or, sql } from 'drizzle-orm';
import { db, outcomes } from '@percival/vouch-db';

// ── Types ──

export interface ReportOutcomeParams {
  agentPubkey: string;
  counterpartyPubkey: string;
  role: 'performer' | 'purchaser';
  taskType: string;
  taskRef: string;
  success: boolean;
  rating?: number;
  evidence?: string;
}

export interface OutcomeResult {
  outcomeId: string;
  creditAwarded: 'full' | 'partial' | 'pending';
}

export interface OutcomeQueryOptions {
  role?: 'performer' | 'purchaser';
  limit?: number;
  offset?: number;
}

export interface PerformanceMetrics {
  totalOutcomes: number;
  confirmedOutcomes: number;
  successRate: number;
  avgRating: number | null;
  taskTypes: Record<string, number>;
}

// ── Validation ──

function assertValidRating(rating: number): void {
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    throw new Error('Rating must be an integer between 1 and 5');
  }
}

function oppositeRole(role: 'performer' | 'purchaser'): 'performer' | 'purchaser' {
  return role === 'performer' ? 'purchaser' : 'performer';
}

// ── Outcome Reporting ──

/**
 * Report an outcome for a completed task.
 * If the counterparty has already reported for the same taskRef with the opposite role,
 * both outcomes are linked and awarded full credit. Otherwise, partial credit is awarded.
 */
export async function reportOutcome(params: ReportOutcomeParams): Promise<OutcomeResult> {
  const { agentPubkey, counterpartyPubkey, role, taskType, taskRef, success, rating, evidence } = params;

  // C4 fix: prevent self-vouching (agent reporting outcomes with itself as counterparty)
  if (agentPubkey === counterpartyPubkey) {
    throw new Error('Cannot report outcome with yourself as counterparty');
  }

  if (rating !== undefined) {
    assertValidRating(rating);
  }

  return await db.transaction(async (tx) => {
    // Step 1: Insert the outcome record as pending
    const [inserted] = await tx
      .insert(outcomes)
      .values({
        agentPubkey,
        counterpartyPubkey,
        role,
        taskType,
        taskRef,
        success,
        rating: rating ?? null,
        evidence: evidence ?? null,
        creditAwarded: 'pending',
      })
      .returning({ id: outcomes.id });

    const outcomeId = inserted!.id;

    // Step 2: Look for a matching counterparty report
    // The counterparty's report should have:
    //   - agentPubkey = our counterpartyPubkey (they reported it)
    //   - counterpartyPubkey = our agentPubkey (they referenced us)
    //   - role = opposite of our role
    //   - same taskRef
    //   - not already matched
    const [match] = await tx
      .select({ id: outcomes.id })
      .from(outcomes)
      .where(
        and(
          eq(outcomes.agentPubkey, counterpartyPubkey),
          eq(outcomes.counterpartyPubkey, agentPubkey),
          eq(outcomes.role, oppositeRole(role)),
          eq(outcomes.taskRef, taskRef),
          sql`${outcomes.matchedOutcomeId} IS NULL`,
        ),
      )
      .orderBy(outcomes.createdAt) // FIFO: first report gets matched first
      .limit(1)
      .for('update');

    if (match) {
      // Step 3a: Match found — link both outcomes and award full credit
      await tx
        .update(outcomes)
        .set({ creditAwarded: 'full', matchedOutcomeId: match.id })
        .where(eq(outcomes.id, outcomeId));

      await tx
        .update(outcomes)
        .set({ creditAwarded: 'full', matchedOutcomeId: outcomeId })
        .where(eq(outcomes.id, match.id));

      return { outcomeId, creditAwarded: 'full' as const };
    }

    // Step 3b: No match — award partial credit for single-party report
    await tx
      .update(outcomes)
      .set({ creditAwarded: 'partial' })
      .where(eq(outcomes.id, outcomeId));

    return { outcomeId, creditAwarded: 'partial' as const };
  });
}

// ── Outcome Queries ──

/**
 * Get paginated outcomes for an agent (as reporter or counterparty).
 * Optionally filter by the agent's role in the outcome.
 */
export async function getOutcomesForAgent(
  agentPubkey: string,
  options: OutcomeQueryOptions = {},
) {
  const { role, limit = 25, offset = 0 } = options;

  const conditions = [
    or(
      eq(outcomes.agentPubkey, agentPubkey),
      eq(outcomes.counterpartyPubkey, agentPubkey),
    ),
  ];

  if (role) {
    // When filtering by role, match outcomes where this agent holds that role:
    // - If agent is the reporter with the requested role, match directly
    // - If agent is the counterparty, they hold the opposite role
    conditions.push(
      or(
        and(eq(outcomes.agentPubkey, agentPubkey), eq(outcomes.role, role)),
        and(eq(outcomes.counterpartyPubkey, agentPubkey), eq(outcomes.role, oppositeRole(role))),
      ),
    );
  }

  const rows = await db
    .select()
    .from(outcomes)
    .where(and(...conditions))
    .orderBy(sql`${outcomes.createdAt} DESC`)
    .limit(limit)
    .offset(offset);

  const countResult = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(outcomes)
    .where(and(...conditions));

  const total = countResult[0]?.count ?? 0;

  return {
    data: rows,
    meta: { limit, offset, total, hasMore: offset + limit < total },
  };
}

// ── Performance Computation ──

/**
 * Compute performance metrics from outcome history for an agent.
 * Used as input to the trust score calculation.
 *
 * Success rate formula weights confirmed (full credit) outcomes more than
 * single-party (partial) reports:
 *   successRate = (fullCreditSuccesses * 1.0 + partialCreditSuccesses * 0.7) / totalOutcomes
 *
 * Average rating is computed only from purchaser-role reports about this agent.
 */
export async function computePerformanceFromOutcomes(agentPubkey: string): Promise<PerformanceMetrics> {
  // Get all outcomes involving this agent
  const allOutcomes = await db
    .select()
    .from(outcomes)
    .where(
      or(
        eq(outcomes.agentPubkey, agentPubkey),
        eq(outcomes.counterpartyPubkey, agentPubkey),
      ),
    );

  if (allOutcomes.length === 0) {
    return {
      totalOutcomes: 0,
      confirmedOutcomes: 0,
      successRate: 0,
      avgRating: null,
      taskTypes: {},
    };
  }

  let confirmedOutcomes = 0;
  let fullCreditSuccesses = 0;
  let partialCreditSuccesses = 0;
  const taskTypes: Record<string, number> = {};

  // Collect purchaser ratings about this agent
  const purchaserRatings: number[] = [];

  for (const outcome of allOutcomes) {
    // Count by task type
    taskTypes[outcome.taskType] = (taskTypes[outcome.taskType] ?? 0) + 1;

    // Count confirmed (matched by both parties)
    if (outcome.creditAwarded === 'full') {
      confirmedOutcomes++;
    }

    // Count successes weighted by credit type
    if (outcome.success) {
      if (outcome.creditAwarded === 'full') {
        fullCreditSuccesses++;
      } else if (outcome.creditAwarded === 'partial') {
        partialCreditSuccesses++;
      }
    }

    // Collect purchaser ratings about this agent
    // Case 1: purchaser reported about this agent (agent is counterparty, reporter is purchaser)
    // Case 2: this agent is the performer and the matched purchaser rated them
    if (
      outcome.role === 'purchaser' &&
      outcome.counterpartyPubkey === agentPubkey &&
      outcome.rating !== null
    ) {
      purchaserRatings.push(outcome.rating);
    }
  }

  const totalOutcomes = allOutcomes.length;

  // Weighted success rate: full credit counts 1.0, partial counts 0.7
  const successRate = totalOutcomes > 0
    ? (fullCreditSuccesses * 1.0 + partialCreditSuccesses * 0.7) / totalOutcomes
    : 0;

  const avgRating = purchaserRatings.length > 0
    ? purchaserRatings.reduce((sum, r) => sum + r, 0) / purchaserRatings.length
    : null;

  return {
    totalOutcomes,
    confirmedOutcomes,
    successRate: Math.round(successRate * 1000) / 1000, // 3 decimal places
    avgRating: avgRating !== null ? Math.round(avgRating * 100) / 100 : null, // 2 decimal places
    taskTypes,
  };
}

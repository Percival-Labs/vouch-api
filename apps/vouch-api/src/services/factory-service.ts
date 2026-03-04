// Vouch — Factory Onboarding Service
// Phase 4 agent economy: PL acts as the first "factory" that trains new agents
// through structured low-stakes contracts tagged factory:training.
//
// Design:
//   - Factory contracts are tagged factory:training in the sow jsonb field.
//   - Only agents with trust score < 100 may bid (prevents farming by experienced agents).
//   - Already-graduated agents CAN still bid (they've proven themselves).
//   - After 5 successful factory completions, agent graduates: +25 trust boost.
//   - Graduation is idempotent — a second call after graduation is a no-op.

import { eq, desc, sql } from 'drizzle-orm';
import { db, agents, contracts } from '@percival/vouch-db';

// ── Constants ──

const FACTORY_TAG = 'factory:training';
const GRADUATION_THRESHOLD = 5;
const GRADUATION_TRUST_BOOST = 25;

// ── Types ──

export interface FactoryProgress {
  contractsCompleted: number;
  isGraduate: boolean;
  graduatedAt: string | null;
}

export interface FactoryGraduate {
  agentId: string;
  pubkey: string | null;
  name: string;
  factoryContractsCompleted: number;
  graduatedAt: string;
}

// ── Helpers ──

/**
 * Extract the tags array from a contract SOW jsonb field.
 * SOW can contain a `tags` key (string[]) for metadata like factory:training.
 * Returns an empty array if SOW has no tags.
 */
function extractSowTags(sow: unknown): string[] {
  if (!sow || typeof sow !== 'object') return [];
  const sowObj = sow as Record<string, unknown>;
  const tags = sowObj['tags'];
  if (!Array.isArray(tags)) return [];
  return tags.filter((t): t is string => typeof t === 'string');
}

// ── Public API ──

/**
 * Check if a contract is tagged as a factory training contract.
 * Inspects the sow.tags array for the 'factory:training' tag.
 */
export async function isFactoryContract(contractId: string): Promise<boolean> {
  const [contract] = await db
    .select({ sow: contracts.sow })
    .from(contracts)
    .where(eq(contracts.id, contractId))
    .limit(1);

  if (!contract) return false;

  const tags = extractSowTags(contract.sow);
  return tags.includes(FACTORY_TAG);
}

/**
 * Determine whether an agent is eligible to bid on a factory contract.
 *
 * Rules:
 *   - Agents with trust score < 100 can always bid.
 *   - Already-graduated agents can bid regardless of trust score.
 *   - Agents with trust score >= 100 who are NOT graduates are rejected.
 *
 * Returns { allowed: true } or { allowed: false, reason: string }.
 */
export async function canBidOnFactoryContract(
  agentPubkey: string,
): Promise<{ allowed: boolean; reason?: string }> {
  // Look up by pubkey (primary Nostr identity for agents in the bid system)
  const [agent] = await db
    .select({
      trustScore: agents.trustScore,
      isFactoryGraduate: agents.isFactoryGraduate,
    })
    .from(agents)
    .where(eq(agents.pubkey, agentPubkey))
    .limit(1);

  if (!agent) {
    // Unknown agent — allow bid, trust score defaults to 0
    return { allowed: true };
  }

  // Already-graduated agents can always bid on factory contracts
  if (agent.isFactoryGraduate) {
    return { allowed: true };
  }

  const trustScore = agent.trustScore ?? 0;

  if (trustScore >= 100) {
    return {
      allowed: false,
      reason: 'Factory contracts are for agents with trust < 100. Your trust score is ' +
        `${trustScore}. Graduated agents may still bid.`,
    };
  }

  return { allowed: true };
}

/**
 * Record a factory contract completion for an agent.
 * Increments factory_contracts_completed. If the count reaches GRADUATION_THRESHOLD,
 * sets isFactoryGraduate = true, records graduatedAt, and applies a +25 trust boost.
 *
 * Idempotency: if the agent is already graduated, this is a no-op.
 *
 * Called inside the acceptMilestone transaction (after all milestones accepted) or
 * from contract-service after contract transitions to 'completed'.
 */
export async function recordFactoryCompletion(
  contractId: string,
  agentPubkey: string,
): Promise<{ graduated: boolean; contractsCompleted: number }> {
  return await db.transaction(async (tx) => {
    // Lock the agent row for update
    const [agent] = await tx
      .select({
        id: agents.id,
        trustScore: agents.trustScore,
        factoryContractsCompleted: agents.factoryContractsCompleted,
        isFactoryGraduate: agents.isFactoryGraduate,
      })
      .from(agents)
      .where(eq(agents.pubkey, agentPubkey))
      .for('update');

    if (!agent) {
      // Agent not in DB (registered only by pubkey in contracts) — skip silently
      console.log(
        `[factory] recordFactoryCompletion: agent ${agentPubkey} not found in DB, skipping`,
      );
      return { graduated: false, contractsCompleted: 0 };
    }

    // Idempotency: already graduated, don't double-count
    if (agent.isFactoryGraduate) {
      console.log(
        `[factory] Agent ${agentPubkey} already graduated — skipping completion for contract ${contractId}`,
      );
      return {
        graduated: true,
        contractsCompleted: agent.factoryContractsCompleted ?? GRADUATION_THRESHOLD,
      };
    }

    const newCount = (agent.factoryContractsCompleted ?? 0) + 1;
    const justGraduated = newCount >= GRADUATION_THRESHOLD;
    const now = new Date();

    if (justGraduated) {
      const newTrust = (agent.trustScore ?? 0) + GRADUATION_TRUST_BOOST;

      await tx
        .update(agents)
        .set({
          factoryContractsCompleted: newCount,
          isFactoryGraduate: true,
          factoryGraduatedAt: now,
          trustScore: newTrust,
        })
        .where(eq(agents.id, agent.id));

      console.log(
        `[factory] Agent ${agentPubkey} GRADUATED after ${newCount} factory contracts. ` +
          `Trust: ${agent.trustScore ?? 0} → ${newTrust} (+${GRADUATION_TRUST_BOOST})`,
      );
    } else {
      await tx
        .update(agents)
        .set({ factoryContractsCompleted: newCount })
        .where(eq(agents.id, agent.id));

      console.log(
        `[factory] Agent ${agentPubkey} factory progress: ${newCount}/${GRADUATION_THRESHOLD} ` +
          `(contract ${contractId})`,
      );
    }

    return { graduated: justGraduated, contractsCompleted: newCount };
  });
}

/**
 * Get factory progress for an agent by pubkey.
 * Returns null if agent not found.
 */
export async function getFactoryProgress(
  agentPubkey: string,
): Promise<FactoryProgress | null> {
  const [agent] = await db
    .select({
      factoryContractsCompleted: agents.factoryContractsCompleted,
      isFactoryGraduate: agents.isFactoryGraduate,
      factoryGraduatedAt: agents.factoryGraduatedAt,
    })
    .from(agents)
    .where(eq(agents.pubkey, agentPubkey))
    .limit(1);

  if (!agent) return null;

  return {
    contractsCompleted: agent.factoryContractsCompleted ?? 0,
    isGraduate: agent.isFactoryGraduate ?? false,
    graduatedAt: agent.factoryGraduatedAt?.toISOString() ?? null,
  };
}

/**
 * List all factory graduates, ordered by graduation date descending.
 * Used by the public endpoint.
 */
export async function listFactoryGraduates(
  page = 1,
  limit = 25,
): Promise<{ data: FactoryGraduate[]; meta: { page: number; limit: number; total: number; has_more: boolean } }> {
  const safeLimit = Math.min(limit, 100);
  const offset = (page - 1) * safeLimit;

  const [rows, countRows] = await Promise.all([
    db
      .select({
        id: agents.id,
        pubkey: agents.pubkey,
        name: agents.name,
        factoryContractsCompleted: agents.factoryContractsCompleted,
        factoryGraduatedAt: agents.factoryGraduatedAt,
      })
      .from(agents)
      .where(eq(agents.isFactoryGraduate, true))
      .orderBy(desc(agents.factoryGraduatedAt))
      .limit(safeLimit)
      .offset(offset),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(agents)
      .where(eq(agents.isFactoryGraduate, true)),
  ]);

  const total = countRows[0]?.total ?? 0;

  const data: FactoryGraduate[] = rows
    .filter((r) => r.factoryGraduatedAt !== null)
    .map((r) => ({
      agentId: r.id,
      pubkey: r.pubkey,
      name: r.name,
      factoryContractsCompleted: r.factoryContractsCompleted ?? GRADUATION_THRESHOLD,
      graduatedAt: r.factoryGraduatedAt!.toISOString(),
    }));

  return {
    data,
    meta: {
      page,
      limit: safeLimit,
      total: Number(total),
      has_more: offset + data.length < Number(total),
    },
  };
}

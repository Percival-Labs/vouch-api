// Public Vouch Score API — Unauthenticated endpoints
// Any agent can check another agent's trust score without authentication.
// This makes Vouch composable in agent chains.
//
// Rate limited by IP (60 req/min, "public" tier). No signature verification.

import { Hono } from 'hono';
import { db, agents, acpAgentStats, acpJobs, skills, skillPurchases } from '@percival/vouch-db';
import { eq, sql, and, inArray } from 'drizzle-orm';
import { error, success } from '../lib/response';
import { calculateAgentTrust } from '../services/trust-service';
import { getPoolByAgent } from '../services/staking-service';
import { verifySignature, getPublicKey } from '../lib/bjj-keys';
import { getPricingTable } from '../services/metering-service';

// ── Types ──

type Badge = 'unbacked' | 'emerging' | 'community-backed' | 'institutional-grade';
type Tier = 'unverified' | 'established' | 'trusted' | 'verified';

// ── Badge thresholds (in sats) ──

const BADGE_EMERGING_MIN_SATS = 1;            // any backing
const BADGE_COMMUNITY_MIN_SATS = 100_000;     // ~$100 equivalent
const BADGE_INSTITUTIONAL_MIN_SATS = 5_000_000; // ~$5,000 equivalent

// ── Helpers ──

function resolveBadge(totalStakedSats: number, backerCount: number): Badge {
  if (backerCount === 0 || totalStakedSats < BADGE_EMERGING_MIN_SATS) {
    return 'unbacked';
  }
  if (totalStakedSats >= BADGE_INSTITUTIONAL_MIN_SATS) {
    return 'institutional-grade';
  }
  if (totalStakedSats >= BADGE_COMMUNITY_MIN_SATS) {
    return 'community-backed';
  }
  return 'emerging';
}

function resolveTier(composite: number, isVerified: boolean): Tier {
  if (isVerified) return 'verified';
  if (composite >= 700) return 'trusted';
  if (composite >= 400) return 'established';
  return 'unverified';
}

// ── Route ──

const app = new Hono();

// ── GET /agents/:id/vouch-score — Public, unauthenticated vouch score ──
app.get('/agents/:id/vouch-score', async (c) => {
  const agentId = c.req.param('id');

  // Validate agent ID format (ULID: 26 uppercase base32 characters)
  if (!agentId || !/^[0-9A-HJKMNP-TV-Z]{26}$/i.test(agentId)) {
    return error(c, 400, 'INVALID_AGENT_ID', 'Invalid agent ID format: expected ULID');
  }

  try {
    // Fetch trust breakdown and pool data in parallel
    const [breakdown, pool] = await Promise.all([
      calculateAgentTrust(agentId),
      getPoolByAgent(agentId),
    ]);

    if (!breakdown) {
      return error(c, 404, 'NOT_FOUND', 'Agent not found');
    }

    const totalStakedSats = pool?.totalStakedSats ?? 0;
    const backerCount = pool?.totalStakers ?? 0;

    const badge = resolveBadge(totalStakedSats, backerCount);
    const tier = resolveTier(breakdown.composite, breakdown.is_verified);

    return c.json({
      agentId: breakdown.subject_id,
      vouchScore: breakdown.composite,
      scoreBreakdown: {
        verification: breakdown.dimensions.verification,
        tenure: breakdown.dimensions.tenure,
        performance: breakdown.dimensions.performance,
        backing: breakdown.dimensions.backing,
        community: breakdown.dimensions.community,
      },
      backing: {
        totalStakedSats,
        backerCount,
        badge,
      },
      tier,
      lastUpdated: breakdown.computed_at,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[api] GET /v1/public/agents/${agentId}/vouch-score error:`, message);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to compute vouch score');
  }
});

// ── GET /consumers/:pubkey/vouch-score — Public, unauthenticated consumer score ──
// Used by the Vouch Gateway to look up trust scores by Nostr hex pubkey.
// Identical response format to /agents/:id/vouch-score — the pubkey IS the agent
// identity in Nostr world, so we resolve pubkey → agent ID internally.
app.get('/consumers/:pubkey/vouch-score', async (c) => {
  const pubkey = c.req.param('pubkey');

  // Validate hex pubkey format (64 lowercase/uppercase hex characters)
  if (!pubkey || !/^[0-9a-fA-F]{64}$/.test(pubkey)) {
    return error(c, 400, 'INVALID_PUBKEY', 'Invalid pubkey format: expected 64 hex characters');
  }

  try {
    // Look up agent by Nostr pubkey
    const [agent] = await db.select({ id: agents.id })
      .from(agents)
      .where(eq(agents.pubkey, pubkey.toLowerCase()))
      .limit(1);

    if (!agent) {
      return error(c, 404, 'NOT_FOUND', 'Consumer not found');
    }

    // Reuse the same trust calculation as the agent endpoint
    const [breakdown, pool] = await Promise.all([
      calculateAgentTrust(agent.id),
      getPoolByAgent(agent.id),
    ]);

    if (!breakdown) {
      return error(c, 404, 'NOT_FOUND', 'Consumer not found');
    }

    const totalStakedSats = pool?.totalStakedSats ?? 0;
    const backerCount = pool?.totalStakers ?? 0;

    const badge = resolveBadge(totalStakedSats, backerCount);
    const tier = resolveTier(breakdown.composite, breakdown.is_verified);

    return c.json({
      agentId: breakdown.subject_id,
      vouchScore: breakdown.composite,
      scoreBreakdown: {
        verification: breakdown.dimensions.verification,
        tenure: breakdown.dimensions.tenure,
        performance: breakdown.dimensions.performance,
        backing: breakdown.dimensions.backing,
        community: breakdown.dimensions.community,
      },
      backing: {
        totalStakedSats,
        backerCount,
        badge,
      },
      tier,
      lastUpdated: breakdown.computed_at,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[api] GET /v1/public/consumers/${pubkey}/vouch-score error:`, message);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to compute vouch score');
  }
});

// ── GET /wallets/:address/vouch-score — Public, unauthenticated wallet lookup ──
// Used by @percival-labs/vouch-x402 to resolve EVM wallet addresses to Vouch trust scores.
// Agents registered via ERC-8004 have their owner_address stored; this endpoint bridges
// x402 payment payloads (which contain EVM addresses) to Vouch identity.
app.get('/wallets/:address/vouch-score', async (c) => {
  const address = c.req.param('address');

  // Validate Ethereum address format (0x + 40 hex characters)
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return error(c, 400, 'INVALID_ADDRESS', 'Invalid Ethereum address format: expected 0x + 40 hex characters');
  }

  try {
    // Look up agent by EVM wallet address (case-insensitive)
    const [agent] = await db.select({ id: agents.id, trustScore: agents.trustScore })
      .from(agents)
      .where(eq(agents.ownerAddress, address.toLowerCase()))
      .limit(1);

    if (!agent) {
      return error(c, 404, 'NOT_FOUND', 'No agent registered with this wallet address');
    }

    const [breakdown, pool] = await Promise.all([
      calculateAgentTrust(agent.id),
      getPoolByAgent(agent.id),
    ]);

    if (!breakdown) {
      return error(c, 404, 'NOT_FOUND', 'No agent registered with this wallet address');
    }

    const totalStakedSats = pool?.totalStakedSats ?? 0;
    const backerCount = pool?.totalStakers ?? 0;

    const badge = resolveBadge(totalStakedSats, backerCount);
    const tier = resolveTier(breakdown.composite, breakdown.is_verified);

    return c.json({
      agentId: breakdown.subject_id,
      vouchScore: breakdown.composite,
      scoreBreakdown: {
        verification: breakdown.dimensions.verification,
        tenure: breakdown.dimensions.tenure,
        performance: breakdown.dimensions.performance,
        backing: breakdown.dimensions.backing,
        community: breakdown.dimensions.community,
      },
      backing: {
        totalStakedSats,
        backerCount,
        badge,
      },
      tier,
      lastUpdated: breakdown.computed_at,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[api] GET /v1/public/wallets/${address}/vouch-score error:`, message);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to compute vouch score');
  }
});

// ── GET /acp/agents/:address/score — ACP on-chain trust score for any wallet ──
// No Vouch registration required. Scores computed from public Base L2 events.
app.get('/acp/agents/:address/score', async (c) => {
  const address = c.req.param('address');

  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return error(c, 400, 'INVALID_ADDRESS', 'Invalid Ethereum address format: expected 0x + 40 hex characters');
  }

  try {
    const [stats] = await db.select()
      .from(acpAgentStats)
      .where(eq(acpAgentStats.address, address.toLowerCase()))
      .limit(1);

    if (!stats) {
      return error(c, 404, 'NOT_FOUND', 'No ACP activity found for this address');
    }

    return c.json({
      address: stats.address,
      acpTrustScore: stats.acpTrustScore,
      stats: {
        totalJobsClient: stats.totalJobsClient,
        totalJobsProvider: stats.totalJobsProvider,
        totalJobsEvaluator: stats.totalJobsEvaluator,
        completedAsProvider: stats.completedAsProvider,
        failedAsProvider: stats.failedAsProvider,
        totalEarnedUsdc: stats.totalEarnedUsdc,
        totalSpentUsdc: stats.totalSpentUsdc,
        uniqueClients: stats.uniqueClients,
        uniqueProviders: stats.uniqueProviders,
      },
      firstSeenAt: stats.firstSeenAt,
      lastActiveAt: stats.lastActiveAt,
      updatedAt: stats.updatedAt,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[api] GET /v1/public/acp/agents/${address}/score error:`, message);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to fetch ACP score');
  }
});

// ── GET /acp/stats — Aggregate ACP indexer statistics ──
app.get('/acp/stats', async (c) => {
  try {
    const [agentCount] = await db.select({ count: sql<number>`count(*)::int` })
      .from(acpAgentStats);

    const [jobCount] = await db.select({ count: sql<number>`count(*)::int` })
      .from(acpJobs);

    const [completedCount] = await db.select({ count: sql<number>`count(*)::int` })
      .from(acpJobs)
      .where(eq(acpJobs.phase, 'completed'));

    const [volumeResult] = await db.select({
      total: sql<string>`coalesce(sum(${acpAgentStats.totalEarnedUsdc}), 0)`,
    }).from(acpAgentStats);

    return c.json({
      totalAgents: agentCount.count,
      totalJobs: jobCount.count,
      completedJobs: completedCount.count,
      totalVolumeUsdc: volumeResult.total,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[api] GET /v1/public/acp/stats error:', message);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to fetch ACP stats');
  }
});

// ── POST /verify-zk-proof — Third-party ZK proof verification (public) ──
// Allows any service to verify a Vouch ZK attestation without needing the BJJ key.
app.post('/verify-zk-proof', async (c) => {
  try {
    const body = await c.req.json<{
      identity_hash: string;
      score: number;
      threshold: number;
      expiry: number;
      signature: {
        R8x: string;
        R8y: string;
        S: string;
      };
    }>();

    if (!body.identity_hash || typeof body.score !== 'number' ||
        typeof body.threshold !== 'number' || typeof body.expiry !== 'number' ||
        !body.signature?.R8x || !body.signature?.R8y || !body.signature?.S) {
      return error(c, 400, 'VALIDATION_ERROR', 'identity_hash, score, threshold, expiry, and signature are required');
    }

    // Check expiry
    const nowSecs = Math.floor(Date.now() / 1000);
    const isExpired = body.expiry < nowSecs;

    // Check threshold
    const meetsThreshold = body.score >= body.threshold;

    // Verify BJJ signature
    let signatureValid = false;
    try {
      signatureValid = await verifySignature(
        body.identity_hash,
        body.score,
        body.expiry,
        body.signature,
      );
    } catch {
      signatureValid = false;
    }

    // Get our public key for the verifier to cross-reference
    let issuerPubkey: { Ax: string; Ay: string } | null = null;
    try {
      issuerPubkey = await getPublicKey();
    } catch {
      // BJJ not configured — still return verification result
    }

    return success(c, {
      valid: signatureValid && !isExpired && meetsThreshold,
      checks: {
        signature_valid: signatureValid,
        not_expired: !isExpired,
        meets_threshold: meetsThreshold,
      },
      expiry: body.expiry,
      issuer_pubkey: issuerPubkey,
    });
  } catch (err) {
    console.error('[public] POST /verify-zk-proof error:', err);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to verify ZK proof');
  }
});

// ── GET /pricing — Public model pricing table (cached) ──
// Used by gateway and Engram clients for cost estimation.
app.get('/pricing', async (c) => {
  try {
    const pricing = await getPricingTable();

    return success(c, {
      models: pricing.map(p => ({
        model_id: p.modelId,
        provider: p.provider,
        input_cost_per_million_usd: p.inputCostPerMillion,
        output_cost_per_million_usd: p.outputCostPerMillion,
        pl_input_price_per_million_usd: p.plInputPricePerMillion,
        pl_output_price_per_million_usd: p.plOutputPricePerMillion,
        margin_bps: p.marginBps,
      })),
    });
  } catch (err) {
    console.error('[public] GET /pricing error:', err);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to get pricing');
  }
});

// ── GET /skills — Browse skill marketplace (public) ──
app.get('/skills', async (c) => {
  try {
    const tag = c.req.query('tag');
    const search = c.req.query('search');
    const sort = c.req.query('sort') || 'popular'; // popular | rating | newest | price
    const page = parseInt(c.req.query('page') || '1', 10);
    const limit = Math.min(parseInt(c.req.query('limit') || '25', 10), 100);
    const offset = (page - 1) * limit;

    // Build conditions
    const conditions = [eq(skills.status, 'active')];
    if (tag) {
      conditions.push(sql`${skills.tags} @> ${JSON.stringify([tag])}::jsonb`);
    }
    if (search) {
      // Escape LIKE metacharacters to prevent wildcard injection / DoS
      const escaped = search.replace(/[%_\\]/g, '\\$&');
      conditions.push(
        sql`(${skills.name} ILIKE ${'%' + escaped + '%'} OR ${skills.description} ILIKE ${'%' + escaped + '%'})`,
      );
    }

    const whereClause = conditions.length > 1 ? and(...conditions) : conditions[0];

    // Sort
    const orderBy = sort === 'rating' ? sql`${skills.avgRating} DESC NULLS LAST`
      : sort === 'newest' ? sql`${skills.createdAt} DESC`
      : sort === 'price' ? sql`${skills.priceSats} ASC`
      : sql`${skills.purchaseCount} DESC`; // default: popular

    const rows = await db.select({
      id: skills.id,
      name: skills.name,
      slug: skills.slug,
      description: skills.description,
      version: skills.version,
      priceSats: skills.priceSats,
      royaltyRateBps: skills.royaltyRateBps,
      creatorPubkey: skills.creatorPubkey,
      purchaseCount: skills.purchaseCount,
      avgRating: skills.avgRating,
      ratingCount: skills.ratingCount,
      tags: skills.tags,
      sourceUrl: skills.sourceUrl,
      createdAt: skills.createdAt,
    })
      .from(skills)
      .where(whereClause)
      .orderBy(orderBy)
      .limit(limit)
      .offset(offset);

    const [countResult] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(skills)
      .where(whereClause);

    const total = countResult?.count ?? 0;

    return c.json({
      data: rows,
      meta: { page, limit, total, has_more: offset + limit < total },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[public] GET /skills error:', message);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to list skills');
  }
});

// ── GET /skills/:id — Skill detail (public) ──
app.get('/skills/:id', async (c) => {
  const skillId = c.req.param('id');

  try {
    const [skill] = await db.select().from(skills).where(eq(skills.id, skillId)).limit(1);

    if (!skill || skill.status !== 'active') {
      return error(c, 404, 'NOT_FOUND', 'Skill not found');
    }

    return success(c, skill);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[public] GET /skills/${skillId} error:`, message);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to get skill');
  }
});

// ── GET /contracts — Browse open contracts (public, no auth) ──
app.get('/contracts', async (c) => {
  try {
    const status = c.req.query('status') || 'open';
    const page = parseInt(c.req.query('page') || '1', 10);
    const limit = Math.min(parseInt(c.req.query('limit') || '25', 10), 100);
    const offset = (page - 1) * limit;

    // Whitelist allowed public statuses — never expose disputed/cancelled
    const ALLOWED_PUBLIC_STATUSES = ['open', 'active', 'completed'] as const;
    if (!ALLOWED_PUBLIC_STATUSES.includes(status as typeof ALLOWED_PUBLIC_STATUSES[number])) {
      return error(c, 400, 'VALIDATION_ERROR', `status must be one of: ${ALLOWED_PUBLIC_STATUSES.join(', ')}`);
    }

    // Import contracts schema lazily to avoid circular deps
    const { contracts, contractMilestones } = await import('@percival/vouch-db');

    // Map 'open' to contracts seeking bids (draft, awaiting_funding, or active)
    const statusFilter = status === 'open'
      ? sql`${contracts.status} IN ('draft', 'awaiting_funding', 'active')`
      : eq(contracts.status, status);

    const rows = await db.select({
      id: contracts.id,
      title: contracts.title,
      description: contracts.description,
      totalSats: contracts.totalSats,
      status: contracts.status,
      sow: contracts.sow,
      createdAt: contracts.createdAt,
    })
      .from(contracts)
      .where(statusFilter)
      .orderBy(sql`${contracts.createdAt} DESC`)
      .limit(limit)
      .offset(offset);

    const [countResult] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(contracts)
      .where(statusFilter);

    const total = countResult?.count ?? 0;

    // Fetch milestones for listed contracts
    const contractIds = rows.map((r) => r.id);
    const milestones = contractIds.length > 0
      ? await db.select({
          contractId: contractMilestones.contractId,
          id: contractMilestones.id,
          title: contractMilestones.title,
          percentageBps: contractMilestones.percentageBps,
          status: contractMilestones.status,
        })
          .from(contractMilestones)
          .where(inArray(contractMilestones.contractId, contractIds))
      : [];

    const data = rows.map((contract) => ({
      ...contract,
      milestones: milestones
        .filter((m) => m.contractId === contract.id)
        .map((m) => ({
          id: m.id,
          title: m.title,
          amount_sats: Math.round((m.percentageBps / 10000) * contract.totalSats),
          status: m.status,
        })),
    }));

    return c.json({
      data,
      meta: { page, limit, total, has_more: offset + limit < total },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[public] GET /contracts error:', message);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to list contracts');
  }
});

// ── GET /contracts/:id — Contract detail (public) ──
app.get('/contracts/:id', async (c) => {
  const contractId = c.req.param('id');

  try {
    const { contracts, contractMilestones } = await import('@percival/vouch-db');

    const [contract] = await db.select({
      id: contracts.id,
      title: contracts.title,
      description: contracts.description,
      totalSats: contracts.totalSats,
      status: contracts.status,
      sow: contracts.sow,
      createdAt: contracts.createdAt,
    })
      .from(contracts)
      .where(eq(contracts.id, contractId))
      .limit(1);

    if (!contract) {
      return error(c, 404, 'NOT_FOUND', 'Contract not found');
    }

    const milestones = await db.select({
      id: contractMilestones.id,
      title: contractMilestones.title,
      description: contractMilestones.description,
      percentageBps: contractMilestones.percentageBps,
      status: contractMilestones.status,
      acceptanceCriteria: contractMilestones.acceptanceCriteria,
    })
      .from(contractMilestones)
      .where(eq(contractMilestones.contractId, contractId));

    return success(c, {
      ...contract,
      milestones: milestones.map((m) => ({
        ...m,
        amount_sats: Math.round((m.percentageBps / 10000) * contract.totalSats),
      })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[public] GET /contracts/${contractId} error:`, message);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to get contract');
  }
});

// ── GET /factory/graduates — List factory graduates (public, paginated) ──
app.get('/factory/graduates', async (c) => {
  try {
    const page = Math.max(1, parseInt(c.req.query('page') || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '25', 10)));

    const { listFactoryGraduates } = await import('../services/factory-service');
    const result = await listFactoryGraduates(page, limit);

    return c.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[public] GET /factory/graduates error:', message);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to list factory graduates');
  }
});

// ── GET /factory/progress/:pubkey — Agent factory progress (public) ──
app.get('/factory/progress/:pubkey', async (c) => {
  const pubkey = c.req.param('pubkey');

  if (!pubkey || !/^[0-9a-fA-F]{64}$/.test(pubkey)) {
    return error(c, 400, 'INVALID_PUBKEY', 'Invalid pubkey format: expected 64 hex characters');
  }

  try {
    const { getFactoryProgress } = await import('../services/factory-service');
    const progress = await getFactoryProgress(pubkey);

    if (!progress) {
      return error(c, 404, 'NOT_FOUND', 'Agent not found');
    }

    return success(c, {
      pubkey,
      contractsCompleted: progress.contractsCompleted,
      isGraduate: progress.isGraduate,
      graduatedAt: progress.graduatedAt,
      graduationThreshold: 5,
      trustBoostOnGraduation: 25,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[public] GET /factory/progress/${pubkey} error:`, message);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to get factory progress');
  }
});

// ── GET /stats/flywheel — Capability ROI and compound flywheel metrics (public) ──
// Returns aggregate stats for the capability flywheel: skills listed, purchases,
// royalties, contracts, velocity, factory graduates, and active stakers.
// No auth required. Cached for 60s to prevent DoS via repeated full-table aggregation.

let flywheelCache: { data: unknown; expiresAt: number } | null = null;
const FLYWHEEL_CACHE_TTL_MS = 60_000; // 60 seconds

app.get('/stats/flywheel', async (c) => {
  try {
    // Return cached response if fresh (P1 fix — prevent DoS via repeated aggregate queries)
    if (flywheelCache && Date.now() < flywheelCache.expiresAt) {
      c.header('Cache-Control', 'public, max-age=60');
      return c.json(flywheelCache.data);
    }
    // Lazily import tables that live outside the top-level import to avoid circular deps
    const { contracts, royaltyPayments, stakes } = await import('@percival/vouch-db');

    // ── Skills & Purchases (already top-level imported) ──

    const [skillCount] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(skills)
      .where(eq(skills.status, 'active'));

    const [purchaseStats] = await db
      .select({
        totalPurchases: sql<number>`count(*)::int`,
        totalRevenueSats: sql<string>`coalesce(sum(${skillPurchases.revenueFromSkillSats}), 0)`,
        totalSpentSats: sql<string>`coalesce(sum(${skillPurchases.pricePaidSats}), 0)`,
        purchasesWithRevenue: sql<number>`count(*) filter (where ${skillPurchases.revenueFromSkillSats} > 0)::int`,
      })
      .from(skillPurchases);

    const totalRevenueSats = Number(purchaseStats?.totalRevenueSats ?? 0);
    const totalSpentSats = Number(purchaseStats?.totalSpentSats ?? 0);

    // Average capability ROI across purchases that have yielded revenue
    // revenue_from_skill_sats / price_paid_sats per purchase, averaged
    const [avgROIResult] = await db
      .select({
        avgROI: sql<string>`coalesce(
          avg(${skillPurchases.revenueFromSkillSats}::float8 / nullif(${skillPurchases.pricePaidSats}, 0)),
          0
        )`,
      })
      .from(skillPurchases)
      .where(sql`${skillPurchases.revenueFromSkillSats} > 0`);

    const avgCapabilityROI = Math.round(Number(avgROIResult?.avgROI ?? 0) * 100) / 100;

    // ── Royalties ──

    const [royaltyStats] = await db
      .select({
        totalPaid: sql<number>`count(*) filter (where ${royaltyPayments.status} = 'paid')::int`,
        totalSats: sql<string>`coalesce(sum(${royaltyPayments.royaltySats}) filter (where ${royaltyPayments.status} = 'paid'), 0)`,
      })
      .from(royaltyPayments);

    // ── Contracts ──

    const [contractStats] = await db
      .select({
        completedCount: sql<number>`count(*) filter (where ${contracts.status} = 'completed')::int`,
        completedValueSats: sql<string>`coalesce(sum(${contracts.totalSats}) filter (where ${contracts.status} = 'completed'), 0)`,
      })
      .from(contracts);

    // ── Flywheel Velocity ──
    // Average days between a skill purchase and its first paid royalty event.
    // Uses a raw CTE query — Drizzle subquery-join syntax doesn't compose cleanly here.
    const velocityRows = await db.execute(sql`
      with first_royalty as (
        select purchase_id, min(created_at) as first_royalty_at
        from royalty_payments
        where status = 'paid'
        group by purchase_id
      )
      select coalesce(
        avg(extract(epoch from (fr.first_royalty_at - sp.created_at)) / 86400.0),
        null
      ) as avg_days
      from skill_purchases sp
      inner join first_royalty fr on fr.purchase_id = sp.id
    `);

    const velocityRowArray = (velocityRows as any)?.rows ?? velocityRows;
    const avgVelocityRaw = Array.isArray(velocityRowArray) ? (velocityRowArray[0]?.avg_days as string | null) : null;
    const avgVelocityDays = avgVelocityRaw != null
      ? Math.round(Number(avgVelocityRaw) * 10) / 10
      : null;

    // ── Factory Graduates ──

    const [graduateCount] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(agents)
      .where(eq(agents.isFactoryGraduate, true));

    // ── Active Stakers ──

    const [activeStakerCount] = await db
      .select({
        count: sql<number>`count(DISTINCT ${stakes.stakerId})::int`,
      })
      .from(stakes)
      .where(eq(stakes.status, 'active'));

    const response = {
      data: {
        skills: {
          totalListed: skillCount?.count ?? 0,
        },
        purchases: {
          total: purchaseStats?.totalPurchases ?? 0,
          totalSpentSats,
          totalRevenueFromSkillsSats: totalRevenueSats,
          avgCapabilityROI,
        },
        royalties: {
          totalPaid: royaltyStats?.totalPaid ?? 0,
          totalPaidSats: Number(royaltyStats?.totalSats ?? 0),
        },
        contracts: {
          totalCompleted: contractStats?.completedCount ?? 0,
          totalCompletedValueSats: Number(contractStats?.completedValueSats ?? 0),
        },
        flywheel: {
          avgVelocityDays,
          factoryGraduates: graduateCount?.count ?? 0,
          activeStakers: activeStakerCount?.count ?? 0,
          selfSustaining: avgCapabilityROI >= 3.0,
        },
      },
      computedAt: new Date().toISOString(),
    };

    // Cache for 60s
    flywheelCache = { data: response, expiresAt: Date.now() + FLYWHEEL_CACHE_TTL_MS };
    c.header('Cache-Control', 'public, max-age=60');
    return c.json(response);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[public] GET /stats/flywheel error:', message);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to compute flywheel stats');
  }
});

// ── GET /storefronts/:slug — Public storefront profile by slug ──
app.get('/storefronts/:slug', async (c) => {
  const slug = c.req.param('slug');

  try {
    const { getStorefrontBySlug } = await import('../services/storefront-service');
    const storefront = await getStorefrontBySlug(slug);

    if (!storefront) {
      return error(c, 404, 'NOT_FOUND', 'Storefront not found');
    }

    return success(c, storefront);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[public] GET /storefronts/${slug} error:`, message);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to get storefront');
  }
});

// ── GET /storefronts/:slug/listings — Browse storefront listings (paginated, filtered) ──
app.get('/storefronts/:slug/listings', async (c) => {
  const slug = c.req.param('slug');

  try {
    const category = c.req.query('category');
    const tag = c.req.query('tag');
    const search = c.req.query('search');
    const sort = c.req.query('sort') || 'createdAt';
    const dir = c.req.query('dir') || 'desc';
    const page = Math.max(1, parseInt(c.req.query('page') || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '20', 10)));

    // Resolve slug to storefront ID
    const { getStorefrontBySlug, listStorefrontListings } = await import('../services/storefront-service');
    const storefront = await getStorefrontBySlug(slug);
    if (!storefront) {
      return error(c, 404, 'NOT_FOUND', 'Storefront not found');
    }

    // Map sort param to ListingFilters sortBy
    const sortByMap: Record<string, 'purchaseCount' | 'avgRating' | 'createdAt' | 'priceSats'> = {
      popular: 'purchaseCount',
      rating: 'avgRating',
      newest: 'createdAt',
      price: 'priceSats',
      purchaseCount: 'purchaseCount',
      avgRating: 'avgRating',
      createdAt: 'createdAt',
      priceSats: 'priceSats',
    };
    const sortBy = sortByMap[sort] || 'createdAt';
    const sortDir = dir === 'asc' ? 'asc' as const : 'desc' as const;

    const result = await listStorefrontListings(storefront.id, {
      category: category || undefined,
      tag: tag || undefined,
      search: search || undefined,
      sortBy,
      sortDir,
      page,
      limit,
    });

    return c.json({ data: result.data, meta: result.meta });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[public] GET /storefronts/${slug}/listings error:`, message);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to list storefront listings');
  }
});

// ── GET /storefronts/:slug/listings/:lid — Listing detail (public) ──
app.get('/storefronts/:slug/listings/:lid', async (c) => {
  const slug = c.req.param('slug');
  const listingId = c.req.param('lid');

  try {
    const { getListing } = await import('../services/storefront-service');
    const result = await getListing(listingId);

    if (!result) {
      return error(c, 404, 'NOT_FOUND', 'Listing not found');
    }

    // Verify the listing belongs to the storefront identified by slug
    if (result.storefront.slug !== slug) {
      return error(c, 404, 'NOT_FOUND', 'Listing not found');
    }

    // Don't expose delisted listings publicly
    if (result.listing.status !== 'active') {
      return error(c, 404, 'NOT_FOUND', 'Listing not found');
    }

    return success(c, {
      listing: result.listing,
      storefront: {
        id: result.storefront.id,
        name: result.storefront.name,
        slug: result.storefront.slug,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[public] GET /storefronts/${slug}/listings/${listingId} error:`, message);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to get listing');
  }
});

// ── GET /listings — Cross-storefront search/browse (public) ──
app.get('/listings', async (c) => {
  try {
    const category = c.req.query('category');
    const tag = c.req.query('tag');
    const search = c.req.query('search');
    const sort = c.req.query('sort') || 'createdAt';
    const dir = c.req.query('dir') || 'desc';
    const page = Math.max(1, parseInt(c.req.query('page') || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '20', 10)));

    // Map sort param to ListingFilters sortBy
    const sortByMap: Record<string, 'purchaseCount' | 'avgRating' | 'createdAt' | 'priceSats'> = {
      popular: 'purchaseCount',
      rating: 'avgRating',
      newest: 'createdAt',
      price: 'priceSats',
      purchaseCount: 'purchaseCount',
      avgRating: 'avgRating',
      createdAt: 'createdAt',
      priceSats: 'priceSats',
    };
    const sortBy = sortByMap[sort] || 'createdAt';
    const sortDir = dir === 'asc' ? 'asc' as const : 'desc' as const;

    // Use listPublicListings for general browsing, searchListings for text search
    if (search) {
      const { searchListings } = await import('../services/storefront-service');
      const result = await searchListings(search, {
        category: category || undefined,
        tag: tag || undefined,
        sortBy,
        sortDir,
        page,
        limit,
      });
      return c.json({ data: result.data, meta: result.meta });
    }

    const { listPublicListings } = await import('../services/storefront-service');
    const result = await listPublicListings({
      category: category || undefined,
      tag: tag || undefined,
      sortBy,
      sortDir,
      page,
      limit,
    });

    return c.json({ data: result.data, meta: result.meta });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[public] GET /listings error:', message);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to search listings');
  }
});

export default app;

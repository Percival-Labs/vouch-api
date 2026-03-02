// Public Vouch Score API — Unauthenticated endpoints
// Any agent can check another agent's trust score without authentication.
// This makes Vouch composable in agent chains.
//
// Rate limited by IP (60 req/min, "public" tier). No signature verification.

import { Hono } from 'hono';
import { db, agents, acpAgentStats, acpJobs } from '@percival/vouch-db';
import { eq, sql } from 'drizzle-orm';
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

export default app;

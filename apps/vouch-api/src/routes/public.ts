// Public Vouch Score API — Unauthenticated endpoints
// Any agent can check another agent's trust score without authentication.
// This makes Vouch composable in agent chains.
//
// Rate limited by IP (60 req/min, "public" tier). No signature verification.

import { Hono } from 'hono';
import { db, agents } from '@percival/vouch-db';
import { eq } from 'drizzle-orm';
import { error } from '../lib/response';
import { calculateAgentTrust } from '../services/trust-service';
import { getPoolByAgent } from '../services/staking-service';

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

export default app;

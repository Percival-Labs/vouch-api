// Public Vouch Score API — Unauthenticated endpoints
// Any agent can check another agent's trust score without authentication.
// This makes Vouch composable in agent chains.
//
// Rate limited by IP (60 req/min, "public" tier). No signature verification.

import { Hono } from 'hono';
import { error } from '../lib/response';
import { calculateAgentTrust } from '../services/trust-service';
import { getPoolByAgent } from '../services/staking-service';

// ── Types ──

type Badge = 'unbacked' | 'emerging' | 'community-backed' | 'institutional-grade';
type Tier = 'unverified' | 'established' | 'trusted' | 'verified';

// ── Badge thresholds (in cents) ──

const BADGE_EMERGING_MIN_CENTS = 1;        // any backing
const BADGE_COMMUNITY_MIN_CENTS = 10_000;  // $100+
const BADGE_INSTITUTIONAL_MIN_CENTS = 500_000; // $5,000+

// ── Helpers ──

function resolveBadge(totalStakedCents: number, backerCount: number): Badge {
  if (backerCount === 0 || totalStakedCents < BADGE_EMERGING_MIN_CENTS) {
    return 'unbacked';
  }
  if (totalStakedCents >= BADGE_INSTITUTIONAL_MIN_CENTS) {
    return 'institutional-grade';
  }
  if (totalStakedCents >= BADGE_COMMUNITY_MIN_CENTS) {
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

    const totalStakedCents = pool?.totalStakedCents ?? 0;
    const backerCount = pool?.totalStakers ?? 0;

    const badge = resolveBadge(totalStakedCents, backerCount);
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
        totalStakedCents,
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

export default app;

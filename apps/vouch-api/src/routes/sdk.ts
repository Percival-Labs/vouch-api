// SDK Routes — Nostr-native endpoints for @vouch/agent-sdk
// These endpoints match what the Vouch SDK's Vouch class calls.
// Auth: NIP-98 Nostr events via Authorization header.

import { Hono } from 'hono';
import { db, agents, outcomes } from '@percival/vouch-db';
import { eq, and, or, desc, sql } from 'drizzle-orm';
import { success, paginated, error } from '../lib/response';
import type { NostrAuthEnv } from '../middleware/nostr-auth';
import { reportOutcome, computePerformanceFromOutcomes } from '../services/outcome-service';
import { computeBackingComponent, getPoolByAgent } from '../services/staking-service';
import { computeVouchScore, type TrustScoreParams } from '../lib/trust';
import { computeIdentityHash, signAttestation, getPublicKey } from '../lib/bjj-keys';

const app = new Hono<NostrAuthEnv>();

// ── POST /register — Nostr-native agent registration ──
// Does NOT require existing auth (agent doesn't exist yet).
// Pubkey comes from the NIP-98 event.
app.post('/register', async (c) => {
  try {
    const pubkey = c.get('nostrPubkey');
    if (!pubkey) {
      return error(c, 401, 'AUTH_REQUIRED', 'NIP-98 authorization required for registration');
    }

    const body = await c.req.json<{
      pubkey?: string;
      npub?: string;
      name: string;
      model?: string;
      capabilities?: string[];
      description?: string;
    }>();

    if (!body.name || body.name.trim().length === 0) {
      return error(c, 400, 'VALIDATION_ERROR', 'name is required');
    }

    // Use pubkey from auth event, not from body (auth is authoritative)
    const agentPubkey = pubkey;
    const agentNpub = body.npub || null;

    // Check for duplicate pubkey
    const existing = await db.select({ id: agents.id }).from(agents)
      .where(eq(agents.pubkey, agentPubkey)).limit(1);
    if (existing.length > 0) {
      return error(c, 409, 'DUPLICATE_PUBKEY', 'An agent with this pubkey is already registered');
    }

    // Check for duplicate name
    const existingName = await db.select({ id: agents.id }).from(agents)
      .where(eq(agents.name, body.name.trim())).limit(1);
    if (existingName.length > 0) {
      return error(c, 409, 'DUPLICATE_NAME', 'An agent with this name already exists');
    }

    // Generate NIP-05 identifier
    const nip05 = `${body.name.trim().toLowerCase().replace(/[^a-z0-9]/g, '-')}@vouch.xyz`;

    const [agent] = await db.insert(agents).values({
      name: body.name.trim(),
      modelFamily: body.model || null,
      description: body.description || '',
      pubkey: agentPubkey,
      npub: agentNpub,
      nip05,
      capabilities: body.capabilities || [],
      verified: true, // Nostr identity = cryptographically verified
    }).returning();

    return success(c, {
      agent_id: agent.id,
      npub: agent.npub || agentNpub,
      nip05: agent.nip05,
      score: agent.trustScore ?? 0,
    }, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[sdk] POST /v1/agents/register error:', message);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to register agent');
  }
});

// ── GET /me/score — Own trust score ──
app.get('/me/score', async (c) => {
  const agentId = c.get('verifiedAgentId');
  if (!agentId) {
    return error(c, 401, 'AUTH_REQUIRED', 'Authentication required');
  }

  try {
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
    if (!agent) {
      return error(c, 404, 'NOT_FOUND', 'Agent not found');
    }

    const breakdown = await computeAgentScore(agent);

    return success(c, {
      score: breakdown.composite,
      dimensions: breakdown.dimensions,
    });
  } catch (err) {
    console.error('[sdk] GET /me/score error:', err);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to compute score');
  }
});

// ── POST /me/prove — Generate NIP-85 trust attestation ──
app.post('/me/prove', async (c) => {
  const agentId = c.get('verifiedAgentId');
  const pubkey = c.get('nostrPubkey');
  if (!agentId || !pubkey) {
    return error(c, 401, 'AUTH_REQUIRED', 'Authentication required');
  }

  try {
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
    if (!agent) {
      return error(c, 404, 'NOT_FOUND', 'Agent not found');
    }

    const breakdown = await computeAgentScore(agent);
    const tier = scoreTier(breakdown.composite);

    // Create a NIP-85-style trust attestation event
    // In production, this would be signed by the Vouch service key.
    // For now, we return the unsigned event data for the agent to verify.
    const now = Math.floor(Date.now() / 1000);
    const event = {
      id: '', // would be computed from serialized event
      pubkey: pubkey,
      created_at: now,
      kind: 30382, // NIP-85 Trusted Assertion
      tags: [
        ['d', `vouch:score:${pubkey}`],
        ['p', pubkey],
        ['score', String(breakdown.composite)],
        ['tier', tier],
        ['verification', String(breakdown.dimensions.verification)],
        ['tenure', String(breakdown.dimensions.tenure)],
        ['performance', String(breakdown.dimensions.performance)],
        ['backing', String(breakdown.dimensions.backing)],
        ['community', String(breakdown.dimensions.community)],
        ['attested_by', 'vouch.xyz'],
        ['attested_at', String(now)],
      ],
      content: JSON.stringify({
        score: breakdown.composite,
        tier,
        dimensions: breakdown.dimensions,
        agent_id: agentId,
        name: agent.name,
      }),
      sig: '', // would be signed by Vouch service key
    };

    return success(c, {
      event,
      score: breakdown.composite,
      tier,
    });
  } catch (err) {
    console.error('[sdk] POST /me/prove error:', err);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to generate proof');
  }
});

// ── GET /:hexPubkey/score — Public score lookup by hex pubkey ──
app.get('/:hexPubkey/score', async (c) => {
  const hexPubkey = c.req.param('hexPubkey');

  // Basic hex validation
  if (!/^[0-9a-fA-F]{64}$/.test(hexPubkey)) {
    return error(c, 400, 'VALIDATION_ERROR', 'Invalid hex pubkey (expected 64 hex characters)');
  }

  try {
    const [agent] = await db.select().from(agents)
      .where(eq(agents.pubkey, hexPubkey.toLowerCase())).limit(1);
    if (!agent) {
      return error(c, 404, 'NOT_FOUND', 'Agent not found');
    }

    const breakdown = await computeAgentScore(agent);
    const pool = await getPoolByAgent(agent.id);
    const performance = await computePerformanceFromOutcomes(hexPubkey.toLowerCase());

    return success(c, {
      score: breakdown.composite,
      dimensions: breakdown.dimensions,
      backed: (pool?.totalStakedSats ?? 0) > 0,
      pool_sats: pool?.totalStakedSats ?? 0,
      staker_count: pool?.totalStakers ?? 0,
      performance: {
        success_rate: performance.successRate,
        total_outcomes: performance.totalOutcomes,
      },
    });
  } catch (err) {
    console.error('[sdk] GET /:hexPubkey/score error:', err);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to compute score');
  }
});

// ── POST /me/zk-attestation — BJJ-signed attestation for ZK proofs ──
app.post('/me/zk-attestation', async (c) => {
  const agentId = c.get('verifiedAgentId');
  const pubkey = c.get('nostrPubkey');
  if (!agentId || !pubkey) {
    return error(c, 401, 'AUTH_REQUIRED', 'Authentication required');
  }

  try {
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
    if (!agent) {
      return error(c, 404, 'NOT_FOUND', 'Agent not found');
    }

    const breakdown = await computeAgentScore(agent);
    const identityHash = await computeIdentityHash(pubkey);

    // Attestation valid for 24 hours
    const expiry = Math.floor(Date.now() / 1000) + 24 * 60 * 60;

    const attestation = await signAttestation(identityHash, breakdown.composite, expiry);

    return success(c, {
      attestation,
      score: breakdown.composite,
      dimensions: breakdown.dimensions,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('BJJ_PRIVATE_KEY')) {
      return error(c, 500, 'CONFIG_ERROR', 'ZK attestation service not configured');
    }
    console.error('[sdk] POST /me/zk-attestation error:', err);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to generate attestation');
  }
});

// ── Outcome Routes (mounted under /v1/outcomes from index.ts) ──
// These are exported separately for mounting flexibility.

export const outcomeRoutes = new Hono<NostrAuthEnv>();

// ── POST / — Report task outcome ──
outcomeRoutes.post('/', async (c) => {
  const agentId = c.get('verifiedAgentId');
  const pubkey = c.get('nostrPubkey');
  if (!agentId || !pubkey) {
    return error(c, 401, 'AUTH_REQUIRED', 'Authentication required');
  }

  try {
    const body = await c.req.json<{
      counterparty: string;
      role: 'performer' | 'purchaser';
      task_type: string;
      success: boolean;
      rating?: number;
      evidence?: string;
      task_ref?: string;
    }>();

    // H7 fix: require task_ref explicitly to prevent outcome flood with auto-generated UUIDs
    if (!body.counterparty || !body.role || !body.task_type || body.success === undefined || !body.task_ref) {
      return error(c, 400, 'VALIDATION_ERROR', 'counterparty, role, task_type, task_ref, and success are required');
    }

    if (body.role !== 'performer' && body.role !== 'purchaser') {
      return error(c, 400, 'VALIDATION_ERROR', 'role must be "performer" or "purchaser"');
    }

    if (body.rating !== undefined && (body.rating < 1 || body.rating > 5)) {
      return error(c, 400, 'VALIDATION_ERROR', 'rating must be between 1 and 5');
    }

    // C4 fix: prevent self-vouching at route level
    if (body.counterparty === pubkey) {
      return error(c, 400, 'VALIDATION_ERROR', 'Cannot report outcome with yourself as counterparty');
    }

    const result = await reportOutcome({
      agentPubkey: pubkey,
      counterpartyPubkey: body.counterparty,
      role: body.role,
      taskType: body.task_type,
      taskRef: body.task_ref,
      success: body.success,
      rating: body.rating,
      evidence: body.evidence,
    });

    return success(c, result, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // H7 fix: return 409 for duplicate outcome submissions
    if (message.includes('Duplicate outcome') || message.includes('unique constraint') || message.includes('idx_outcomes_agent_task_role')) {
      return error(c, 409, 'DUPLICATE_OUTCOME' as any, 'Outcome already reported for this task and role');
    }
    console.error('[sdk] POST /outcomes error:', err);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to report outcome');
  }
});

// ── Internal Helpers ──

function scoreTier(score: number): string {
  if (score >= 850) return 'diamond';
  if (score >= 700) return 'gold';
  if (score >= 400) return 'silver';
  if (score >= 200) return 'bronze';
  return 'unranked';
}

type AgentRow = typeof agents.$inferSelect;

async function computeAgentScore(agent: AgentRow) {
  const [backingComp, performance] = await Promise.all([
    computeBackingComponent(agent.id, 'agent'),
    agent.pubkey ? computePerformanceFromOutcomes(agent.pubkey) : { successRate: 0, totalOutcomes: 0 },
  ]);

  // Nostr identity = identity-level verification
  const hasNostrIdentity = !!agent.pubkey;
  const hasOnChainIdentity = !!agent.erc8004AgentId;
  const verificationLevel = (hasNostrIdentity || hasOnChainIdentity || agent.verified)
    ? 'identity' as const
    : null;

  const params: TrustScoreParams = {
    verificationLevel,
    accountCreatedAt: agent.createdAt,
    postsCount: 0,
    avgCommentScore: 0,
    upvotes: 0,
    downvotes: 0,
    totalVotesReceived: 0,
    upheldViolations: 0,
    backingComponent: backingComp,
  };

  // Override performance dimension with outcome-based data if available
  const result = computeVouchScore(params);

  // If we have outcome data, adjust performance dimension
  if (performance.totalOutcomes > 0) {
    const outcomeScore = Math.min(1000, Math.round(performance.successRate * 1000));
    result.dimensions.performance = outcomeScore;
    // Recompute composite
    const w = { verification: 0.20, tenure: 0.10, performance: 0.30, backing: 0.25, community: 0.15 };
    result.composite = Math.min(1000, Math.max(0, Math.round(
      result.dimensions.verification * w.verification +
      result.dimensions.tenure * w.tenure +
      result.dimensions.performance * w.performance +
      result.dimensions.backing * w.backing +
      result.dimensions.community * w.community,
    )));
  }

  return result;
}

export default app;

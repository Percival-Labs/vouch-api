// Agent routes — registration, profile management
// POST /v1/agents/register does NOT require signature auth
// All other /v1/agents/* endpoints require it

import { Hono } from 'hono';
import { db, agents, agentKeys } from '@percival/vouch-db';
import { eq, and, desc, sql } from 'drizzle-orm';
import { success, paginated, error } from '../lib/response';
import { verifyOwnership, verifyOnChainOwner, getRegistryAddress } from '../lib/erc8004';
import { validate, AgentRegisterSchema } from '../lib/schemas';
import type { AppEnv } from '../middleware/verify-signature';

const app = new Hono<AppEnv>();

// ── POST /register — Register a new agent with ERC-8004 identity ──
// Requires on-chain NFT ownership + EIP-191 signature.
app.post('/register', async (c) => {
  try {
    const body = await c.req.json();
    const parsed = validate(AgentRegisterSchema, body);
    if (!parsed.success) {
      return error(c, 400, parsed.error.code, parsed.error.message, parsed.error.details);
    }
    const data = parsed.data;

    // Validate Ed25519 public key format (base64-encoded, 32 bytes raw)
    const keyBuffer = Buffer.from(data.publicKey, 'base64');
    if (keyBuffer.length !== 32) {
      return error(c, 400, 'VALIDATION_ERROR', 'Invalid Ed25519 public key (expected 32 bytes base64-encoded)', [
        { field: 'publicKey', issue: 'invalid_format' },
      ]);
    }

    // Step 1: Verify EIP-191 signature (proves caller controls the Ethereum wallet)
    const signatureValid = await verifyOwnership(
      data.ownerAddress,
      data.erc8004AgentId,
      data.ownerSignature as `0x${string}`,
      data.publicKey,
    );
    if (!signatureValid) {
      return error(c, 400, 'SIGNATURE_INVALID', 'EIP-191 ownership signature verification failed', [
        { field: 'ownerSignature', issue: 'signature_mismatch' },
      ]);
    }

    // Step 2: Verify on-chain NFT ownership (ownerOf must match claimed address)
    let onChainOwner: string;
    try {
      onChainOwner = await verifyOnChainOwner(data.erc8004AgentId, data.erc8004Chain);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return error(c, 400, 'ONCHAIN_VERIFICATION_FAILED', `Failed to verify on-chain ownership: ${msg}`, [
        { field: 'erc8004AgentId', issue: 'not_found_on_chain' },
      ]);
    }

    if (onChainOwner.toLowerCase() !== data.ownerAddress.toLowerCase()) {
      return error(c, 403, 'NOT_NFT_OWNER', 'ownerAddress does not match on-chain ownerOf for this token', [
        { field: 'ownerAddress', issue: 'not_nft_owner' },
      ]);
    }

    // Step 3: Check no existing Vouch agent has this (erc8004AgentId, chain) combo
    const existingAgent = await db.select({ id: agents.id }).from(agents).where(
      and(
        eq(agents.erc8004AgentId, data.erc8004AgentId),
        eq(agents.erc8004Chain, data.erc8004Chain),
      ),
    ).limit(1);

    if (existingAgent.length > 0) {
      return error(c, 409, 'DUPLICATE_ERC8004', 'An agent with this ERC-8004 identity is already registered');
    }

    // Check for duplicate Ed25519 key
    const hashBuffer = await crypto.subtle.digest('SHA-256', keyBuffer);
    const keyFingerprint = Buffer.from(hashBuffer).toString('hex');

    const existingKey = await db.select().from(agentKeys).where(
      eq(agentKeys.keyFingerprint, keyFingerprint),
    ).limit(1);

    if (existingKey.length > 0) {
      return error(c, 409, 'DUPLICATE_KEY', 'An agent with this public key already exists');
    }

    // Check for duplicate name if provided
    const agentName = data.name || `Agent #${data.erc8004AgentId}`;
    const existingName = await db.select({ id: agents.id }).from(agents).where(
      eq(agents.name, agentName),
    ).limit(1);

    if (existingName.length > 0) {
      return error(c, 409, 'DUPLICATE_NAME', 'An agent with this name already exists');
    }

    // Step 4: Insert agent + key
    const registryAddress = getRegistryAddress(data.erc8004Chain);

    const [agent] = await db.insert(agents).values({
      name: agentName,
      modelFamily: data.modelFamily || null,
      description: data.description || '',
      erc8004AgentId: data.erc8004AgentId,
      erc8004Chain: data.erc8004Chain,
      erc8004Registry: registryAddress,
      ownerAddress: data.ownerAddress,
      verified: true, // on-chain identity = verified by definition
    }).returning();

    await db.insert(agentKeys).values({
      agentId: agent.id,
      publicKey: data.publicKey,
      keyFingerprint,
    });

    return success(c, {
      agent_id: agent.id,
      erc8004_agent_id: agent.erc8004AgentId,
      erc8004_chain: agent.erc8004Chain,
      name: agent.name,
      model_family: agent.modelFamily,
      description: agent.description,
      verified: agent.verified,
      trust_score: agent.trustScore,
      key_fingerprint: keyFingerprint,
      created_at: agent.createdAt.toISOString(),
    }, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[api] POST /v1/agents/register error:', message);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to register agent');
  }
});

// ── GET /me — Agent's own profile ──
app.get('/me', async (c) => {
  const agentId = c.get('verifiedAgentId');
  if (!agentId) {
    return error(c, 401, 'UNAUTHORIZED', 'Authentication required');
  }

  try {
    const agent = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
    if (agent.length === 0) {
      return error(c, 404, 'NOT_FOUND', 'Agent not found');
    }

    const keys = await db.select().from(agentKeys).where(
      and(eq(agentKeys.agentId, agentId), eq(agentKeys.isActive, true)),
    );

    return success(c, {
      id: agent[0].id,
      name: agent[0].name,
      model_family: agent[0].modelFamily,
      description: agent[0].description,
      verified: agent[0].verified,
      trust_score: agent[0].trustScore,
      erc8004_agent_id: agent[0].erc8004AgentId,
      erc8004_chain: agent[0].erc8004Chain,
      owner_address: agent[0].ownerAddress,
      rate_limit_tier: agent[0].rateLimitTier,
      created_at: agent[0].createdAt.toISOString(),
      last_active_at: agent[0].lastActiveAt?.toISOString() || null,
      keys: keys.map((k) => ({
        fingerprint: k.keyFingerprint,
        created_at: k.createdAt.toISOString(),
        is_active: k.isActive,
      })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[api] GET /v1/agents/me error:', message);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to fetch agent profile');
  }
});

// ── PATCH /me — Update agent profile ──
app.patch('/me', async (c) => {
  const agentId = c.get('verifiedAgentId');
  if (!agentId) {
    return error(c, 401, 'UNAUTHORIZED', 'Authentication required');
  }

  try {
    const body = await c.req.json<{
      name?: string;
      description?: string;
      avatarUrl?: string;
    }>();

    const updates: Record<string, unknown> = {};
    if (body.name !== undefined) updates.name = body.name;
    if (body.description !== undefined) updates.description = body.description;
    if (body.avatarUrl !== undefined) updates.avatarUrl = body.avatarUrl;

    if (Object.keys(updates).length === 0) {
      return error(c, 400, 'VALIDATION_ERROR', 'No fields to update');
    }

    const [updated] = await db.update(agents)
      .set(updates)
      .where(eq(agents.id, agentId))
      .returning();

    if (!updated) {
      return error(c, 404, 'NOT_FOUND', 'Agent not found');
    }

    return success(c, {
      id: updated.id,
      name: updated.name,
      model_family: updated.modelFamily,
      description: updated.description,
      verified: updated.verified,
      trust_score: updated.trustScore,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[api] PATCH /v1/agents/me error:', message);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to update agent profile');
  }
});

// ── GET / — List all agents (paginated) ──
app.get('/', async (c) => {
  const limit = Math.min(parseInt(c.req.query('limit') || '25', 10), 100);
  const page = Math.max(parseInt(c.req.query('page') || '1', 10), 1);
  const offset = (page - 1) * limit;

  try {
    const [rows, countResult] = await Promise.all([
      db.select()
        .from(agents)
        .orderBy(desc(agents.trustScore))
        .limit(limit)
        .offset(offset),
      db.select({ count: sql<number>`count(*)` })
        .from(agents),
    ]);

    const total = Number(countResult[0].count);

    return paginated(c, rows.map((a) => ({
      id: a.id,
      name: a.name,
      model_family: a.modelFamily,
      description: a.description,
      verified: a.verified,
      trust_score: a.trustScore,
      erc8004_agent_id: a.erc8004AgentId,
      erc8004_chain: a.erc8004Chain,
      created_at: a.createdAt.toISOString(),
    })), {
      page,
      limit,
      total,
      has_more: offset + limit < total,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[api] GET /v1/agents error:', message);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to list agents');
  }
});

// ── POST /me/keys — Register a new key (L1: key rotation) ──
app.post('/me/keys', async (c) => {
  const agentId = c.get('verifiedAgentId');
  if (!agentId) {
    return error(c, 401, 'UNAUTHORIZED', 'Authentication required');
  }

  try {
    const body = await c.req.json<{ publicKey: string; proof: string }>();

    if (!body.publicKey || !body.proof) {
      return error(c, 400, 'VALIDATION_ERROR', 'publicKey and proof are required');
    }

    const keyBuffer = Buffer.from(body.publicKey, 'base64');
    if (keyBuffer.length !== 32) {
      return error(c, 400, 'VALIDATION_ERROR', 'Invalid Ed25519 public key (expected 32 bytes)');
    }

    // Verify proof-of-ownership for the new key
    const currentHour = new Date().toISOString().slice(0, 13);
    const prevHour = new Date(Date.now() - 3600_000).toISOString().slice(0, 13);
    let proofValid = false;

    for (const ts of [currentHour, prevHour]) {
      const proofCanonical = `ROTATE\n${agentId}\n${body.publicKey}\n${ts}`;
      const proofBytes = new TextEncoder().encode(proofCanonical);
      const proofSigBytes = Buffer.from(body.proof, 'base64');

      try {
        const cryptoKey = await crypto.subtle.importKey(
          'raw', keyBuffer, { name: 'Ed25519' }, false, ['verify'],
        );
        proofValid = await crypto.subtle.verify('Ed25519', cryptoKey, proofSigBytes, proofBytes);
        if (proofValid) break;
      } catch {
        continue;
      }
    }

    if (!proofValid) {
      return error(c, 400, 'VALIDATION_ERROR', 'Proof-of-key-ownership verification failed');
    }

    // L2: Check active key count (max 5)
    const activeKeys = await db.select({ id: agentKeys.id }).from(agentKeys).where(
      and(eq(agentKeys.agentId, agentId), eq(agentKeys.isActive, true)),
    );

    if (activeKeys.length >= 5) {
      return error(c, 400, 'VALIDATION_ERROR', 'Maximum 5 active keys per agent. Revoke a key first.');
    }

    const hashBuffer = await crypto.subtle.digest('SHA-256', keyBuffer);
    const keyFingerprint = Buffer.from(hashBuffer).toString('hex');

    // Check for duplicate
    const existingKey = await db.select().from(agentKeys).where(
      eq(agentKeys.keyFingerprint, keyFingerprint),
    ).limit(1);

    if (existingKey.length > 0) {
      return error(c, 409, 'DUPLICATE_KEY', 'This public key is already registered');
    }

    await db.insert(agentKeys).values({
      agentId,
      publicKey: body.publicKey,
      keyFingerprint,
    });

    return success(c, { key_fingerprint: keyFingerprint, is_active: true }, 201);
  } catch (err) {
    console.error('[api] POST /v1/agents/me/keys error:', err);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to add key');
  }
});

// ── DELETE /me/keys/:fingerprint — Revoke a key (L1: key rotation) ──
app.delete('/me/keys/:fingerprint', async (c) => {
  const agentId = c.get('verifiedAgentId');
  if (!agentId) {
    return error(c, 401, 'UNAUTHORIZED', 'Authentication required');
  }

  try {
    const fingerprint = c.req.param('fingerprint');

    // Don't allow revoking the last active key
    const activeKeys = await db.select({ id: agentKeys.id, keyFingerprint: agentKeys.keyFingerprint }).from(agentKeys).where(
      and(eq(agentKeys.agentId, agentId), eq(agentKeys.isActive, true)),
    );

    if (activeKeys.length <= 1) {
      return error(c, 400, 'VALIDATION_ERROR', 'Cannot revoke the last active key');
    }

    const [updated] = await db.update(agentKeys)
      .set({ isActive: false, revokedAt: new Date() })
      .where(
        and(
          eq(agentKeys.agentId, agentId),
          eq(agentKeys.keyFingerprint, fingerprint),
          eq(agentKeys.isActive, true),
        ),
      )
      .returning({ id: agentKeys.id });

    if (!updated) {
      return error(c, 404, 'NOT_FOUND', 'Active key with this fingerprint not found');
    }

    return success(c, { revoked: true, key_fingerprint: fingerprint });
  } catch (err) {
    console.error('[api] DELETE /v1/agents/me/keys error:', err);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to revoke key');
  }
});

// ── GET /:id/registration.json — ERC-8004 registration file ──
// Public endpoint (no auth required). Serves the agent's ERC-8004-compatible registration JSON.
// This URL can be used as the tokenURI when minting the NFT.
app.get('/:id/registration.json', async (c) => {
  const agentId = c.req.param('id');

  try {
    const rows = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
    if (rows.length === 0) {
      return error(c, 404, 'NOT_FOUND', 'Agent not found');
    }

    const agent = rows[0];

    const registrationFile: Record<string, unknown> = {
      type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
      name: agent.name,
      description: agent.description || '',
      services: [
        { name: 'vouch', endpoint: `${c.req.url.split('/v1/')[0]}/v1/agents/${agent.id}` },
      ],
      supportedTrust: ['reputation', 'crypto-economic'],
      active: true,
    };

    if (agent.erc8004AgentId && agent.erc8004Chain && agent.erc8004Registry) {
      registrationFile.registrations = [{
        agentId: Number(agent.erc8004AgentId),
        agentRegistry: `${agent.erc8004Chain}:${agent.erc8004Registry}`,
      }];
    }

    return c.json(registrationFile);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[api] GET /v1/agents/${agentId}/registration.json error:`, message);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to generate registration file');
  }
});

// ── GET /:id — View any agent's public profile ──
app.get('/:id', async (c) => {
  const agentId = c.req.param('id');

  try {
    const agent = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
    if (agent.length === 0) {
      return error(c, 404, 'NOT_FOUND', 'Agent not found');
    }

    return success(c, {
      id: agent[0].id,
      name: agent[0].name,
      model_family: agent[0].modelFamily,
      description: agent[0].description,
      verified: agent[0].verified,
      trust_score: agent[0].trustScore,
      erc8004_agent_id: agent[0].erc8004AgentId,
      erc8004_chain: agent[0].erc8004Chain,
      owner_address: agent[0].ownerAddress,
      created_at: agent[0].createdAt.toISOString(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[api] GET /v1/agents/${agentId} error:`, message);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to fetch agent profile');
  }
});

export default app;

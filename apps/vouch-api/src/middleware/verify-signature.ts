// Ed25519 Signature Verification Middleware
// Verifies agent request signatures per the Vouch Architecture spec.
// Auth bypass requires explicit VOUCH_SKIP_AUTH=true (never set in production).

import type { MiddlewareHandler } from 'hono';
import type { Context } from 'hono';
import { db, agentKeys, requestNonces } from '@percival/vouch-db';
import { eq, and, lt } from 'drizzle-orm';

// Auth bypass requires an explicit opt-in flag — NODE_ENV alone is never enough
const SKIP_AUTH = process.env.VOUCH_SKIP_AUTH === 'true';
if (SKIP_AUTH && process.env.NODE_ENV === 'production') {
  console.error('[FATAL] VOUCH_SKIP_AUTH=true is forbidden in production. Exiting.');
  process.exit(1);
}
const MAX_TIMESTAMP_AGE_MS = 5 * 60 * 1000; // 5 minutes
const NONCE_TTL_MS = 6 * 60 * 1000; // 6 minutes (slightly longer than timestamp window)

// Hono env type for verified identity propagation
export type AppEnv = {
  Variables: {
    verifiedAgentId: string;
  };
};

export const verifySignature: MiddlewareHandler<AppEnv> = async (c, next) => {
  // Skip auth for agent registration endpoint
  if (c.req.path === '/v1/agents/register' && c.req.method === 'POST') {
    await next();
    return;
  }

  // Skip auth for public endpoints (unauthenticated, rate-limited by IP)
  if (c.req.path.startsWith('/v1/public/')) {
    await next();
    return;
  }

  // Skip Ed25519 auth for user-facing auth endpoints (cookie-based JWT, not agent signatures)
  if (c.req.path.startsWith('/v1/auth/')) {
    await next();
    return;
  }

  // Skip Ed25519 auth for SDK routes (use NIP-98 Nostr auth instead)
  if (c.req.path.startsWith('/v1/sdk/')) {
    await next();
    return;
  }

  // Skip Ed25519 auth for outcome routes (use NIP-98 Nostr auth)
  if (c.req.path.startsWith('/v1/outcomes')) {
    await next();
    return;
  }

  // Explicit test-mode bypass — requires VOUCH_SKIP_AUTH=true
  if (SKIP_AUTH) {
    const agentId = c.req.header('X-Agent-Id');
    if (agentId) {
      c.set('verifiedAgentId', agentId);
    }
    console.warn('[verify-signature] WARNING: Auth bypassed via VOUCH_SKIP_AUTH=true');
    await next();
    return;
  }

  const agentId = c.req.header('X-Agent-Id');
  const timestamp = c.req.header('X-Timestamp');
  const signature = c.req.header('X-Signature');
  const nonce = c.req.header('X-Nonce');

  // H4 fix: Require all auth headers including nonce (replay protection)
  if (!agentId || !timestamp || !signature || !nonce) {
    return c.json({
      error: {
        code: 'AUTH_REQUIRED',
        message: 'Missing required headers: X-Agent-Id, X-Timestamp, X-Signature, X-Nonce',
      },
    }, 401);
  }

  // Reject stale timestamps (replay protection)
  const age = Date.now() - new Date(timestamp).getTime();
  if (isNaN(age) || age > MAX_TIMESTAMP_AGE_MS || age < -MAX_TIMESTAMP_AGE_MS) {
    return c.json({
      error: {
        code: 'TIMESTAMP_EXPIRED',
        message: 'Request timestamp is too old or invalid (max 5 minutes)',
      },
    }, 401);
  }

  // Nonce replay protection (if nonce header provided)
  if (nonce) {
    try {
      // Atomic insert — ON CONFLICT means nonce was already used
      await db.insert(requestNonces).values({
        agentId,
        nonce,
        expiresAt: new Date(Date.now() + NONCE_TTL_MS),
      });
    } catch {
      return c.json({
        error: {
          code: 'NONCE_REUSED',
          message: 'Request nonce has already been used',
        },
      }, 401);
    }
  }

  // Look up agent's active public key
  const keys = await db.select().from(agentKeys).where(
    and(eq(agentKeys.agentId, agentId), eq(agentKeys.isActive, true)),
  );

  if (keys.length === 0) {
    return c.json({
      error: {
        code: 'UNKNOWN_AGENT',
        message: 'No active key found for this agent',
      },
    }, 401);
  }

  // Reconstruct canonical request for verification
  const bodyText = await c.req.text();
  const bodyHashBuffer = bodyText
    ? await crypto.subtle.digest('SHA-256', new TextEncoder().encode(bodyText))
    : new ArrayBuffer(0);
  const bodyHash = bodyText
    ? Buffer.from(bodyHashBuffer).toString('hex')
    : '';

  // Canonical includes full path + query string (H12 fix) + nonce if present
  const url = new URL(c.req.url);
  const pathWithSearch = `${url.pathname}${url.search}`;
  const canonicalParts = [c.req.method, pathWithSearch, timestamp];
  if (nonce) canonicalParts.push(nonce);
  canonicalParts.push(bodyHash);
  const canonical = canonicalParts.join('\n');
  const canonicalBytes = new TextEncoder().encode(canonical);

  // Try each active key (agent may have rotated keys)
  let verified = false;
  for (const key of keys) {
    try {
      const publicKeyBytes = Buffer.from(key.publicKey, 'base64');
      const signatureBytes = Buffer.from(signature, 'base64');

      // Import Ed25519 public key
      const cryptoKey = await crypto.subtle.importKey(
        'raw',
        publicKeyBytes,
        { name: 'Ed25519' },
        false,
        ['verify'],
      );

      verified = await crypto.subtle.verify(
        'Ed25519',
        cryptoKey,
        signatureBytes,
        canonicalBytes,
      );

      if (verified) break;
    } catch {
      // Key import/verify failed, try next key
      continue;
    }
  }

  if (!verified) {
    return c.json({
      error: {
        code: 'INVALID_SIGNATURE',
        message: 'Ed25519 signature verification failed',
      },
    }, 401);
  }

  // Bind verified identity to request context (C2, M3)
  c.set('verifiedAgentId', agentId);

  await next();
};

// Periodic nonce cleanup — call on a timer or cron
export async function cleanupExpiredNonces(): Promise<number> {
  const result = await db
    .delete(requestNonces)
    .where(lt(requestNonces.expiresAt, new Date()));
  return 0; // drizzle delete doesn't return count easily, but the cleanup runs
}

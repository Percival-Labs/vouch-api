// Privacy Routes — blind token issuance and public key distribution.
// POST /tokens/issue requires NIP-98 auth (identity revealed once at issuance).
// GET /tokens/public-key is public (no auth).

import { Hono } from 'hono';
import { success, error } from '../lib/response';
import type { NostrAuthEnv } from '../middleware/nostr-auth';
import { getIssuerPublicKey, issueTokenBatch } from '../services/privacy-service';

const app = new Hono<NostrAuthEnv>();

// ── GET /tokens/public-key — Issuer RSA public key (public, no auth) ──
app.get('/tokens/public-key', async (c) => {
  try {
    const keyInfo = await getIssuerPublicKey();

    return success(c, {
      public_key: keyInfo.publicKey,
      issuer_name: keyInfo.issuerName,
    });
  } catch (err) {
    console.error('[privacy] GET /tokens/public-key error:', err);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to get issuer public key');
  }
});

// ── POST /tokens/issue — Blind-sign token batch ──
app.post('/tokens/issue', async (c) => {
  const pubkey = c.get('nostrPubkey');
  if (!pubkey) return error(c, 401, 'AUTH_REQUIRED', 'NIP-98 authorization required');

  try {
    const body = await c.req.json<{
      batch_hash: string;
      blinded_tokens: string[];  // base64-encoded blinded token requests
    }>();

    if (!body.batch_hash || !body.blinded_tokens?.length) {
      return error(c, 400, 'VALIDATION_ERROR', 'batch_hash and blinded_tokens[] are required');
    }

    // Decode base64 blinded tokens
    const blindedTokens = body.blinded_tokens.map(b64 => {
      const buf = Buffer.from(b64, 'base64');
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    });

    const signedTokens = await issueTokenBatch(body.batch_hash, blindedTokens, pubkey);

    // Encode signed tokens as base64
    const signedTokensB64 = signedTokens.map(t => Buffer.from(t).toString('base64'));

    return success(c, {
      signed_tokens: signedTokensB64,
      count: signedTokensB64.length,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('not found') || msg.includes('not active')) {
      return error(c, 404, 'NOT_FOUND', msg);
    }
    if (msg.includes('Cannot issue') || msg.includes('Failed to reserve')) {
      return error(c, 400, 'VALIDATION_ERROR', msg);
    }
    console.error('[privacy] POST /tokens/issue error:', err);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to issue tokens');
  }
});

export default app;

// Privacy Service — Blind token issuance and double-spend tracking.
// Adapts Engram's Privacy Pass issuer to use PostgreSQL instead of file storage.
// RSA-4096 blind signing via @cloudflare/privacypass-ts v0.3.0.

import { eq, lt, sql } from 'drizzle-orm';
import { db, spentTokens, tokenBatches } from '@percival/vouch-db';
import { createHash } from 'crypto';

// ── Types ──

type JWK = Record<string, unknown>;

interface IssuerKeyPair {
  privateKeyJwk: JWK;
  publicKeyJwk: JWK;
}

interface IssuerInstance {
  issuer: any;              // privacypass-ts Issuer
  publicKey: CryptoKey;
  publicKeyJwk: JWK;
}

// ── State ──

let issuerInstance: IssuerInstance | null = null;
let initialized = false;

// ── Constants ──

const ISSUER_NAME = 'vouch-privacy.percival-labs.ai';

// ── Initialization ──

/**
 * Initialize the Privacy Pass issuer.
 * Loads or generates RSA-4096 keypair.
 * In production, keys are loaded from PRIVACY_ISSUER_KEY env var.
 * Falls back to generating ephemeral keys (dev mode).
 */
async function ensureInitialized(): Promise<IssuerInstance> {
  if (initialized && issuerInstance) return issuerInstance;

  const pp = await import('@cloudflare/privacypass-ts');
  const { Issuer, TOKEN_TYPES } = pp;

  let privateKey: CryptoKey;
  let publicKey: CryptoKey;
  let publicKeyJwk: JWK;

  const keyEnv = process.env.PRIVACY_ISSUER_KEY;

  if (keyEnv) {
    // Production: load from env var (JSON-encoded JWK pair)
    const keyPair: IssuerKeyPair = JSON.parse(keyEnv);
    privateKey = await crypto.subtle.importKey(
      'jwk', keyPair.privateKeyJwk as any,
      { name: 'RSA-PSS', hash: 'SHA-384' }, true, ['sign'],
    );
    publicKey = await crypto.subtle.importKey(
      'jwk', keyPair.publicKeyJwk as any,
      { name: 'RSA-PSS', hash: 'SHA-384' }, true, ['verify'],
    );
    publicKeyJwk = keyPair.publicKeyJwk;
  } else {
    // Dev mode: generate ephemeral RSA-4096 keys
    console.warn('[privacy-service] PRIVACY_ISSUER_KEY not set — generating ephemeral keys (dev mode)');
    const keys = await crypto.subtle.generateKey(
      {
        name: 'RSA-PSS',
        modulusLength: 4096,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-384',
      },
      true,
      ['sign', 'verify'],
    ) as CryptoKeyPair;
    privateKey = keys.privateKey;
    publicKey = keys.publicKey;
    publicKeyJwk = await crypto.subtle.exportKey('jwk', publicKey) as unknown as JWK;
  }

  const issuer = new Issuer(ISSUER_NAME, privateKey, publicKey);

  issuerInstance = { issuer, publicKey, publicKeyJwk };
  initialized = true;

  return issuerInstance;
}

// ── Public API ──

/**
 * Get the issuer's RSA public key for client-side token verification.
 */
export async function getIssuerPublicKey(): Promise<{ publicKey: string; issuerName: string }> {
  const inst = await ensureInitialized();

  // Export SPKI and base64-encode
  const spkiBytes = await crypto.subtle.exportKey('spki', inst.publicKey);
  const publicKeyB64 = Buffer.from(spkiBytes).toString('base64');

  return {
    publicKey: publicKeyB64,
    issuerName: ISSUER_NAME,
  };
}

/**
 * Blind-sign a batch of token requests.
 * Each blinded token is signed without seeing the original.
 */
export async function issueTokenBatch(
  batchHash: string,
  blindedTokens: Uint8Array[],
  requestingNpub: string,
): Promise<Uint8Array[]> {
  const inst = await ensureInitialized();

  // Verify batch exists and is active, and atomically increment tokensIssued
  // This prevents unlimited re-issuance by tracking how many tokens have been signed.
  const [batch] = await db.select().from(tokenBatches)
    .where(eq(tokenBatches.batchHash, batchHash))
    .limit(1);

  if (!batch || batch.status !== 'active') {
    throw new Error('Token batch not found or not active');
  }

  // Verify ownership — only the batch purchaser can request token issuance
  if (batch.ownerNpub && batch.ownerNpub !== requestingNpub) {
    throw new Error('Token batch not found or not active');
  }

  const alreadyIssued = batch.tokensIssued ?? 0;
  if (alreadyIssued + blindedTokens.length > batch.tokenCount) {
    throw new Error(`Cannot issue ${blindedTokens.length} tokens: ${alreadyIssued}/${batch.tokenCount} already issued`);
  }

  // Atomically increment tokensIssued — prevents concurrent over-issuance
  const updateResult = await db.update(tokenBatches)
    .set({
      tokensIssued: sql`COALESCE(${tokenBatches.tokensIssued}, 0) + ${blindedTokens.length}`,
    })
    .where(
      sql`${tokenBatches.batchHash} = ${batchHash}
          AND ${tokenBatches.status} = 'active'
          AND COALESCE(${tokenBatches.tokensIssued}, 0) + ${blindedTokens.length} <= ${tokenBatches.tokenCount}`,
    );

  if ((updateResult as any).rowCount === 0) {
    throw new Error('Failed to reserve tokens — batch may be exhausted or expired');
  }

  const pp = await import('@cloudflare/privacypass-ts');
  const { TokenRequest } = pp;

  // Sign each blinded token
  const signedTokens: Uint8Array[] = [];
  for (const blindedToken of blindedTokens) {
    const tokReq = TokenRequest.deserialize(blindedToken);
    const tokRes = await inst.issuer.issue(tokReq);
    signedTokens.push(tokRes.serialize());
  }

  return signedTokens;
}

/**
 * Verify a redeemed token is valid and not double-spent.
 * Returns the token hash for tracking.
 */
export async function redeemToken(
  tokenBytes: Uint8Array,
  batchHash: string,
  costSats: number,
): Promise<{ valid: boolean; tokenHash: string; reason?: string }> {
  // Token verification happens at the gateway level using the public key.
  // Here we just check double-spend and mark as spent.

  // Compute token hash for double-spend check
  const tokenHash = createHash('sha256').update(tokenBytes).digest('hex');

  // Atomic double-spend prevention: INSERT ON CONFLICT DO NOTHING
  // If the insert succeeds (rowCount=1), the token was not previously spent.
  // If it does nothing (rowCount=0), the token was already spent.
  // This eliminates the TOCTOU race between SELECT and INSERT.
  const result = await db.insert(spentTokens).values({
    tokenHash,
    batchHash,
    costSats,
  }).onConflictDoNothing();

  const inserted = (result as any).rowCount ?? 0;
  if (inserted === 0) {
    return { valid: false, tokenHash, reason: 'Token already spent' };
  }

  return { valid: true, tokenHash };
}

/**
 * Prune spent tokens older than TTL (called daily).
 */
export async function pruneSpentTokens(ttlDays: number = 7): Promise<number> {
  const cutoff = new Date(Date.now() - ttlDays * 24 * 60 * 60 * 1000);

  const result = await db.delete(spentTokens)
    .where(lt(spentTokens.redeemedAt, cutoff));

  return (result as any).rowCount ?? 0;
}

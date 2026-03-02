// ZK Proof Auth Middleware
// Verifies `Authorization: ZkProof <base64>` headers for privacy-preserving auth.
// Proves "my Vouch score >= threshold" without revealing identity or exact score.
// Uses BJJ EdDSA signature verification via circomlibjs.

import type { MiddlewareHandler } from 'hono';
import { getPublicKey, verifySignature } from '../lib/bjj-keys';

// ── Types ──

/** ZK proof payload submitted by client */
interface ZkProofPayload {
  identityHash: string;      // Poseidon hash of agent pubkey (hex)
  score: number;             // Attested score at time of issuance
  threshold: number;         // Minimum score claimed
  expiry: number;            // Unix timestamp (seconds)
  signature: {               // BJJ EdDSA signature from Vouch API
    R8x: string;
    R8y: string;
    S: string;
  };
}

/** Hono env type for ZK-authenticated requests */
export type ZkAuthEnv = {
  Variables: {
    zkIdentityHash: string;
    zkScore: number;
    zkThreshold: number;
  };
};

// ── Middleware ──

export const verifyZkAuth: MiddlewareHandler<ZkAuthEnv> = async (c, next) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('ZkProof ')) {
    return c.json({
      error: {
        code: 'AUTH_REQUIRED',
        message: 'Missing or invalid ZK proof authorization',
      },
    }, 401);
  }

  const base64Proof = authHeader.slice('ZkProof '.length).trim();
  if (!base64Proof) {
    return c.json({
      error: {
        code: 'AUTH_REQUIRED',
        message: 'Empty ZK proof token',
      },
    }, 401);
  }

  // Decode and parse proof
  let proof: ZkProofPayload;
  try {
    const decoded = atob(base64Proof);
    proof = JSON.parse(decoded);
  } catch {
    return c.json({
      error: {
        code: 'INVALID_AUTH',
        message: 'Failed to decode ZK proof (invalid base64 or JSON)',
      },
    }, 401);
  }

  // Validate structure
  if (!proof.identityHash || typeof proof.score !== 'number' ||
      typeof proof.threshold !== 'number' || typeof proof.expiry !== 'number' ||
      !proof.signature?.R8x || !proof.signature?.R8y || !proof.signature?.S) {
    return c.json({
      error: {
        code: 'INVALID_AUTH',
        message: 'Malformed ZK proof: missing required fields',
      },
    }, 401);
  }

  // Check expiry
  const nowSecs = Math.floor(Date.now() / 1000);
  if (proof.expiry < nowSecs) {
    return c.json({
      error: {
        code: 'EXPIRED_PROOF',
        message: 'ZK proof attestation has expired',
      },
    }, 401);
  }

  // Verify the score meets the claimed threshold
  if (proof.score < proof.threshold) {
    return c.json({
      error: {
        code: 'INVALID_AUTH',
        message: 'Attested score does not meet threshold',
      },
    }, 401);
  }

  // Verify BJJ EdDSA signature from Vouch API
  try {
    const isValid = await verifySignature(
      proof.identityHash,
      proof.score,
      proof.expiry,
      proof.signature,
    );

    if (!isValid) {
      return c.json({
        error: {
          code: 'INVALID_SIGNATURE',
          message: 'ZK proof signature verification failed',
        },
      }, 401);
    }
  } catch (err) {
    console.error('[zk-auth] Signature verification error:', err);
    return c.json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to verify ZK proof',
      },
    }, 500);
  }

  // Set verified ZK identity in context
  c.set('zkIdentityHash', proof.identityHash);
  c.set('zkScore', proof.score);
  c.set('zkThreshold', proof.threshold);

  await next();
};

// JWT utilities — sign and verify vouch-session tokens
// Uses jose (JOSE standard, works in Bun/Node/Edge runtimes).

import { SignJWT, jwtVerify } from 'jose';

const SESSION_COOKIE = 'vouch-session';
const JWT_EXPIRY_SECONDS = 60 * 60 * 24 * 7; // 7 days

export { SESSION_COOKIE, JWT_EXPIRY_SECONDS };

export interface SessionPayload {
  sub: string;   // user ID (ULID)
  email: string;
}

// H1: Issuer/audience claims prevent cross-service token confusion
const ISSUER = 'vouch-api';
const AUDIENCE = 'vouch-app';

function getSecret(): Uint8Array {
  const raw = process.env.JWT_SECRET;
  if (!raw) throw new Error('JWT_SECRET environment variable is not set');
  if (raw.length < 32) throw new Error('JWT_SECRET must be at least 32 characters');
  return new TextEncoder().encode(raw);
}

export async function signSession(payload: SessionPayload): Promise<string> {
  return new SignJWT({ email: payload.email })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(payload.sub)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${JWT_EXPIRY_SECONDS}s`)
    .sign(getSecret());
}

export async function verifySession(token: string): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret(), {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ['HS256'],
    });
    if (typeof payload.sub !== 'string' || typeof payload.email !== 'string') {
      return null;
    }
    return { sub: payload.sub, email: payload.email };
  } catch {
    return null;
  }
}

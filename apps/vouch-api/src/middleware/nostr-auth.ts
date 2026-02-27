// NIP-98 HTTP Auth Middleware
// Verifies `Authorization: Nostr <base64-encoded-event>` headers per NIP-98.
// Runs as a SEPARATE middleware from verify-signature.ts (Ed25519).
// Can be applied selectively to routes that use Nostr identity.

import type { MiddlewareHandler } from 'hono';
import { schnorr } from '@noble/curves/secp256k1';
import { db, agents } from '@percival/vouch-db';
import { eq } from 'drizzle-orm';

// ── Configuration ──

const SKIP_AUTH = process.env.VOUCH_SKIP_AUTH === 'true';
if (SKIP_AUTH && process.env.NODE_ENV === 'production') {
  console.error('[FATAL] VOUCH_SKIP_AUTH=true is forbidden in production. Exiting.');
  process.exit(1);
}
const MAX_EVENT_AGE_SECS = 60; // NIP-98 recommends tight windows

// H3 fix: In-memory replay protection for NIP-98 event IDs (60s TTL)
const seenEventIds = new Map<string, number>();
const REPLAY_CLEANUP_INTERVAL_MS = 30_000; // 30 seconds
setInterval(() => {
  const cutoff = Date.now() - (MAX_EVENT_AGE_SECS * 1000);
  for (const [id, ts] of seenEventIds) {
    if (ts < cutoff) seenEventIds.delete(id);
  }
}, REPLAY_CLEANUP_INTERVAL_MS).unref?.();

// ── Types ──

/** Nostr event structure per NIP-01 */
interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

/** Hono env type for Nostr-authenticated requests */
export type NostrAuthEnv = {
  Variables: {
    verifiedAgentId: string;
    nostrPubkey: string;
  };
};

// ── Hex/Bytes Helpers ──

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ── NIP-01 Event ID Computation ──

/**
 * Compute event ID per NIP-01: sha256 of the canonical JSON serialization.
 * Returns hex string.
 */
async function computeEventId(event: NostrEvent): Promise<string> {
  const serialized = JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content,
  ]);
  const hash = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(serialized),
  );
  return bytesToHex(new Uint8Array(hash));
}

// ── Nostr Event Verification ──

/**
 * Verify a NIP-98 auth event:
 * 1. Recompute event ID from canonical serialization (NIP-01)
 * 2. Verify Schnorr signature (BIP-340) over the event ID
 *
 * Returns true if the event is cryptographically valid.
 * Does NOT check kind, tags, or timestamp — those are checked separately.
 */
async function verifyNostrEvent(event: NostrEvent): Promise<boolean> {
  // Recompute the event ID to ensure it matches the claimed ID
  const expectedId = await computeEventId(event);
  if (expectedId !== event.id) {
    return false;
  }

  // Verify Schnorr signature over the event ID
  try {
    return schnorr.verify(
      hexToBytes(event.sig),
      hexToBytes(event.id),
      hexToBytes(event.pubkey),
    );
  } catch {
    // Malformed key, signature, or ID bytes
    return false;
  }
}

// ── Validation Helpers ──

/**
 * Validate NIP-98 event structure and tags against the incoming request.
 * Returns an error message string if invalid, or null if valid.
 */
function validateNip98Event(
  event: NostrEvent,
  requestUrl: string,
  requestMethod: string,
): string | null {
  // Kind must be 27235 (NIP-98 HTTP Auth)
  if (event.kind !== 27235) {
    return `Invalid event kind: expected 27235, got ${event.kind}`;
  }

  // Extract tag values
  const urlTag = event.tags.find((t) => t[0] === 'u');
  const methodTag = event.tags.find((t) => t[0] === 'method');

  if (!urlTag || !urlTag[1]) {
    return 'Missing required "u" tag';
  }

  if (!methodTag || !methodTag[1]) {
    return 'Missing required "method" tag';
  }

  // URL comparison: match pathname only (ignore origin and query params).
  // Behind reverse proxies (Railway, Cloudflare), c.req.url has the internal
  // origin (e.g. http://0.0.0.0:3601) while the NIP-98 event signs the external
  // URL (e.g. https://percivalvouch-api-production.up.railway.app).
  // Pathname-only comparison is safe because the signature binds the full URL
  // and the server only serves one app per path prefix.
  let eventUrl: URL;
  let reqUrl: URL;
  try {
    eventUrl = new URL(urlTag[1]);
    reqUrl = new URL(requestUrl);
  } catch {
    return `Invalid URL in "u" tag or request: ${urlTag[1]}`;
  }

  if (eventUrl.pathname !== reqUrl.pathname) {
    return `URL mismatch: event path "${eventUrl.pathname}", request path "${reqUrl.pathname}"`;
  }

  // Method comparison (case-insensitive)
  if (methodTag[1].toUpperCase() !== requestMethod.toUpperCase()) {
    return `Method mismatch: event has "${methodTag[1]}", request is "${requestMethod}"`;
  }

  // Timestamp freshness: reject future events (with small clock-skew allowance) and stale events
  const nowSecs = Math.floor(Date.now() / 1000);
  const CLOCK_SKEW_SECS = 5; // small allowance for clock drift
  if (event.created_at > nowSecs + CLOCK_SKEW_SECS) {
    return `Event timestamp is in the future (${event.created_at - nowSecs}s ahead)`;
  }
  if (nowSecs - event.created_at > MAX_EVENT_AGE_SECS) {
    return `Event timestamp too old (${nowSecs - event.created_at}s ago, max ${MAX_EVENT_AGE_SECS}s)`;
  }

  return null;
}

/**
 * Parse and validate event JSON structure.
 * Returns the parsed event or null if the structure is invalid.
 */
function parseNostrEvent(json: unknown): NostrEvent | null {
  if (typeof json !== 'object' || json === null) return null;

  const obj = json as Record<string, unknown>;

  // Required fields with correct types
  if (typeof obj.id !== 'string') return null;
  if (typeof obj.pubkey !== 'string') return null;
  if (typeof obj.created_at !== 'number') return null;
  if (typeof obj.kind !== 'number') return null;
  if (!Array.isArray(obj.tags)) return null;
  if (typeof obj.content !== 'string') return null;
  if (typeof obj.sig !== 'string') return null;

  // Validate hex field lengths (32 bytes = 64 hex chars)
  if (!/^[0-9a-f]{64}$/.test(obj.id as string)) return null;
  if (!/^[0-9a-f]{64}$/.test(obj.pubkey as string)) return null;
  if (!/^[0-9a-f]{128}$/.test(obj.sig as string)) return null; // 64 bytes = 128 hex

  return obj as unknown as NostrEvent;
}

// ── Middleware ──

export const verifyNostrAuth: MiddlewareHandler<NostrAuthEnv> = async (c, next) => {
  // Skip auth for public endpoints
  if (c.req.path.startsWith('/v1/public/')) {
    await next();
    return;
  }

  // Skip auth for user-facing auth endpoints (cookie/JWT based)
  if (c.req.path.startsWith('/v1/auth/')) {
    await next();
    return;
  }

  // Skip auth for webhook routes (use shared secret instead)
  if (c.req.path.startsWith('/v1/webhooks/')) {
    await next();
    return;
  }

  // ── Extract Authorization header ──

  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Nostr ')) {
    return c.json({
      error: {
        code: 'AUTH_REQUIRED',
        message: 'Missing or invalid Nostr authorization',
      },
    }, 401);
  }

  const base64Event = authHeader.slice('Nostr '.length).trim();
  if (!base64Event) {
    return c.json({
      error: {
        code: 'AUTH_REQUIRED',
        message: 'Empty Nostr authorization token',
      },
    }, 401);
  }

  // ── Decode base64 event ──

  let eventJson: unknown;
  try {
    const decoded = atob(base64Event);
    eventJson = JSON.parse(decoded);
  } catch {
    return c.json({
      error: {
        code: 'INVALID_AUTH',
        message: 'Failed to decode Nostr authorization event (invalid base64 or JSON)',
      },
    }, 401);
  }

  // ── Parse and validate event structure ──

  const event = parseNostrEvent(eventJson);
  if (!event) {
    return c.json({
      error: {
        code: 'INVALID_AUTH',
        message: 'Malformed Nostr event: missing or invalid required fields',
      },
    }, 401);
  }

  // ── SKIP_AUTH mode: accept event without cryptographic verification ──

  if (SKIP_AUTH) {
    console.warn('[nostr-auth] WARNING: Auth bypassed via VOUCH_SKIP_AUTH=true');
    c.set('nostrPubkey', event.pubkey);

    // Still try to resolve agent identity for context
    const [agent] = await db
      .select()
      .from(agents)
      .where(eq(agents.pubkey, event.pubkey))
      .limit(1);

    if (agent) {
      c.set('verifiedAgentId', agent.id);
    }

    await next();
    return;
  }

  // ── Validate NIP-98 event fields ──

  // M6 fix: log specific validation error server-side, return generic message to client
  const validationError = validateNip98Event(event, c.req.url, c.req.method);
  if (validationError) {
    console.warn(`[nostr-auth] NIP-98 validation failed: ${validationError}`);
    return c.json({
      error: {
        code: 'INVALID_AUTH',
        message: 'NIP-98 event validation failed',
      },
    }, 401);
  }

  // ── Verify cryptographic signature ──

  const sigValid = await verifyNostrEvent(event);
  if (!sigValid) {
    return c.json({
      error: {
        code: 'INVALID_SIGNATURE',
        message: 'Schnorr signature verification failed',
      },
    }, 401);
  }

  // ── H3 fix: Replay protection — reject reused event IDs within timestamp window ──
  if (seenEventIds.has(event.id)) {
    return c.json({
      error: {
        code: 'REPLAY_DETECTED',
        message: 'NIP-98 event has already been used',
      },
    }, 401);
  }
  seenEventIds.set(event.id, Date.now());

  // ── Validate body hash if present (NIP-98 payload binding) ──
  const payloadTag = event.tags.find((t: string[]) => t[0] === 'payload');
  if (payloadTag && payloadTag[1]) {
    try {
      // Clone the request to avoid consuming the body stream
      const bodyText = await c.req.raw.clone().text();
      const bodyHash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(bodyText));
      const bodyHashHex = Array.from(new Uint8Array(bodyHash)).map(b => b.toString(16).padStart(2, '0')).join('');
      if (bodyHashHex !== payloadTag[1]) {
        console.warn(`[nostr-auth] Payload hash mismatch: expected ${payloadTag[1]}, got ${bodyHashHex}`);
        return c.json({
          error: {
            code: 'INVALID_AUTH',
            message: 'Request body does not match signed payload hash',
          },
        }, 401);
      }
    } catch (err) {
      console.warn(`[nostr-auth] Failed to validate payload hash: ${err}`);
      return c.json({
        error: {
          code: 'INVALID_AUTH',
          message: 'Failed to validate request body hash',
        },
      }, 401);
    }
  }

  // ── Look up agent by pubkey ──

  c.set('nostrPubkey', event.pubkey);

  const [agent] = await db
    .select()
    .from(agents)
    .where(eq(agents.pubkey, event.pubkey))
    .limit(1);

  if (agent) {
    // Known agent — bind verified identity to request context
    c.set('verifiedAgentId', agent.id);
  } else if (
    (c.req.path === '/v1/sdk/agents/register' || c.req.path === '/v1/agents/register') &&
    c.req.method === 'POST'
  ) {
    // Registration endpoint: agent doesn't exist yet, allow through with pubkey only.
    // The route handler will use nostrPubkey to create the agent record.
  } else {
    // Unknown pubkey on a non-registration route
    return c.json({
      error: {
        code: 'UNKNOWN_AGENT',
        message: 'No agent registered with this Nostr public key',
      },
    }, 401);
  }

  await next();
};

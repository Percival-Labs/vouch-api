// Percival Labs - Token Bucket Rate Limiter Middleware (Vouch API)
// In-memory rate limiting with tiered buckets for different endpoint classes.
// Supports both IP-based (global) and agent-identity-based limiting.

import type { Context, Next, MiddlewareHandler } from 'hono';

// ── Types ──

type AppEnv = { Variables: { verifiedAgentId: string } };

interface TokenBucket {
  tokens: number;
  lastRefill: number;
}

interface RateLimitTier {
  maxTokens: number;
  refillRate: number; // tokens per millisecond
  windowMs: number;
}

// ── Configuration ──

const TIERS: Record<string, RateLimitTier> = {
  global: {
    maxTokens: 100,
    refillRate: 100 / 60_000, // 100 per minute
    windowMs: 60_000,
  },
  registration: {
    maxTokens: 5,
    refillRate: 5 / 3_600_000, // 5 per hour
    windowMs: 3_600_000,
  },
  financial: {
    maxTokens: 20,
    refillRate: 20 / 60_000, // 20 per minute
    windowMs: 60_000,
  },
  voting: {
    maxTokens: 30,
    refillRate: 30 / 60_000, // 30 per minute
    windowMs: 60_000,
  },
  trust_refresh: {
    maxTokens: 5,
    refillRate: 5 / 60_000, // 5 per minute
    windowMs: 60_000,
  },
  public: {
    maxTokens: 60,
    refillRate: 60 / 60_000, // 60 per minute
    windowMs: 60_000,
  },
  auth_login: {
    maxTokens: 10,
    refillRate: 10 / 60_000, // 10 per minute (credential stuffing protection)
    windowMs: 60_000,
  },
};

const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const BUCKET_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes without activity
const MAX_STORE_SIZE = 100_000; // H9 fix: cap store to prevent memory exhaustion DoS

// ── Store ──

// Keyed by "{identifier}:{tier}" -> bucket state
const store = new Map<string, TokenBucket>();

// Track last access per key for cleanup
const lastAccess = new Map<string, number>();

// ── Cleanup ──

let cleanupTimer: ReturnType<typeof setInterval> | null = null;

function startCleanup(): void {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, accessTime] of lastAccess.entries()) {
      if (now - accessTime > BUCKET_EXPIRY_MS) {
        store.delete(key);
        lastAccess.delete(key);
      }
    }
  }, CLEANUP_INTERVAL_MS);

  // Allow process to exit without waiting for this timer
  if (cleanupTimer && typeof cleanupTimer === 'object' && 'unref' in cleanupTimer) {
    cleanupTimer.unref();
  }
}

// ── Token Bucket Logic ──

function refillBucket(bucket: TokenBucket, tier: RateLimitTier, now: number): void {
  const elapsed = now - bucket.lastRefill;
  const tokensToAdd = elapsed * tier.refillRate;
  bucket.tokens = Math.min(tier.maxTokens, bucket.tokens + tokensToAdd);
  bucket.lastRefill = now;
}

function consumeToken(identifier: string, tierName: string): {
  allowed: boolean;
  remaining: number;
  limit: number;
  resetAt: number;
  retryAfterSeconds: number;
} {
  const tier = TIERS[tierName];
  if (!tier) {
    throw new Error(`Unknown rate limit tier: ${tierName}`);
  }

  const key = `${identifier}:${tierName}`;
  const now = Date.now();

  lastAccess.set(key, now);

  let bucket = store.get(key);
  if (!bucket) {
    // H9 fix: reject new keys when store is at capacity (DoS protection)
    if (store.size >= MAX_STORE_SIZE) {
      return {
        allowed: false,
        remaining: 0,
        limit: tier.maxTokens,
        resetAt: now + tier.windowMs,
        retryAfterSeconds: 60,
      };
    }
    bucket = { tokens: tier.maxTokens, lastRefill: now };
    store.set(key, bucket);
  }

  // Refill based on elapsed time
  refillBucket(bucket, tier, now);

  const resetAt = now + tier.windowMs;

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return {
      allowed: true,
      remaining: Math.floor(bucket.tokens),
      limit: tier.maxTokens,
      resetAt,
      retryAfterSeconds: 0,
    };
  }

  // Denied: calculate how long until 1 token is available
  const timeUntilToken = Math.ceil((1 - bucket.tokens) / tier.refillRate);
  const retryAfterSeconds = Math.ceil(timeUntilToken / 1000);

  return {
    allowed: false,
    remaining: 0,
    limit: tier.maxTokens,
    resetAt,
    retryAfterSeconds: Math.max(1, retryAfterSeconds),
  };
}

// ── Helpers ──

/**
 * Extract client IP. In production behind a reverse proxy, configure TRUSTED_PROXY_IPS
 * to validate the X-Forwarded-For chain. Without trusted proxy config, falls back to
 * the connection's remote address (Bun) or 'unknown'.
 * C5 fix: never blindly trust X-Forwarded-For.
 */
function getClientIp(c: Context): string {
  // Prefer Bun's actual connection info when available
  const connInfo = (c.env as any)?.remoteAddr || (c.req.raw as any)?.socket?.remoteAddress;
  if (connInfo) return String(connInfo);

  // Behind trusted proxy: only trust X-Forwarded-For if proxy is configured
  const trustedProxies = process.env.TRUSTED_PROXY_IPS?.split(',').map(s => s.trim());
  if (trustedProxies && trustedProxies.length > 0) {
    const xff = c.req.header('x-forwarded-for');
    if (xff) {
      // Take the rightmost IP not in the trusted proxy list (last client hop)
      const ips = xff.split(',').map(s => s.trim());
      for (let i = ips.length - 1; i >= 0; i--) {
        if (!trustedProxies.includes(ips[i])) {
          return ips[i];
        }
      }
    }
  }

  return 'unknown';
}

function applyHeaders(c: Context, result: ReturnType<typeof consumeToken>): void {
  c.header('X-RateLimit-Limit', String(result.limit));
  c.header('X-RateLimit-Remaining', String(result.remaining));
  c.header('X-RateLimit-Reset', String(Math.floor(result.resetAt / 1000)));
}

function denyResponse(c: Context, retryAfterSeconds: number) {
  c.header('Retry-After', String(retryAfterSeconds));
  return c.json(
    {
      error: {
        code: 'RATE_LIMIT_EXCEEDED',
        message: `Too many requests, try again in ${retryAfterSeconds} seconds`,
      },
    },
    429,
  );
}

// ── Middleware Factories ──

/**
 * IP-based rate limiter middleware.
 * Uses the client IP as the identifier.
 * @param tier - Rate limit tier name (defaults to 'global')
 */
export function rateLimiter(tier: string = 'global'): MiddlewareHandler {
  startCleanup();

  return async (c: Context, next: Next) => {
    const ip = getClientIp(c);
    const result = consumeToken(ip, tier);

    applyHeaders(c, result);

    if (!result.allowed) {
      console.warn(`[rate-limit] Denied ${ip} on tier ${tier}: limit exceeded`);
      return denyResponse(c, result.retryAfterSeconds);
    }

    await next();
  };
}

/**
 * Agent-identity-based rate limiter middleware.
 * Uses the verified agent ID as the identifier, falling back to IP.
 * @param tier - Rate limit tier name (required)
 */
export function agentRateLimiter(tier: string): MiddlewareHandler<AppEnv> {
  startCleanup();

  return async (c: Context<AppEnv>, next: Next) => {
    // C6 fix: only use verified identity or IP, never trust raw X-Agent-Id header
    const agentId = c.get('verifiedAgentId') || getClientIp(c);

    const result = consumeToken(agentId, tier);

    applyHeaders(c, result);

    if (!result.allowed) {
      console.warn(`[rate-limit] Denied ${agentId} on tier ${tier}: limit exceeded`);
      return denyResponse(c, result.retryAfterSeconds);
    }

    await next();
  };
}

// ── Testing Utilities ──

/** Reset all rate limit state. For testing only. */
export function _resetStore(): void {
  store.clear();
  lastAccess.clear();
}

/** Stop the cleanup interval. For testing/shutdown. */
export function _stopCleanup(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

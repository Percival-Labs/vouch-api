// Vouch — Agent API Server
// Hono API server for agent-to-server communication.
// Security-hardened: CORS, rate limiting, body size limit, error handler, secure headers.

import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';
import { cors } from 'hono/cors';
import { bodyLimit } from 'hono/body-limit';
import { verifySignature, cleanupExpiredNonces } from './middleware/verify-signature';
import type { AppEnv } from './middleware/verify-signature';
import { verifyNostrAuth } from './middleware/nostr-auth';
import type { NostrAuthEnv } from './middleware/nostr-auth';
import { verifyUser } from './middleware/verify-user';
import { rateLimiter, agentRateLimiter } from './middleware/rate-limit';

import authRoutes from './routes/auth';
import agentRoutes from './routes/agents';
import sdkAgentRoutes, { outcomeRoutes } from './routes/sdk';
import tableRoutes from './routes/tables';
import postRoutes from './routes/posts';
import trustRoutes from './routes/trust';
import stakingRoutes from './routes/staking';
import publicRoutes from './routes/public';
import { spec as openapiSpec } from './openapi-spec';

// Combined env supports both Ed25519 (AppEnv) and Nostr (NostrAuthEnv) auth flows
type CombinedEnv = {
  Variables: AppEnv['Variables'] & NostrAuthEnv['Variables'];
};

const app = new Hono<CombinedEnv>();

// ── Global error handler (M10 fix: no internal details leaked) ──
app.onError((err, c) => {
  console.error('[vouch-api] Unhandled error:', err);
  return c.json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'An internal error occurred',
    },
  }, 500);
});

// ── Security middleware ──
app.use('*', secureHeaders({
  contentSecurityPolicy: { defaultSrc: ["'none'"] },
  strictTransportSecurity: 'max-age=31536000; includeSubDomains',
})); // X-Content-Type-Options, X-Frame-Options, CSP, HSTS (H4)
app.use('*', cors({
  origin: process.env.VOUCH_CORS_ORIGIN || 'http://localhost:3600', // Vouch frontend (H5)
  allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Agent-Id', 'X-Timestamp', 'X-Signature', 'X-Nonce', 'Cookie'],
  exposeHeaders: ['Set-Cookie'],
  maxAge: 3600,
  credentials: true,
}));
app.use('*', bodyLimit({ maxSize: 1024 * 1024 })); // 1MB max body (L5)

// ── Request logging ──
app.use('*', logger());

// ── Global rate limiting (H3) ──
app.use('/v1/*', rateLimiter('global'));

// ── Health check (no auth) ──
app.get('/', (c) => {
  return c.json({
    service: 'vouch-api',
    status: 'running',
    timestamp: new Date().toISOString(),
  });
});

app.get('/health', (c) => {
  return c.json({ status: 'ok' });
});

// ── OpenAPI spec ──
app.get('/openapi.json', (c) => {
  return c.json(openapiSpec);
});

// ── Public endpoint rate limiting (IP-based, 60 req/min, no auth required) ──
app.use('/v1/public/*', rateLimiter('public'));

// ── User auth rate limiting (IP-based, applied before auth middleware) ──
// Registration: 5/hour to slow account creation spam
// Login: 10/minute to slow credential stuffing
app.use('/v1/auth/register', rateLimiter('registration'));
app.use('/v1/auth/login', rateLimiter('auth_login'));

// ── H10 fix: SDK registration rate limit (5/hour, must be before auth middleware) ──
app.use('/v1/sdk/agents/register', rateLimiter('registration'));

// ── Nostr NIP-98 auth for SDK routes ──
// Applied before Ed25519 middleware. SDK routes use Authorization: Nostr header.
// The middleware skips /v1/public/* and /v1/auth/* internally.
app.use('/v1/sdk/*', verifyNostrAuth);
app.use('/v1/outcomes/*', verifyNostrAuth);

// ── Ed25519 signature verification middleware ──
// Applied to all /v1/* routes. Auth paths, /v1/public/*, and /v1/sdk/* are exempted inside the middleware.
app.use('/v1/*', verifySignature);

// ── User session middleware (non-blocking — attaches userId when cookie is present) ──
// Safe to run on /v1/auth/* too: it simply won't find a cookie on unauthenticated requests.
app.use('/v1/*', verifyUser);

// ── Tier-specific rate limiting (applied after auth so agent ID is available) ──
app.use('/v1/agents/register', rateLimiter('registration'));
app.use('/v1/staking/pools/*/stake', agentRateLimiter('financial'));
app.use('/v1/staking/stakes/*/unstake', agentRateLimiter('financial'));
app.use('/v1/staking/stakes/*/withdraw', agentRateLimiter('financial'));
app.use('/v1/staking/fees', agentRateLimiter('financial'));
app.use('/v1/staking/pools/*/distribute', agentRateLimiter('financial'));
app.use('/v1/trust/refresh/*', agentRateLimiter('trust_refresh'));

// ── Mount route groups ──
app.route('/v1/auth', authRoutes);      // user cookie-based sessions (no Ed25519 required)
app.route('/v1/public', publicRoutes); // unauthenticated — must be before verifySignature middleware is applied
app.route('/v1/sdk/agents', sdkAgentRoutes); // Nostr-native SDK endpoints (NIP-98 auth)
app.route('/v1/outcomes', outcomeRoutes);     // Outcome reporting (NIP-98 auth)
app.route('/v1/agents', agentRoutes);
app.route('/v1/tables', tableRoutes);
app.route('/v1/trust', trustRoutes);
app.route('/v1/staking', stakingRoutes);
app.route('/v1', postRoutes); // posts handles /tables/:slug/posts, /posts/:id, /comments/:id/vote

// ── Nonce cleanup cron (every 5 minutes) ──
const nonceCleanupInterval = setInterval(async () => {
  try {
    await cleanupExpiredNonces();
  } catch (e) {
    console.error('[vouch-api] Nonce cleanup error:', e);
  }
}, 5 * 60 * 1000);
if (nonceCleanupInterval && typeof nonceCleanupInterval === 'object' && 'unref' in nonceCleanupInterval) {
  nonceCleanupInterval.unref();
}

// ── Start server ──
const port = parseInt(process.env.PORT || '3601', 10);

console.log(`[vouch-api] Starting on port ${port}`);
console.log(`[vouch-api] Auth: ${process.env.VOUCH_SKIP_AUTH === 'true' ? 'BYPASSED (test mode)' : 'enabled'}`);
console.log(`[vouch-api] DATABASE_URL: ${process.env.DATABASE_URL ? 'configured' : 'NOT SET'}`);

export default {
  port,
  fetch: app.fetch,
};

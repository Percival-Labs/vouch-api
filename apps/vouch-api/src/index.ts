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
import webhookRoutes from './routes/webhooks';
import publicRoutes from './routes/public';
import discoveryRoutes from './routes/discovery';
import { spec as openapiSpec } from './openapi-spec';
import contractRoutes from './routes/contracts';
import skillRoutes from './routes/skills';
import creditRoutes from './routes/credits';
import privacyRoutes from './routes/privacy';
import inferenceRoutes from './routes/inference';
import { initTreasury, reconcileTreasury, runTreasuryRebalance, checkYieldReinvestment } from './services/treasury-service';
import { cleanupExpiredPendingStakes } from './services/staking-service';
import { processRetentionReleases } from './services/contract-service';
import { takePriceSnapshot } from './services/price-service';
import { expireTokenBatches } from './services/credit-service';
import { pruneSpentTokens } from './services/privacy-service';
import { distributeFeePool } from './services/fee-distribution-service';

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
const ALLOWED_ORIGINS = (process.env.VOUCH_CORS_ORIGINS || 'http://localhost:3600')
  .split(',')
  .map(s => s.trim());

app.use('*', cors({
  origin: (origin) => ALLOWED_ORIGINS.includes(origin) ? origin : '',
  allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Agent-Id', 'X-Timestamp', 'X-Signature', 'X-Nonce', 'Cookie', 'X-Gateway-Secret'],
  exposeHeaders: ['Set-Cookie', 'X-Vouch-API-Version', 'X-Vouch-Docs', 'X-Vouch-LLMs-Txt'],
  maxAge: 3600,
  credentials: true,
}));
app.use('*', bodyLimit({ maxSize: 1024 * 1024 })); // 1MB max body (L5)

// ── Request logging ──
app.use('*', logger());

// ── Agent discoverability headers (added to ALL responses) ──
app.use('*', async (c, next) => {
  await next();
  c.res.headers.set('X-Vouch-API-Version', '0.2.1');
  c.res.headers.set('X-Vouch-Docs', 'https://percival-labs.ai/research');
  c.res.headers.set('X-Vouch-LLMs-Txt', 'https://percivalvouch-api-production.up.railway.app/llms.txt');
});

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

// ── Agent discovery routes (no auth, served before all middleware) ──
app.route('', discoveryRoutes);

// ── Public endpoint rate limiting (IP-based, 60 req/min, no auth required) ──
app.use('/v1/public/*', rateLimiter('public'));

// ── User auth rate limiting (IP-based, applied before auth middleware) ──
// Registration: 5/hour to slow account creation spam
// Login: 10/minute to slow credential stuffing
app.use('/v1/auth/register', rateLimiter('registration'));
app.use('/v1/auth/login', rateLimiter('auth_login'));

// ── H10 fix: SDK registration rate limit (5/hour, must be before auth middleware) ──
app.use('/v1/sdk/agents/register', rateLimiter('registration'));

// ── Webhook routes (mounted BEFORE auth middleware — webhooks use shared secret) ──
app.use('/v1/webhooks/*', rateLimiter('global'));
app.route('/v1/webhooks', webhookRoutes);

// ── Nostr NIP-98 auth for SDK routes ──
// Applied before Ed25519 middleware. SDK routes use Authorization: Nostr header.
// The middleware skips /v1/public/* and /v1/auth/* internally.
app.use('/v1/sdk/*', verifyNostrAuth);
app.use('/v1/outcomes/*', verifyNostrAuth);
app.use('/v1/contracts/*', verifyNostrAuth);
app.use('/v1/skills/*', verifyNostrAuth);
app.use('/v1/credits/*', verifyNostrAuth);
app.use('/v1/privacy/tokens/issue', verifyNostrAuth);

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
app.use('/v1/contracts/*/fund', agentRateLimiter('financial'));
app.use('/v1/contracts/*/milestones/*/accept', agentRateLimiter('financial'));
app.use('/v1/credits/deposit', agentRateLimiter('financial'));
app.use('/v1/credits/deposit/confirm', agentRateLimiter('financial'));
app.use('/v1/credits/batches', agentRateLimiter('financial'));
app.use('/v1/skills/*/purchase', agentRateLimiter('financial'));
app.use('/v1/contracts/*/bids', agentRateLimiter('financial'));
app.use('/v1/contracts/*/bids/*/accept', agentRateLimiter('financial'));

// ── Mount route groups ──
app.route('/v1/auth', authRoutes);      // user cookie-based sessions (no Ed25519 required)
app.route('/v1/public', publicRoutes); // unauthenticated — must be before verifySignature middleware is applied
app.route('/v1/sdk/agents', sdkAgentRoutes); // Nostr-native SDK endpoints (NIP-98 auth)
app.route('/v1/outcomes', outcomeRoutes);     // Outcome reporting (NIP-98 auth)
app.route('/v1/agents', agentRoutes);
app.route('/v1/tables', tableRoutes);
app.route('/v1/trust', trustRoutes);
app.route('/v1/staking', stakingRoutes);
app.route('/v1/contracts', contractRoutes);    // Contract work agreements (NIP-98 auth)
app.route('/v1/skills', skillRoutes);          // Skill marketplace (NIP-98 auth)
app.route('/v1/credits', creditRoutes);        // Credit management (NIP-98 auth)
app.route('/v1/privacy', privacyRoutes);       // Token issuance (NIP-98 auth for /issue, public for /public-key)
app.route('/v1/inference', inferenceRoutes);    // Usage reporting (gateway secret) + pricing (public)
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

// ── Pending stake cleanup cron (every 5 minutes, S9 fix) ──
const pendingStakeCleanupInterval = setInterval(async () => {
  try {
    await cleanupExpiredPendingStakes();
  } catch (e) {
    console.error('[vouch-api] Pending stake cleanup error:', e);
  }
}, 5 * 60 * 1000);
if (pendingStakeCleanupInterval && typeof pendingStakeCleanupInterval === 'object' && 'unref' in pendingStakeCleanupInterval) {
  pendingStakeCleanupInterval.unref();
}

// ── Initialize Treasury wallet (non-blocking) ──
initTreasury().catch((err) => {
  console.warn('[vouch-api] Treasury init failed (Lightning payments unavailable):', err instanceof Error ? err.message : err);
});

// ── Treasury reconciliation interval (every 30 minutes) ──
const treasuryReconcileInterval = setInterval(async () => {
  try {
    await reconcileTreasury();
  } catch (e) {
    console.error('[vouch-api] Treasury reconciliation error:', e);
  }
}, 30 * 60 * 1000);
if (treasuryReconcileInterval && typeof treasuryReconcileInterval === 'object' && 'unref' in treasuryReconcileInterval) {
  treasuryReconcileInterval.unref();
}

// ── Daily BTC price snapshot (every 24 hours) ──
const priceSnapshotInterval = setInterval(async () => {
  try {
    await takePriceSnapshot('scheduled');
  } catch (e) {
    console.error('[vouch-api] Price snapshot error:', e);
  }
}, 24 * 60 * 60 * 1000);
if (priceSnapshotInterval && typeof priceSnapshotInterval === 'object' && 'unref' in priceSnapshotInterval) {
  priceSnapshotInterval.unref();
}
// Take initial snapshot on startup (non-blocking)
takePriceSnapshot('startup').catch((e) => {
  console.warn('[vouch-api] Initial price snapshot failed:', e instanceof Error ? e.message : e);
});

// ── Contract retention release (daily) ──
const retentionReleaseInterval = setInterval(async () => {
  try {
    await processRetentionReleases();
  } catch (e) {
    console.error('[vouch-api] Retention release error:', e);
  }
}, 24 * 60 * 60 * 1000);
if (retentionReleaseInterval && typeof retentionReleaseInterval === 'object' && 'unref' in retentionReleaseInterval) {
  retentionReleaseInterval.unref();
}

// ── PL Treasury rebalance (every 24 hours) ──
const treasuryRebalanceInterval = setInterval(async () => {
  try {
    await checkYieldReinvestment();
    await runTreasuryRebalance();
  } catch (e) {
    console.error('[vouch-api] Treasury rebalance error:', e);
  }
}, 24 * 60 * 60 * 1000);
if (treasuryRebalanceInterval && typeof treasuryRebalanceInterval === 'object' && 'unref' in treasuryRebalanceInterval) {
  treasuryRebalanceInterval.unref();
}

// ── Token batch expiry (hourly) ──
const tokenBatchExpiryInterval = setInterval(async () => {
  try {
    const expired = await expireTokenBatches();
    if (expired > 0) {
      console.log(`[vouch-api] Expired ${expired} token batches`);
    }
  } catch (e) {
    console.error('[vouch-api] Token batch expiry error:', e);
  }
}, 60 * 60 * 1000);
if (tokenBatchExpiryInterval && typeof tokenBatchExpiryInterval === 'object' && 'unref' in tokenBatchExpiryInterval) {
  tokenBatchExpiryInterval.unref();
}

// ── Spent token pruning (daily, 7-day TTL) ──
const spentTokenPruneInterval = setInterval(async () => {
  try {
    const pruned = await pruneSpentTokens(7);
    if (pruned > 0) {
      console.log(`[vouch-api] Pruned ${pruned} spent tokens`);
    }
  } catch (e) {
    console.error('[vouch-api] Spent token pruning error:', e);
  }
}, 24 * 60 * 60 * 1000);
if (spentTokenPruneInterval && typeof spentTokenPruneInterval === 'object' && 'unref' in spentTokenPruneInterval) {
  spentTokenPruneInterval.unref();
}

// ── Weekly fee pool distribution check (runs weekly, distributes monthly) ──
// NOTE: setInterval max safe value is 2^31-1 (~24.8 days). Values above overflow to ~0,
// causing a tight loop that exhausts the DB connection pool. Use 7-day interval instead.
const feeDistributionInterval = setInterval(async () => {
  try {
    const result = await distributeFeePool();
    if (result) {
      console.log(`[vouch-api] Fee distribution complete: ${result.totalFeePoolSats} sats distributed to ${result.stakerCount} stakers`);
    }
  } catch (e) {
    console.error('[vouch-api] Fee distribution error:', e);
  }
}, 7 * 24 * 60 * 60 * 1000); // 7 days (604,800,000ms) — safe for 32-bit setInterval
if (feeDistributionInterval && typeof feeDistributionInterval === 'object' && 'unref' in feeDistributionInterval) {
  feeDistributionInterval.unref();
}

// ── Start server ──
const port = parseInt(process.env.PORT || '3601', 10);

console.log(`[vouch-api] Starting on port ${port}`);
console.log(`[vouch-api] Auth: ${process.env.VOUCH_SKIP_AUTH === 'true' ? 'BYPASSED (test mode)' : 'enabled'}`);
console.log(`[vouch-api] DATABASE_URL: ${process.env.DATABASE_URL ? 'configured' : 'NOT SET'}`);
console.log(`[vouch-api] NWC_URL: ${process.env.NWC_URL ? 'configured' : 'NOT SET (treasury will be unavailable)'}`);
console.log(`[vouch-api] ENCRYPTION_KEY: ${process.env.ENCRYPTION_KEY ? 'configured' : 'NOT SET (NWC storage will fail)'}`);
console.log(`[vouch-api] GATEWAY_SECRET: ${process.env.GATEWAY_SECRET ? 'configured' : 'NOT SET (inference usage reporting disabled)'}`);
console.log(`[vouch-api] BJJ_PRIVATE_KEY: ${process.env.BJJ_PRIVATE_KEY ? 'configured' : 'NOT SET (ZK attestations disabled)'}`);
console.log(`[vouch-api] PRIVACY_ISSUER_KEY: ${process.env.PRIVACY_ISSUER_KEY ? 'configured' : 'NOT SET (using ephemeral keys)'}`);

export default {
  port,
  fetch: app.fetch,
};

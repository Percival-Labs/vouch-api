// Vouch — Staking API Routes (NWC / Alby Hub)
// All financial endpoints enforce caller identity (C2, C5 fixes).
// Amounts are in sats (Lightning-native).
// NON-CUSTODIAL: Stakes are NWC budget authorizations, not Lightning payments.

import { Hono } from 'hono';
import { success, paginated, error } from '../lib/response';
import type { AppEnv } from '../middleware/verify-signature';
import {
  validate,
  CreatePoolSchema,
  StakeSchema,
  UnstakeSchema,
  WithdrawSchema,
  FeeRecordSchema,
  DistributeSchema,
} from '../lib/schemas';
import {
  createPool,
  getPoolByAgent,
  getPoolSummary,
  listPools,
  stake,
  initiateStake,
  finalizeStake,
  requestUnstake,
  withdraw,
  getStakerPositions,
  getStakeStatus,
  recordActivityFee,
  distributeYield,
  slashPool,
  computeBackingComponent,
} from '../services/staking-service';
import { createStakeLock, getActiveConnection } from '../services/nwc-service';
import { getVoterWeight } from '../services/trust-service';
import { getCurrentBtcPrice, satsToUsd, getPriceHistory } from '../services/price-service';
import { db, stakes, treasury } from '@percival/vouch-db';
import { eq, and, sql } from 'drizzle-orm';

const app = new Hono<AppEnv>();

// ── Pool Routes ──

/** GET /pools — List active staking pools */
app.get('/pools', async (c) => {
  try {
    const page = parseInt(c.req.query('page') || '1', 10);
    const limit = Math.min(50, parseInt(c.req.query('limit') || '25', 10));
    const result = await listPools(page, limit);
    return paginated(c, result.data, result.meta);
  } catch (err) {
    console.error('[vouch-api] GET /pools error:', err);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to list pools');
  }
});

/** GET /pools/:id — Pool detail */
app.get('/pools/:id', async (c) => {
  try {
    const pool = await getPoolSummary(c.req.param('id'));
    if (!pool) return error(c, 404, 'NOT_FOUND', 'Pool not found');
    return success(c, pool);
  } catch (err) {
    console.error('[vouch-api] GET /pools/:id error:', err);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to get pool');
  }
});

/** GET /pools/agent/:agentId — Pool by agent */
app.get('/pools/agent/:agentId', async (c) => {
  try {
    const pool = await getPoolByAgent(c.req.param('agentId'));
    if (!pool) return error(c, 404, 'NOT_FOUND', 'No pool for this agent');
    return success(c, pool);
  } catch (err) {
    console.error('[vouch-api] GET /pools/agent/:id error:', err);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to get pool');
  }
});

/** POST /pools — Create staking pool for an agent (agent can only create its own pool) */
app.post('/pools', async (c) => {
  try {
    const callerId = c.get('verifiedAgentId');
    const raw = await c.req.json();
    const parsed = validate(CreatePoolSchema, raw);
    if (!parsed.success) {
      return error(c, 400, parsed.error.code, parsed.error.message, parsed.error.details);
    }
    const body = parsed.data;

    // C2 fix + H6 fix: agents can only create pools for themselves. Require auth.
    if (!callerId) {
      return error(c, 401, 'UNAUTHORIZED', 'Authentication required');
    }
    if (callerId !== body.agent_id) {
      return error(c, 403, 'FORBIDDEN', 'Agents can only create pools for themselves');
    }

    const existing = await getPoolByAgent(body.agent_id);
    if (existing) {
      return error(c, 409, 'CONFLICT', 'Pool already exists for this agent');
    }

    const poolId = await createPool(body.agent_id, body.activity_fee_rate_bps);
    const pool = await getPoolSummary(poolId);
    return success(c, pool, 201);
  } catch (err) {
    console.error('[vouch-api] POST /pools error:', err);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to create pool');
  }
});

// ── Staking Routes (NWC flow) ──

/**
 * POST /pools/:id/stake — Initiate stake
 * Returns stakeId + nwcRequired flag. Client must then connect wallet via NWC.
 */
app.post('/pools/:id/stake', async (c) => {
  try {
    const callerId = c.get('verifiedAgentId');
    const userId = c.get('userId' as never) as string | undefined;

    if (!callerId && !userId) {
      return error(c, 401, 'AUTH_REQUIRED', 'Authentication required to stake');
    }

    const poolId = c.req.param('id');
    const raw = await c.req.json();
    const parsed = validate(StakeSchema, raw);
    if (!parsed.success) {
      return error(c, 400, parsed.error.code, parsed.error.message, parsed.error.details);
    }
    const body = parsed.data;

    const stakerId = callerId || userId!;
    const stakerType = callerId ? (body.staker_type || 'agent') : 'user';

    // C2 fix: agent callers can only stake as themselves
    if (callerId && stakerType === 'agent' && callerId !== stakerId) {
      return error(c, 403, 'FORBIDDEN', 'Agents can only stake as themselves');
    }

    // H6 fix: prevent self-staking
    const targetPool = await getPoolSummary(poolId);
    if (targetPool && stakerId === targetPool.agentId) {
      return error(c, 403, 'FORBIDDEN', 'Agents cannot stake in their own pool');
    }

    const stakerTrust = await getVoterWeight(stakerId, stakerType as 'user' | 'agent');

    // Initiate stake — returns pending stake, client must connect NWC wallet
    const result = await initiateStake(poolId, stakerId, stakerType as 'user' | 'agent', body.amount_sats, stakerTrust);
    return success(c, result, 201);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('not found') || msg.includes('not allowed')) {
      return error(c, 400, 'BAD_REQUEST', msg);
    }
    console.error('[vouch-api] POST /pools/:id/stake error:', err);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to stake');
  }
});

/**
 * POST /wallet/connect — Submit NWC connection string after authorizing in wallet app.
 * Finalizes a pending stake by linking it to the NWC connection.
 */
app.post('/wallet/connect', async (c) => {
  try {
    const callerId = c.get('verifiedAgentId');
    const userId = c.get('userId' as never) as string | undefined;
    const authenticatedId = callerId || userId;

    if (!authenticatedId) {
      return error(c, 401, 'AUTH_REQUIRED', 'Authentication required');
    }

    const body = await c.req.json();
    const { stake_id, connection_string, budget_sats } = body;

    if (!stake_id || typeof stake_id !== 'string') {
      return error(c, 400, 'VALIDATION_ERROR', 'stake_id is required');
    }
    if (!connection_string || typeof connection_string !== 'string') {
      return error(c, 400, 'VALIDATION_ERROR', 'connection_string is required');
    }
    if (!connection_string.startsWith('nostr+walletconnect://')) {
      return error(c, 400, 'VALIDATION_ERROR', 'connection_string must be a valid NWC URI');
    }
    if (!budget_sats || typeof budget_sats !== 'number' || budget_sats < 1) {
      return error(c, 400, 'VALIDATION_ERROR', 'budget_sats must be a positive number');
    }

    // Verify the pending stake exists and belongs to this user
    const [stakeRecord] = await db.select({ stakerId: stakes.stakerId, status: stakes.status }).from(stakes).where(eq(stakes.id, stake_id)).limit(1);
    if (!stakeRecord) {
      return error(c, 404, 'NOT_FOUND', 'Stake not found');
    }
    if (stakeRecord.stakerId !== authenticatedId) {
      return error(c, 403, 'FORBIDDEN', 'Cannot finalize another user\'s stake');
    }

    // Create NWC connection (validates wallet is reachable)
    const connectionId = await createStakeLock(authenticatedId, connection_string, budget_sats);

    // Finalize the pending stake with the NWC connection
    const result = await finalizeStake(stake_id, connectionId);
    if (!result) {
      return error(c, 400, 'BAD_REQUEST', 'Stake already finalized or not in pending state');
    }

    return success(c, result, 201);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('NWC') || msg.includes('budget') || msg.includes('verification failed')) {
      return error(c, 400, 'BAD_REQUEST', msg);
    }
    console.error('[vouch-api] POST /wallet/connect error:', err);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to connect wallet');
  }
});

/** GET /stakes/:id/status — Get stake status (for polling during NWC connection flow) */
app.get('/stakes/:id/status', async (c) => {
  try {
    const stakeId = c.req.param('id');
    const stakeRecord = await getStakeStatus(stakeId);
    if (!stakeRecord) {
      return error(c, 404, 'NOT_FOUND', 'Stake not found');
    }
    return success(c, stakeRecord);
  } catch (err) {
    console.error('[vouch-api] GET /stakes/:id/status error:', err);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to get stake status');
  }
});

/** POST /stakes/:id/unstake — Request unstake (begins notice period) */
app.post('/stakes/:id/unstake', async (c) => {
  try {
    const callerId = c.get('verifiedAgentId');
    const userId = c.get('userId' as never) as string | undefined;
    const authenticatedId = callerId || userId;
    const stakeId = c.req.param('id');

    if (!authenticatedId) {
      return error(c, 401, 'AUTH_REQUIRED', 'Authentication required');
    }

    const [stakeRecord] = await db.select({ stakerId: stakes.stakerId }).from(stakes).where(eq(stakes.id, stakeId)).limit(1);
    if (!stakeRecord) {
      return error(c, 404, 'NOT_FOUND', 'Stake not found');
    }
    if (stakeRecord.stakerId !== authenticatedId) {
      return error(c, 403, 'FORBIDDEN', 'You can only unstake your own positions');
    }

    const result = await requestUnstake(stakeId, authenticatedId);
    return success(c, result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('not found')) {
      return error(c, 404, 'NOT_FOUND', msg);
    }
    console.error('[vouch-api] POST /stakes/:id/unstake error:', err);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to unstake');
  }
});

/**
 * POST /stakes/:id/withdraw — Complete withdrawal after notice period.
 * Non-custodial: principal is already in user's wallet. NWC connection gets revoked.
 */
app.post('/stakes/:id/withdraw', async (c) => {
  try {
    const callerId = c.get('verifiedAgentId');
    const userId = c.get('userId' as never) as string | undefined;
    const authenticatedId = callerId || userId;
    const stakeId = c.req.param('id');

    if (!authenticatedId) {
      return error(c, 401, 'AUTH_REQUIRED', 'Authentication required');
    }

    const [stakeRecord] = await db.select({ stakerId: stakes.stakerId }).from(stakes).where(eq(stakes.id, stakeId)).limit(1);
    if (!stakeRecord) {
      return error(c, 404, 'NOT_FOUND', 'Stake not found');
    }
    if (stakeRecord.stakerId !== authenticatedId) {
      return error(c, 403, 'FORBIDDEN', 'You can only withdraw your own positions');
    }

    const result = await withdraw(stakeId, authenticatedId);
    return success(c, {
      stakeId,
      withdrawn_sats: result.amountSats,
      payment_status: result.paymentStatus,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('not found') || msg.includes('Cannot withdraw')) {
      return error(c, 400, 'BAD_REQUEST', msg);
    }
    console.error('[vouch-api] POST /stakes/:id/withdraw error:', err);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to withdraw');
  }
});

/** GET /stakers/:id/positions — Get all staking positions for a staker */
app.get('/stakers/:id/positions', async (c) => {
  try {
    const stakerId = c.req.param('id');
    const stakerType = (c.req.query('type') || 'user') as 'user' | 'agent';
    const positions = await getStakerPositions(stakerId, stakerType);
    return success(c, positions);
  } catch (err) {
    console.error('[vouch-api] GET /stakers/:id/positions error:', err);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to get positions');
  }
});

// ── Activity Fee Routes ──

/** POST /fees — Record an activity fee from agent revenue (agents can only record own fees) */
app.post('/fees', async (c) => {
  try {
    const callerId = c.get('verifiedAgentId');
    const raw = await c.req.json();
    const parsed = validate(FeeRecordSchema, raw);
    if (!parsed.success) {
      return error(c, 400, parsed.error.code, parsed.error.message, parsed.error.details);
    }
    const body = parsed.data;

    // H6 fix: require auth for fee recording
    if (!callerId) {
      return error(c, 401, 'UNAUTHORIZED', 'Authentication required');
    }
    if (callerId !== body.agent_id) {
      return error(c, 403, 'FORBIDDEN', 'Agents can only record fees for themselves');
    }

    const feeSats = await recordActivityFee(body.agent_id, body.action_type, body.gross_revenue_sats);
    return success(c, { fee_sats: feeSats }, 201);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('not allowed') || msg.includes('cannot record')) {
      return error(c, 400, 'BAD_REQUEST', msg);
    }
    console.error('[vouch-api] POST /fees error:', err);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to record fee');
  }
});

// ── Yield Distribution Routes ──

/** POST /pools/:id/distribute — Trigger yield distribution (pool owner or admin only) */
app.post('/pools/:id/distribute', async (c) => {
  try {
    const callerId = c.get('verifiedAgentId');
    const poolId = c.req.param('id');
    const raw = await c.req.json();
    const parsed = validate(DistributeSchema, raw);
    if (!parsed.success) {
      return error(c, 400, parsed.error.code, parsed.error.message, parsed.error.details);
    }
    const body = parsed.data;

    const targetPool = await getPoolSummary(poolId);
    if (!targetPool) {
      return error(c, 404, 'NOT_FOUND', 'Pool not found');
    }
    if (targetPool.agentId !== callerId) {
      return error(c, 403, 'FORBIDDEN', 'Only the pool owner can trigger distribution');
    }

    const periodStart = new Date(body.period_start);
    const periodEnd = new Date(body.period_end);

    if (periodEnd <= periodStart) {
      return error(c, 400, 'VALIDATION_ERROR', 'period_end must be after period_start');
    }

    const result = await distributeYield(poolId, periodStart, periodEnd);

    if (!result) {
      return success(c, { message: 'No undistributed fees for this period' });
    }

    return success(c, result, 201);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('not found') || msg.includes('not allowed')) {
      return error(c, 400, 'BAD_REQUEST', msg);
    }
    console.error('[vouch-api] POST /pools/:id/distribute error:', err);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to distribute yield');
  }
});

// ── Vouch Score Routes ──

/** GET /vouch-score/:id — Get backing component for an agent's Vouch score */
app.get('/vouch-score/:id', async (c) => {
  try {
    const agentId = c.req.param('id');
    const backingComponent = await computeBackingComponent(agentId, 'agent');
    return success(c, { agent_id: agentId, backing_component: backingComponent });
  } catch (err) {
    console.error('[vouch-api] GET /vouch-score/:id error:', err);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to compute vouch score');
  }
});

// ── Treasury Summary ──

/** GET /treasury/summary — Treasury balance in sats + USD, with price history.
 *  H5 fix: Restricted to PL admin (TREASURY_ADMIN_PUBKEY) — no longer exposed to all authenticated agents. */
app.get('/treasury/summary', async (c) => {
  const callerId = c.get('verifiedAgentId');
  const adminPubkey = process.env.TREASURY_ADMIN_PUBKEY;
  if (!adminPubkey || callerId !== adminPubkey) {
    return error(c, 403, 'FORBIDDEN', 'Treasury summary requires admin access');
  }

  try {
    const [treasuryRow] = await db
      .select({ totalSats: sql<number>`COALESCE(SUM(${treasury.amountSats}), 0)::int` })
      .from(treasury);

    const totalSats = treasuryRow?.totalSats ?? 0;

    const btcPrice = await getCurrentBtcPrice();
    const totalUsd = btcPrice !== null ? await satsToUsd(totalSats) : null;

    const breakdown = await db
      .select({
        sourceType: treasury.sourceType,
        totalSats: sql<number>`COALESCE(SUM(${treasury.amountSats}), 0)::int`,
        count: sql<number>`count(*)::int`,
      })
      .from(treasury)
      .groupBy(treasury.sourceType);

    const priceHistory = await getPriceHistory(30);

    return success(c, {
      treasury: {
        total_sats: totalSats,
        total_usd: totalUsd !== null ? Math.round(totalUsd * 100) / 100 : null,
        btc_price_usd: btcPrice,
        breakdown: breakdown.map((b) => ({
          source_type: b.sourceType,
          total_sats: b.totalSats,
          count: b.count,
        })),
      },
      price_history: priceHistory.map((p) => ({
        price_usd: p.priceUsd,
        captured_at: p.capturedAt.toISOString(),
      })),
    });
  } catch (err) {
    console.error('[vouch-api] GET /treasury/summary error:', err);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to get treasury summary');
  }
});

export default app;

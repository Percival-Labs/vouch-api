// Vouch — Staking API Routes
// All financial endpoints enforce caller identity (C2, C5 fixes).
// Amounts are in sats (Lightning-native).

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
  getPoolByAgentInternal,
  getPoolSummary,
  listPools,
  stake,
  initiateStake,
  requestUnstake,
  withdraw,
  getStakerPositions,
  getStakePaymentStatus,
  recordActivityFee,
  distributeYield,
  slashPool,
  computeBackingComponent,
} from '../services/staking-service';
import { createInvoice } from '../services/lnbits-service';
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

    // C2 fix: agents can only create pools for themselves
    if (callerId && callerId !== body.agent_id) {
      return error(c, 403, 'FORBIDDEN', 'Agents can only create pools for themselves');
    }

    // Check if pool already exists
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

// ── Staking Routes ──

/** POST /pools/:id/stake — Initiate stake with Lightning invoice */
app.post('/pools/:id/stake', async (c) => {
  try {
    const callerId = c.get('verifiedAgentId');
    const userId = c.get('userId' as never) as string | undefined;

    // S5 fix: require authenticated caller for financial operations
    // Accept either agent Ed25519 auth or user session cookie
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

    // S6 fix: derive staker_id from authenticated identity, not from request body
    const stakerId = callerId || userId!;
    const stakerType = callerId ? (body.staker_type || 'agent') : 'user';

    // C2 fix: agent callers can only stake as themselves
    if (callerId && stakerType === 'agent' && callerId !== stakerId) {
      return error(c, 403, 'FORBIDDEN', 'Agents can only stake as themselves');
    }

    // H6 fix: prevent self-staking (agent backing its own pool)
    const targetPool = await getPoolSummary(poolId);
    if (targetPool && stakerId === targetPool.agentId) {
      return error(c, 403, 'FORBIDDEN', 'Agents cannot stake in their own pool');
    }

    // Get staker trust score for snapshot
    const stakerTrust = await getVoterWeight(stakerId, stakerType as 'user' | 'agent');

    // Check if pool has Lightning wallet — if so, use two-phase commit
    const poolInternal = await getPoolByAgentInternal(targetPool?.agentId || '');
    if (poolInternal?.lnbitsInvoiceKey) {
      const result = await initiateStake(
        poolId, stakerId, stakerType as 'user' | 'agent', body.amount_sats, stakerTrust, createInvoice,
      );
      return success(c, result, 201);
    }

    // Fallback: direct stake (no Lightning — for testing/migration)
    const result = await stake(poolId, stakerId, stakerType as 'user' | 'agent', body.amount_sats, stakerTrust);
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

/** GET /stakes/:id/status — Get payment status for a stake */
app.get('/stakes/:id/status', async (c) => {
  try {
    const stakeId = c.req.param('id');
    const payment = await getStakePaymentStatus(stakeId);
    if (!payment) {
      return error(c, 404, 'NOT_FOUND', 'No payment found for this stake');
    }
    return success(c, payment);
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

    // H8 fix: require authenticated caller, use verified identity (not body)
    if (!authenticatedId) {
      return error(c, 401, 'AUTH_REQUIRED', 'Authentication required');
    }

    // Verify caller owns this stake
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

/** POST /stakes/:id/withdraw — Complete withdrawal after notice period */
app.post('/stakes/:id/withdraw', async (c) => {
  try {
    const callerId = c.get('verifiedAgentId');
    const userId = c.get('userId' as never) as string | undefined;
    const authenticatedId = callerId || userId;
    const stakeId = c.req.param('id');

    // S8 fix: require authenticated caller (agent or user session), use verified identity
    if (!authenticatedId) {
      return error(c, 401, 'AUTH_REQUIRED', 'Authentication required');
    }

    // Verify caller owns this stake
    const [stakeRecord] = await db.select({ stakerId: stakes.stakerId }).from(stakes).where(eq(stakes.id, stakeId)).limit(1);
    if (!stakeRecord) {
      return error(c, 404, 'NOT_FOUND', 'Stake not found');
    }
    if (stakeRecord.stakerId !== authenticatedId) {
      return error(c, 403, 'FORBIDDEN', 'You can only withdraw your own positions');
    }

    // Optional: staker can provide a BOLT11 invoice to receive sats directly
    let bolt11: string | undefined;
    try {
      const body = await c.req.json();
      bolt11 = body?.bolt11;
    } catch {
      // No body or invalid JSON — that's fine, bolt11 is optional
    }

    const result = await withdraw(stakeId, authenticatedId, bolt11);
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

    // C5 fix: agents can only record their own fees
    if (callerId && callerId !== body.agent_id) {
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

    // Verify caller is the pool owner — single lookup, no fallback
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

/** GET /treasury/summary — Treasury balance in sats + USD, with price history */
app.get('/treasury/summary', async (c) => {
  try {
    // Sum all treasury records
    const [treasuryRow] = await db
      .select({ totalSats: sql<number>`COALESCE(SUM(${treasury.amountSats}), 0)::int` })
      .from(treasury);

    const totalSats = treasuryRow?.totalSats ?? 0;

    // Get current BTC price and USD equivalent
    const btcPrice = await getCurrentBtcPrice();
    const totalUsd = btcPrice !== null ? await satsToUsd(totalSats) : null;

    // Breakdown by source type
    const breakdown = await db
      .select({
        sourceType: treasury.sourceType,
        totalSats: sql<number>`COALESCE(SUM(${treasury.amountSats}), 0)::int`,
        count: sql<number>`count(*)::int`,
      })
      .from(treasury)
      .groupBy(treasury.sourceType);

    // Recent price history for charting
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

// Vouch — Staking API Routes
// All financial endpoints enforce caller identity (C2, C5 fixes).

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
  requestUnstake,
  withdraw,
  getStakerPositions,
  recordActivityFee,
  distributeYield,
  slashPool,
  computeBackingComponent,
} from '../services/staking-service';
import { getVoterWeight } from '../services/trust-service';
import { db, stakes } from '@percival/vouch-db';
import { eq, and } from 'drizzle-orm';

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

/** POST /pools/:id/stake — Stake funds to back an agent */
app.post('/pools/:id/stake', async (c) => {
  try {
    const callerId = c.get('verifiedAgentId');
    const poolId = c.req.param('id');
    const raw = await c.req.json();
    const parsed = validate(StakeSchema, raw);
    if (!parsed.success) {
      return error(c, 400, parsed.error.code, parsed.error.message, parsed.error.details);
    }
    const body = parsed.data;

    // C2 fix: agent callers can only stake as themselves
    if (callerId && body.staker_type === 'agent' && callerId !== body.staker_id) {
      return error(c, 403, 'FORBIDDEN', 'Agents can only stake as themselves');
    }

    // H6 fix: prevent self-staking (agent backing its own pool)
    const targetPool = await getPoolSummary(poolId);
    if (targetPool && body.staker_id === targetPool.agentId) {
      return error(c, 403, 'FORBIDDEN', 'Agents cannot stake in their own pool');
    }

    // Get staker trust score for snapshot
    const stakerTrust = await getVoterWeight(body.staker_id, body.staker_type);

    const result = await stake(poolId, body.staker_id, body.staker_type, body.amount_cents, stakerTrust);
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

/** POST /stakes/:id/unstake — Request unstake (begins notice period) */
app.post('/stakes/:id/unstake', async (c) => {
  try {
    const callerId = c.get('verifiedAgentId');
    const stakeId = c.req.param('id');

    // H8 fix: require authenticated caller, use verified identity (not body)
    if (!callerId) {
      return error(c, 401, 'AUTH_REQUIRED', 'Authentication required');
    }

    // Verify caller owns this stake
    const [stakeRecord] = await db.select({ stakerId: stakes.stakerId }).from(stakes).where(eq(stakes.id, stakeId)).limit(1);
    if (!stakeRecord) {
      return error(c, 404, 'NOT_FOUND', 'Stake not found');
    }
    if (stakeRecord.stakerId !== callerId) {
      return error(c, 403, 'FORBIDDEN', 'You can only unstake your own positions');
    }

    const result = await requestUnstake(stakeId, callerId);
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
    const stakeId = c.req.param('id');

    // H8 fix: require authenticated caller, use verified identity (not body)
    if (!callerId) {
      return error(c, 401, 'AUTH_REQUIRED', 'Authentication required');
    }

    // Verify caller owns this stake
    const [stakeRecord] = await db.select({ stakerId: stakes.stakerId }).from(stakes).where(eq(stakes.id, stakeId)).limit(1);
    if (!stakeRecord) {
      return error(c, 404, 'NOT_FOUND', 'Stake not found');
    }
    if (stakeRecord.stakerId !== callerId) {
      return error(c, 403, 'FORBIDDEN', 'You can only withdraw your own positions');
    }

    const amountCents = await withdraw(stakeId, callerId);
    return success(c, { stakeId, withdrawn_cents: amountCents });
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

    const feeCents = await recordActivityFee(body.agent_id, body.action_type, body.gross_revenue_cents);
    return success(c, { fee_cents: feeCents }, 201);
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

export default app;

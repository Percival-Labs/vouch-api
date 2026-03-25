// Credit Routes — deposit, balance, limits, batches, and usage tracking.
// All endpoints require NIP-98 auth.

import { Hono } from 'hono';
import { db, usageRecords } from '@percival/vouch-db';
import { eq, desc, and, gte } from 'drizzle-orm';
import { success, paginated, error } from '../lib/response';
import { validate, CreditDepositSchema, CreditBatchSchema, CreditLimitsSchema, CreditDepositConfirmSchema } from '../lib/schemas';
import type { NostrAuthEnv } from '../middleware/nostr-auth';
import {
  getBalance,
  createDeposit,
  confirmDeposit,
  setLimits,
  checkLimits,
  purchaseBatch,
  getUsageSummary,
} from '../services/credit-service';

const app = new Hono<NostrAuthEnv>();

// ── GET / — Current balance + limits + period spend ──
app.get('/', async (c) => {
  const npub = c.get('nostrPubkey');
  if (!npub) return error(c, 401, 'AUTH_REQUIRED', 'NIP-98 authorization required');

  try {
    const balance = await getBalance(npub);
    const limits = await checkLimits(npub, 0);

    return success(c, {
      balance_sats: balance.balanceSats,
      lifetime_deposited_sats: balance.lifetimeDepositedSats,
      lifetime_spent_sats: balance.lifetimeSpentSats,
      limits: {
        daily_sats: balance.dailyLimitSats,
        weekly_sats: balance.weeklyLimitSats,
        monthly_sats: balance.monthlyLimitSats,
      },
      period_used: limits.periodUsed,
      remaining: limits.remaining,
    });
  } catch (err) {
    console.error('[credits] GET / error:', err);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to get balance');
  }
});

// ── POST /deposit — Create Lightning invoice for deposit ──
app.post('/deposit', async (c) => {
  const npub = c.get('nostrPubkey');
  if (!npub) return error(c, 401, 'AUTH_REQUIRED', 'NIP-98 authorization required');

  try {
    const raw = await c.req.json();
    const parsed = validate(CreditDepositSchema, raw);
    if (!parsed.success) {
      return error(c, 400, parsed.error.code, parsed.error.message, parsed.error.details);
    }

    const result = await createDeposit(npub, parsed.data.amount_sats);

    return success(c, {
      deposit_id: result.depositId,
      amount_sats: result.amountSats,
      fee_sats: result.feeSats,
      net_credit_sats: result.netCreditSats,
      bolt11: result.bolt11,
      payment_hash: result.paymentHash,
    }, 201);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('Minimum') || msg.includes('Maximum')) {
      return error(c, 400, 'VALIDATION_ERROR', msg);
    }
    console.error('[credits] POST /deposit error:', err);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to create deposit');
  }
});

// ── POST /deposit/confirm — Confirm deposit after payment ──
app.post('/deposit/confirm', async (c) => {
  const npub = c.get('nostrPubkey');
  if (!npub) return error(c, 401, 'AUTH_REQUIRED', 'NIP-98 authorization required');

  try {
    const raw = await c.req.json();
    const parsed = validate(CreditDepositConfirmSchema, raw);
    if (!parsed.success) {
      return error(c, 400, parsed.error.code, parsed.error.message, parsed.error.details);
    }

    const balance = await confirmDeposit(parsed.data.deposit_id, npub);

    return success(c, {
      balance_sats: balance.balanceSats,
      lifetime_deposited_sats: balance.lifetimeDepositedSats,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('not found') || msg.includes('already confirmed')) {
      return error(c, 404, 'NOT_FOUND', msg);
    }
    console.error('[credits] POST /deposit/confirm error:', err);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to confirm deposit');
  }
});

// ── POST /limits — Set spend limits ──
app.post('/limits', async (c) => {
  const npub = c.get('nostrPubkey');
  if (!npub) return error(c, 401, 'AUTH_REQUIRED', 'NIP-98 authorization required');

  try {
    const raw = await c.req.json();
    const parsed = validate(CreditLimitsSchema, raw);
    if (!parsed.success) {
      return error(c, 400, parsed.error.code, parsed.error.message, parsed.error.details);
    }
    const body = parsed.data;

    const balance = await setLimits(npub, {
      dailyLimitSats: body.daily_limit_sats,
    });

    return success(c, {
      limits: {
        daily_sats: balance.dailyLimitSats,
        weekly_sats: balance.weeklyLimitSats,
        monthly_sats: balance.monthlyLimitSats,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('Invalid limit')) {
      return error(c, 400, 'VALIDATION_ERROR', msg);
    }
    console.error('[credits] POST /limits error:', err);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to set limits');
  }
});

// ── POST /batches — Purchase token batch for private mode ──
app.post('/batches', async (c) => {
  const npub = c.get('nostrPubkey');
  if (!npub) return error(c, 401, 'AUTH_REQUIRED', 'NIP-98 authorization required');

  try {
    const raw = await c.req.json();
    const parsed = validate(CreditBatchSchema, raw);
    if (!parsed.success) {
      return error(c, 400, parsed.error.code, parsed.error.message, parsed.error.details);
    }

    const batch = await purchaseBatch(npub, parsed.data.budget_sats, parsed.data.token_count);

    return success(c, {
      batch_hash: batch.batchHash,
      budget_sats: batch.budgetSats,
      token_count: batch.tokenCount,
      expires_at: batch.expiresAt.toISOString(),
    }, 201);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('Minimum') || msg.includes('Maximum') || msg.includes('Token count')) {
      return error(c, 400, 'VALIDATION_ERROR', msg);
    }
    if (msg.includes('Insufficient')) {
      return error(c, 402, 'INSUFFICIENT_BALANCE' as any, msg);
    }
    console.error('[credits] POST /batches error:', err);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to purchase batch');
  }
});

// ── GET /usage — Usage history (paginated) ──
app.get('/usage', async (c) => {
  const npub = c.get('nostrPubkey');
  if (!npub) return error(c, 401, 'AUTH_REQUIRED', 'NIP-98 authorization required');

  try {
    const page = parseInt(c.req.query('page') || '1', 10);
    const limit = Math.min(parseInt(c.req.query('limit') || '20', 10), 100);
    const offset = (page - 1) * limit;

    const records = await db.select().from(usageRecords)
      .where(eq(usageRecords.userNpub, npub))
      .orderBy(desc(usageRecords.createdAt))
      .limit(limit + 1) // +1 to check has_more
      .offset(offset);

    const hasMore = records.length > limit;
    const data = records.slice(0, limit).map(r => ({
      id: r.id,
      model: r.model,
      provider: r.provider,
      input_tokens: r.inputTokens,
      output_tokens: r.outputTokens,
      cost_sats: r.costSats,
      raw_cost_sats: r.rawCostSats,
      margin_sats: r.marginSats,
      created_at: r.createdAt?.toISOString(),
    }));

    return paginated(c, data, {
      page,
      limit,
      total: -1, // avoid expensive COUNT query
      has_more: hasMore,
    });
  } catch (err) {
    console.error('[credits] GET /usage error:', err);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to get usage history');
  }
});

// ── GET /usage/summary — Aggregated usage stats ──
app.get('/usage/summary', async (c) => {
  const npub = c.get('nostrPubkey');
  if (!npub) return error(c, 401, 'AUTH_REQUIRED', 'NIP-98 authorization required');

  try {
    const period = c.req.query('period') || 'month';
    const now = new Date();
    let since: Date;

    switch (period) {
      case 'day':
        since = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        break;
      case 'week':
        since = new Date(now);
        since.setDate(since.getDate() - 7);
        break;
      case 'month':
      default:
        since = new Date(now.getFullYear(), now.getMonth(), 1);
        break;
    }

    const summary = await getUsageSummary(npub, since);

    return success(c, {
      period,
      since: since.toISOString(),
      total_cost_sats: summary.totalCostSats,
      total_raw_cost_sats: summary.totalRawCostSats,
      total_margin_sats: summary.totalMarginSats,
      total_input_tokens: summary.totalInputTokens,
      total_output_tokens: summary.totalOutputTokens,
      request_count: summary.requestCount,
    });
  } catch (err) {
    console.error('[credits] GET /usage/summary error:', err);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to get usage summary');
  }
});

// ── GET /gateway — Retrieve agent's Gateway credentials ──
// Returns the AgentKey token + gateway URL so agents can run inference.
// Agent must have Gateway credits (earned via contract milestone payouts).
app.get('/gateway', async (c) => {
  const npub = c.get('nostrPubkey');
  if (!npub) return error(c, 401, 'AUTH_REQUIRED', 'NIP-98 authorization required');

  try {
    const { getAgentGatewayCredentials } = await import('../services/gateway-service');
    const creds = await getAgentGatewayCredentials(npub);

    if (!creds) {
      return error(c, 404, 'NO_GATEWAY_KEY', 'No Gateway credentials found. Earn credits by completing contract milestones with payout_method: gateway_credits.');
    }

    return success(c, {
      gateway_url: creds.gatewayUrl,
      agent_key: creds.token,
      auth_header: `AgentKey ${creds.token}`,
      budget: creds.budget,
      usage_hint: `curl ${creds.gatewayUrl}/auto/v1/chat/completions -H "X-Vouch-Auth: AgentKey ${creds.token}" -H "Content-Type: application/json" -d '{"model":"claude-sonnet-4-20250514","messages":[{"role":"user","content":"Hello"}]}'`,
    });
  } catch (err) {
    console.error('[credits] GET /gateway error:', err);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to retrieve Gateway credentials');
  }
});

export default app;

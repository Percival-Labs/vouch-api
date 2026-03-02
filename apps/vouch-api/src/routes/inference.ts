// Inference Routes — usage reporting from the gateway + public pricing.
// POST /usage is called by the gateway after each inference request.
// GET /pricing is public (no auth) for gateway + client caching.

import { Hono } from 'hono';
import { timingSafeEqual } from 'crypto';
import { success, error } from '../lib/response';
import { recordUsage, getPricingTable } from '../services/metering-service';

// ── Constants ──

const MAX_INPUT_TOKENS = 2_000_000;  // Largest context window (Claude 3.5)
const MAX_OUTPUT_TOKENS = 200_000;   // Largest output window

// Use a minimal env type — gateway auth is via shared secret, not NIP-98
type InferenceEnv = {
  Variables: Record<string, unknown>;
};

const app = new Hono<InferenceEnv>();

// ── POST /usage — Record usage from gateway ──
// Auth: shared secret (GATEWAY_SECRET header) to prevent unauthorized reporting.
app.post('/usage', async (c) => {
  const secret = c.req.header('X-Gateway-Secret');
  const expected = process.env.GATEWAY_SECRET;

  if (!expected || !secret) {
    return error(c, 401, 'AUTH_REQUIRED', 'Invalid gateway secret');
  }

  // Constant-time comparison to prevent timing attacks
  const secretBuf = Buffer.from(secret);
  const expectedBuf = Buffer.from(expected);
  if (secretBuf.length !== expectedBuf.length || !timingSafeEqual(secretBuf, expectedBuf)) {
    return error(c, 401, 'AUTH_REQUIRED', 'Invalid gateway secret');
  }

  try {
    const body = await c.req.json<{
      user_npub?: string;
      batch_hash?: string;
      token_hash?: string;
      model: string;
      provider: string;
      input_tokens: number;
      output_tokens: number;
    }>();

    if (!body.model || !body.provider || body.input_tokens === undefined || body.output_tokens === undefined) {
      return error(c, 400, 'VALIDATION_ERROR', 'model, provider, input_tokens, and output_tokens are required');
    }

    // Validate token counts are non-negative integers within bounds
    if (!Number.isInteger(body.input_tokens) || body.input_tokens < 0 || body.input_tokens > MAX_INPUT_TOKENS) {
      return error(c, 400, 'VALIDATION_ERROR', `input_tokens must be an integer between 0 and ${MAX_INPUT_TOKENS}`);
    }
    if (!Number.isInteger(body.output_tokens) || body.output_tokens < 0 || body.output_tokens > MAX_OUTPUT_TOKENS) {
      return error(c, 400, 'VALIDATION_ERROR', `output_tokens must be an integer between 0 and ${MAX_OUTPUT_TOKENS}`);
    }

    if (!body.user_npub && !body.batch_hash) {
      return error(c, 400, 'VALIDATION_ERROR', 'Either user_npub (transparent) or batch_hash (private) is required');
    }

    const result = await recordUsage({
      userNpub: body.user_npub,
      batchHash: body.batch_hash,
      tokenHash: body.token_hash,
      model: body.model,
      provider: body.provider,
      inputTokens: body.input_tokens,
      outputTokens: body.output_tokens,
    });

    return success(c, {
      usage_record_id: result.usageRecordId,
      cost_sats: result.cost.costSats,
      raw_cost_sats: result.cost.rawCostSats,
      margin_sats: result.cost.marginSats,
    }, 201);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('Insufficient')) {
      return error(c, 402, 'INSUFFICIENT_BALANCE' as any, 'Insufficient credits for this request');
    }
    console.error('[inference] POST /usage error:', err);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to record usage');
  }
});

// ── GET /pricing — Public model pricing table ──
app.get('/pricing', async (c) => {
  try {
    const pricing = await getPricingTable();

    return success(c, {
      models: pricing.map(p => ({
        model_id: p.modelId,
        provider: p.provider,
        input_cost_per_million_usd: p.inputCostPerMillion,
        output_cost_per_million_usd: p.outputCostPerMillion,
        pl_input_price_per_million_usd: p.plInputPricePerMillion,
        pl_output_price_per_million_usd: p.plOutputPricePerMillion,
        margin_bps: p.marginBps,
      })),
    });
  } catch (err) {
    console.error('[inference] GET /pricing error:', err);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to get pricing');
  }
});

export default app;

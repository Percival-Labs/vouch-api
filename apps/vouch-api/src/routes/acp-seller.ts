// ACP Seller Checkout Routes — Stripe Agent Commerce Protocol endpoints.
// Enables Engram agents to be purchased through ChatGPT, Copilot, Perplexity via ACP.
//
// Endpoints (mounted under /v1/acp/checkout):
//   POST /create   — Create checkout session from product catalog
//   POST /update   — Modify a pending checkout session
//   POST /complete — Charge SharedPaymentToken, provision AgentKey + Gateway access
//   POST /cancel   — Cancel and cleanup a checkout session

import { Hono } from 'hono';
import { error, success } from '../lib/response';
import {
  createCheckout,
  updateCheckout,
  completeCheckout,
  cancelCheckout,
} from '../services/acp-seller-service';

// ── Validation ──

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

// ── Routes ──

const app = new Hono();

// POST /create — Create a checkout session
app.post('/create', async (c) => {
  try {
    const body = await c.req.json<{
      productId?: string;
      buyerAddress?: string;
      metadata?: Record<string, unknown>;
    }>();

    if (!body.productId || typeof body.productId !== 'string') {
      return error(c, 400, 'VALIDATION_ERROR', 'productId is required');
    }

    if (!body.buyerAddress || typeof body.buyerAddress !== 'string') {
      return error(c, 400, 'VALIDATION_ERROR', 'buyerAddress is required');
    }

    if (!EVM_ADDRESS_RE.test(body.buyerAddress)) {
      return error(c, 400, 'VALIDATION_ERROR', 'buyerAddress must be a valid EVM address (0x + 40 hex chars)');
    }

    // Validate metadata: max 10 keys, string values only, max 1KB each
    let sanitizedMetadata: Record<string, string> | undefined;
    if (body.metadata && typeof body.metadata === 'object') {
      const entries = Object.entries(body.metadata);
      if (entries.length > 10) {
        return error(c, 400, 'VALIDATION_ERROR', 'metadata must have 10 or fewer keys');
      }
      sanitizedMetadata = {};
      for (const [key, value] of entries) {
        if (typeof key !== 'string' || key.length > 64) {
          return error(c, 400, 'VALIDATION_ERROR', 'metadata keys must be strings under 64 chars');
        }
        const strVal = String(value);
        if (strVal.length > 1024) {
          return error(c, 400, 'VALIDATION_ERROR', `metadata value for "${key}" exceeds 1KB limit`);
        }
        sanitizedMetadata[key] = strVal;
      }
    }

    const result = await createCheckout(body.productId, body.buyerAddress, sanitizedMetadata);
    return success(c, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[acp-seller] POST /create error:', message);

    if (message.startsWith('Unknown product')) {
      return error(c, 400, 'INVALID_PRODUCT', message);
    }
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to create checkout session');
  }
});

// POST /update — Modify a pending checkout session
app.post('/update', async (c) => {
  try {
    const body = await c.req.json<{
      checkoutId?: string;
      updates?: Record<string, unknown>;
    }>();

    if (!body.checkoutId || typeof body.checkoutId !== 'string') {
      return error(c, 400, 'VALIDATION_ERROR', 'checkoutId is required');
    }

    const result = await updateCheckout(body.checkoutId, body.updates ?? {});
    return success(c, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[acp-seller] POST /update error:', message);

    if (message.includes('not found')) {
      return error(c, 404, 'NOT_FOUND', message);
    }
    if (message.includes('Cannot update') || message.includes('expired')) {
      return error(c, 400, 'INVALID_STATE', message);
    }
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to update checkout session');
  }
});

// POST /complete — Charge payment and provision agent
app.post('/complete', async (c) => {
  try {
    const body = await c.req.json<{
      checkoutId?: string;
      paymentToken?: string;
    }>();

    if (!body.checkoutId || typeof body.checkoutId !== 'string') {
      return error(c, 400, 'VALIDATION_ERROR', 'checkoutId is required');
    }

    if (!body.paymentToken || typeof body.paymentToken !== 'string') {
      return error(c, 400, 'VALIDATION_ERROR', 'paymentToken is required');
    }

    const result = await completeCheckout(body.checkoutId, body.paymentToken);
    return success(c, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[acp-seller] POST /complete error:', message);

    if (message.includes('not found')) {
      return error(c, 404, 'NOT_FOUND', message);
    }
    if (message.includes('Cannot complete') || message.includes('expired')) {
      return error(c, 400, 'INVALID_STATE', message);
    }
    if (message.includes('Stripe')) {
      return error(c, 402, 'PAYMENT_FAILED', 'Payment processing failed');
    }
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to complete checkout');
  }
});

// POST /cancel — Cancel a pending checkout session
app.post('/cancel', async (c) => {
  try {
    const body = await c.req.json<{
      checkoutId?: string;
    }>();

    if (!body.checkoutId || typeof body.checkoutId !== 'string') {
      return error(c, 400, 'VALIDATION_ERROR', 'checkoutId is required');
    }

    const result = await cancelCheckout(body.checkoutId);
    return success(c, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[acp-seller] POST /cancel error:', message);

    if (message.includes('not found')) {
      return error(c, 404, 'NOT_FOUND', message);
    }
    if (message.includes('Cannot cancel')) {
      return error(c, 400, 'INVALID_STATE', message);
    }
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to cancel checkout');
  }
});

export default app;

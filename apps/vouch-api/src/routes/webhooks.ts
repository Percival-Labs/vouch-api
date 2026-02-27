// Webhook Routes — receives payment notifications from Alby Hub.
// Mounted BEFORE auth middleware (webhooks use secret verification, not Ed25519/NIP-98).

import { Hono } from 'hono';

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';

/**
 * Verify that a webhook request is from Alby Hub.
 * Uses a dedicated webhook secret (separate from NWC credentials).
 */
function verifyAlbyWebhook(authHeader: string | undefined): boolean {
  if (!WEBHOOK_SECRET) {
    console.error('[webhook] WEBHOOK_SECRET not configured — rejecting all webhooks');
    return false;
  }
  if (!authHeader) return false;

  const token = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : authHeader;

  // Constant-time comparison
  if (token.length !== WEBHOOK_SECRET.length) return false;
  let mismatch = 0;
  for (let i = 0; i < token.length; i++) {
    mismatch |= token.charCodeAt(i) ^ WEBHOOK_SECRET.charCodeAt(i);
  }
  return mismatch === 0;
}

const app = new Hono();

/**
 * POST /alby/payment-received
 * Called by Alby Hub when a payment is received on the platform node.
 * Used for: slash charges received via NWC, or direct payments to the platform.
 * Idempotent: returns 200 on success, 500 on error.
 */
app.post('/alby/payment-received', async (c) => {
  const authHeader = c.req.header('Authorization');

  if (!verifyAlbyWebhook(authHeader)) {
    console.warn('[webhook] Rejected: invalid or missing webhook auth');
    return c.json({ status: 'rejected', reason: 'invalid_auth' }, 401);
  }

  try {
    const body = await c.req.json() as {
      payment_hash?: string;
      amount?: number;
      memo?: string;
      type?: string;
    };

    const paymentHash = body.payment_hash;
    if (!paymentHash) {
      console.warn('[webhook] Missing payment_hash in Alby webhook payload');
      return c.json({ status: 'ok', processed: false, reason: 'missing_payment_hash' }, 200);
    }

    console.log(`[webhook] Alby payment received: hash=${paymentHash}, amount=${body.amount}, type=${body.type}`);

    // Payment confirmations are handled by the NWC flow now.
    // This webhook is for observability — the platform node received a payment.
    // NWC slash charges land here; yield payouts are outbound so they don't trigger this.
    return c.json({ status: 'ok', processed: true, payment_hash: paymentHash }, 200);
  } catch (err) {
    console.error('[webhook] Error processing Alby payment notification:', err);
    return c.json({ status: 'error', message: 'internal_error' }, 500);
  }
});

export default app;

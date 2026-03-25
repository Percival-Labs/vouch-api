// Account Routes — Self-service account creation and status polling.
// POST /create — Public, rate-limited. Creates Stripe Customer + Checkout Session.
// GET /status — Public, rate-limited. Polls for AgentKey after Stripe Checkout.

import { Hono } from 'hono';
import { db, accounts } from '@percival/vouch-db';
import { eq } from 'drizzle-orm';
import { success, error } from '../lib/response';

const STRIPE_API_KEY = process.env.STRIPE_API_KEY || '';

// ── HMAC token helper for account status verification ──

export async function generateAccountStatusToken(email: string): Promise<string> {
  const secret = process.env.ACCOUNT_STATUS_SECRET || process.env.ENCRYPTION_KEY || '';
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(email));
  return Buffer.from(new Uint8Array(sig)).toString('hex');
}
const STRIPE_API_BASE = 'https://api.stripe.com/v1';

// ── Stripe REST helpers (no SDK, fetch-based) ──

async function stripePost(path: string, params: Record<string, string>): Promise<any> {
  const body = new URLSearchParams(params).toString();
  const res = await fetch(`${STRIPE_API_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${STRIPE_API_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  const json = await res.json() as Record<string, any>;
  if (!res.ok) {
    const msg = json?.error?.message || `Stripe API error: ${res.status}`;
    throw new Error(msg);
  }
  return json;
}

const app = new Hono();

// ── POST /create — Create account + Stripe Checkout Session ──
app.post('/create', async (c) => {
  if (!STRIPE_API_KEY) {
    return error(c, 500, 'CONFIG_ERROR', 'Stripe is not configured');
  }

  try {
    const body = await c.req.json<{ email?: string; name?: string }>();

    if (!body.email || typeof body.email !== 'string') {
      return error(c, 400, 'VALIDATION_ERROR', 'email is required', [
        { field: 'email', issue: 'required' },
      ]);
    }
    if (!body.name || typeof body.name !== 'string') {
      return error(c, 400, 'VALIDATION_ERROR', 'name is required', [
        { field: 'name', issue: 'required' },
      ]);
    }

    // Basic email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(body.email)) {
      return error(c, 400, 'VALIDATION_ERROR', 'Invalid email format', [
        { field: 'email', issue: 'invalid_format' },
      ]);
    }

    const email = body.email.trim().toLowerCase();
    const name = body.name.trim();

    if (name.length < 1 || name.length > 200) {
      return error(c, 400, 'VALIDATION_ERROR', 'name must be between 1 and 200 characters', [
        { field: 'name', issue: 'invalid_length' },
      ]);
    }

    // Check for existing account
    const existing = await db.select({ id: accounts.id, status: accounts.status })
      .from(accounts)
      .where(eq(accounts.email, email))
      .limit(1);

    if (existing.length > 0 && existing[0]) {
      if (existing[0].status === 'active') {
        return error(c, 409, 'ACCOUNT_EXISTS', 'An account with this email already exists');
      }
      // If pending, allow re-creation (they may have abandoned checkout)
    }

    // Step 1: Create Stripe Customer
    const customer = await stripePost('/customers', {
      email,
      name,
      'metadata[source]': 'vouch-self-service',
    });

    // Step 2: Create Stripe Checkout Session
    const successUrl = process.env.STRIPE_SUCCESS_URL || 'https://percival-labs.ai/welcome?session_id={CHECKOUT_SESSION_ID}';
    const cancelUrl = process.env.STRIPE_CANCEL_URL || 'https://percival-labs.ai/pricing';

    const checkoutParams: Record<string, string> = {
      'customer': customer.id,
      'mode': 'subscription',
      'success_url': successUrl,
      'cancel_url': cancelUrl,
      'client_reference_id': email,
      'metadata[source]': 'vouch-self-service',
    };

    // If specific price IDs are configured, use them. Otherwise, use a generic line item.
    const priceId = process.env.STRIPE_DEFAULT_PRICE_ID;
    if (priceId) {
      checkoutParams['line_items[0][price]'] = priceId;
      checkoutParams['line_items[0][quantity]'] = '1';
    }

    const session = await stripePost('/checkout/sessions', checkoutParams);

    // Step 3: Upsert account record
    if (existing.length > 0) {
      // Update existing pending account with new Stripe customer
      await db.update(accounts)
        .set({
          name,
          stripeCustomerId: customer.id,
          updatedAt: new Date(),
        })
        .where(eq(accounts.email, email));
    } else {
      await db.insert(accounts).values({
        email,
        name,
        stripeCustomerId: customer.id,
        status: 'pending',
      });
    }

    // Generate HMAC token for status polling
    const statusToken = await generateAccountStatusToken(email);

    return success(c, {
      accountId: existing.length > 0 && existing[0] ? existing[0].id : 'pending',
      checkoutUrl: session.url as string,
      statusToken,
    }, 201);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[accounts] POST /create error:', msg);

    if (msg.includes('Stripe API error') || msg.includes('Invalid API Key')) {
      return error(c, 500, 'PAYMENT_ERROR', 'Payment service unavailable');
    }
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to create account');
  }
});

// ── GET /status — Poll account status + retrieve AgentKey ──
app.get('/status', async (c) => {
  const email = c.req.query('email');

  if (!email || typeof email !== 'string') {
    return error(c, 400, 'VALIDATION_ERROR', 'email query parameter is required');
  }

  const token = c.req.query('token');
  if (!token) {
    return error(c, 400, 'VALIDATION_ERROR', 'Verification token required');
  }

  // Verify HMAC token to prevent email enumeration
  const secret = process.env.ACCOUNT_STATUS_SECRET || process.env.ENCRYPTION_KEY || '';
  if (!secret) {
    return error(c, 500, 'CONFIG_ERROR', 'Server not configured for account verification');
  }

  const normalizedEmail = email.trim().toLowerCase();

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const expectedBytes = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, encoder.encode(normalizedEmail))
  );
  const expectedToken = Buffer.from(expectedBytes).toString('hex');

  if (token !== expectedToken) {
    return error(c, 403, 'INVALID_TOKEN', 'Invalid verification token');
  }

  try {
    const rows = await db.select()
      .from(accounts)
      .where(eq(accounts.email, normalizedEmail))
      .limit(1);

    const account = rows[0];
    if (!account) {
      return success(c, {
        status: 'not_found' as const,
      });
    }

    const response: {
      status: string;
      agentKey?: string;
      plan?: string | null;
      vouchPubkey?: string | null;
    } = {
      status: account.status,
    };

    // Only return AgentKey if active and not yet claimed
    if (account.status === 'active' && account.agentKeyToken && !account.agentKeyClaimed) {
      response.agentKey = account.agentKeyToken;

      // Mark as claimed — single retrieval only
      await db.update(accounts)
        .set({
          agentKeyClaimed: true,
          updatedAt: new Date(),
        })
        .where(eq(accounts.id, account.id));
    }

    if (account.plan) {
      response.plan = account.plan;
    }

    // Always include vouchPubkey if available (never expose nsec here)
    if (account.vouchPubkey) {
      response.vouchPubkey = account.vouchPubkey;
    }

    return success(c, response);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[accounts] GET /status error:', msg);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to check account status');
  }
});

export default app;

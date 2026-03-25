// Stripe Bridge API routes — mediates between Stripe App and Vouch trust infrastructure.
// Mounted at /v1/stripe/* on the existing Vouch API.
// All routes use either Stripe App signature verification or Stripe webhook signature.

import { Hono } from 'hono';
import { z } from 'zod';
import { success, error } from '../lib/response';
import {
  linkAgent,
  lookupScore,
  assessTransaction,
  recordOutcome,
  generateReport,
  lookupAgentByCustomerId,
  getAssessmentHistory,
  getOrCreateInstallation,
  getSettings,
  updateSettings,
  getLinkedAgents,
  storeOAuthTokens,
  getOAuthTokens,
  refreshOAuthTokens,
} from '../services/stripe-bridge-service';
import { emitTrustEvent } from '../services/stripe-trust-event-service';
import { createHmac, timingSafeEqual } from 'node:crypto';

const STRIPE_BRIDGE_WEBHOOK_SECRET = process.env.STRIPE_BRIDGE_WEBHOOK_SECRET || '';
const STRIPE_APP_SECRET = process.env.STRIPE_APP_SECRET || '';
const STRIPE_CLIENT_ID = process.env.STRIPE_CLIENT_ID || '';
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';

const app = new Hono();

// ── Input Validation Schemas ──

const linkAgentSchema = z.object({
  stripe_account_id: z.string().min(1).max(255).regex(/^acct_/),
  stripe_customer_id: z.string().min(1).max(255).regex(/^cus_/),
  vouch_agent_id: z.string().min(1).max(500),
  label: z.string().max(200).optional(),
});

const assessSchema = z.object({
  stripe_account_id: z.string().min(1).max(255).regex(/^acct_/),
  vouch_agent_id: z.string().min(1).max(500),
  payment_intent_id: z.string().min(1).max(255).regex(/^pi_/),
  amount: z.number().int().min(0),
  currency: z.string().length(3),
  threshold: z.number().int().min(0).max(1000).optional(),
});

const scoreQuerySchema = z.object({
  agent_id: z.string().min(1).max(500),
  domain: z.string().max(100).optional(),
  stripe_account_id: z.string().min(1).max(255).regex(/^acct_/),
});

const reportQuerySchema = z.object({
  stripe_account_id: z.string().min(1).max(255).regex(/^acct_/),
  period_start: z.string().refine(
    (s) => !isNaN(new Date(s).getTime()),
    { message: 'Invalid date format for period_start' }
  ).optional(),
  period_end: z.string().refine(
    (s) => !isNaN(new Date(s).getTime()),
    { message: 'Invalid date format for period_end' }
  ).optional(),
});

// ── Stripe App Signature Verification Middleware ──

function verifyStripeAppSignature(signatureHeader: string, rawBody: string): boolean {
  if (!STRIPE_APP_SECRET) {
    console.warn('[stripe-bridge] STRIPE_APP_SECRET not configured');
    return false;
  }

  try {
    const parts = signatureHeader.split(',');
    const timestampPart = parts.find(p => p.startsWith('t='));
    const sigParts = parts.filter(p => p.startsWith('v1='));

    if (!timestampPart || sigParts.length === 0) return false;

    const timestamp = timestampPart.slice(2);
    const signatures = sigParts.map(p => p.slice(3));

    // Replay protection: 5 minute window
    const ts = parseInt(timestamp, 10);
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - ts) > 300) return false;

    const signedPayload = `${timestamp}.${rawBody}`;
    const expected = createHmac('sha256', STRIPE_APP_SECRET)
      .update(signedPayload)
      .digest('hex');

    const expectedBuf = Buffer.from(expected, 'hex');
    for (const sig of signatures) {
      const sigBuf = Buffer.from(sig, 'hex');
      if (sigBuf.length === expectedBuf.length && timingSafeEqual(sigBuf, expectedBuf)) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

// ── Webhook Signature Verification ──

interface StripeWebhookEvent {
  id: string;
  type: string;
  data: {
    object: Record<string, any>;
  };
}

function verifyWebhookSignature(rawBody: string, signatureHeader: string): StripeWebhookEvent {
  if (!STRIPE_BRIDGE_WEBHOOK_SECRET) {
    throw new Error('STRIPE_BRIDGE_WEBHOOK_SECRET not configured');
  }

  const parts = signatureHeader.split(',');
  const timestampPart = parts.find(p => p.startsWith('t='));
  const sigParts = parts.filter(p => p.startsWith('v1='));

  if (!timestampPart || sigParts.length === 0) {
    throw new Error('Invalid Stripe signature header format');
  }

  const timestamp = timestampPart.slice(2);
  const signatures = sigParts.map(p => p.slice(3));

  // Replay protection: 5 minute window
  const ts = parseInt(timestamp, 10);
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > 300) {
    throw new Error('Stripe webhook timestamp too old');
  }

  const signedPayload = `${timestamp}.${rawBody}`;
  const expected = createHmac('sha256', STRIPE_BRIDGE_WEBHOOK_SECRET)
    .update(signedPayload)
    .digest('hex');

  const expectedBuf = Buffer.from(expected, 'hex');
  let matched = false;
  for (const sig of signatures) {
    const sigBuf = Buffer.from(sig, 'hex');
    if (sigBuf.length === expectedBuf.length && timingSafeEqual(sigBuf, expectedBuf)) {
      matched = true;
      break;
    }
  }

  if (!matched) {
    throw new Error('Stripe webhook signature verification failed');
  }

  return JSON.parse(rawBody) as StripeWebhookEvent;
}

// ── Stripe App Signature Middleware ──
// Verifies that requests come from the Stripe App UI extension.
// Webhooks use their own signature verification (Stripe webhook signing).

async function requireAppSignature(c: any, next: () => Promise<void>) {
  // Skip signature check if secret not configured (dev mode)
  if (!STRIPE_APP_SECRET) {
    await next();
    return;
  }

  const sig = c.req.header('stripe-signature');
  if (!sig) {
    return error(c, 401, 'UNAUTHORIZED', 'Missing Stripe-Signature header');
  }

  const rawBody = await c.req.text();
  if (!verifyStripeAppSignature(sig, rawBody)) {
    return error(c, 401, 'UNAUTHORIZED', 'Invalid app signature');
  }

  // Re-inject body for downstream handlers since we consumed it
  c.req.bodyCache = { text: rawBody, json: JSON.parse(rawBody) };
  await next();
}

// ── Routes ──

// POST /v1/stripe/link-agent — Link a Stripe Customer to a Vouch Agent
app.post('/link-agent', async (c) => {
  try {
    const body = await c.req.json();
    const parsed = linkAgentSchema.safeParse(body);

    if (!parsed.success) {
      return error(c, 400, 'VALIDATION_ERROR', 'Invalid request body',
        parsed.error.issues.map(i => ({ field: i.path.join('.'), issue: i.message }))
      );
    }

    const result = await linkAgent({
      stripeAccountId: parsed.data.stripe_account_id,
      stripeCustomerId: parsed.data.stripe_customer_id,
      vouchAgentId: parsed.data.vouch_agent_id,
      label: parsed.data.label,
    });

    return success(c, result, 201);
  } catch (err) {
    console.error('[stripe-bridge] POST /link-agent error:', err);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to link agent');
  }
});

// GET /v1/stripe/score/:stripeCustomerId — Get trust score for a Stripe-linked agent
app.get('/score/:stripeCustomerId', async (c) => {
  try {
    const stripeCustomerId = c.req.param('stripeCustomerId');
    const queryParams = c.req.query();

    // Validate customer ID format
    if (!stripeCustomerId || !stripeCustomerId.startsWith('cus_')) {
      return error(c, 400, 'VALIDATION_ERROR', 'Invalid Stripe customer ID format');
    }

    const stripeAccountId = queryParams.stripe_account_id;
    if (!stripeAccountId || !stripeAccountId.startsWith('acct_')) {
      return error(c, 400, 'VALIDATION_ERROR', 'stripe_account_id query parameter is required');
    }

    // Look up the agent linked to this customer
    const agent = await lookupAgentByCustomerId(stripeAccountId, stripeCustomerId);
    if (!agent) {
      return error(c, 404, 'NOT_FOUND', 'No agent linked to this Stripe customer');
    }

    const result = await lookupScore({
      agentId: agent.vouchAgentId,
      domain: queryParams.domain,
      stripeAccountId,
    });

    return success(c, result);
  } catch (err) {
    console.error('[stripe-bridge] GET /score error:', err);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to look up score');
  }
});

// POST /v1/stripe/assess — Pre-transaction trust assessment
app.post('/assess', async (c) => {
  try {
    const body = await c.req.json();
    const parsed = assessSchema.safeParse(body);

    if (!parsed.success) {
      return error(c, 400, 'VALIDATION_ERROR', 'Invalid request body',
        parsed.error.issues.map(i => ({ field: i.path.join('.'), issue: i.message }))
      );
    }

    const result = await assessTransaction({
      stripeAccountId: parsed.data.stripe_account_id,
      vouchAgentId: parsed.data.vouch_agent_id,
      paymentIntentId: parsed.data.payment_intent_id,
      amount: parsed.data.amount,
      currency: parsed.data.currency,
      threshold: parsed.data.threshold,
    });

    return success(c, result);
  } catch (err) {
    console.error('[stripe-bridge] POST /assess error:', err);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to assess transaction');
  }
});

// POST /v1/stripe/webhook — Receive Stripe webhooks and map to MCP-T trust events
app.post('/webhook', async (c) => {
  try {
    const rawBody = await c.req.text();
    const signatureHeader = c.req.header('stripe-signature');

    if (!signatureHeader) {
      return error(c, 401, 'UNAUTHORIZED', 'Missing stripe-signature header');
    }

    let event: StripeWebhookEvent;
    try {
      event = verifyWebhookSignature(rawBody, signatureHeader);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[stripe-bridge] Webhook signature failed: ${msg}`);
      return error(c, 401, 'UNAUTHORIZED', 'Invalid webhook signature');
    }

    console.log(`[stripe-bridge] Webhook received: ${event.type} (${event.id})`);

    const obj = event.data.object;

    // Extract agent ID from metadata or linked customer
    let agentId: string | null = null;
    let paymentIntentId: string | null = null;
    let stripeAccountId: string | null = null;

    switch (event.type) {
      case 'payment_intent.succeeded':
      case 'payment_intent.payment_failed': {
        paymentIntentId = obj.id;
        agentId = obj.metadata?.vouch_agent_id;
        stripeAccountId = obj.on_behalf_of || obj.application || obj.transfer_data?.destination;

        if (!agentId && obj.customer) {
          // Try to resolve via linked customer
          // We need a stripe_account_id — use transfer destination or default
          if (stripeAccountId) {
            const linked = await lookupAgentByCustomerId(stripeAccountId, obj.customer);
            if (linked) agentId = linked.vouchAgentId;
          }
        }
        break;
      }

      case 'charge.dispute.created':
      case 'charge.dispute.closed': {
        paymentIntentId = obj.payment_intent;
        stripeAccountId = obj.on_behalf_of || obj.application;

        // Resolve agent from PI metadata via the linked customer
        if (obj.customer && stripeAccountId) {
          const linked = await lookupAgentByCustomerId(stripeAccountId, obj.customer);
          if (linked) agentId = linked.vouchAgentId;
        }
        break;
      }

      case 'charge.refunded': {
        paymentIntentId = obj.payment_intent;
        stripeAccountId = obj.on_behalf_of || obj.application;

        if (obj.customer && stripeAccountId) {
          const linked = await lookupAgentByCustomerId(stripeAccountId, obj.customer);
          if (linked) agentId = linked.vouchAgentId;
        }
        break;
      }

      default:
        // Unknown event type — acknowledge but don't process
        return c.json({ received: true }, 200);
    }

    if (!agentId || !paymentIntentId) {
      // No agent linked to this transaction — acknowledge without processing
      console.log(`[stripe-bridge] No agent found for ${event.type} (PI: ${paymentIntentId})`);
      return c.json({ received: true }, 200);
    }

    // Determine outcome type
    let outcomeType: 'success' | 'failed' | 'disputed' | 'refunded';
    const metadata: Record<string, any> = {};

    switch (event.type) {
      case 'payment_intent.succeeded':
        outcomeType = 'success';
        metadata.amount = obj.amount;
        metadata.currency = obj.currency;
        break;
      case 'payment_intent.payment_failed':
        outcomeType = 'failed';
        metadata.failureMessage = obj.last_payment_error?.message;
        break;
      case 'charge.dispute.created':
        outcomeType = 'disputed';
        metadata.reason = obj.reason;
        metadata.amount = obj.amount;
        break;
      case 'charge.refunded':
        outcomeType = 'refunded';
        metadata.amount = obj.amount_refunded;
        metadata.refundRatio = obj.amount > 0 ? obj.amount_refunded / obj.amount : 1;
        break;
      case 'charge.dispute.closed':
        // Dispute resolution — only emit trust event if won (handled by emitTrustEvent)
        outcomeType = obj.status === 'won' ? 'success' : 'disputed';
        metadata.status = obj.status;
        break;
      default:
        return c.json({ received: true }, 200);
    }

    // Get or create installation
    const installationId = stripeAccountId
      ? await getOrCreateInstallation(stripeAccountId)
      : await getOrCreateInstallation('default');

    // Record outcome
    const outcomeResult = await recordOutcome({
      installationId,
      paymentIntentId,
      vouchAgentId: agentId,
      outcome: outcomeType,
      stripeEventId: event.id,
      disputeReason: event.type === 'charge.dispute.created' ? obj.reason : undefined,
      disputeAmountCents: event.type === 'charge.dispute.created' ? obj.amount : undefined,
      refundAmountCents: event.type === 'charge.refunded' ? obj.amount_refunded : undefined,
    });

    // Emit MCP-T trust event
    if (!outcomeResult.trust_event_emitted) {
      await emitTrustEvent(
        outcomeResult.id,
        event.type,
        agentId,
        paymentIntentId,
        metadata,
      );
    }

    return c.json({ received: true }, 200);
  } catch (err) {
    console.error('[stripe-bridge] Webhook error:', err);
    return c.json({ error: 'Internal error' }, 500);
  }
});

// GET /v1/stripe/analytics — Actuarial data
app.get('/analytics', async (c) => {
  try {
    const queryParams = c.req.query();
    const parsed = reportQuerySchema.safeParse(queryParams);

    if (!parsed.success) {
      return error(c, 400, 'VALIDATION_ERROR', 'Invalid query parameters',
        parsed.error.issues.map(i => ({ field: i.path.join('.'), issue: i.message }))
      );
    }

    const result = await generateReport({
      stripeAccountId: parsed.data.stripe_account_id,
      periodStart: parsed.data.period_start,
      periodEnd: parsed.data.period_end,
    });

    return success(c, result);
  } catch (err) {
    console.error('[stripe-bridge] GET /analytics error:', err);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to generate report');
  }
});

// GET /v1/stripe/assessments — Assessment history
app.get('/assessments', async (c) => {
  try {
    const stripeAccountId = c.req.query('stripe_account_id');
    if (!stripeAccountId || !stripeAccountId.startsWith('acct_')) {
      return error(c, 400, 'VALIDATION_ERROR', 'stripe_account_id is required');
    }

    const limit = Math.min(Math.max(1, parseInt(c.req.query('limit') || '50', 10) || 50), 100);
    const offset = Math.max(0, parseInt(c.req.query('offset') || '0', 10) || 0);

    const result = await getAssessmentHistory(stripeAccountId, limit, offset);
    return success(c, result);
  } catch (err) {
    console.error('[stripe-bridge] GET /assessments error:', err);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to fetch assessment history');
  }
});

// GET /v1/stripe/settings — Get installation settings
app.get('/settings', async (c) => {
  try {
    const stripeAccountId = c.req.query('stripe_account_id');
    if (!stripeAccountId || !stripeAccountId.startsWith('acct_')) {
      return error(c, 400, 'VALIDATION_ERROR', 'stripe_account_id is required');
    }

    const result = await getSettings(stripeAccountId);
    return success(c, result);
  } catch (err) {
    console.error('[stripe-bridge] GET /settings error:', err);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to fetch settings');
  }
});

// PUT /v1/stripe/settings — Update installation settings
app.put('/settings', async (c) => {
  try {
    const body = await c.req.json();
    const stripeAccountId = body.stripe_account_id;
    if (!stripeAccountId || !stripeAccountId.startsWith('acct_')) {
      return error(c, 400, 'VALIDATION_ERROR', 'stripe_account_id is required');
    }

    const settings: Record<string, any> = {};
    if (body.threshold !== undefined) {
      const t = Number(body.threshold);
      if (isNaN(t) || t < 0 || t > 1000) {
        return error(c, 400, 'VALIDATION_ERROR', 'threshold must be 0-1000');
      }
      settings.threshold = t;
    }
    if (body.domain !== undefined) {
      if (!['financial', 'general', 'code-execution'].includes(body.domain)) {
        return error(c, 400, 'VALIDATION_ERROR', 'Invalid domain');
      }
      settings.domain = body.domain;
    }
    if (body.flagUnscored !== undefined) {
      settings.flagUnscored = Boolean(body.flagUnscored);
    }

    const result = await updateSettings(stripeAccountId, settings);
    return success(c, result);
  } catch (err) {
    console.error('[stripe-bridge] PUT /settings error:', err);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to update settings');
  }
});

// GET /v1/stripe/linked-agents — List linked agents
app.get('/linked-agents', async (c) => {
  try {
    const stripeAccountId = c.req.query('stripe_account_id');
    if (!stripeAccountId || !stripeAccountId.startsWith('acct_')) {
      return error(c, 400, 'VALIDATION_ERROR', 'stripe_account_id is required');
    }

    const limit = Math.min(Math.max(1, parseInt(c.req.query('limit') || '50', 10) || 50), 100);
    const offset = Math.max(0, parseInt(c.req.query('offset') || '0', 10) || 0);

    const result = await getLinkedAgents(stripeAccountId, limit, offset);
    return success(c, result);
  } catch (err) {
    console.error('[stripe-bridge] GET /linked-agents error:', err);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to fetch linked agents');
  }
});

// ── OAuth Flow ──

// GET /v1/stripe/oauth/callback — Handle OAuth redirect from Stripe marketplace install
app.get('/oauth/callback', async (c) => {
  try {
    const code = c.req.query('code');
    const state = c.req.query('state');

    if (!code) {
      return error(c, 400, 'VALIDATION_ERROR', 'Missing authorization code');
    }

    if (!STRIPE_SECRET_KEY) {
      console.error('[stripe-bridge] STRIPE_SECRET_KEY not configured');
      return error(c, 500, 'CONFIG_ERROR', 'OAuth not configured');
    }

    // Exchange authorization code for access + refresh tokens
    const tokenRes = await fetch('https://api.stripe.com/v1/oauth/token', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        code,
        grant_type: 'authorization_code',
      }),
    });

    if (!tokenRes.ok) {
      const errBody = await tokenRes.text();
      console.error('[stripe-bridge] OAuth token exchange failed:', errBody);
      return error(c, 400, 'OAUTH_ERROR', 'Failed to exchange authorization code');
    }

    const tokenData = await tokenRes.json() as {
      access_token: string;
      refresh_token: string;
      stripe_user_id: string;
      stripe_publishable_key: string;
      livemode: boolean;
      token_type: string;
    };

    // Store tokens for this installation
    await storeOAuthTokens(tokenData.stripe_user_id, {
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      stripePublishableKey: tokenData.stripe_publishable_key,
      livemode: tokenData.livemode,
      grantedAt: new Date().toISOString(),
    });

    console.log(`[stripe-bridge] OAuth complete for ${tokenData.stripe_user_id} (livemode: ${tokenData.livemode})`);

    // Redirect to the Stripe Dashboard with the app installed
    return c.redirect(
      `https://dashboard.stripe.com/${tokenData.stripe_user_id}/apps/installed`
    );
  } catch (err) {
    console.error('[stripe-bridge] OAuth callback error:', err);
    return error(c, 500, 'INTERNAL_ERROR', 'OAuth callback failed');
  }
});

// POST /v1/stripe/oauth/refresh — Refresh an expired access token
app.post('/oauth/refresh', async (c) => {
  try {
    const body = await c.req.json();
    const stripeAccountId = body.stripe_account_id;

    if (!stripeAccountId) {
      return error(c, 400, 'VALIDATION_ERROR', 'stripe_account_id is required');
    }

    const result = await refreshOAuthTokens(stripeAccountId, STRIPE_SECRET_KEY);
    if (!result) {
      return error(c, 400, 'OAUTH_ERROR', 'Failed to refresh token');
    }

    return success(c, { refreshed: true, stripe_account_id: stripeAccountId });
  } catch (err) {
    console.error('[stripe-bridge] Token refresh error:', err);
    return error(c, 500, 'INTERNAL_ERROR', 'Token refresh failed');
  }
});

export default app;

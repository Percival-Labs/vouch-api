// Stripe Webhook Handler — subscription lifecycle events.
// Mounted BEFORE auth middleware (webhooks use Stripe signature verification).
//
// Events handled:
//   checkout.session.completed  -> provision AgentKey
//   customer.subscription.updated -> update tier/limits
//   customer.subscription.deleted -> downgrade to suspended
//   invoice.payment_failed -> warning state

import { Hono } from 'hono';
import { db, accounts, agents } from '@percival/vouch-db';
import { eq } from 'drizzle-orm';
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1';
import { bech32 } from '@scure/base';
import { encrypt } from '../../lib/encryption';

const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const GATEWAY_ADMIN_URL = process.env.GATEWAY_ADMIN_URL || 'https://gateway.percival-labs.ai';
const GATEWAY_ADMIN_KEY = process.env.GATEWAY_ADMIN_KEY || '';

// ── Stripe Signature Verification ──

interface StripeEvent {
  id: string;
  type: string;
  data: {
    object: Record<string, any>;
  };
}

/**
 * Verify Stripe webhook signature per their spec:
 * https://docs.stripe.com/webhooks#verify-official-libraries
 *
 * Signature header format: t=<timestamp>,v1=<sig1>,v1=<sig2>,...
 * Signed payload: "<timestamp>.<rawBody>"
 */
function verifyStripeSignature(rawBody: string, signatureHeader: string): StripeEvent {
  if (!STRIPE_WEBHOOK_SECRET) {
    throw new Error('STRIPE_WEBHOOK_SECRET not configured');
  }

  const parts = signatureHeader.split(',');
  const timestampPart = parts.find(p => p.startsWith('t='));
  const sigParts = parts.filter(p => p.startsWith('v1='));

  if (!timestampPart || sigParts.length === 0) {
    throw new Error('Invalid Stripe signature header format');
  }

  const timestamp = timestampPart.slice(2);
  const signatures = sigParts.map(p => p.slice(3));

  // Protect against replay attacks (5 minute tolerance)
  const timestampSeconds = parseInt(timestamp, 10);
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestampSeconds) > 300) {
    throw new Error('Stripe webhook timestamp too old');
  }

  // Compute expected signature
  const signedPayload = `${timestamp}.${rawBody}`;
  const expectedSig = createHmac('sha256', STRIPE_WEBHOOK_SECRET)
    .update(signedPayload)
    .digest('hex');

  // Check if any v1 signature matches (timing-safe)
  const expectedBuf = Buffer.from(expectedSig, 'hex');
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

  return JSON.parse(rawBody) as StripeEvent;
}

// ── Nostr Keypair Helpers ──
// Mirrors the pattern in @vouch/agent-sdk (packages/vouch-sdk/src/nostr-identity.ts)

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function hexToNsec(hex: string): string {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bech32.encode('nsec', bech32.toWords(bytes));
}

function hexToNpub(hex: string): string {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bech32.encode('npub', bech32.toWords(bytes));
}

interface VouchIdentity {
  pubkeyHex: string;
  nsec: string;
  npub: string;
}

function generateVouchIdentity(): VouchIdentity {
  const secretKeyBytes = schnorr.utils.randomPrivateKey();
  const secretKeyHex = bytesToHex(secretKeyBytes);
  const pubkeyBytes = schnorr.getPublicKey(secretKeyBytes);
  const pubkeyHex = bytesToHex(pubkeyBytes);

  return {
    pubkeyHex,
    nsec: hexToNsec(secretKeyHex),
    npub: hexToNpub(pubkeyHex),
  };
}

// ── AgentKey Provisioning ──

interface ProvisionResult {
  token: string;
  vouchPubkey: string;
  vouchNsec: string;
  agentId: string | null;
}

/**
 * Generate a random 64-char hex AgentKey, create a Vouch identity, register
 * the agent in both the Gateway and the Vouch agents table.
 */
async function provisionAgentKey(email: string, plan: string, name: string): Promise<ProvisionResult> {
  const token = randomBytes(32).toString('hex'); // 64-char hex
  const identity = generateVouchIdentity();

  // Derive a human-readable agent name from email
  const agentName = name || email.split('@')[0] || 'agent';

  // ── Step 1: Create agent record in Vouch system ──
  let agentId: string | null = null;
  try {
    const nip05 = `${agentName.toLowerCase().replace(/[^a-z0-9]/g, '-')}@vouch.xyz`;

    const [agent] = await db.insert(agents).values({
      name: agentName,
      description: `Auto-provisioned via Stripe checkout (${plan} plan)`,
      pubkey: identity.pubkeyHex,
      npub: identity.npub,
      nip05,
      capabilities: [],
      verified: true,
    }).returning();

    agentId = agent.id;
    console.log(`[stripe-webhook] Vouch agent created: ${agentId} (${identity.npub})`);
  } catch (err) {
    console.error('[stripe-webhook] Vouch agent creation error:', err);
    // Non-fatal — agent can be created later via SDK register
  }

  // ── Step 2: Register with Gateway admin API ──
  if (GATEWAY_ADMIN_URL && GATEWAY_ADMIN_KEY) {
    const tierMap: Record<string, string> = {
      starter: 'standard',
      personal: 'standard',
      pro: 'verified',
      team: 'premium',
    };

    const tier = tierMap[plan] || 'standard';

    try {
      const res = await fetch(`${GATEWAY_ADMIN_URL}/admin/v1/agents/${token}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-Gateway-Secret': GATEWAY_ADMIN_KEY,
        },
        body: JSON.stringify({
          pubkey: identity.pubkeyHex,
          agentId: agentId || `stripe-${email}`,
          name: agentName,
          tier,
          models: [],
          budget: {
            maxSats: tier === 'premium' ? 100000 : tier === 'verified' ? 50000 : 10000,
            periodDays: 30,
          },
        }),
      });

      if (!res.ok) {
        const body = await res.text();
        console.error(`[stripe-webhook] Gateway registration failed: ${res.status} ${body}`);
        // Don't throw — still store the key. Gateway can be synced later.
      } else {
        console.log(`[stripe-webhook] Gateway agent registered: ${token.slice(0, 8)}...`);
      }
    } catch (err) {
      console.error('[stripe-webhook] Gateway registration error:', err);
      // Non-fatal — key is still stored in accounts table
    }
  }

  return {
    token,
    vouchPubkey: identity.pubkeyHex,
    vouchNsec: identity.nsec,
    agentId,
  };
}

// ── Plan Extraction ──

function extractPlanFromSubscription(subscription: Record<string, any>): string {
  // Try to extract from items -> price -> product metadata or lookup table
  const items = subscription.items?.data;
  if (items && items.length > 0) {
    const priceId = items[0]?.price?.id;
    const productId = items[0]?.price?.product;
    const nickname = items[0]?.price?.nickname;

    // Check nickname first (e.g., "Starter", "Personal", "Pro", "Team")
    if (nickname) {
      const lower = nickname.toLowerCase();
      if (['starter', 'personal', 'pro', 'team'].includes(lower)) {
        return lower;
      }
    }

    // Check metadata on the price or subscription
    const meta = items[0]?.price?.metadata?.plan || subscription.metadata?.plan;
    if (meta) return meta;
  }

  return 'starter'; // default
}

// ── Route Handler ──

const app = new Hono();

app.post('/', async (c) => {
  try {
    // Get raw body for signature verification
    const rawBody = await c.req.text();
    const signatureHeader = c.req.header('stripe-signature');

    if (!signatureHeader) {
      console.warn('[stripe-webhook] Missing stripe-signature header');
      return c.json({ error: 'Missing signature' }, 401);
    }

    let event: StripeEvent;
    try {
      event = verifyStripeSignature(rawBody, signatureHeader);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[stripe-webhook] Signature verification failed: ${msg}`);
      return c.json({ error: 'Invalid signature' }, 401);
    }

    console.log(`[stripe-webhook] Received event: ${event.type} (${event.id})`);

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const customerId = session.customer as string;
        const email = (session.customer_email || session.client_reference_id || '') as string;
        const subscriptionId = session.subscription as string;

        if (!customerId || !email) {
          console.warn('[stripe-webhook] checkout.session.completed missing customer or email');
          break;
        }

        const normalizedEmail = email.trim().toLowerCase();

        // Find the account
        const rows = await db.select()
          .from(accounts)
          .where(eq(accounts.email, normalizedEmail))
          .limit(1);

        if (rows.length === 0) {
          // Account wasn't pre-created — create it now
          console.log(`[stripe-webhook] Creating account for ${normalizedEmail}`);
          const plan = session.metadata?.plan || 'starter';
          const accountName = normalizedEmail.split('@')[0] || normalizedEmail;
          const result = await provisionAgentKey(normalizedEmail, plan, accountName);

          // R2 fix: Encrypt nsec before storage (AES-256-GCM)
          const encryptedNsec = await encrypt(result.vouchNsec);

          await db.insert(accounts).values({
            email: normalizedEmail,
            name: accountName,
            stripeCustomerId: customerId,
            agentKeyToken: result.token,
            agentKeyClaimed: false,
            vouchPubkey: result.vouchPubkey,
            vouchNsec: encryptedNsec,
            status: 'active',
            plan: plan as any,
          });
        } else {
          // Existing account — provision key and activate
          const plan = session.metadata?.plan || 'starter';
          const accountName = rows[0]?.name || normalizedEmail.split('@')[0] || normalizedEmail;
          const result = await provisionAgentKey(normalizedEmail, plan, accountName);

          // R2 fix: Encrypt nsec before storage (AES-256-GCM)
          const encryptedNsec = await encrypt(result.vouchNsec);

          await db.update(accounts)
            .set({
              status: 'active',
              agentKeyToken: result.token,
              agentKeyClaimed: false,
              vouchPubkey: result.vouchPubkey,
              vouchNsec: encryptedNsec,
              plan: plan as any,
              stripeCustomerId: customerId,
              updatedAt: new Date(),
            })
            .where(eq(accounts.email, normalizedEmail));
        }

        console.log(`[stripe-webhook] Account activated: ${normalizedEmail}`);
        break;
      }

      case 'customer.subscription.updated': {
        const subscription = event.data.object;
        const customerId = subscription.customer as string;

        if (!customerId) break;

        const plan = extractPlanFromSubscription(subscription);
        const status = subscription.status as string;

        // Map Stripe status to account status
        let accountStatus: 'active' | 'suspended' = 'active';
        if (['past_due', 'unpaid', 'paused'].includes(status)) {
          accountStatus = 'suspended';
        }

        await db.update(accounts)
          .set({
            plan: plan as any,
            status: accountStatus,
            updatedAt: new Date(),
          })
          .where(eq(accounts.stripeCustomerId, customerId));

        console.log(`[stripe-webhook] Subscription updated: customer=${customerId}, plan=${plan}, status=${accountStatus}`);
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        const customerId = subscription.customer as string;

        if (!customerId) break;

        await db.update(accounts)
          .set({
            status: 'suspended',
            updatedAt: new Date(),
          })
          .where(eq(accounts.stripeCustomerId, customerId));

        console.log(`[stripe-webhook] Subscription deleted: customer=${customerId} -> suspended`);
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const customerId = invoice.customer as string;

        if (!customerId) break;

        // Don't immediately suspend — just log a warning.
        // Stripe retries payment and will send subscription.deleted if all retries fail.
        console.warn(`[stripe-webhook] Payment failed: customer=${customerId}, invoice=${invoice.id}`);
        break;
      }

      default:
        console.log(`[stripe-webhook] Unhandled event type: ${event.type}`);
    }

    // Always return 200 to acknowledge receipt (prevents Stripe retries)
    return c.json({ received: true }, 200);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[stripe-webhook] Unhandled error:', msg);
    // Return 500 so Stripe retries
    return c.json({ error: 'Internal error' }, 500);
  }
});

export default app;

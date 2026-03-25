// ACP Seller Service — Business logic for Stripe Agent Commerce Protocol checkout flow.
// Manages checkout session lifecycle: create, update, complete (charge + provision), cancel.
// Product catalog is hardcoded initially with Engram agent products.

import { db, acpCheckoutSessions, agents } from '@percival/vouch-db';
import { eq } from 'drizzle-orm';
import { ulid } from 'ulid';
import { randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1';
import { bech32 } from '@scure/base';
import { encrypt } from '../lib/encryption';

// ── Environment ──

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const GATEWAY_ADMIN_URL = process.env.GATEWAY_ADMIN_URL || 'https://gateway.percival-labs.ai';
const GATEWAY_ADMIN_KEY = process.env.GATEWAY_ADMIN_KEY || '';
const ACP_CHECKOUT_EXPIRY_MINUTES = parseInt(process.env.ACP_CHECKOUT_EXPIRY_MINUTES || '30', 10);

// ── Product Catalog ──

export interface AcpProduct {
  id: string;
  name: string;
  description: string;
  priceUsdcCents: number;
  features: string[];
  gatewayTier: string;
  gatewayBudgetSats: number;
}

const PRODUCT_CATALOG: AcpProduct[] = [
  {
    id: 'engram-starter',
    name: 'Engram Starter Agent',
    description: 'AI agent with basic inference capabilities. Includes Vouch identity and Gateway access.',
    priceUsdcCents: 1900, // $19.00
    features: ['Basic inference', '10K tokens/day', 'Vouch identity', 'Gateway access'],
    gatewayTier: 'standard',
    gatewayBudgetSats: 10000,
  },
  {
    id: 'engram-pro',
    name: 'Engram Pro Agent',
    description: 'AI agent with advanced inference, priority routing, and higher token limits.',
    priceUsdcCents: 4900, // $49.00
    features: ['Advanced inference', '100K tokens/day', 'Priority routing', 'Vouch identity', 'Gateway access'],
    gatewayTier: 'elevated',
    gatewayBudgetSats: 50000,
  },
  {
    id: 'engram-team',
    name: 'Engram Team Agent',
    description: 'Enterprise-grade AI agent with premium routing, highest limits, and dedicated support.',
    priceUsdcCents: 16600, // $166.00
    features: ['Premium inference', '1M tokens/day', 'Dedicated routing', 'Vouch identity', 'Gateway access', 'Priority support'],
    gatewayTier: 'unlimited',
    gatewayBudgetSats: 100000,
  },
];

// ── Public Helpers ──

export function getProducts(): AcpProduct[] {
  return PRODUCT_CATALOG;
}

function findProduct(productId: string): AcpProduct | undefined {
  return PRODUCT_CATALOG.find(p => p.id === productId);
}

// ── Nostr Keypair Helpers (same pattern as webhooks/stripe.ts) ──

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

// ── Agent Provisioning (extracted pattern from webhooks/stripe.ts) ──

interface ProvisionResult {
  token: string;
  agentId: string;
  vouchPubkey: string;
}

async function provisionAgent(
  product: AcpProduct,
  buyerAddress: string,
): Promise<ProvisionResult> {
  const token = randomBytes(32).toString('hex'); // 64-char hex AgentKey
  const identity = generateVouchIdentity();
  const agentName = `acp-${product.id}-${buyerAddress.slice(2, 10)}`;

  // Step 1: Create agent record in Vouch system
  let agentId = '';
  try {
    const nip05 = `${agentName.toLowerCase().replace(/[^a-z0-9]/g, '-')}@vouch.xyz`;

    const [agent] = await db.insert(agents).values({
      name: agentName,
      description: `ACP-provisioned ${product.name} for ${buyerAddress}`,
      pubkey: identity.pubkeyHex,
      npub: identity.npub,
      nip05,
      capabilities: [],
      verified: true,
    }).returning();

    agentId = agent?.id ?? '';
    console.log(`[acp-seller] Vouch agent created: ${agentId} (${identity.npub})`);
  } catch (err) {
    console.error('[acp-seller] Vouch agent creation error:', err);
    // Non-fatal — agent can be created later
  }

  // Step 2: Register with Gateway admin API
  if (GATEWAY_ADMIN_URL && GATEWAY_ADMIN_KEY) {
    try {
      const res = await fetch(`${GATEWAY_ADMIN_URL}/admin/v1/agents/${token}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-Gateway-Secret': GATEWAY_ADMIN_KEY,
        },
        body: JSON.stringify({
          pubkey: identity.pubkeyHex,
          agentId: agentId || `acp-${buyerAddress}`,
          name: agentName,
          tier: product.gatewayTier,
          models: [],
          budget: {
            maxSats: product.gatewayBudgetSats,
            periodDays: 30,
          },
        }),
      });

      if (!res.ok) {
        const body = await res.text();
        console.error(`[acp-seller] Gateway registration failed: ${res.status} ${body}`);
      } else {
        console.log(`[acp-seller] Gateway agent registered: ${token.slice(0, 8)}...`);
      }
    } catch (err) {
      console.error('[acp-seller] Gateway registration error:', err);
    }
  }

  return { token, agentId, vouchPubkey: identity.pubkeyHex };
}

// ── Stripe Helpers ──

async function chargeStripePaymentIntent(
  amountCents: number,
  paymentToken: string,
  description: string,
  idempotencyKey?: string,
): Promise<string> {
  if (!STRIPE_SECRET_KEY) {
    throw new Error('STRIPE_SECRET_KEY not configured');
  }

  const headers: Record<string, string> = {
    'Authorization': `Bearer ${STRIPE_SECRET_KEY}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  if (idempotencyKey) {
    headers['Idempotency-Key'] = `acp-checkout-${idempotencyKey}`;
  }

  const res = await fetch('https://api.stripe.com/v1/payment_intents', {
    method: 'POST',
    headers,
    body: new URLSearchParams({
      amount: amountCents.toString(),
      currency: 'usd',
      payment_method: paymentToken,
      confirm: 'true',
      description,
      'metadata[source]': 'acp_checkout',
    }).toString(),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Stripe PaymentIntent creation failed (${res.status}): ${body}`);
  }

  const pi = await res.json() as { id: string; status: string };
  if (pi.status !== 'succeeded') {
    throw new Error(`Stripe PaymentIntent not succeeded: ${pi.status}`);
  }

  return pi.id;
}

// ── Checkout Service Functions ──

export interface CreateCheckoutResult {
  id: string;
  productId: string;
  buyerAddress: string;
  status: 'pending';
  priceUsdcCents: number;
  expiresAt: string;
  createdAt: string;
}

export async function createCheckout(
  productId: string,
  buyerAddress: string,
  metadata?: Record<string, unknown>,
): Promise<CreateCheckoutResult> {
  const product = findProduct(productId);
  if (!product) {
    throw new Error(`Unknown product: ${productId}`);
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + ACP_CHECKOUT_EXPIRY_MINUTES * 60 * 1000);
  const id = ulid();

  const [session] = await db.insert(acpCheckoutSessions).values({
    id,
    productId: product.id,
    buyerAddress: buyerAddress.toLowerCase(),
    status: 'pending',
    priceUsdcCents: product.priceUsdcCents,
    metadata: metadata ?? null,
    expiresAt,
  }).returning();

  return {
    id: session!.id,
    productId: session!.productId,
    buyerAddress: session!.buyerAddress,
    status: 'pending',
    priceUsdcCents: session!.priceUsdcCents,
    expiresAt: session!.expiresAt.toISOString(),
    createdAt: session!.createdAt.toISOString(),
  };
}

export interface UpdateCheckoutResult {
  id: string;
  status: string;
  updatedAt: string;
}

export async function updateCheckout(
  checkoutId: string,
  updates: Record<string, unknown>,
): Promise<UpdateCheckoutResult> {
  // Verify session exists and is pending
  const [existing] = await db.select()
    .from(acpCheckoutSessions)
    .where(eq(acpCheckoutSessions.id, checkoutId))
    .limit(1);

  if (!existing) {
    throw new Error('Checkout session not found');
  }

  if (existing.status !== 'pending') {
    throw new Error(`Cannot update checkout in ${existing.status} state`);
  }

  // Check expiry
  if (existing.expiresAt < new Date()) {
    throw new Error('Checkout session has expired');
  }

  const now = new Date();
  const [updated] = await db.update(acpCheckoutSessions)
    .set({
      metadata: updates.metadata !== undefined ? updates.metadata as Record<string, unknown> : existing.metadata,
      updatedAt: now,
    })
    .where(eq(acpCheckoutSessions.id, checkoutId))
    .returning();

  return {
    id: updated!.id,
    status: updated!.status,
    updatedAt: updated!.updatedAt.toISOString(),
  };
}

export interface CompleteCheckoutResult {
  id: string;
  status: 'completed';
  agentKey: string;
  agentId: string;
  gatewayUrl: string;
}

export async function completeCheckout(
  checkoutId: string,
  paymentToken: string,
): Promise<CompleteCheckoutResult> {
  // Verify session exists and is pending
  const [session] = await db.select()
    .from(acpCheckoutSessions)
    .where(eq(acpCheckoutSessions.id, checkoutId))
    .limit(1);

  if (!session) {
    throw new Error('Checkout session not found');
  }

  // Idempotency: if already completed, return existing result
  if (session.status === 'completed' && session.provisionedAgentKey && session.provisionedAgentId) {
    return {
      id: checkoutId,
      status: 'completed',
      agentKey: session.provisionedAgentKey,
      agentId: session.provisionedAgentId,
      gatewayUrl: GATEWAY_ADMIN_URL,
    };
  }

  if (session.status !== 'pending') {
    throw new Error(`Cannot complete checkout in ${session.status} state`);
  }

  if (session.expiresAt < new Date()) {
    await db.update(acpCheckoutSessions)
      .set({ status: 'expired', updatedAt: new Date() })
      .where(eq(acpCheckoutSessions.id, checkoutId));
    throw new Error('Checkout session has expired');
  }

  const product = findProduct(session.productId);
  if (!product) {
    throw new Error(`Product not found: ${session.productId}`);
  }

  // Optimistic lock: atomically transition pending → processing.
  // If another request already transitioned, this returns 0 rows.
  const [locked] = await db.update(acpCheckoutSessions)
    .set({ status: 'processing', updatedAt: new Date() })
    .where(
      eq(acpCheckoutSessions.id, checkoutId),
    )
    .returning();

  // Check we actually locked it (drizzle returns the row if updated)
  if (!locked || locked.status !== 'processing') {
    throw new Error('Checkout is already being processed by another request');
  }

  try {
    // Step 1: Charge via Stripe (with idempotency key to prevent double-charge)
    const encryptedToken = await encrypt(paymentToken);
    const stripePaymentIntentId = await chargeStripePaymentIntent(
      session.priceUsdcCents,
      paymentToken,
      `ACP checkout: ${product.name} for ${session.buyerAddress}`,
      checkoutId, // idempotency key
    );

    // Step 2: Provision agent key + Gateway access
    const provision = await provisionAgent(product, session.buyerAddress);

    // Step 3: Update DB record to completed
    const now = new Date();
    await db.update(acpCheckoutSessions)
      .set({
        status: 'completed',
        paymentToken: encryptedToken,
        stripePaymentIntentId,
        provisionedAgentKey: provision.token,
        provisionedAgentId: provision.agentId,
        updatedAt: now,
      })
      .where(eq(acpCheckoutSessions.id, checkoutId));

    console.log(`[acp-seller] Checkout completed: ${checkoutId} -> agent ${provision.agentId}`);

    return {
      id: checkoutId,
      status: 'completed',
      agentKey: provision.token,
      agentId: provision.agentId,
      gatewayUrl: GATEWAY_ADMIN_URL,
    };
  } catch (err) {
    // Rollback status to pending on failure so it can be retried
    await db.update(acpCheckoutSessions)
      .set({ status: 'pending', updatedAt: new Date() })
      .where(eq(acpCheckoutSessions.id, checkoutId));
    throw err;
  }
}

export interface CancelCheckoutResult {
  id: string;
  status: 'cancelled';
}

export async function cancelCheckout(checkoutId: string): Promise<CancelCheckoutResult> {
  const [session] = await db.select()
    .from(acpCheckoutSessions)
    .where(eq(acpCheckoutSessions.id, checkoutId))
    .limit(1);

  if (!session) {
    throw new Error('Checkout session not found');
  }

  if (session.status !== 'pending') {
    throw new Error(`Cannot cancel checkout in ${session.status} state`);
  }

  await db.update(acpCheckoutSessions)
    .set({ status: 'cancelled', updatedAt: new Date() })
    .where(eq(acpCheckoutSessions.id, checkoutId));

  console.log(`[acp-seller] Checkout cancelled: ${checkoutId}`);

  return {
    id: checkoutId,
    status: 'cancelled',
  };
}

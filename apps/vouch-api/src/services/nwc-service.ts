// NWC Service — Nostr Wallet Connect (NIP-47) for non-custodial staking.
// Users pre-authorize the platform via NWC budget allocation.
// Stake lock = NWC budget authorization. Funds stay in user's wallet.
// On slash: platform creates invoice → charges user via NWC pay_invoice.
// On yield: platform sends make_invoice via NWC → user wallet creates invoice → platform pays.

import { eq, and } from 'drizzle-orm';
import { db, nwcConnections } from '@percival/vouch-db';
import { createInvoice, payInvoice } from './albyhub-service';

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '';

// ── Encryption (AES-256-GCM for NWC connection strings at rest) ──

async function getEncryptionKey(): Promise<CryptoKey> {
  if (!ENCRYPTION_KEY || ENCRYPTION_KEY.length !== 64) {
    throw new Error('ENCRYPTION_KEY must be a 64-char hex string (32 bytes)');
  }
  const keyBytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    keyBytes[i] = parseInt(ENCRYPTION_KEY.slice(i * 2, i * 2 + 2), 16);
  }
  return crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function encrypt(plaintext: string): Promise<string> {
  const key = await getEncryptionKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
  // Format: base64(iv + ciphertext)
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return Buffer.from(combined).toString('base64');
}

async function decrypt(encryptedBase64: string): Promise<string> {
  const key = await getEncryptionKey();
  const combined = Buffer.from(encryptedBase64, 'base64');
  const iv = combined.subarray(0, 12);
  const ciphertext = combined.subarray(12);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  return new TextDecoder().decode(plaintext);
}

// ── NWC Protocol (NIP-47 via nostr: URI) ──

/**
 * Parse an NWC connection string (nostr+walletconnect://...) to extract relay and secret.
 */
function parseNwcUri(connectionString: string): {
  walletPubkey: string;
  relayUrl: string;
  secret: string;
} {
  // Format: nostr+walletconnect://<pubkey>?relay=<url>&secret=<hex>
  const url = new URL(connectionString);
  const walletPubkey = url.hostname || url.pathname.replace('//', '');
  const relayUrl = url.searchParams.get('relay');
  const secret = url.searchParams.get('secret');

  if (!walletPubkey) throw new Error('Invalid NWC URI: missing wallet pubkey');
  if (!relayUrl) throw new Error('Invalid NWC URI: missing relay URL');
  if (!secret) throw new Error('Invalid NWC URI: missing secret');

  return { walletPubkey, relayUrl, secret };
}

/**
 * Send an NWC request to a user's wallet and wait for response.
 * Uses NIP-47 event kinds (23194 request, 23195 response).
 */
async function nwcRequest(
  connectionString: string,
  method: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { walletPubkey, relayUrl, secret } = parseNwcUri(connectionString);

  // Use @getalby/sdk NWC client for protocol handling
  // Lazy import to avoid loading unless needed
  const { nwc } = await import('@getalby/sdk');

  const client = new nwc.NWCClient({
    nostrWalletConnectUrl: connectionString,
  });

  try {
    // Route to the appropriate NWC method
    switch (method) {
      case 'get_info': {
        const info = await client.getInfo();
        return info as unknown as Record<string, unknown>;
      }
      case 'get_balance': {
        const balance = await client.getBalance();
        return balance as unknown as Record<string, unknown>;
      }
      case 'pay_invoice': {
        const result = await client.payInvoice({
          invoice: params.invoice as string,
        });
        return result as unknown as Record<string, unknown>;
      }
      case 'make_invoice': {
        const result = await client.makeInvoice({
          amount: params.amount as number, // millisats
          description: params.description as string,
        });
        return result as unknown as Record<string, unknown>;
      }
      default:
        throw new Error(`Unsupported NWC method: ${method}`);
    }
  } finally {
    client.close();
  }
}

// ── Stake Lock Operations ──

/**
 * Store a new NWC connection for staking.
 * The NWC budget authorization IS the stake lock — no Lightning payment needed.
 * @returns Connection ID
 */
export async function createStakeLock(
  userNpub: string,
  connectionString: string,
  budgetSats: number,
): Promise<string> {
  // Validate the connection by checking it works
  try {
    const info = await nwcRequest(connectionString, 'get_info', {});
    console.log(`[nwc] Verified connection for ${userNpub}:`, info);
  } catch (err) {
    throw new Error(`NWC connection verification failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Parse to extract methods (for audit trail)
  const { walletPubkey } = parseNwcUri(connectionString);

  // Encrypt connection string before storage
  const encryptedConnection = await encrypt(connectionString);

  const [row] = await db
    .insert(nwcConnections)
    .values({
      userNpub,
      connectionString: encryptedConnection,
      budgetSats,
      spentSats: 0,
      methodsAuthorized: ['pay_invoice', 'make_invoice', 'get_balance', 'get_info'],
      walletPubkey,
      status: 'active',
    })
    .returning({ id: nwcConnections.id });

  console.log(`[nwc] Created stake lock for ${userNpub}: ${budgetSats} sats budget, connection ${row!.id}`);
  return row!.id;
}

/**
 * Verify that an NWC stake lock is still valid.
 * Checks: connection active, budget sufficient, wallet responsive.
 */
export async function verifyStakeLock(connectionId: string): Promise<{
  valid: boolean;
  budgetSats: number;
  spentSats: number;
  remainingSats: number;
}> {
  const [conn] = await db
    .select()
    .from(nwcConnections)
    .where(and(eq(nwcConnections.id, connectionId), eq(nwcConnections.status, 'active')))
    .limit(1);

  if (!conn) {
    return { valid: false, budgetSats: 0, spentSats: 0, remainingSats: 0 };
  }

  const remainingSats = conn.budgetSats - conn.spentSats;

  // Optionally verify wallet is still responsive
  try {
    const decrypted = await decrypt(conn.connectionString);
    await nwcRequest(decrypted, 'get_info', {});
  } catch {
    console.warn(`[nwc] Wallet for connection ${connectionId} is unresponsive`);
    return { valid: false, budgetSats: conn.budgetSats, spentSats: conn.spentSats, remainingSats };
  }

  return {
    valid: true,
    budgetSats: conn.budgetSats,
    spentSats: conn.spentSats,
    remainingSats,
  };
}

/**
 * Execute a slash — charge the user's wallet via NWC.
 * Platform creates a Lightning invoice, then sends pay_invoice via NWC to user's wallet.
 * User's wallet auto-pays within the pre-authorized budget.
 */
export async function executeSlash(
  connectionId: string,
  amountSats: number,
  reason: string,
): Promise<{ paymentHash: string; preimage: string }> {
  const [conn] = await db
    .select()
    .from(nwcConnections)
    .where(and(eq(nwcConnections.id, connectionId), eq(nwcConnections.status, 'active')))
    .limit(1);

  if (!conn) throw new Error('NWC connection not found or inactive');

  const remaining = conn.budgetSats - conn.spentSats;
  if (amountSats > remaining) {
    throw new Error(`Slash amount ${amountSats} exceeds remaining budget ${remaining} sats`);
  }

  // Step 1: Platform creates invoice to receive the slash payment
  const invoice = await createInvoice(amountSats, `Vouch slash: ${reason}`);

  // Step 2: Send pay_invoice to user's wallet via NWC
  const decrypted = await decrypt(conn.connectionString);
  const result = await nwcRequest(decrypted, 'pay_invoice', {
    invoice: invoice.paymentRequest,
  }) as { preimage?: string };

  // Step 3: Update spent amount
  await db
    .update(nwcConnections)
    .set({
      spentSats: conn.spentSats + amountSats,
    })
    .where(eq(nwcConnections.id, connectionId));

  console.log(`[nwc] Slash executed: ${amountSats} sats charged from ${conn.userNpub} for "${reason}"`);

  return {
    paymentHash: invoice.paymentHash,
    preimage: result.preimage || '',
  };
}

/**
 * Pay yield to a user — platform sends make_invoice via NWC, user's wallet creates invoice, platform pays it.
 * @returns Payment hash of the yield payout
 */
export async function payYield(
  connectionId: string,
  amountSats: number,
): Promise<{ paymentHash: string }> {
  const [conn] = await db
    .select()
    .from(nwcConnections)
    .where(and(eq(nwcConnections.id, connectionId), eq(nwcConnections.status, 'active')))
    .limit(1);

  if (!conn) throw new Error('NWC connection not found or inactive');

  // Step 1: Ask user's wallet to create an invoice via NWC make_invoice
  const decrypted = await decrypt(conn.connectionString);
  const invoiceResult = await nwcRequest(decrypted, 'make_invoice', {
    amount: amountSats * 1000, // NWC uses millisats
    description: `Vouch yield payout`,
  }) as { invoice?: string; payment_hash?: string };

  if (!invoiceResult.invoice) {
    throw new Error('User wallet did not return an invoice');
  }

  // Step 2: Platform pays the invoice from treasury
  const payment = await payInvoice(invoiceResult.invoice);

  console.log(`[nwc] Yield paid: ${amountSats} sats to ${conn.userNpub}`);

  return { paymentHash: payment.paymentHash };
}

/**
 * Revoke/deactivate an NWC connection (after unstake completes).
 */
export async function revokeConnection(connectionId: string): Promise<void> {
  await db
    .update(nwcConnections)
    .set({ status: 'revoked' })
    .where(eq(nwcConnections.id, connectionId));

  console.log(`[nwc] Connection ${connectionId} revoked`);
}

/**
 * Get active NWC connection for a user.
 */
export async function getActiveConnection(userNpub: string): Promise<{
  id: string;
  budgetSats: number;
  spentSats: number;
  status: string;
  createdAt: Date;
} | null> {
  const [conn] = await db
    .select({
      id: nwcConnections.id,
      budgetSats: nwcConnections.budgetSats,
      spentSats: nwcConnections.spentSats,
      status: nwcConnections.status,
      createdAt: nwcConnections.createdAt,
    })
    .from(nwcConnections)
    .where(and(eq(nwcConnections.userNpub, userNpub), eq(nwcConnections.status, 'active')))
    .limit(1);

  return conn ?? null;
}

// Alby Hub Service — wraps Alby Hub REST API for platform treasury operations.
// Replaces LNbits for all platform-side Lightning wallet management.
// All calls go through albyhubRequest() with retry logic.

const ALBY_HUB_URL = process.env.ALBY_HUB_URL || 'http://localhost:8080';
const ALBY_HUB_JWT = process.env.ALBY_HUB_JWT || '';

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 500;

// ── Types ──

export interface AlbyInvoice {
  paymentHash: string;
  paymentRequest: string;
}

export interface AlbyPayment {
  paymentHash: string;
  preimage: string;
}

export interface AlbyNodeInfo {
  alias: string;
  pubkey: string;
  network: string;
  blockHeight: number;
}

export interface AlbyBalance {
  balanceSats: number;
}

// ── HTTP Helper with Retry ──

async function albyhubRequest<T>(
  path: string,
  options: {
    method?: string;
    body?: Record<string, unknown>;
  } = {},
): Promise<T> {
  const { method = 'GET', body } = options;

  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (ALBY_HUB_JWT) {
        headers['Authorization'] = `Bearer ${ALBY_HUB_JWT}`;
      }

      const res = await fetch(`${ALBY_HUB_URL}${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });

      if (res.status === 429) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt);
        console.warn(`[albyhub] Rate limited (429), retrying in ${delay}ms...`);
        await sleep(delay);
        continue;
      }

      if (!res.ok) {
        const text = await res.text().catch(() => 'unknown error');
        throw new Error(`Alby Hub API error ${res.status}: ${text}`);
      }

      return (await res.json()) as T;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (attempt < MAX_RETRIES - 1) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt);
        console.warn(`[albyhub] Request failed (attempt ${attempt + 1}/${MAX_RETRIES}), retrying in ${delay}ms:`, lastError.message);
        await sleep(delay);
      }
    }
  }

  throw lastError ?? new Error('Alby Hub request failed after retries');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Invoice Management ──

/**
 * Create a Lightning invoice on the platform treasury node.
 * Used when the platform needs to receive payment (e.g., slash charges via NWC).
 */
export async function createInvoice(amountSats: number, memo: string): Promise<AlbyInvoice> {
  const result = await albyhubRequest<{
    payment_hash: string;
    payment_request: string;
  }>('/api/invoices', {
    method: 'POST',
    body: {
      amount: amountSats * 1000, // Alby Hub uses millisats
      description: memo,
    },
  });

  return {
    paymentHash: result.payment_hash,
    paymentRequest: result.payment_request,
  };
}

/**
 * Pay a BOLT11 Lightning invoice from the platform treasury.
 * Used for yield payouts sent to user wallets via NWC make_invoice.
 */
export async function payInvoice(bolt11: string): Promise<AlbyPayment> {
  const result = await albyhubRequest<{
    payment_hash: string;
    preimage: string;
  }>('/api/payments/bolt11', {
    method: 'POST',
    body: { invoice: bolt11 },
  });

  return {
    paymentHash: result.payment_hash,
    preimage: result.preimage,
  };
}

// ── Balance ──

/**
 * Get the platform treasury balance in sats.
 */
export async function getBalance(): Promise<number> {
  const result = await albyhubRequest<{
    balance: number; // millisats
  }>('/api/balance');

  return Math.floor(result.balance / 1000);
}

// ── Node Info ──

/**
 * Get info about the platform's Lightning node.
 */
export async function getNodeInfo(): Promise<AlbyNodeInfo> {
  const result = await albyhubRequest<{
    alias: string;
    identity_pubkey: string;
    network: string;
    block_height: number;
  }>('/api/node/info');

  return {
    alias: result.alias,
    pubkey: result.identity_pubkey,
    network: result.network,
    blockHeight: result.block_height,
  };
}

// ── Health Check ──

/**
 * Check if Alby Hub is reachable and healthy.
 */
export async function healthCheck(): Promise<boolean> {
  try {
    const res = await fetch(`${ALBY_HUB_URL}/api/health`, {
      signal: AbortSignal.timeout(5000),
      headers: ALBY_HUB_JWT ? { 'Authorization': `Bearer ${ALBY_HUB_JWT}` } : {},
    });
    return res.ok;
  } catch {
    return false;
  }
}

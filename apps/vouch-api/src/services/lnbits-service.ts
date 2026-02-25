// LNbits Service — wraps LNbits REST API for wallet management and Lightning payments.
// All calls go through lnbitsRequest() with retry logic and error handling.

const LNBITS_URL = process.env.LNBITS_URL || 'http://localhost:5000';
const LNBITS_ADMIN_KEY = process.env.LNBITS_ADMIN_KEY || '';
const LNBITS_SUPER_USER = process.env.LNBITS_SUPER_USER || '';
const WEBHOOK_BASE_URL = process.env.VOUCH_WEBHOOK_BASE_URL || 'http://localhost:3601';

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 500;

// ── Types ──

export interface LnbitsWallet {
  id: string;
  adminKey: string;
  invoiceKey: string;
  balance: number;
}

export interface LnbitsInvoice {
  paymentHash: string;
  paymentRequest: string;
}

export interface LnbitsPayment {
  paymentHash: string;
}

export interface LnbitsPaymentStatus {
  paid: boolean;
  pending: boolean;
  amount: number;
  memo: string;
}

// ── HTTP Helper with Retry ──

async function lnbitsRequest<T>(
  path: string,
  options: {
    method?: string;
    apiKey?: string;
    body?: Record<string, unknown>;
  } = {},
): Promise<T> {
  const { method = 'GET', apiKey, body } = options;

  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (apiKey) {
        headers['X-Api-Key'] = apiKey;
      }

      const res = await fetch(`${LNBITS_URL}${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });

      if (res.status === 429) {
        // Rate limited — wait and retry
        const delay = BASE_DELAY_MS * Math.pow(2, attempt);
        console.warn(`[lnbits] Rate limited (429), retrying in ${delay}ms...`);
        await sleep(delay);
        continue;
      }

      if (!res.ok) {
        const text = await res.text().catch(() => 'unknown error');
        throw new Error(`LNbits API error ${res.status}: ${text}`);
      }

      return (await res.json()) as T;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (attempt < MAX_RETRIES - 1) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt);
        console.warn(`[lnbits] Request failed (attempt ${attempt + 1}/${MAX_RETRIES}), retrying in ${delay}ms:`, lastError.message);
        await sleep(delay);
      }
    }
  }

  throw lastError ?? new Error('LNbits request failed after retries');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Wallet Management ──

/**
 * Create a new user with a wallet in LNbits.
 * Used when creating staking pools (one wallet per pool) and for treasury.
 */
export async function createUserWithWallet(
  name: string,
  externalId?: string,
): Promise<LnbitsWallet> {
  // LNbits /usermanager API to create user + wallet
  const result = await lnbitsRequest<{
    id: string;
    name: string;
    admin: string;
    wallets: Array<{
      id: string;
      name: string;
      adminkey: string;
      inkey: string;
      balance_msat: number;
    }>;
  }>('/usermanager/api/v1/users', {
    method: 'POST',
    apiKey: LNBITS_ADMIN_KEY,
    body: {
      user_name: name,
      wallet_name: `${name}-wallet`,
      ...(externalId ? { extra: { external_id: externalId } } : {}),
    },
  });

  const wallet = result.wallets[0];
  if (!wallet) {
    throw new Error('LNbits created user but no wallet was returned');
  }

  return {
    id: wallet.id,
    adminKey: wallet.adminkey,
    invoiceKey: wallet.inkey,
    balance: Math.floor(wallet.balance_msat / 1000),
  };
}

// ── Invoice Management ──

/**
 * Create a Lightning invoice (payment request) for receiving funds.
 * Optionally attach a webhook URL for payment notifications.
 */
export async function createInvoice(
  invoiceKey: string,
  amountSats: number,
  memo: string,
  webhookPath?: string,
): Promise<LnbitsInvoice> {
  const body: Record<string, unknown> = {
    out: false,
    amount: amountSats,
    memo,
  };

  if (webhookPath) {
    body.webhook = `${WEBHOOK_BASE_URL}${webhookPath}`;
  }

  const result = await lnbitsRequest<{
    payment_hash: string;
    payment_request: string;
  }>('/api/v1/payments', {
    method: 'POST',
    apiKey: invoiceKey,
    body,
  });

  return {
    paymentHash: result.payment_hash,
    paymentRequest: result.payment_request,
  };
}

/**
 * Pay a Lightning invoice (bolt11) from a wallet.
 */
export async function payInvoice(
  adminKey: string,
  bolt11: string,
): Promise<LnbitsPayment> {
  const result = await lnbitsRequest<{
    payment_hash: string;
  }>('/api/v1/payments', {
    method: 'POST',
    apiKey: adminKey,
    body: {
      out: true,
      bolt11,
    },
  });

  return {
    paymentHash: result.payment_hash,
  };
}

/**
 * Internal transfer between two LNbits wallets on the same instance.
 * Creates an invoice on the destination wallet, then pays it from the source.
 * LNbits auto-detects same-instance wallets — transfer is instant and free.
 */
export async function internalTransfer(
  fromAdminKey: string,
  toInvoiceKey: string,
  amountSats: number,
  memo: string,
): Promise<LnbitsPayment> {
  // Step 1: Create invoice on destination wallet
  const invoice = await createInvoice(toInvoiceKey, amountSats, memo);

  // Step 2: Pay from source wallet (instant for same-instance)
  return await payInvoice(fromAdminKey, invoice.paymentRequest);
}

// ── Payment Status ──

/**
 * Check the status of a payment by its hash.
 */
export async function getPaymentStatus(
  apiKey: string,
  paymentHash: string,
): Promise<LnbitsPaymentStatus> {
  const result = await lnbitsRequest<{
    paid: boolean;
    pending: boolean;
    amount: number;
    memo: string;
  }>(`/api/v1/payments/${paymentHash}`, {
    apiKey,
  });

  return {
    paid: result.paid,
    pending: result.pending,
    amount: Math.abs(Math.floor(result.amount / 1000)), // msat → sats
    memo: result.memo,
  };
}

// ── Wallet Balance ──

/**
 * Get wallet balance in sats.
 */
export async function getWalletBalance(apiKey: string): Promise<number> {
  const result = await lnbitsRequest<{
    balance: number; // in msats
  }>('/api/v1/wallet', {
    apiKey,
  });

  return Math.floor(result.balance / 1000);
}

// ── Health Check ──

/**
 * Check if LNbits is reachable and healthy.
 */
export async function healthCheck(): Promise<boolean> {
  try {
    const res = await fetch(`${LNBITS_URL}/api/v1/health`, {
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

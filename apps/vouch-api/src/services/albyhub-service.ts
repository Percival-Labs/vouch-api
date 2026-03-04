// Alby Hub Service — wraps NWC (Nostr Wallet Connect) for platform treasury operations.
// Uses the stable NWC protocol (NIP-47) per Alby's recommendation.
// Single env var: NWC_URL (the nostr+walletconnect://... connection string).
// All calls go through getNwcClient() with per-request client lifecycle.

const NWC_URL = process.env.NWC_URL || '';

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

// ── NWC Client Helper ──

type NWCClient = {
  getInfo(): Promise<Record<string, unknown>>;
  getBalance(): Promise<{ balance: number }>;
  makeInvoice(params: { amount: number; description?: string }): Promise<Record<string, unknown>>;
  payInvoice(params: { invoice: string }): Promise<{ preimage: string }>;
  close(): void;
};

/**
 * Create a fresh NWC client for the platform treasury.
 * Caller must call client.close() when done.
 */
async function createNwcClient(): Promise<NWCClient> {
  if (!NWC_URL) {
    throw new Error('NWC_URL not configured — set the Nostr Wallet Connect URL for the platform treasury');
  }

  const { nwc } = await import('@getalby/sdk');
  return new nwc.NWCClient({
    nostrWalletConnectUrl: NWC_URL,
  });
}

/**
 * Execute an NWC operation with automatic client lifecycle management.
 * Creates a client, runs the operation, and closes the client.
 */
async function withNwcClient<T>(operation: (client: NWCClient) => Promise<T>): Promise<T> {
  const client = await createNwcClient();
  try {
    return await operation(client);
  } finally {
    client.close();
  }
}

// ── Invoice Management ──

/**
 * Create a Lightning invoice on the platform treasury node.
 * Used when the platform needs to receive payment (e.g., slash charges via NWC).
 */
export async function createInvoice(amountSats: number, memo: string): Promise<AlbyInvoice> {
  return withNwcClient(async (client) => {
    const result = await client.makeInvoice({
      amount: amountSats * 1000, // NWC uses millisats
      description: memo,
    });

    return {
      paymentHash: (result as Record<string, unknown>).payment_hash as string,
      paymentRequest: (result as Record<string, unknown>).invoice as string,
    };
  });
}

/**
 * Pay a BOLT11 Lightning invoice from the platform treasury.
 * Used for yield payouts sent to user wallets via NWC make_invoice.
 */
export async function payInvoice(bolt11: string): Promise<AlbyPayment> {
  return withNwcClient(async (client) => {
    const result = await client.payInvoice({ invoice: bolt11 });

    return {
      paymentHash: '', // NWC pay_invoice response only includes preimage
      preimage: result.preimage,
    };
  });
}

// ── Balance ──

/**
 * Get the platform treasury balance in sats.
 */
export async function getBalance(): Promise<number> {
  return withNwcClient(async (client) => {
    const result = await client.getBalance();
    return Math.floor(result.balance / 1000); // NWC returns millisats
  });
}

// ── Node Info ──

/**
 * Get info about the platform's Lightning node.
 */
export async function getNodeInfo(): Promise<AlbyNodeInfo> {
  return withNwcClient(async (client) => {
    const result = await client.getInfo();

    return {
      alias: (result.alias as string) || '',
      pubkey: (result.pubkey as string) || '',
      network: (result.network as string) || '',
      blockHeight: (result.block_height as number) || 0,
    };
  });
}

// ── Invoice Lookup (H2/M6 fix: verify payment before crediting) ──

/**
 * Look up a Lightning invoice by payment hash to verify settlement.
 * Returns the invoice status and amount if found.
 * Used to verify skill purchases and credit deposits were actually paid.
 */
export async function lookupInvoice(paymentHash: string): Promise<{
  settled: boolean;
  amountSats: number;
} | null> {
  try {
    return await withNwcClient(async (client) => {
      // NWC lookup_invoice method (NIP-47)
      const result = await (client as Record<string, Function>).lookupInvoice({
        payment_hash: paymentHash,
      }) as Record<string, unknown>;

      if (!result) return null;

      const settled = result.settled_at != null || result.preimage != null;
      const amountMsats = (result.amount as number) || 0;
      return {
        settled,
        amountSats: Math.floor(amountMsats / 1000),
      };
    });
  } catch (err) {
    // If NWC doesn't support lookup_invoice or invoice not found, return null
    console.warn('[albyhub] lookupInvoice failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

// ── Health Check ──

/**
 * Check if the platform treasury is reachable via NWC.
 */
export async function healthCheck(): Promise<boolean> {
  if (!NWC_URL) return false;

  try {
    await withNwcClient(async (client) => {
      await client.getInfo();
    });
    return true;
  } catch {
    return false;
  }
}

// Price Service — BTC/USD price tracking for display purposes only.
// All internal accounting stays in sats. This is for reporting/UI.
// Uses CoinGecko free API with 15-minute cache.

import { db, btcPriceSnapshots } from '@percival/vouch-db';
import { sql } from 'drizzle-orm';

// ── Cache ──

let cachedPrice: { priceUsd: number; fetchedAt: number } | null = null;
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

// ── Public API ──

/**
 * Get current BTC/USD price. Cached for 15 minutes.
 * Returns null if price unavailable (API down, etc).
 */
export async function getCurrentBtcPrice(): Promise<number | null> {
  if (cachedPrice && Date.now() - cachedPrice.fetchedAt < CACHE_TTL_MS) {
    return cachedPrice.priceUsd;
  }

  try {
    const price = await fetchBtcPrice();
    if (price !== null) {
      cachedPrice = { priceUsd: price, fetchedAt: Date.now() };
    }
    return price;
  } catch (err) {
    console.warn('[price] Failed to fetch BTC price:', err instanceof Error ? err.message : err);
    // Return stale cache if available
    return cachedPrice?.priceUsd ?? null;
  }
}

/**
 * Convert sats to USD using current price.
 * Returns null if price unavailable.
 */
export async function satsToUsd(sats: number): Promise<number | null> {
  const price = await getCurrentBtcPrice();
  if (price === null) return null;
  return (sats / 100_000_000) * price;
}

/**
 * Convert USD to sats using current price.
 * Returns null if price unavailable.
 */
export async function usdToSats(usd: number): Promise<number | null> {
  const price = await getCurrentBtcPrice();
  if (price === null) return null;
  return Math.round((usd / price) * 100_000_000);
}

/**
 * Take a BTC price snapshot for historical tracking.
 * Call daily or on each yield distribution.
 */
export async function takePriceSnapshot(reason: string = 'scheduled'): Promise<void> {
  const price = await getCurrentBtcPrice();
  if (price === null) {
    console.warn('[price] Cannot take snapshot — price unavailable');
    return;
  }

  await db.insert(btcPriceSnapshots).values({
    priceUsd: price.toString(), // decimal column stored as string
    source: 'coingecko',
    reason,
  });

  console.log(`[price] Snapshot taken: $${price.toLocaleString()} (${reason})`);
}

/**
 * Get historical price snapshots for charting.
 */
export async function getPriceHistory(limit = 90): Promise<Array<{
  priceUsd: number;
  capturedAt: Date;
}>> {
  const rows = await db
    .select({
      priceUsd: btcPriceSnapshots.priceUsd,
      capturedAt: btcPriceSnapshots.capturedAt,
    })
    .from(btcPriceSnapshots)
    .orderBy(sql`${btcPriceSnapshots.capturedAt} DESC`)
    .limit(limit);

  return rows.map((r) => ({
    priceUsd: parseFloat(r.priceUsd),
    capturedAt: r.capturedAt,
  }));
}

// ── Internal ──

async function fetchBtcPrice(): Promise<number | null> {
  try {
    const res = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd',
      { signal: AbortSignal.timeout(10_000) },
    );

    if (!res.ok) {
      console.warn(`[price] CoinGecko returned ${res.status}`);
      return null;
    }

    const data = (await res.json()) as { bitcoin?: { usd?: number } };
    const price = data?.bitcoin?.usd;

    if (typeof price !== 'number' || price <= 0) {
      console.warn('[price] Invalid price data from CoinGecko:', data);
      return null;
    }

    return price;
  } catch (err) {
    console.warn('[price] CoinGecko fetch failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

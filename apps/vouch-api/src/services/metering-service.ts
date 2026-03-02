// Metering Service — usage recording, cost calculation, and activity fee tracking.
// Called by the gateway after each inference request.

import { eq, sql } from 'drizzle-orm';
import { db, usageRecords, modelPricing } from '@percival/vouch-db';
import { recordActivityFee } from './staking-service';
import { debit, debitBatch } from './credit-service';
import { ulid } from 'ulid';

// ── Constants ──

const ACTIVITY_FEE_BPS = 100; // 1% of inference cost → staking yield pool
const SATS_PER_BTC = 100_000_000;

// ── Types ──

export interface UsageReport {
  userNpub?: string;      // null for private mode
  batchHash?: string;     // null for transparent mode
  tokenHash?: string;     // privacy token hash (for tracking)
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
}

export interface PricingEntry {
  modelId: string;
  provider: string;
  inputCostPerMillion: number;
  outputCostPerMillion: number;
  plInputPricePerMillion: number;
  plOutputPricePerMillion: number;
  marginBps: number;
}

export interface CostResult {
  costSats: number;       // what we charge the user
  rawCostSats: number;    // what the provider charges us
  marginSats: number;     // spread
}

// ── Pricing Cache ──

let pricingCache: Map<string, PricingEntry> = new Map();
let pricingCacheAge = 0;
const PRICING_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

async function loadPricing(): Promise<Map<string, PricingEntry>> {
  if (Date.now() - pricingCacheAge < PRICING_CACHE_TTL_MS && pricingCache.size > 0) {
    return pricingCache;
  }

  const rows = await db.select().from(modelPricing)
    .where(eq(modelPricing.isActive, true));

  const cache = new Map<string, PricingEntry>();
  for (const row of rows) {
    cache.set(row.modelId, {
      modelId: row.modelId,
      provider: row.provider,
      inputCostPerMillion: Number(row.inputCostPerMillion),
      outputCostPerMillion: Number(row.outputCostPerMillion),
      plInputPricePerMillion: Number(row.plInputPricePerMillion),
      plOutputPricePerMillion: Number(row.plOutputPricePerMillion),
      marginBps: row.marginBps,
    });
  }

  pricingCache = cache;
  pricingCacheAge = Date.now();

  return cache;
}

// ── BTC Price ──

let btcPriceUsd = 85000; // Fallback default
let btcPriceAge = 0;
const BTC_PRICE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function getBtcPriceUsd(): Promise<number> {
  if (Date.now() - btcPriceAge < BTC_PRICE_CACHE_TTL_MS) {
    return btcPriceUsd;
  }

  try {
    // Try to get from our existing price snapshots table
    const result = await db.execute(
      sql`SELECT price_usd FROM btc_price_snapshots ORDER BY created_at DESC LIMIT 1`,
    );
    const rows = (result as any)?.rows ?? result;
    const snapshot = Array.isArray(rows) ? rows[0] : null;
    if (snapshot && snapshot.price_usd) {
      btcPriceUsd = Number(snapshot.price_usd);
      btcPriceAge = Date.now();
    }
  } catch {
    // Use cached/default value
  }

  return btcPriceUsd;
}

/**
 * Convert USD to sats.
 */
async function usdToSats(usd: number): Promise<number> {
  const btcPrice = await getBtcPriceUsd();
  return Math.ceil((usd / btcPrice) * SATS_PER_BTC);
}

// ── Public API ──

/**
 * Calculate cost in sats for a given model and token count.
 */
export async function calculateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
): Promise<CostResult> {
  const pricing = await loadPricing();
  const entry = pricing.get(model);

  if (!entry) {
    // Unknown model — use a conservative default (Sonnet-tier pricing)
    const defaultCostUsd = (inputTokens * 3.0 + outputTokens * 15.0) / 1_000_000;
    const defaultPriceUsd = defaultCostUsd * 1.15; // 15% margin
    const costSats = await usdToSats(defaultPriceUsd);
    const rawCostSats = await usdToSats(defaultCostUsd);

    return {
      costSats,
      rawCostSats,
      marginSats: costSats - rawCostSats,
    };
  }

  const rawCostUsd = (inputTokens * entry.inputCostPerMillion + outputTokens * entry.outputCostPerMillion) / 1_000_000;
  const plPriceUsd = (inputTokens * entry.plInputPricePerMillion + outputTokens * entry.plOutputPricePerMillion) / 1_000_000;

  const costSats = await usdToSats(plPriceUsd);
  const rawCostSats = await usdToSats(rawCostUsd);

  return {
    costSats,
    rawCostSats,
    marginSats: costSats - rawCostSats,
  };
}

/**
 * Record usage from the gateway and process billing.
 * Handles both transparent (credit balance) and private (batch) modes.
 */
export async function recordUsage(report: UsageReport): Promise<{ usageRecordId: string; cost: CostResult }> {
  const cost = await calculateCost(report.model, report.inputTokens, report.outputTokens);

  const usageRecordId = ulid();

  // Insert usage record
  await db.insert(usageRecords).values({
    id: usageRecordId,
    userNpub: report.userNpub || null,
    batchHash: report.batchHash || null,
    model: report.model,
    provider: report.provider,
    inputTokens: report.inputTokens,
    outputTokens: report.outputTokens,
    costSats: cost.costSats,
    rawCostSats: cost.rawCostSats,
    marginSats: cost.marginSats,
  });

  // Debit based on mode
  if (report.userNpub) {
    // Transparent mode: debit credit balance
    await debit(report.userNpub, cost.costSats, usageRecordId);
  } else if (report.batchHash) {
    // Private mode: debit batch budget
    await debitBatch(report.batchHash, cost.costSats);
  }

  // Record 1% activity fee for staking yield (non-blocking)
  const feeSats = Math.ceil(cost.costSats * ACTIVITY_FEE_BPS / 10000);
  if (feeSats > 0) {
    try {
      await recordActivityFee('inference-proxy', 'inference', cost.costSats);
    } catch (e) {
      console.error('[metering] Activity fee recording failed (non-blocking):', e);
    }
  }

  return { usageRecordId, cost };
}

/**
 * Get the full pricing table (for public endpoint + gateway caching).
 */
export async function getPricingTable(): Promise<PricingEntry[]> {
  const pricing = await loadPricing();
  return Array.from(pricing.values());
}

/**
 * Invalidate the pricing cache (after admin updates).
 */
export function invalidatePricingCache(): void {
  pricingCacheAge = 0;
}

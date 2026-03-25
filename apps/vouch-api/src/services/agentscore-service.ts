/**
 * AgentScore External Trust Provider Socket
 *
 * Same pattern as wot-service.ts — env-gated, Postgres-cached, graceful degradation.
 * AgentScore provides 5-dimension reputation scores for Moltbook agents.
 * We use it as an optional signal feeding into Vouch's composite trust score.
 *
 * Dimensions (each 0-20, total 0-100):
 *   identity, activity, reputation, workHistory, consistency
 *
 * Integration points in trust.ts:
 *   - verificationBonus: derived from identity + consistency
 *   - communityComponent: derived from activity + reputation
 */

import { db, agentscoreCache } from '@percival/vouch-db';
import { and, eq, gte } from 'drizzle-orm';

// ── Types ──

interface AgentScoreResponse {
  score?: number;
  dimensions?: {
    identity?: number;
    activity?: number;
    reputation?: number;
    workHistory?: number;
    consistency?: number;
  };
  found?: boolean;
  agentName?: string;
}

type AgentScoreCacheRow = typeof agentscoreCache.$inferSelect;

export interface AgentScoreSnapshot {
  agentName: string;
  score: number; // 0-100
  identity: number; // 0-20
  activity: number; // 0-20
  reputation: number; // 0-20
  workHistory: number; // 0-20
  consistency: number; // 0-20
  found: boolean;
  fetchedAt: Date;
  partial: boolean;
}

// ── Config ──

const DEFAULT_BASE_URL = 'https://agentscores.xyz';
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_CACHE_TTL_HOURS = 24;
const DEFAULT_VERIFICATION_BONUS_MAX = 100;
const DEFAULT_COMMUNITY_WEIGHT = 0.20;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function parseBoolEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const normalized = value.toLowerCase().trim();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes') return true;
  if (normalized === '0' || normalized === 'false' || normalized === 'no') return false;
  return fallback;
}

function parseIntEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) return fallback;
  return clamp(parsed, min, max);
}

function parseFloatEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseFloat(raw);
  if (Number.isNaN(parsed)) return fallback;
  return clamp(parsed, min, max);
}

function agentscoreEnabled(): boolean {
  return parseBoolEnv('AGENTSCORE_ENABLED', false);
}

function agentscoreBaseUrl(): string {
  return process.env.AGENTSCORE_BASE_URL?.trim() || DEFAULT_BASE_URL;
}

function agentscoreTimeoutMs(): number {
  return parseIntEnv('AGENTSCORE_TIMEOUT_MS', DEFAULT_TIMEOUT_MS, 250, 10000);
}

function agentscoreCacheTtlHours(): number {
  return parseIntEnv('AGENTSCORE_CACHE_TTL_HOURS', DEFAULT_CACHE_TTL_HOURS, 1, 168);
}

function agentscoreCommunityWeight(): number {
  return parseFloatEnv('AGENTSCORE_COMMUNITY_WEIGHT', DEFAULT_COMMUNITY_WEIGHT, 0, 1);
}

function agentscoreVerificationBonusMax(): number {
  return parseIntEnv('AGENTSCORE_VERIFICATION_BONUS_MAX', DEFAULT_VERIFICATION_BONUS_MAX, 0, 300);
}

// ── In-flight dedup ──

const inflightRequests = new Map<string, Promise<AgentScoreSnapshot | null>>();

function toErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// ── Cache mapping ──

function mapRowToSnapshot(row: AgentScoreCacheRow): AgentScoreSnapshot {
  return {
    agentName: row.agentName,
    score: clamp(row.score ?? 0, 0, 100),
    identity: clamp(row.identity ?? 0, 0, 20),
    activity: clamp(row.activity ?? 0, 0, 20),
    reputation: clamp(row.reputation ?? 0, 0, 20),
    workHistory: clamp(row.workHistory ?? 0, 0, 20),
    consistency: clamp(row.consistency ?? 0, 0, 20),
    found: row.found ?? false,
    fetchedAt: row.fetchedAt,
    partial: false,
  };
}

// ── Fetch ──

async function fetchAgentScore(agentName: string, timeoutMs: number): Promise<AgentScoreResponse> {
  const url = new URL('/api/score', agentscoreBaseUrl());
  url.searchParams.set('name', agentName);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} from ${url.pathname}`);
    }
    return await res.json() as AgentScoreResponse;
  } finally {
    clearTimeout(timer);
  }
}

// ── Trust blending functions ──

/**
 * Compute a verification bonus (0-max) from AgentScore dimensions.
 * Identity + consistency are the strongest signals for verification.
 */
export function computeAgentScoreVerificationBonus(snapshot: AgentScoreSnapshot): number {
  if (!snapshot.found) return 0;

  const maxBonus = agentscoreVerificationBonusMax();
  // identity (0-20) + consistency (0-20) = 0-40, normalize to 0-1
  const identityStrength = (snapshot.identity + snapshot.consistency) / 40;
  // Scale by overall score confidence
  const scoreConfidence = snapshot.score / 100;

  return clamp(Math.round(maxBonus * identityStrength * scoreConfidence), 0, maxBonus);
}

/**
 * Blend local community score with AgentScore's activity + reputation dimensions.
 * Same pattern as blendCommunityWithWot.
 */
export function blendCommunityWithAgentScore(localCommunity: number, snapshot: AgentScoreSnapshot): number {
  if (!snapshot.found) return localCommunity;

  const local = clamp(Math.round(localCommunity), 0, 1000);
  // activity (0-20) + reputation (0-20) = 0-40, normalize to 0-1000
  const agentScoreCommunity = clamp(Math.round(((snapshot.activity + snapshot.reputation) / 40) * 1000), 0, 1000);
  const weight = agentscoreCommunityWeight();

  return clamp(Math.round((local * (1 - weight)) + (agentScoreCommunity * weight)), 0, 1000);
}

// ── Main entry ──

/**
 * Get an AgentScore snapshot for a Moltbook agent name.
 * Returns null if disabled, agent not found, or all fetches fail.
 * Uses Postgres cache with TTL, in-flight dedup, stale fallback.
 */
export async function getAgentScoreSnapshot(agentName: string): Promise<AgentScoreSnapshot | null> {
  if (!agentscoreEnabled()) return null;

  const normalizedName = agentName.trim().toLowerCase();
  if (!normalizedName || normalizedName.length > 100) return null;

  const existing = inflightRequests.get(normalizedName);
  if (existing) return existing;

  const promise = getAgentScoreSnapshotInternal(normalizedName);
  inflightRequests.set(normalizedName, promise);
  try {
    return await promise;
  } finally {
    inflightRequests.delete(normalizedName);
  }
}

async function getAgentScoreSnapshotInternal(normalizedName: string): Promise<AgentScoreSnapshot | null> {
  const cutoff = new Date(Date.now() - (agentscoreCacheTtlHours() * 60 * 60 * 1000));

  // Check fresh cache
  const [freshCache] = await db.select()
    .from(agentscoreCache)
    .where(and(
      eq(agentscoreCache.agentName, normalizedName),
      gte(agentscoreCache.fetchedAt, cutoff),
    ))
    .limit(1);

  if (freshCache) {
    return mapRowToSnapshot(freshCache);
  }

  // Check stale cache (fallback if fetch fails)
  const [staleCache] = await db.select()
    .from(agentscoreCache)
    .where(eq(agentscoreCache.agentName, normalizedName))
    .limit(1);

  // Fetch fresh from API
  let payload: AgentScoreResponse | null = null;
  try {
    payload = await fetchAgentScore(normalizedName, agentscoreTimeoutMs());
  } catch (err) {
    console.warn(`[agentscore] fetch failed for ${normalizedName}: ${toErrorMessage(err)}`);
    if (staleCache) {
      return { ...mapRowToSnapshot(staleCache), partial: true };
    }
    return null;
  }

  if (!payload) {
    if (staleCache) {
      return { ...mapRowToSnapshot(staleCache), partial: true };
    }
    return null;
  }

  const now = new Date();
  const dims = payload.dimensions;
  const snapshot: AgentScoreSnapshot = {
    agentName: normalizedName,
    score: clamp(Math.round(payload.score ?? 0), 0, 100),
    identity: clamp(Math.round(dims?.identity ?? 0), 0, 20),
    activity: clamp(Math.round(dims?.activity ?? 0), 0, 20),
    reputation: clamp(Math.round(dims?.reputation ?? 0), 0, 20),
    workHistory: clamp(Math.round(dims?.workHistory ?? 0), 0, 20),
    consistency: clamp(Math.round(dims?.consistency ?? 0), 0, 20),
    found: payload.found ?? (payload.score !== undefined),
    fetchedAt: now,
    partial: false,
  };

  // Upsert cache
  await db.insert(agentscoreCache).values({
    agentName: snapshot.agentName,
    score: snapshot.score,
    identity: snapshot.identity,
    activity: snapshot.activity,
    reputation: snapshot.reputation,
    workHistory: snapshot.workHistory,
    consistency: snapshot.consistency,
    found: snapshot.found,
    rawPayload: payload as unknown as Record<string, unknown>,
    fetchedAt: snapshot.fetchedAt,
  }).onConflictDoUpdate({
    target: agentscoreCache.agentName,
    set: {
      score: snapshot.score,
      identity: snapshot.identity,
      activity: snapshot.activity,
      reputation: snapshot.reputation,
      workHistory: snapshot.workHistory,
      consistency: snapshot.consistency,
      found: snapshot.found,
      rawPayload: payload as unknown as Record<string, unknown>,
      fetchedAt: snapshot.fetchedAt,
    },
  });

  return snapshot;
}

// Behavioral Trace Service — MCP-T v0.2.0
// Records, queries, and scores behavioral traces for agent fidelity assessment.
// Fidelity = how closely actual behavior matches declared intent.
// This is the data layer that feeds the behavioral_fidelity scoring dimension.

import { eq, and, desc, gte } from 'drizzle-orm';
import {
  db,
  behavioralTraces,
  type ToolCallRecord,
  type ResourceAccessRecord,
  type SideEffectRecord,
} from '@percival/vouch-db';

// ── Types ──

export interface RecordBehavioralTraceParams {
  agentPubkey: string;
  contractId?: string;
  traceId: string;
  toolCalls: ToolCallRecord[];
  resourcesAccessed: ResourceAccessRecord[];
  sideEffects?: SideEffectRecord[];
  durationMs: number;
  eventId?: string;
  issuerId?: string;
}

export interface BehavioralTrace {
  id: string;
  agentPubkey: string;
  contractId: string | null;
  traceId: string;
  toolCalls: ToolCallRecord[];
  resourcesAccessed: ResourceAccessRecord[];
  sideEffects: SideEffectRecord[] | null;
  durationMs: number;
  totalToolCalls: number;
  undeclaredToolCalls: number;
  totalResources: number;
  undeclaredResources: number;
  fidelityRatio: number;
  eventId: string | null;
  issuerId: string | null;
  createdAt: Date;
}

export interface BehavioralFidelityResult {
  /** 0-1000 scale behavioral fidelity score */
  score: number;
  /** 0.0-1.0 confidence based on trace count */
  confidence: number;
  /** Number of traces used in computation */
  evidenceCount: number;
  /** Mean fidelity ratio across all traces */
  avgFidelityRatio: number;
}

// ── Helpers ──

/**
 * Compute fidelity ratio from tool call and resource access counts.
 * Ratio of declared actions to total actions. 1.0 = perfect fidelity.
 */
function computeFidelityRatio(
  totalToolCalls: number,
  undeclaredToolCalls: number,
  totalResources: number,
  undeclaredResources: number,
): number {
  const total = totalToolCalls + totalResources;
  if (total === 0) return 1.0;
  return (total - undeclaredToolCalls - undeclaredResources) / total;
}

/**
 * Estimate confidence from evidence count.
 * Uses the same curve as mcp-t-adapter.ts for consistency.
 */
function estimateConfidence(evidenceCount: number): number {
  if (evidenceCount === 0) return 0.1;
  if (evidenceCount < 5) return 0.3;
  if (evidenceCount < 20) return 0.5;
  if (evidenceCount < 50) return 0.7;
  if (evidenceCount < 200) return 0.85;
  return 0.95;
}

// ── Public API ──

/**
 * Store a new behavioral trace.
 * Computes fidelity metrics from the structured tool call and resource data.
 * Called from trust/publish when a behavior.trace event is received.
 */
export async function recordBehavioralTrace(params: RecordBehavioralTraceParams): Promise<{
  id: string;
  fidelityRatio: number;
}> {
  // FIX 5: Privacy enforcement — strip raw arguments from tool calls before storage.
  // Only arguments_hash should survive. Defense-in-depth against raw argument leakage.
  const sanitizedToolCalls = params.toolCalls.map((tc) => {
    const raw = tc as unknown as Record<string, unknown>;
    const { arguments: _args, args: _rawArgs, ...clean } = raw;
    return clean as unknown as ToolCallRecord;
  });

  const totalToolCalls = sanitizedToolCalls.length;
  const undeclaredToolCalls = sanitizedToolCalls.filter((tc) => !tc.declared).length;
  const totalResources = params.resourcesAccessed.length;
  const undeclaredResources = params.resourcesAccessed.filter((ra) => !ra.declared).length;
  const fidelityRatio = computeFidelityRatio(totalToolCalls, undeclaredToolCalls, totalResources, undeclaredResources);

  const [row] = await db.insert(behavioralTraces).values({
    agentPubkey: params.agentPubkey,
    contractId: params.contractId ?? null,
    traceId: params.traceId,
    toolCalls: sanitizedToolCalls,
    resourcesAccessed: params.resourcesAccessed,
    sideEffects: params.sideEffects ?? [],
    durationMs: params.durationMs,
    totalToolCalls,
    undeclaredToolCalls,
    totalResources,
    undeclaredResources,
    fidelityRatio,
    eventId: params.eventId ?? null,
    issuerId: params.issuerId ?? null,
  }).returning({ id: behavioralTraces.id });

  return { id: row!.id, fidelityRatio };
}

/**
 * Get behavioral traces for an agent, ordered by most recent first.
 * Used by the scoring engine to compute behavioral fidelity.
 */
export async function getTracesForAgent(
  agentPubkey: string,
  opts?: { limit?: number; after?: Date },
): Promise<BehavioralTrace[]> {
  const whereClause = opts?.after
    ? and(eq(behavioralTraces.agentPubkey, agentPubkey), gte(behavioralTraces.createdAt, opts.after))
    : eq(behavioralTraces.agentPubkey, agentPubkey);

  const rows = await db
    .select()
    .from(behavioralTraces)
    .where(whereClause)
    .orderBy(desc(behavioralTraces.createdAt))
    .limit(opts?.limit ?? 100);

  return rows as BehavioralTrace[];
}

/**
 * Compute behavioral fidelity score from all traces for an agent.
 * Returns a 0-1000 score, confidence level, and supporting data.
 *
 * When no traces exist, returns neutral score (500) with minimum confidence (0.1).
 * This ensures the dimension doesn't help or hurt agents without behavioral data.
 */
export async function computeBehavioralFidelity(agentPubkey: string): Promise<BehavioralFidelityResult> {
  const traces = await getTracesForAgent(agentPubkey, { limit: 1000 });

  if (traces.length === 0) {
    return {
      score: 500,
      confidence: 0.1,
      evidenceCount: 0,
      avgFidelityRatio: 0.5,
    };
  }

  const totalFidelity = traces.reduce((sum, t) => sum + t.fidelityRatio, 0);
  const avgFidelityRatio = totalFidelity / traces.length;

  return {
    score: Math.round(avgFidelityRatio * 1000),
    confidence: estimateConfidence(traces.length),
    evidenceCount: traces.length,
    avgFidelityRatio: Math.round(avgFidelityRatio * 10000) / 10000,
  };
}

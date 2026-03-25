// MCP-T Protocol Adapter
// Translates between MCP-T v0.2.0 JSON-RPC protocol and Vouch's internal scoring engine.
// This is the bridge that makes Vouch a conformant MCP-T Trust Provider.

import { calculateAgentTrust, calculateUserTrust, type VouchBreakdownResponse } from './trust-service';
import { db, contractEvents, contracts, outcomes, behavioralTraces } from '@percival/vouch-db';
import { eq, and, gte, lte, inArray, sql, desc } from 'drizzle-orm';
import { recordBehavioralTrace, computeBehavioralFidelity } from './behavioral-trace-service';
import { z } from 'zod';

// ── MCP-T Constants ──

const SCHEMA_VERSION = '0.2.0';
const PROVIDER_ID = 'did:web:percival-labs.ai';
const PROVIDER_NAME = 'Vouch Protocol';
const PROVIDER_DESCRIPTION = 'Behavioral and economic trust scoring for MCP agents. Reference MCP-T implementation.';
const PROVIDER_ENDPOINT = 'https://percivalvouch-api-production.up.railway.app/mcp-t/v1';
const CONFORMANCE_LEVEL = 2; // Level 2: Economic
const SUPPORTED_DOMAINS = ['general', 'code-execution'];
const SCORE_VALIDITY_SECONDS = 3600; // 1 hour default
const PROVIDER_PUBLIC_KEY = 'vouch-provider-key-placeholder'; // TODO: Replace with real Ed25519 key

// Vouch dimension → MCP-T dimension mapping
// Vouch uses 'backing' internally; MCP-T spec uses 'commitment'
const VOUCH_TO_MCPT_DIMENSION: Record<string, string> = {
  verification: 'verification',
  tenure: 'tenure',
  performance: 'performance',
  backing: 'commitment',
  community: 'community',
  behavioralFidelity: 'behavioral_fidelity',
};

const MCPT_TO_VOUCH_DIMENSION: Record<string, string> = {
  verification: 'verification',
  tenure: 'tenure',
  performance: 'performance',
  commitment: 'backing',
  community: 'community',
  behavioral_fidelity: 'behavioralFidelity',
};

// Dimensions Vouch currently scores
const SCORED_DIMENSIONS = ['verification', 'tenure', 'performance', 'commitment', 'community', 'behavioral_fidelity'];

// MCP-T contract event type → Vouch contractEvent.eventType mapping
const VOUCH_EVENT_TO_MCPT: Record<string, string> = {
  completed: 'contract.completed',
  cancelled: 'contract.abandoned',
  disputed: 'contract.disputed',
  funded: 'economic.stake_deposited',
  rated: 'contract.completed', // Ratings attach to completion
  milestone_submitted: 'contract.completed',
  milestone_accepted: 'contract.completed',
  milestone_rejected: 'contract.failed',
};

// ── MCP-T Types ──

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

interface McptDimensionScore {
  value: number;
  confidence: number;
  evidence_count: number;
}

interface McptTrustScore {
  schema_version: string;
  subject_id: string;
  provider_id: string;
  score: {
    composite: number;
    dimensions: Record<string, McptDimensionScore>;
  };
  domain?: string;
  domain_match?: boolean;
  validity: {
    issued_at: string;
    expires_at: string;
    max_age_seconds: number;
  };
  metadata?: Record<string, unknown>;
  authorized?: boolean;
  signature: {
    algorithm: string;
    public_key: string;
    value: string;
  };
}

interface McptTrustEvent {
  event_id: string;
  event_type: string;
  subject_id: string;
  issuer_id: string;
  timestamp: string;
  payload: Record<string, unknown>;
  dimensions_affected?: string[];
  signature: {
    algorithm: string;
    public_key: string;
    value: string;
  };
}

// ── Helpers ──

function now(): string {
  return new Date().toISOString();
}

function expiresAt(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function placeholderSignature() {
  return {
    algorithm: 'Ed25519' as const,
    public_key: PROVIDER_PUBLIC_KEY,
    value: 'signature-pending-key-setup',
  };
}

function jsonRpcError(id: string | number, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message, data } };
}

function jsonRpcResult(id: string | number, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

/** Estimate confidence from evidence count. More evidence = higher confidence. */
function estimateConfidence(evidenceCount: number): number {
  if (evidenceCount === 0) return 0.1;
  if (evidenceCount < 5) return 0.3;
  if (evidenceCount < 20) return 0.5;
  if (evidenceCount < 50) return 0.7;
  if (evidenceCount < 200) return 0.85;
  return 0.95;
}

/** Get approximate evidence count for a subject from contract events + outcomes */
async function getEvidenceCounts(subjectId: string): Promise<{
  total: number;
  performance: number;
  community: number;
}> {
  // Count contract events where this agent was involved
  const contractEventCount = await db
    .select({ count: sql<number>`count(*)` })
    .from(contractEvents)
    .where(eq(contractEvents.actorPubkey, subjectId));

  // Count outcomes
  const outcomeCount = await db
    .select({ count: sql<number>`count(*)` })
    .from(outcomes)
    .where(eq(outcomes.agentPubkey, subjectId));

  const perf = Number(contractEventCount[0]?.count ?? 0) + Number(outcomeCount[0]?.count ?? 0);

  return {
    total: perf,
    performance: perf,
    community: Math.max(1, Math.floor(perf * 0.3)), // Rough proxy
  };
}

// ── Protocol Method Handlers ──

/**
 * trust/query — Full trust score retrieval
 */
async function handleTrustQuery(id: string | number, params: Record<string, unknown>): Promise<JsonRpcResponse> {
  const subjectId = params.subject_id as string;
  if (!subjectId) {
    return jsonRpcError(id, -32001, 'SubjectNotFound', { message: 'subject_id is required' });
  }

  const domain = (params.domain as string) || undefined;
  const requestedDimensions = params.dimensions as string[] | undefined;

  // Try agent first, fall back to user
  let breakdown: VouchBreakdownResponse | null = await calculateAgentTrust(subjectId);
  if (!breakdown) {
    breakdown = await calculateUserTrust(subjectId);
  }
  if (!breakdown) {
    return jsonRpcError(id, -32001, 'SubjectNotFound', { message: `No trust data for ${subjectId}` });
  }

  const [evidence, behavioralFidelity] = await Promise.all([
    getEvidenceCounts(subjectId),
    computeBehavioralFidelity(subjectId),
  ]);

  // Map Vouch dimensions to MCP-T format
  const allDimensions: Record<string, McptDimensionScore> = {};
  for (const [vouchKey, mcptKey] of Object.entries(VOUCH_TO_MCPT_DIMENSION)) {
    const value = breakdown.dimensions[vouchKey as keyof typeof breakdown.dimensions];
    if (value !== undefined) {
      // Use behavioral fidelity's own confidence and evidence count
      if (mcptKey === 'behavioral_fidelity') {
        allDimensions[mcptKey] = {
          value,
          confidence: behavioralFidelity.confidence,
          evidence_count: behavioralFidelity.evidenceCount,
        };
        continue;
      }

      const evCount = mcptKey === 'performance' ? evidence.performance
        : mcptKey === 'community' ? evidence.community
        : Math.max(1, Math.floor(evidence.total * 0.2));

      allDimensions[mcptKey] = {
        value,
        confidence: estimateConfidence(evCount),
        evidence_count: evCount,
      };
    }
  }

  // Filter to requested dimensions if specified
  const dimensions = requestedDimensions
    ? Object.fromEntries(
        Object.entries(allDimensions).filter(([k]) => requestedDimensions.includes(k)),
      )
    : allDimensions;

  const trustScore: McptTrustScore = {
    schema_version: SCHEMA_VERSION,
    subject_id: subjectId,
    provider_id: PROVIDER_ID,
    score: {
      composite: breakdown.composite,
      dimensions,
    },
    domain: domain || 'general',
    domain_match: !domain || domain === 'general', // We only have general scores currently
    validity: {
      issued_at: breakdown.computed_at,
      expires_at: expiresAt(SCORE_VALIDITY_SECONDS),
      max_age_seconds: SCORE_VALIDITY_SECONDS,
    },
    metadata: {
      algorithm_version: 'vouch-scoring-v1.0',
      total_events_processed: evidence.total,
      vouch_vote_weight_bp: breakdown.vote_weight_bp,
    },
    authorized: true,
    signature: placeholderSignature(),
  };

  return jsonRpcResult(id, { trust_score: trustScore });
}

/**
 * trust/verify — Binary threshold check
 */
async function handleTrustVerify(id: string | number, params: Record<string, unknown>): Promise<JsonRpcResponse> {
  const subjectId = params.subject_id as string;
  if (!subjectId) {
    return jsonRpcError(id, -32001, 'SubjectNotFound', { message: 'subject_id is required' });
  }

  const threshold = params.threshold as {
    composite_min?: number;
    dimension_mins?: Record<string, number>;
    confidence_min?: number;
    min_evidence_count?: number;
  };
  if (!threshold || (!threshold.composite_min && !threshold.dimension_mins)) {
    return jsonRpcError(id, -32602, 'InvalidParams', {
      message: 'threshold with composite_min or dimension_mins is required',
    });
  }

  const nonce = params.nonce as string | undefined;
  const domain = params.domain as string | undefined;

  // Get the score
  let breakdown: VouchBreakdownResponse | null = await calculateAgentTrust(subjectId);
  if (!breakdown) {
    breakdown = await calculateUserTrust(subjectId);
  }
  if (!breakdown) {
    return jsonRpcError(id, -32001, 'SubjectNotFound', { message: `No trust data for ${subjectId}` });
  }

  const evidence = await getEvidenceCounts(subjectId);
  let verified = true;
  const thresholdResults: Record<string, unknown> = {};
  let minConfidence = 1.0;

  // Check composite threshold
  if (threshold.composite_min !== undefined) {
    const met = breakdown.composite >= threshold.composite_min;
    thresholdResults.composite_min = { required: threshold.composite_min, met };
    if (!met) verified = false;
  }

  // Check per-dimension thresholds
  if (threshold.dimension_mins) {
    const dimResults: Record<string, { required: number; met: boolean }> = {};
    for (const [mcptDim, minVal] of Object.entries(threshold.dimension_mins)) {
      const vouchDim = MCPT_TO_VOUCH_DIMENSION[mcptDim];
      if (!vouchDim) {
        dimResults[mcptDim] = { required: minVal, met: false };
        verified = false;
        continue;
      }
      const actual = breakdown.dimensions[vouchDim as keyof typeof breakdown.dimensions];
      if (actual === undefined) {
        dimResults[mcptDim] = { required: minVal, met: false };
        verified = false;
        continue;
      }
      const met = actual >= minVal;
      dimResults[mcptDim] = { required: minVal, met };
      if (!met) verified = false;

      // Track confidence
      const evCount = mcptDim === 'performance' ? evidence.performance : Math.max(1, Math.floor(evidence.total * 0.2));
      const conf = estimateConfidence(evCount);
      if (conf < minConfidence) minConfidence = conf;
    }
    thresholdResults.dimension_mins = dimResults;
  }

  // Check confidence minimum
  if (threshold.confidence_min !== undefined && minConfidence < threshold.confidence_min) {
    verified = false;
  }

  // Check evidence count minimum
  if (threshold.min_evidence_count !== undefined && evidence.total < threshold.min_evidence_count) {
    verified = false;
  }

  const result: Record<string, unknown> = {
    verified,
    subject_id: subjectId,
    provider_id: PROVIDER_ID,
    threshold_results: thresholdResults,
    confidence: Math.round(minConfidence * 100) / 100,
    checked_at: now(),
    valid_until: expiresAt(SCORE_VALIDITY_SECONDS),
    signature: placeholderSignature(),
  };

  if (nonce) result.nonce = nonce;

  return jsonRpcResult(id, result);
}

/**
 * trust/history — Retrieve trust events for a subject
 */
async function handleTrustHistory(id: string | number, params: Record<string, unknown>): Promise<JsonRpcResponse> {
  const subjectId = params.subject_id as string;
  if (!subjectId) {
    return jsonRpcError(id, -32001, 'SubjectNotFound', { message: 'subject_id is required' });
  }

  const eventTypes = params.event_types as string[] | undefined;
  const after = params.after as string | undefined;
  const before = params.before as string | undefined;
  const limit = Math.min(1000, Math.max(1, (params.limit as number) || 50));

  // Query contract events for this subject
  const contractConditions = [eq(contractEvents.actorPubkey, subjectId)];
  if (after) contractConditions.push(gte(contractEvents.createdAt, new Date(after)));
  if (before) contractConditions.push(lte(contractEvents.createdAt, new Date(before)));

  // Query behavioral traces for this subject
  const traceConditions = [eq(behavioralTraces.agentPubkey, subjectId)];
  if (after) traceConditions.push(gte(behavioralTraces.createdAt, new Date(after)));
  if (before) traceConditions.push(lte(behavioralTraces.createdAt, new Date(before)));

  // FIX 6: Fetch limit+1 from each source, merge, sort, take limit.
  // This correctly determines has_more across both sources combined.
  const [rawEvents, rawTraces, contractTotal, traceTotal] = await Promise.all([
    db
      .select()
      .from(contractEvents)
      .where(and(...contractConditions))
      .orderBy(desc(contractEvents.createdAt))
      .limit(limit + 1),
    db
      .select()
      .from(behavioralTraces)
      .where(and(...traceConditions))
      .orderBy(desc(behavioralTraces.createdAt))
      .limit(limit + 1),
    // Fetch total counts in parallel with data queries
    db
      .select({ count: sql<number>`count(*)` })
      .from(contractEvents)
      .where(eq(contractEvents.actorPubkey, subjectId)),
    db
      .select({ count: sql<number>`count(*)` })
      .from(behavioralTraces)
      .where(eq(behavioralTraces.agentPubkey, subjectId)),
  ]);

  // Convert contract events to MCP-T format
  const mcptEvents: McptTrustEvent[] = [];
  for (const evt of rawEvents) {
    const mcptType = VOUCH_EVENT_TO_MCPT[evt.eventType];
    if (!mcptType) continue;
    if (eventTypes && !eventTypes.includes(mcptType)) continue;

    const dimensionsAffected: string[] = [];
    if (mcptType.startsWith('contract.')) dimensionsAffected.push('performance', 'consistency');
    if (mcptType.startsWith('economic.')) dimensionsAffected.push('commitment');

    mcptEvents.push({
      event_id: evt.id,
      event_type: mcptType,
      subject_id: subjectId,
      issuer_id: PROVIDER_ID,
      timestamp: evt.createdAt.toISOString(),
      payload: {
        contract_id: evt.contractId,
        vouch_event_type: evt.eventType,
        ...(evt.metadata as Record<string, unknown> || {}),
      },
      dimensions_affected: dimensionsAffected,
      signature: placeholderSignature(),
    });
  }

  // Convert behavioral traces to MCP-T event format
  for (const trace of rawTraces) {
    if (eventTypes && !eventTypes.includes('behavior.trace')) continue;

    mcptEvents.push({
      event_id: trace.eventId || trace.id,
      event_type: 'behavior.trace',
      subject_id: subjectId,
      issuer_id: trace.issuerId || PROVIDER_ID,
      timestamp: trace.createdAt.toISOString(),
      payload: {
        trace_id: trace.traceId,
        contract_id: trace.contractId,
        fidelity_ratio: trace.fidelityRatio,
        total_tool_calls: trace.totalToolCalls,
        undeclared_tool_calls: trace.undeclaredToolCalls,
        total_resources: trace.totalResources,
        undeclared_resources: trace.undeclaredResources,
        duration_ms: trace.durationMs,
      },
      dimensions_affected: ['behavioral_fidelity'],
      signature: placeholderSignature(),
    });
  }

  // Sort merged events by timestamp descending, then paginate
  mcptEvents.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  const hasMore = mcptEvents.length > limit;
  const paginatedEvents = mcptEvents.slice(0, limit);

  const totalCount = Number(contractTotal[0]?.count ?? 0) + Number(traceTotal[0]?.count ?? 0);

  return jsonRpcResult(id, {
    events: paginatedEvents,
    has_more: hasMore,
    total_count: totalCount,
  });
}

/**
 * trust/providers — Provider discovery
 */
function handleTrustProviders(id: string | number): JsonRpcResponse {
  return jsonRpcResult(id, {
    providers: [
      {
        provider_id: PROVIDER_ID,
        name: PROVIDER_NAME,
        description: PROVIDER_DESCRIPTION,
        endpoint: PROVIDER_ENDPOINT,
        transport_bindings: ['https'],
        conformance_level: CONFORMANCE_LEVEL,
        supported_domains: SUPPORTED_DOMAINS,
        dimensions: SCORED_DIMENSIONS,
        scoring_methodology_uri: 'https://percival-labs.ai/research',
        public_key: PROVIDER_PUBLIC_KEY,
      },
    ],
  });
}

// ── FIX 3: Zod validation schemas for behavior.trace payloads ──

const HEX_HASH_REGEX = /^[a-f0-9]{16,128}$/i;

const toolCallSchema = z.object({
  tool_name: z.string().min(1),
  arguments_hash: z.string().regex(HEX_HASH_REGEX, 'arguments_hash must be a hex string (16-128 chars)').optional(),
  timestamp: z.string().min(1),
  duration_ms: z.number().int().nonnegative(),
  result_hash: z.string().optional(),
  declared: z.boolean(),
});

const resourceAccessSchema = z.object({
  resource_type: z.enum(['file', 'network', 'database', 'api', 'memory', 'system']),
  resource_id: z.string().min(1),
  access_type: z.enum(['read', 'write', 'execute', 'delete']),
  declared: z.boolean(),
});

const sideEffectSchema = z.object({
  type: z.enum(['file_write', 'network_request', 'state_mutation', 'notification', 'other']),
  target: z.string().min(1),
  declared: z.boolean(),
});

const behaviorTracePayloadSchema = z.object({
  trace_id: z.string().min(1).max(128),
  contract_id: z.string().optional(),
  tool_calls: z.array(toolCallSchema).max(500),
  resources_accessed: z.array(resourceAccessSchema).max(200),
  side_effects: z.array(sideEffectSchema).max(100).optional(),
  duration_ms: z.number().int().positive(),
});

/**
 * trust/publish — Accept trust events (Level 1+ compliance)
 * Requires authentication (callerPubkey). Validates payloads, prevents self-vouching,
 * and enforces per-agent rate limits.
 */
async function handleTrustPublish(id: string | number, params: Record<string, unknown>, callerPubkey: string): Promise<JsonRpcResponse> {
  const event = params.event as Record<string, unknown> | undefined;
  if (!event) {
    return jsonRpcError(id, -32011, 'UnknownEventType', { message: 'event is required' });
  }

  const eventId = event.event_id as string;
  const eventType = event.event_type as string;

  if (!eventId || !eventType) {
    return jsonRpcError(id, -32011, 'UnknownEventType', { message: 'event_id and event_type are required' });
  }

  console.log(`[mcp-t] Received trust event: ${eventType} (${eventId}) from ${callerPubkey}`);

  // Process behavioral trace events immediately
  if (eventType === 'behavior.trace') {
    const payload = event.payload as Record<string, unknown> | undefined;
    const subjectId = event.subject_id as string;
    const issuerId = event.issuer_id as string | undefined;

    if (!payload || !subjectId) {
      return jsonRpcError(id, -32602, 'InvalidParams', {
        message: 'behavior.trace requires subject_id and payload',
      });
    }

    // FIX 1: Self-vouching prevention — issuer cannot vouch for their own behavior
    if (issuerId && issuerId === subjectId) {
      return jsonRpcError(id, -32602, 'SelfVouchingProhibited', 'issuer_id cannot equal subject_id');
    }

    // FIX 3: Validate payload with Zod
    const parseResult = behaviorTracePayloadSchema.safeParse(payload);
    if (!parseResult.success) {
      const firstError = parseResult.error.errors[0];
      return jsonRpcError(id, -32602, 'InvalidParams', {
        message: `Payload validation failed: ${firstError?.path.join('.')} — ${firstError?.message}`,
        errors: parseResult.error.errors.map(e => ({ path: e.path.join('.'), message: e.message })),
      });
    }
    const validatedPayload = parseResult.data;

    // FIX 4: Per-agent rate limit — max 100 traces per agent per hour
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const [rateCheck] = await db
      .select({ count: sql<number>`count(*)` })
      .from(behavioralTraces)
      .where(and(
        eq(behavioralTraces.agentPubkey, subjectId),
        gte(behavioralTraces.createdAt, oneHourAgo),
      ));
    if (Number(rateCheck?.count ?? 0) >= 100) {
      return jsonRpcError(id, -32015, 'RateLimitExceeded', 'Maximum 100 traces per agent per hour');
    }

    try {
      const result = await recordBehavioralTrace({
        agentPubkey: subjectId,
        contractId: validatedPayload.contract_id,
        traceId: validatedPayload.trace_id || eventId,
        toolCalls: validatedPayload.tool_calls,
        resourcesAccessed: validatedPayload.resources_accessed,
        sideEffects: validatedPayload.side_effects ?? [],
        durationMs: validatedPayload.duration_ms,
        eventId,
        issuerId,
      });

      return jsonRpcResult(id, {
        accepted: true,
        event_id: eventId,
        processing_status: 'processed',
        trace_id: result.id,
        fidelity_ratio: result.fidelityRatio,
      });
    } catch (err) {
      console.error(`[mcp-t] Failed to record behavioral trace: ${err}`);
      return jsonRpcError(id, -32603, 'InternalError', {
        message: 'Failed to process behavioral trace',
      });
    }
  }

  // Other behavioral event types — log and queue for future processing
  if (eventType.startsWith('behavior.')) {
    console.log(`[mcp-t] Queued behavioral event: ${eventType} (${eventId})`);
    return jsonRpcResult(id, {
      accepted: true,
      event_id: eventId,
      processing_status: 'queued',
    });
  }

  // Non-behavioral events — accept and queue
  return jsonRpcResult(id, {
    accepted: true,
    event_id: eventId,
    processing_status: 'queued',
  });
}

// ── Main Router ──

/**
 * Route an MCP-T JSON-RPC request to the appropriate handler.
 * @param callerPubkey - Authenticated caller pubkey (required for trust/publish, optional for reads)
 */
export async function handleMcpTRequest(request: JsonRpcRequest, callerPubkey?: string): Promise<JsonRpcResponse> {
  const { id, method, params } = request;

  switch (method) {
    case 'trust/query':
      return handleTrustQuery(id, params);
    case 'trust/verify':
      return handleTrustVerify(id, params);
    case 'trust/history':
      return handleTrustHistory(id, params);
    case 'trust/providers':
      return handleTrustProviders(id);
    case 'trust/publish':
      if (!callerPubkey) {
        return jsonRpcError(id, -32603, 'AuthenticationRequired', 'trust/publish requires NIP-98 authentication');
      }
      return handleTrustPublish(id, params, callerPubkey);
    default:
      return jsonRpcError(id, -32601, 'MethodNotFound', { message: `Unknown method: ${method}` });
  }
}

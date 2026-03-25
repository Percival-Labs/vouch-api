// Behavioral Traces — MCP-T v0.2.0 Behavioral Fidelity Layer
// Records structured behavioral data from agent task execution.
// Tool calls, resource access, and side effects are tracked against declarations
// to compute a fidelity ratio: how closely actual behavior matched declared intent.

import { pgTable, text, timestamp, integer, real, jsonb, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { ulid } from 'ulid';

// ── JSONB Column Types ──

export interface ToolCallRecord {
  tool_name: string;
  arguments_hash?: string;
  timestamp: string;
  duration_ms: number;
  result_hash?: string;
  declared: boolean;
}

export interface ResourceAccessRecord {
  resource_type: 'file' | 'network' | 'database' | 'api' | 'memory' | 'system';
  resource_id: string;
  access_type: 'read' | 'write' | 'execute' | 'delete';
  declared: boolean;
}

export interface SideEffectRecord {
  type: 'file_write' | 'network_request' | 'state_mutation' | 'notification' | 'other';
  target: string;
  declared: boolean;
}

// ── Behavioral Traces Table ──

export const behavioralTraces = pgTable('behavioral_traces', {
  id: text('id').primaryKey().$defaultFn(() => ulid()),
  /** Hex pubkey of the agent whose behavior was observed */
  agentPubkey: text('agent_pubkey').notNull(),
  /** Optional contract this trace is associated with */
  contractId: text('contract_id'),
  /** Trace ID from the MCP-T event payload — globally unique */
  traceId: text('trace_id').notNull(),

  // Structured behavioral data (JSONB)
  toolCalls: jsonb('tool_calls').notNull().$type<ToolCallRecord[]>(),
  resourcesAccessed: jsonb('resources_accessed').notNull().$type<ResourceAccessRecord[]>(),
  sideEffects: jsonb('side_effects').$type<SideEffectRecord[]>().default([]),

  // Fidelity metrics (pre-computed for fast queries)
  durationMs: integer('duration_ms').notNull(),
  totalToolCalls: integer('total_tool_calls').notNull(),
  undeclaredToolCalls: integer('undeclared_tool_calls').notNull(),
  totalResources: integer('total_resources').notNull(),
  undeclaredResources: integer('undeclared_resources').notNull(),
  /** (total - undeclared) / total, range [0.0, 1.0]. 1.0 = perfect fidelity. */
  fidelityRatio: real('fidelity_ratio').notNull(),

  // Metadata
  /** The MCP-T trust event that created this trace */
  eventId: text('event_id'),
  /** Who submitted this trace (verifier pubkey or provider ID) */
  issuerId: text('issuer_id'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  index('idx_bt_agent').on(table.agentPubkey),
  index('idx_bt_contract').on(table.contractId),
  index('idx_bt_created').on(table.createdAt),
  index('idx_bt_agent_created').on(table.agentPubkey, table.createdAt),
  uniqueIndex('idx_bt_trace_id').on(table.traceId),
]);

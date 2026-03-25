-- MCP-T v0.2.0: Behavioral Traces
-- Records structured behavioral data from agent task execution.
-- Fidelity ratio measures declared-vs-observed behavior honesty.

CREATE TABLE IF NOT EXISTS "behavioral_traces" (
  "id" text PRIMARY KEY NOT NULL,
  "agent_pubkey" text NOT NULL,
  "contract_id" text,
  "trace_id" text NOT NULL,
  "tool_calls" jsonb NOT NULL,
  "resources_accessed" jsonb NOT NULL,
  "side_effects" jsonb DEFAULT '[]'::jsonb,
  "duration_ms" integer NOT NULL,
  "total_tool_calls" integer NOT NULL,
  "undeclared_tool_calls" integer NOT NULL,
  "total_resources" integer NOT NULL,
  "undeclared_resources" integer NOT NULL,
  "fidelity_ratio" real NOT NULL,
  "event_id" text,
  "issuer_id" text,
  "created_at" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_bt_agent" ON "behavioral_traces" ("agent_pubkey");
CREATE INDEX IF NOT EXISTS "idx_bt_contract" ON "behavioral_traces" ("contract_id");
CREATE INDEX IF NOT EXISTS "idx_bt_created" ON "behavioral_traces" ("created_at");
CREATE INDEX IF NOT EXISTS "idx_bt_agent_created" ON "behavioral_traces" ("agent_pubkey", "created_at");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_bt_trace_id" ON "behavioral_traces" ("trace_id");

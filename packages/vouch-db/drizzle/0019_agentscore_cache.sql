CREATE TABLE IF NOT EXISTS "agentscore_cache" (
  "agent_name" text PRIMARY KEY NOT NULL,
  "vouch_agent_id" text,
  "score" integer NOT NULL,
  "identity" integer,
  "activity" integer,
  "reputation" integer,
  "work_history" integer,
  "consistency" integer,
  "found" boolean NOT NULL DEFAULT false,
  "raw_payload" jsonb,
  "fetched_at" timestamp DEFAULT now() NOT NULL
);

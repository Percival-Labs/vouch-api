CREATE TYPE "public"."pool_status" AS ENUM('active', 'frozen', 'dissolved');--> statement-breakpoint
CREATE TYPE "public"."snapshot_reason" AS ENUM('daily', 'stake_change', 'slash', 'milestone');--> statement-breakpoint
CREATE TYPE "public"."stake_status" AS ENUM('active', 'unstaking', 'withdrawn', 'slashed');--> statement-breakpoint
CREATE TYPE "public"."treasury_source" AS ENUM('slash', 'platform_fee', 'donation');--> statement-breakpoint
CREATE TABLE "activity_fees" (
	"id" text PRIMARY KEY NOT NULL,
	"pool_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"action_type" text NOT NULL,
	"gross_revenue_cents" bigint NOT NULL,
	"fee_cents" bigint NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "slash_events" (
	"id" text PRIMARY KEY NOT NULL,
	"pool_id" text NOT NULL,
	"reason" text NOT NULL,
	"evidence_hash" text NOT NULL,
	"total_slashed_cents" bigint NOT NULL,
	"to_affected_cents" bigint NOT NULL,
	"to_treasury_cents" bigint NOT NULL,
	"violation_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stakes" (
	"id" text PRIMARY KEY NOT NULL,
	"pool_id" text NOT NULL,
	"staker_id" text NOT NULL,
	"staker_type" "author_type" NOT NULL,
	"amount_cents" bigint NOT NULL,
	"staker_trust_at_stake" integer NOT NULL,
	"status" "stake_status" DEFAULT 'active' NOT NULL,
	"staked_at" timestamp DEFAULT now() NOT NULL,
	"unstake_requested_at" timestamp,
	"withdrawn_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "treasury" (
	"id" text PRIMARY KEY NOT NULL,
	"amount_cents" bigint NOT NULL,
	"source_type" "treasury_source" NOT NULL,
	"source_id" text,
	"description" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vouch_pools" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"total_staked_cents" bigint DEFAULT 0 NOT NULL,
	"total_stakers" integer DEFAULT 0 NOT NULL,
	"total_yield_paid_cents" bigint DEFAULT 0 NOT NULL,
	"total_slashed_cents" bigint DEFAULT 0 NOT NULL,
	"activity_fee_rate_bps" integer DEFAULT 500 NOT NULL,
	"status" "pool_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "vouch_pools_agent_id_unique" UNIQUE("agent_id")
);
--> statement-breakpoint
CREATE TABLE "vouch_score_history" (
	"id" text PRIMARY KEY NOT NULL,
	"subject_id" text NOT NULL,
	"subject_type" "author_type" NOT NULL,
	"score" integer NOT NULL,
	"verification_component" integer NOT NULL,
	"tenure_component" integer NOT NULL,
	"performance_component" integer NOT NULL,
	"backing_component" integer NOT NULL,
	"community_component" integer NOT NULL,
	"snapshot_reason" "snapshot_reason" NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "yield_distributions" (
	"id" text PRIMARY KEY NOT NULL,
	"pool_id" text NOT NULL,
	"total_amount_cents" bigint NOT NULL,
	"platform_fee_cents" bigint NOT NULL,
	"distributed_amount_cents" bigint NOT NULL,
	"period_start" timestamp NOT NULL,
	"period_end" timestamp NOT NULL,
	"staker_count" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "yield_receipts" (
	"id" text PRIMARY KEY NOT NULL,
	"distribution_id" text NOT NULL,
	"stake_id" text NOT NULL,
	"amount_cents" bigint NOT NULL,
	"stake_proportion_bps" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "activity_fees" ADD CONSTRAINT "activity_fees_pool_id_vouch_pools_id_fk" FOREIGN KEY ("pool_id") REFERENCES "public"."vouch_pools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_fees" ADD CONSTRAINT "activity_fees_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slash_events" ADD CONSTRAINT "slash_events_pool_id_vouch_pools_id_fk" FOREIGN KEY ("pool_id") REFERENCES "public"."vouch_pools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slash_events" ADD CONSTRAINT "slash_events_violation_id_chivalry_violations_id_fk" FOREIGN KEY ("violation_id") REFERENCES "public"."chivalry_violations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stakes" ADD CONSTRAINT "stakes_pool_id_vouch_pools_id_fk" FOREIGN KEY ("pool_id") REFERENCES "public"."vouch_pools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vouch_pools" ADD CONSTRAINT "vouch_pools_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "yield_distributions" ADD CONSTRAINT "yield_distributions_pool_id_vouch_pools_id_fk" FOREIGN KEY ("pool_id") REFERENCES "public"."vouch_pools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "yield_receipts" ADD CONSTRAINT "yield_receipts_distribution_id_yield_distributions_id_fk" FOREIGN KEY ("distribution_id") REFERENCES "public"."yield_distributions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "yield_receipts" ADD CONSTRAINT "yield_receipts_stake_id_stakes_id_fk" FOREIGN KEY ("stake_id") REFERENCES "public"."stakes"("id") ON DELETE no action ON UPDATE no action;
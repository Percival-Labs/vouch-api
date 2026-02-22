-- Security Hardening Migration
-- Adds CHECK constraints, nonces table, distributionId on activity_fees,
-- and partial unique index for active stakes.

-- ── Request Nonces (replay protection) ──
CREATE TABLE "request_nonces" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"nonce" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "unique_agent_nonce" UNIQUE("agent_id", "nonce")
);
--> statement-breakpoint
CREATE INDEX "idx_nonce_expires" ON "request_nonces" USING btree ("expires_at");
--> statement-breakpoint
ALTER TABLE "request_nonces" ADD CONSTRAINT "request_nonces_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

-- ── Add distributionId to activity_fees (yield replay prevention) ──
ALTER TABLE "activity_fees" ADD COLUMN "distribution_id" text;
--> statement-breakpoint
ALTER TABLE "activity_fees" ADD CONSTRAINT "activity_fees_distribution_id_yield_distributions_id_fk" FOREIGN KEY ("distribution_id") REFERENCES "public"."yield_distributions"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

-- ── CHECK constraints on vouch_pools ──
ALTER TABLE "vouch_pools" ADD CONSTRAINT "check_non_negative_staked" CHECK ("vouch_pools"."total_staked_cents" >= 0);
--> statement-breakpoint
ALTER TABLE "vouch_pools" ADD CONSTRAINT "check_non_negative_stakers" CHECK ("vouch_pools"."total_stakers" >= 0);
--> statement-breakpoint
ALTER TABLE "vouch_pools" ADD CONSTRAINT "check_non_negative_yield" CHECK ("vouch_pools"."total_yield_paid_cents" >= 0);
--> statement-breakpoint
ALTER TABLE "vouch_pools" ADD CONSTRAINT "check_fee_rate_bounds" CHECK ("vouch_pools"."activity_fee_rate_bps" BETWEEN 200 AND 1000);
--> statement-breakpoint

-- ── CHECK constraints on stakes ──
ALTER TABLE "stakes" ADD CONSTRAINT "check_positive_amount" CHECK ("stakes"."amount_cents" > 0);
--> statement-breakpoint

-- ── Partial unique index: one active stake per staker per pool ──
CREATE UNIQUE INDEX "idx_one_active_stake_per_staker" ON "stakes" ("pool_id", "staker_id") WHERE status = 'active';
--> statement-breakpoint

-- ── CHECK constraints on activity_fees ──
ALTER TABLE "activity_fees" ADD CONSTRAINT "check_positive_revenue" CHECK ("activity_fees"."gross_revenue_cents" > 0);
--> statement-breakpoint
ALTER TABLE "activity_fees" ADD CONSTRAINT "check_positive_fee" CHECK ("activity_fees"."fee_cents" > 0);

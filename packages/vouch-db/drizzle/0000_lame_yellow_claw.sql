CREATE TYPE "public"."verification_level" AS ENUM('email', 'identity');--> statement-breakpoint
CREATE TYPE "public"."rate_limit_tier" AS ENUM('standard', 'verified', 'premium');--> statement-breakpoint
CREATE TYPE "public"."author_type" AS ENUM('user', 'agent');--> statement-breakpoint
CREATE TYPE "public"."member_role" AS ENUM('member', 'moderator', 'creator');--> statement-breakpoint
CREATE TYPE "public"."table_type" AS ENUM('public', 'private', 'paid');--> statement-breakpoint
CREATE TYPE "public"."body_format" AS ENUM('markdown', 'plaintext');--> statement-breakpoint
CREATE TYPE "public"."violation_status" AS ENUM('open', 'investigating', 'upheld', 'dismissed');--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"display_name" text NOT NULL,
	"password_hash" text NOT NULL,
	"avatar_url" text,
	"is_verified" boolean DEFAULT false,
	"verification_level" "verification_level",
	"stripe_account_id" text,
	"trust_score" integer DEFAULT 0,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"last_active_at" timestamp DEFAULT now(),
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "agent_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"public_key" text NOT NULL,
	"key_fingerprint" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"revoked_at" timestamp,
	"is_active" boolean DEFAULT true
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text,
	"name" text NOT NULL,
	"model_family" text,
	"description" text DEFAULT '',
	"avatar_url" text,
	"verified" boolean DEFAULT false,
	"trust_score" integer DEFAULT 0,
	"cosign_token_hash" text,
	"rate_limit_tier" "rate_limit_tier" DEFAULT 'standard',
	"created_at" timestamp DEFAULT now() NOT NULL,
	"last_active_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "cosign_proofs" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"user_id" text NOT NULL,
	"signature" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"revoked_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" text PRIMARY KEY NOT NULL,
	"table_id" text NOT NULL,
	"member_id" text NOT NULL,
	"member_type" "author_type" NOT NULL,
	"role" "member_role" DEFAULT 'member',
	"stripe_subscription_id" text,
	"joined_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "tables" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '',
	"type" "table_type" DEFAULT 'public',
	"creator_id" text NOT NULL,
	"creator_type" "author_type" NOT NULL,
	"icon_url" text,
	"banner_url" text,
	"rules" text,
	"stripe_product_id" text,
	"price_cents" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"subscriber_count" integer DEFAULT 0,
	"post_count" integer DEFAULT 0,
	CONSTRAINT "tables_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "comments" (
	"id" text PRIMARY KEY NOT NULL,
	"post_id" text NOT NULL,
	"parent_id" text,
	"author_id" text NOT NULL,
	"author_type" "author_type" NOT NULL,
	"body" text NOT NULL,
	"body_format" "body_format" DEFAULT 'markdown',
	"signature" text,
	"score" integer DEFAULT 0,
	"depth" integer DEFAULT 0,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"edited_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "posts" (
	"id" text PRIMARY KEY NOT NULL,
	"table_id" text NOT NULL,
	"author_id" text NOT NULL,
	"author_type" "author_type" NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"body_format" "body_format" DEFAULT 'markdown',
	"signature" text,
	"is_pinned" boolean DEFAULT false,
	"is_locked" boolean DEFAULT false,
	"score" integer DEFAULT 0,
	"comment_count" integer DEFAULT 0,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"edited_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "votes" (
	"id" text PRIMARY KEY NOT NULL,
	"target_id" text NOT NULL,
	"target_type" text NOT NULL,
	"voter_id" text NOT NULL,
	"voter_type" "author_type" NOT NULL,
	"value" integer NOT NULL,
	"weight" integer DEFAULT 100,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chivalry_violations" (
	"id" text PRIMARY KEY NOT NULL,
	"reported_id" text NOT NULL,
	"reported_type" "author_type" NOT NULL,
	"reporter_id" text NOT NULL,
	"reporter_type" "author_type" NOT NULL,
	"rule_number" integer NOT NULL,
	"evidence_post_id" text,
	"description" text NOT NULL,
	"status" "violation_status" DEFAULT 'open',
	"resolved_by" text,
	"resolution_note" text,
	"penalty_applied" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "flags" (
	"id" text PRIMARY KEY NOT NULL,
	"target_id" text NOT NULL,
	"target_type" text NOT NULL,
	"flagged_by" text NOT NULL,
	"flagged_by_type" "author_type" NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mod_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"table_id" text,
	"moderator_id" text NOT NULL,
	"moderator_type" "author_type" NOT NULL,
	"target_id" text NOT NULL,
	"target_type" text NOT NULL,
	"action" text NOT NULL,
	"reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"recipient_id" text NOT NULL,
	"recipient_type" "author_type" NOT NULL,
	"type" text NOT NULL,
	"payload" text,
	"read_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trust_events" (
	"id" text PRIMARY KEY NOT NULL,
	"subject_id" text NOT NULL,
	"subject_type" "author_type" NOT NULL,
	"event_type" text NOT NULL,
	"delta" integer NOT NULL,
	"reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_keys" ADD CONSTRAINT "agent_keys_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cosign_proofs" ADD CONSTRAINT "cosign_proofs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cosign_proofs" ADD CONSTRAINT "cosign_proofs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_table_id_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."tables"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_table_id_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."tables"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mod_actions" ADD CONSTRAINT "mod_actions_table_id_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."tables"("id") ON DELETE no action ON UPDATE no action;
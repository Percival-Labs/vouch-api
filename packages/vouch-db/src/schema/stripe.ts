// Stripe integration tables for Vouch for Stripe app.
// Three new tables: stripe_installations, stripe_agent_links, stripe_assessments, stripe_outcomes.
// Per architecture doc Section 6.

import { pgTable, text, timestamp, boolean, integer, jsonb, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { ulid } from 'ulid';

// Track Stripe App installations per connected account
export const stripeInstallations = pgTable('stripe_installations', {
  id: text('id').primaryKey().$defaultFn(() => ulid()),
  stripeAccountId: text('stripe_account_id').notNull().unique(),
  appUserId: text('app_user_id'),
  tier: text('tier').notNull().default('free'), // free, growth, scale, enterprise
  settings: jsonb('settings').notNull().default('{}').$type<{
    threshold?: number;
    domain?: string;
    flagUnscored?: boolean;
    notifications?: boolean;
  }>(),
  installedAt: timestamp('installed_at').defaultNow().notNull(),
  uninstalledAt: timestamp('uninstalled_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// Link Stripe Customer IDs to Vouch Agent identifiers
export const stripeAgentLinks = pgTable('stripe_agent_links', {
  id: text('id').primaryKey().$defaultFn(() => ulid()),
  installationId: text('installation_id').references(() => stripeInstallations.id).notNull(),
  stripeCustomerId: text('stripe_customer_id').notNull(),
  vouchAgentId: text('vouch_agent_id').notNull(),
  label: text('label'),
  linkedAt: timestamp('linked_at').defaultNow().notNull(),
  unlinkedAt: timestamp('unlinked_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  uniqueIndex('stripe_agent_links_install_customer')
    .on(table.installationId, table.stripeCustomerId),
  index('idx_stripe_agent_links_agent').on(table.vouchAgentId),
  index('idx_stripe_agent_links_customer').on(table.stripeCustomerId),
]);

// Record trust assessments per PaymentIntent
export const stripeAssessments = pgTable('stripe_assessments', {
  id: text('id').primaryKey().$defaultFn(() => ulid()),
  installationId: text('installation_id').references(() => stripeInstallations.id).notNull(),
  paymentIntentId: text('payment_intent_id').notNull(),
  vouchAgentId: text('vouch_agent_id').notNull(),
  compositeScore: integer('composite_score'),
  tier: text('tier'), // unscored, bronze, silver, gold, diamond
  domain: text('domain').notNull().default('financial'),
  threshold: integer('threshold').notNull().default(400),
  thresholdMet: boolean('threshold_met'),
  recommendation: text('recommendation').notNull().default('proceed'), // proceed, review, block
  amountCents: integer('amount_cents'),
  currency: text('currency'),
  assessedAt: timestamp('assessed_at').defaultNow().notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  index('idx_stripe_assessments_pi').on(table.paymentIntentId),
  index('idx_stripe_assessments_agent').on(table.vouchAgentId),
  index('idx_stripe_assessments_date').on(table.assessedAt),
]);

// Track transaction outcomes for actuarial analysis
export const stripeOutcomes = pgTable('stripe_outcomes', {
  id: text('id').primaryKey().$defaultFn(() => ulid()),
  assessmentId: text('assessment_id').references(() => stripeAssessments.id),
  installationId: text('installation_id').references(() => stripeInstallations.id).notNull(),
  paymentIntentId: text('payment_intent_id').notNull(),
  vouchAgentId: text('vouch_agent_id').notNull(),
  scoreAtTime: integer('score_at_time'),
  outcome: text('outcome').notNull(), // success, failed, disputed, refunded
  disputeReason: text('dispute_reason'),
  disputeAmountCents: integer('dispute_amount_cents'),
  refundAmountCents: integer('refund_amount_cents'),
  stripeEventId: text('stripe_event_id').unique(), // Idempotency
  trustEventEmitted: boolean('trust_event_emitted').notNull().default(false),
  occurredAt: timestamp('occurred_at').defaultNow().notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  index('idx_stripe_outcomes_agent').on(table.vouchAgentId),
  index('idx_stripe_outcomes_date').on(table.occurredAt),
  index('idx_stripe_outcomes_outcome').on(table.outcome),
]);

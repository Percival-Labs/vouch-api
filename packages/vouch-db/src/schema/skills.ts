// Vouch Skill Marketplace — Agent Skill Commerce
// Skills are purchasable capabilities that agents can acquire and use in contracts.
// Creator royalties, community staking, and purchase tracking enable the compound capability flywheel.

import { pgTable, text, timestamp, integer, bigint, real, pgEnum, index, check, jsonb } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { ulid } from 'ulid';

// -- Enums --

export const skillStatusEnum = pgEnum('skill_status', [
  'active', 'suspended', 'delisted',
]);

// -- Skills --

export const skills = pgTable('skills', {
  id: text('id').primaryKey().$defaultFn(() => ulid()),
  creatorPubkey: text('creator_pubkey').notNull(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  description: text('description').notNull(),
  version: text('version').default('1.0.0').notNull(),
  priceSats: integer('price_sats').notNull(),
  royaltyRateBps: integer('royalty_rate_bps').default(1000).notNull(), // 1000 = 10%
  creatorStakeSats: integer('creator_stake_sats').default(0).notNull(),
  communityStakeSats: integer('community_stake_sats').default(0).notNull(),
  purchaseCount: integer('purchase_count').default(0).notNull(),
  avgRating: real('avg_rating'), // nullable, computed from purchases
  ratingCount: integer('rating_count').default(0).notNull(),
  tags: jsonb('tags').$type<string[]>().default([]).notNull(),
  status: skillStatusEnum('status').default('active').notNull(),
  contentHash: text('content_hash'), // SHA-256 of skill content
  sourceUrl: text('source_url'), // optional: URL to skill source/repo
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => [
  check('check_price_sats_positive', sql`${table.priceSats} > 0`),
  check('check_royalty_rate_bps_bounds', sql`${table.royaltyRateBps} BETWEEN 0 AND 5000`), // 0-50%
  check('check_creator_stake_non_negative', sql`${table.creatorStakeSats} >= 0`),
  check('check_community_stake_non_negative', sql`${table.communityStakeSats} >= 0`),
  check('check_purchase_count_non_negative', sql`${table.purchaseCount} >= 0`),
  check('check_avg_rating_bounds', sql`${table.avgRating} IS NULL OR ${table.avgRating} BETWEEN 1.0 AND 5.0`),
  check('check_rating_count_non_negative', sql`${table.ratingCount} >= 0`),
  index('idx_skills_slug').on(table.slug),
  index('idx_skills_creator').on(table.creatorPubkey),
  index('idx_skills_status').on(table.status),
  index('idx_skills_tags').using('gin', table.tags),
]);

// -- Skill Purchases --

export const skillPurchases = pgTable('skill_purchases', {
  id: text('id').primaryKey().$defaultFn(() => ulid()),
  skillId: text('skill_id').references(() => skills.id).notNull(),
  buyerPubkey: text('buyer_pubkey').notNull(),
  pricePaidSats: integer('price_paid_sats').notNull(),
  paymentHash: text('payment_hash').unique(), // Lightning payment hash — unique prevents double-spend
  rating: integer('rating'), // 1-5, nullable until rated
  ratedAt: timestamp('rated_at'),
  contractsUsingSkill: integer('contracts_using_skill').default(0).notNull(),
  revenueFromSkillSats: bigint('revenue_from_skill_sats', { mode: 'number' }).default(0).notNull(), // bigint: accumulates across contracts
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  check('check_price_paid_positive', sql`${table.pricePaidSats} > 0`),
  check('check_rating_bounds', sql`${table.rating} IS NULL OR ${table.rating} BETWEEN 1 AND 5`),
  check('check_contracts_using_non_negative', sql`${table.contractsUsingSkill} >= 0`),
  check('check_revenue_non_negative', sql`${table.revenueFromSkillSats} >= 0`),
  index('idx_skill_purchases_skill').on(table.skillId),
  index('idx_skill_purchases_buyer').on(table.buyerPubkey),
]);

// -- Royalty Status Enum --

export const royaltyStatusEnum = pgEnum('royalty_status', [
  'pending', 'paid', 'failed',
]);

// -- Royalty Payments --
// Records royalty flows from contract milestones back to skill creators.
// When an agent completes work using a purchased skill, a percentage of the
// milestone payment flows to the skill creator. This is the compound flywheel.

export const royaltyPayments = pgTable('royalty_payments', {
  id: text('id').primaryKey().$defaultFn(() => ulid()),
  skillId: text('skill_id').references(() => skills.id).notNull(),
  creatorPubkey: text('creator_pubkey').notNull(), // skill creator receiving the royalty
  contractId: text('contract_id').notNull(), // the contract that triggered this
  milestoneId: text('milestone_id').notNull(), // the specific milestone
  purchaseId: text('purchase_id').references(() => skillPurchases.id).notNull(),
  grossRevenueSats: integer('gross_revenue_sats').notNull(), // milestone payment amount
  royaltyRateBps: integer('royalty_rate_bps').notNull(), // rate at time of payment, snapshotted
  royaltySats: integer('royalty_sats').notNull(), // actual royalty amount
  paymentHash: text('payment_hash'), // Lightning payment hash, null until paid
  status: royaltyStatusEnum('status').default('pending').notNull(),
  paidAt: timestamp('paid_at'), // null until paid
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  check('check_royalty_sats_positive', sql`${table.royaltySats} > 0`),
  check('check_royalty_rate_bps_bounds', sql`${table.royaltyRateBps} BETWEEN 0 AND 5000`),
  index('idx_royalty_skill').on(table.skillId),
  index('idx_royalty_creator').on(table.creatorPubkey),
  index('idx_royalty_contract').on(table.contractId),
]);

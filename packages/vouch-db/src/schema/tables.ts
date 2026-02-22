import { pgTable, text, timestamp, integer, pgEnum } from 'drizzle-orm/pg-core';
import { ulid } from 'ulid';

export const tableTypeEnum = pgEnum('table_type', ['public', 'private', 'paid']);
export const authorTypeEnum = pgEnum('author_type', ['user', 'agent']);
export const memberRoleEnum = pgEnum('member_role', ['member', 'moderator', 'creator']);

export const tables = pgTable('tables', {
  id: text('id').primaryKey().$defaultFn(() => ulid()),
  slug: text('slug').unique().notNull(),
  name: text('name').notNull(),
  description: text('description').default(''),
  type: tableTypeEnum('type').default('public'),
  creatorId: text('creator_id').notNull(),
  creatorType: authorTypeEnum('creator_type').notNull(),
  iconUrl: text('icon_url'),
  bannerUrl: text('banner_url'),
  rules: text('rules'),
  stripeProductId: text('stripe_product_id'),
  priceCents: integer('price_cents'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  subscriberCount: integer('subscriber_count').default(0),
  postCount: integer('post_count').default(0),
});

export const memberships = pgTable('memberships', {
  id: text('id').primaryKey().$defaultFn(() => ulid()),
  tableId: text('table_id').references(() => tables.id).notNull(),
  memberId: text('member_id').notNull(),
  memberType: authorTypeEnum('member_type').notNull(),
  role: memberRoleEnum('role').default('member'),
  stripeSubscriptionId: text('stripe_subscription_id'),
  joinedAt: timestamp('joined_at').defaultNow().notNull(),
  expiresAt: timestamp('expires_at'),
});

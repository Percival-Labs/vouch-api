import { pgTable, text, timestamp, boolean, integer, pgEnum } from 'drizzle-orm/pg-core';
import { ulid } from 'ulid';

export const verificationLevelEnum = pgEnum('verification_level', ['email', 'identity']);

export const users = pgTable('users', {
  id: text('id').primaryKey().$defaultFn(() => ulid()),
  email: text('email').unique().notNull(),
  displayName: text('display_name').notNull(),
  passwordHash: text('password_hash').notNull(),
  avatarUrl: text('avatar_url'),
  isVerified: boolean('is_verified').default(false),
  verificationLevel: verificationLevelEnum('verification_level'),
  stripeAccountId: text('stripe_account_id'),
  trustScore: integer('trust_score').default(0),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  lastActiveAt: timestamp('last_active_at').defaultNow(),
});

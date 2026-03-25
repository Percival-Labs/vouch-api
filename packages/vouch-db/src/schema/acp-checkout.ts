// ACP Checkout Sessions — Stripe Agent Commerce Protocol seller checkout flow.
// Tracks checkout lifecycle from creation through payment and AgentKey provisioning.
// Used by ACP seller endpoints (Play 3: Engram agents purchasable via ChatGPT/Copilot/Perplexity).

import { pgTable, text, timestamp, integer, jsonb, pgEnum, index } from 'drizzle-orm/pg-core';
import { ulid } from 'ulid';

export const acpCheckoutStatusEnum = pgEnum('acp_checkout_status', [
  'pending', 'processing', 'completed', 'cancelled', 'expired',
]);

export const acpCheckoutSessions = pgTable('acp_checkout_sessions', {
  id: text('id').primaryKey().$defaultFn(() => ulid()),
  productId: text('product_id').notNull(),
  buyerAddress: text('buyer_address').notNull(), // EVM address
  status: acpCheckoutStatusEnum('status').default('pending').notNull(),
  priceUsdcCents: integer('price_usdc_cents').notNull(),
  paymentToken: text('payment_token'), // encrypted SharedPaymentToken
  stripePaymentIntentId: text('stripe_payment_intent_id'),
  provisionedAgentKey: text('provisioned_agent_key'),
  provisionedAgentId: text('provisioned_agent_id'),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  expiresAt: timestamp('expires_at').notNull(),
}, (table) => [
  index('acp_checkout_buyer').on(table.buyerAddress),
  index('acp_checkout_status').on(table.status),
  index('acp_checkout_product').on(table.productId),
  index('acp_checkout_stripe_pi').on(table.stripePaymentIntentId),
]);

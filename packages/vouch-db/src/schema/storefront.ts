// Vouch Storefront — Digital Asset Marketplace
// NIP-99 compatible listings for STL files, SVGs, GCode, digital art, ebooks, and other assets.
// Lightning-native purchases with download token gating and trust-score-compounding ratings.

import { pgTable, text, timestamp, integer, bigint, real, pgEnum, index, uniqueIndex, check, jsonb } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { ulid } from 'ulid';

// ── Enums ──

export const storefrontStatusEnum = pgEnum('storefront_status', [
  'active', 'suspended', 'closed',
]);

export const listingStatusEnum = pgEnum('listing_status', [
  'active', 'delisted', 'suspended',
]);

export const storefrontEventTypeEnum = pgEnum('storefront_event_type', [
  'listing_created', 'listing_updated', 'listing_delisted',
  'purchase_completed', 'purchase_refunded', 'rating_submitted',
  'storefront_created', 'storefront_updated',
]);

// ── Storefronts ──

export const storefronts = pgTable('storefronts', {
  id: text('id').primaryKey().$defaultFn(() => ulid()),
  ownerPubkey: text('owner_pubkey').notNull(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  description: text('description'),
  logoUrl: text('logo_url'),
  bannerUrl: text('banner_url'),
  relayUrls: jsonb('relay_urls').$type<string[]>().default(['wss://relay.damus.io']).notNull(),
  settings: jsonb('settings').$type<Record<string, unknown>>().default({}).notNull(),
  status: storefrontStatusEnum('status').default('active').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => [
  index('idx_storefronts_owner').on(table.ownerPubkey),
  index('idx_storefronts_slug').on(table.slug),
  index('idx_storefronts_status').on(table.status),
]);

// ── Asset Listings ──

export const assetListings = pgTable('asset_listings', {
  id: text('id').primaryKey().$defaultFn(() => ulid()),
  storefrontId: text('storefront_id').references(() => storefronts.id).notNull(),
  creatorPubkey: text('creator_pubkey').notNull(),
  nostrEventId: text('nostr_event_id'), // set after NIP-99 publish
  title: text('title').notNull(),
  slug: text('slug').notNull(),
  description: text('description').notNull(),
  priceSats: integer('price_sats').notNull(),
  priceUsdCents: integer('price_usd_cents'),
  currency: text('currency').default('sats').notNull(),
  // 'stl', 'svg', 'gcode', 'digital_art', 'ebook', 'other'
  category: text('category').notNull(),
  fileHash: text('file_hash').notNull(), // SHA-256
  fileUrl: text('file_url').notNull(),
  fileSizeBytes: bigint('file_size_bytes', { mode: 'number' }),
  previewUrls: jsonb('preview_urls').$type<string[]>().default([]).notNull(),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}).notNull(), // extensible: STL dimensions, print specs, etc
  tags: jsonb('tags').$type<string[]>().default([]).notNull(),
  purchaseCount: integer('purchase_count').default(0).notNull(),
  avgRating: real('avg_rating'),
  ratingCount: integer('rating_count').default(0).notNull(),
  status: listingStatusEnum('status').default('active').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => [
  check('check_listing_price_positive', sql`${table.priceSats} > 0`),
  index('idx_listings_storefront').on(table.storefrontId),
  index('idx_listings_creator').on(table.creatorPubkey),
  index('idx_listings_category').on(table.category),
  index('idx_listings_status').on(table.status),
  index('idx_listings_tags').using('gin', table.tags),
  uniqueIndex('idx_listing_storefront_slug').on(table.storefrontId, table.slug),
]);

// ── Asset Purchases ──

export const assetPurchases = pgTable('asset_purchases', {
  id: text('id').primaryKey().$defaultFn(() => ulid()),
  listingId: text('listing_id').references(() => assetListings.id).notNull(),
  buyerPubkey: text('buyer_pubkey').notNull(),
  pricePaidSats: integer('price_paid_sats').notNull(),
  paymentMethod: text('payment_method').notNull(), // 'lightning' or 'strike'
  paymentHash: text('payment_hash').unique(), // Lightning payment hash
  strikePaymentId: text('strike_payment_id'),
  downloadToken: text('download_token'), // for file access
  downloadCount: integer('download_count').default(0).notNull(),
  maxDownloads: integer('max_downloads').default(5).notNull(),
  rating: integer('rating'), // 1-5
  ratedAt: timestamp('rated_at'),
  expiresAt: timestamp('expires_at'), // download link expiry
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  check('check_purchase_price_positive', sql`${table.pricePaidSats} > 0`),
  check('check_rating_bounds', sql`${table.rating} IS NULL OR ${table.rating} BETWEEN 1 AND 5`),
  check('check_download_count_non_negative', sql`${table.downloadCount} >= 0`),
  check('check_max_downloads_positive', sql`${table.maxDownloads} > 0`),
  index('idx_purchases_listing').on(table.listingId),
  index('idx_purchases_buyer').on(table.buyerPubkey),
  index('idx_purchases_payment_hash').on(table.paymentHash),
]);

// ── Storefront Events (Audit Trail) ──

export const storefrontEvents = pgTable('storefront_events', {
  id: text('id').primaryKey().$defaultFn(() => ulid()),
  storefrontId: text('storefront_id').references(() => storefronts.id).notNull(),
  eventType: storefrontEventTypeEnum('event_type').notNull(),
  actorPubkey: text('actor_pubkey').notNull(),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  index('idx_storefront_events_storefront').on(table.storefrontId),
  index('idx_storefront_events_type').on(table.eventType),
]);

// Vouch Storefront Service — Digital Asset Marketplace
// Business logic for agent storefronts: creation, listing, purchasing, downloads, and ratings.
// All financial mutations use db.transaction() for atomicity (matching skill-service pattern).
// Prices are in sats (Lightning-native). Downloads gated by token + expiry + max count.

import { eq, and, sql, desc, asc, ilike, or } from 'drizzle-orm';
import { db, storefronts, assetListings, assetPurchases, storefrontEvents } from '@percival/vouch-db';
import { createInvoice, lookupInvoice } from './albyhub-service';
import { randomUUID } from 'crypto';

// ── Types ──

export interface CreateStorefrontParams {
  ownerPubkey: string;
  name: string;
  slug: string;
  description?: string;
  logoUrl?: string;
  bannerUrl?: string;
  relayUrls?: string[];
  settings?: Record<string, unknown>;
}

export interface UpdateStorefrontParams {
  name?: string;
  description?: string;
  logoUrl?: string;
  bannerUrl?: string;
  relayUrls?: string[];
  settings?: Record<string, unknown>;
}

export interface CreateListingParams {
  storefrontId: string;
  creatorPubkey: string;
  title: string;
  slug: string;
  description: string;
  priceSats: number;
  category: string;
  fileHash: string;
  fileUrl: string;
  fileSizeBytes?: number;
  priceUsdCents?: number;
  previewUrls?: string[];
  metadata?: Record<string, unknown>;
  tags?: string[];
}

export interface UpdateListingParams {
  title?: string;
  description?: string;
  priceSats?: number;
  previewUrls?: string[];
  metadata?: Record<string, unknown>;
  tags?: string[];
}

export interface ListingFilters {
  category?: string;
  tag?: string;
  search?: string;
  sortBy?: 'purchaseCount' | 'avgRating' | 'createdAt' | 'priceSats';
  sortDir?: 'asc' | 'desc';
  page?: number;
  limit?: number;
}

// ── Validation Helpers ──

function assertPositiveInt(value: number, name: string, max?: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  if (max !== undefined && value > max) {
    throw new Error(`${name} exceeds maximum of ${max}`);
  }
}

function assertValidSlug(slug: string): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new Error('slug must be lowercase alphanumeric with hyphens (e.g. "my-store")');
  }
  if (slug.length < 2 || slug.length > 100) {
    throw new Error('slug must be between 2 and 100 characters');
  }
}

function assertValidRating(rating: number): void {
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    throw new Error('rating must be an integer between 1 and 5');
  }
}

function assertNonEmptyString(value: string | undefined | null, name: string, maxLen: number): void {
  if (!value || value.trim().length === 0) {
    throw new Error(`${name} is required`);
  }
  if (value.trim().length > maxLen) {
    throw new Error(`${name} must be under ${maxLen} characters`);
  }
}

function assertValidUrl(url: string, name: string): void {
  if (url.length > 2000) {
    throw new Error(`${name} must be under 2000 characters`);
  }
  if (!url.startsWith('https://')) {
    throw new Error(`${name} must start with https://`);
  }
}

// ── Event Logging ──

/** Insert an audit trail event into storefrontEvents. */
export async function logStorefrontEvent(
  storefrontId: string,
  eventType: 'listing_created' | 'listing_updated' | 'listing_delisted' |
    'purchase_completed' | 'purchase_refunded' | 'rating_submitted' |
    'storefront_created' | 'storefront_updated',
  actorPubkey: string,
  metadata?: Record<string, unknown>,
) {
  const [event] = await db
    .insert(storefrontEvents)
    .values({
      storefrontId,
      eventType,
      actorPubkey,
      metadata: metadata ?? {},
    })
    .returning();

  return event!;
}

// ── Storefront CRUD ──

/** Create a new storefront. Owner must be authenticated via NIP-98. */
export async function createStorefront(params: CreateStorefrontParams) {
  assertNonEmptyString(params.name, 'name', 200);
  assertValidSlug(params.slug);

  if (params.description && params.description.trim().length > 10000) {
    throw new Error('description must be under 10,000 characters');
  }

  if (params.logoUrl) assertValidUrl(params.logoUrl, 'logo_url');
  if (params.bannerUrl) assertValidUrl(params.bannerUrl, 'banner_url');

  if (params.relayUrls) {
    if (params.relayUrls.length > 20) {
      throw new Error('Maximum 20 relay URLs allowed');
    }
    for (const url of params.relayUrls) {
      if (!url.startsWith('wss://') && !url.startsWith('ws://')) {
        throw new Error('Relay URLs must start with wss:// or ws://');
      }
    }
  }

  const [storefront] = await db
    .insert(storefronts)
    .values({
      ownerPubkey: params.ownerPubkey,
      name: params.name.trim(),
      slug: params.slug,
      description: params.description?.trim() ?? null,
      logoUrl: params.logoUrl ?? null,
      bannerUrl: params.bannerUrl ?? null,
      relayUrls: params.relayUrls ?? ['wss://relay.damus.io'],
      settings: params.settings ?? {},
    })
    .returning();

  await logStorefrontEvent(storefront!.id, 'storefront_created', params.ownerPubkey);

  console.log(`[storefront] Created "${storefront!.name}" (${storefront!.id}) by ${params.ownerPubkey}`);
  return storefront!;
}

/** Get a storefront by ID. */
export async function getStorefront(id: string) {
  const [storefront] = await db
    .select()
    .from(storefronts)
    .where(eq(storefronts.id, id))
    .limit(1);

  return storefront ?? null;
}

/** Get a storefront by slug. */
export async function getStorefrontBySlug(slug: string) {
  const [storefront] = await db
    .select()
    .from(storefronts)
    .where(eq(storefronts.slug, slug))
    .limit(1);

  return storefront ?? null;
}

/** List all storefronts owned by a pubkey. */
export async function listMyStorefronts(ownerPubkey: string) {
  return db
    .select()
    .from(storefronts)
    .where(eq(storefronts.ownerPubkey, ownerPubkey))
    .orderBy(desc(storefronts.createdAt));
}

/** Update a storefront. Caller must own it. */
export async function updateStorefront(
  id: string,
  ownerPubkey: string,
  updates: UpdateStorefrontParams,
) {
  // Verify ownership
  const [existing] = await db
    .select({ id: storefronts.id, ownerPubkey: storefronts.ownerPubkey })
    .from(storefronts)
    .where(eq(storefronts.id, id))
    .limit(1);

  if (!existing) throw new Error('Storefront not found');
  if (existing.ownerPubkey !== ownerPubkey) throw new Error('Not the storefront owner');

  // Validate optional fields
  if (updates.name !== undefined) assertNonEmptyString(updates.name, 'name', 200);
  if (updates.description !== undefined && updates.description.trim().length > 10000) {
    throw new Error('description must be under 10,000 characters');
  }
  if (updates.logoUrl) assertValidUrl(updates.logoUrl, 'logo_url');
  if (updates.bannerUrl) assertValidUrl(updates.bannerUrl, 'banner_url');
  if (updates.relayUrls) {
    if (updates.relayUrls.length > 20) {
      throw new Error('Maximum 20 relay URLs allowed');
    }
    for (const url of updates.relayUrls) {
      if (!url.startsWith('wss://') && !url.startsWith('ws://')) {
        throw new Error('Relay URLs must start with wss:// or ws://');
      }
    }
  }

  const setClause: Record<string, unknown> = { updatedAt: new Date() };
  if (updates.name !== undefined) setClause.name = updates.name.trim();
  if (updates.description !== undefined) setClause.description = updates.description.trim();
  if (updates.logoUrl !== undefined) setClause.logoUrl = updates.logoUrl;
  if (updates.bannerUrl !== undefined) setClause.bannerUrl = updates.bannerUrl;
  if (updates.relayUrls !== undefined) setClause.relayUrls = updates.relayUrls;
  if (updates.settings !== undefined) setClause.settings = updates.settings;

  const [updated] = await db
    .update(storefronts)
    .set(setClause)
    .where(eq(storefronts.id, id))
    .returning();

  await logStorefrontEvent(id, 'storefront_updated', ownerPubkey, { fields: Object.keys(updates) });

  console.log(`[storefront] Updated "${updated!.name}" (${id}) by ${ownerPubkey}`);
  return updated!;
}

// ── Listing CRUD ──

/** Create a new asset listing in a storefront. Caller must own the storefront. */
export async function createListing(params: CreateListingParams) {
  assertNonEmptyString(params.title, 'title', 200);
  assertNonEmptyString(params.description, 'description', 10000);
  assertValidSlug(params.slug);
  assertPositiveInt(params.priceSats, 'price_sats', 100_000_000); // 1 BTC cap

  if (!params.category || params.category.trim().length === 0) {
    throw new Error('category is required');
  }
  if (!params.fileHash || !/^[0-9a-f]{64}$/i.test(params.fileHash)) {
    throw new Error('file_hash must be a 64-character hex string (SHA-256)');
  }
  assertValidUrl(params.fileUrl, 'file_url');

  if (params.tags) {
    if (params.tags.length > 20) {
      throw new Error('Maximum 20 tags allowed');
    }
    for (const tag of params.tags) {
      if (typeof tag !== 'string' || tag.length > 50 || !/^[a-z0-9-]+$/.test(tag)) {
        throw new Error('Each tag must be lowercase alphanumeric with hyphens, max 50 characters');
      }
    }
  }

  if (params.previewUrls) {
    if (params.previewUrls.length > 10) {
      throw new Error('Maximum 10 preview URLs allowed');
    }
    for (const url of params.previewUrls) {
      assertValidUrl(url, 'preview_url');
    }
  }

  // Verify caller owns the storefront
  const [storefront] = await db
    .select({ id: storefronts.id, ownerPubkey: storefronts.ownerPubkey, status: storefronts.status })
    .from(storefronts)
    .where(eq(storefronts.id, params.storefrontId))
    .limit(1);

  if (!storefront) throw new Error('Storefront not found');
  if (storefront.ownerPubkey !== params.creatorPubkey) throw new Error('Not the storefront owner');
  if (storefront.status !== 'active') throw new Error(`Storefront is ${storefront.status} — cannot create listings`);

  const [listing] = await db
    .insert(assetListings)
    .values({
      storefrontId: params.storefrontId,
      creatorPubkey: params.creatorPubkey,
      title: params.title.trim(),
      slug: params.slug,
      description: params.description.trim(),
      priceSats: params.priceSats,
      priceUsdCents: params.priceUsdCents ?? null,
      category: params.category.trim(),
      fileHash: params.fileHash.toLowerCase(),
      fileUrl: params.fileUrl,
      fileSizeBytes: params.fileSizeBytes ?? null,
      previewUrls: params.previewUrls ?? [],
      metadata: params.metadata ?? {},
      tags: params.tags ?? [],
    })
    .returning();

  await logStorefrontEvent(params.storefrontId, 'listing_created', params.creatorPubkey, {
    listingId: listing!.id,
    title: listing!.title,
  });

  console.log(`[storefront] Created listing "${listing!.title}" (${listing!.id}) in storefront ${params.storefrontId}`);
  return listing!;
}

/** Get a listing by ID, joined with storefront info. */
export async function getListing(listingId: string) {
  const [result] = await db
    .select({
      listing: assetListings,
      storefront: storefronts,
    })
    .from(assetListings)
    .innerJoin(storefronts, eq(storefronts.id, assetListings.storefrontId))
    .where(eq(assetListings.id, listingId))
    .limit(1);

  return result ?? null;
}

/** Update a listing. Caller must own the parent storefront. */
export async function updateListing(
  listingId: string,
  ownerPubkey: string,
  updates: UpdateListingParams,
) {
  // Fetch listing + verify ownership via storefront
  const [result] = await db
    .select({
      listing: assetListings,
      storefrontOwner: storefronts.ownerPubkey,
    })
    .from(assetListings)
    .innerJoin(storefronts, eq(storefronts.id, assetListings.storefrontId))
    .where(eq(assetListings.id, listingId))
    .limit(1);

  if (!result) throw new Error('Listing not found');
  if (result.storefrontOwner !== ownerPubkey) throw new Error('Not the storefront owner');
  if (result.listing.status !== 'active') throw new Error(`Listing is ${result.listing.status} — cannot update`);

  // Validate optional fields
  if (updates.title !== undefined) assertNonEmptyString(updates.title, 'title', 200);
  if (updates.description !== undefined) assertNonEmptyString(updates.description, 'description', 10000);
  if (updates.priceSats !== undefined) assertPositiveInt(updates.priceSats, 'price_sats', 100_000_000);

  if (updates.tags) {
    if (updates.tags.length > 20) {
      throw new Error('Maximum 20 tags allowed');
    }
    for (const tag of updates.tags) {
      if (typeof tag !== 'string' || tag.length > 50 || !/^[a-z0-9-]+$/.test(tag)) {
        throw new Error('Each tag must be lowercase alphanumeric with hyphens, max 50 characters');
      }
    }
  }

  if (updates.previewUrls) {
    if (updates.previewUrls.length > 10) {
      throw new Error('Maximum 10 preview URLs allowed');
    }
    for (const url of updates.previewUrls) {
      assertValidUrl(url, 'preview_url');
    }
  }

  const setClause: Record<string, unknown> = { updatedAt: new Date() };
  if (updates.title !== undefined) setClause.title = updates.title.trim();
  if (updates.description !== undefined) setClause.description = updates.description.trim();
  if (updates.priceSats !== undefined) setClause.priceSats = updates.priceSats;
  if (updates.previewUrls !== undefined) setClause.previewUrls = updates.previewUrls;
  if (updates.metadata !== undefined) setClause.metadata = updates.metadata;
  if (updates.tags !== undefined) setClause.tags = updates.tags;

  const [updated] = await db
    .update(assetListings)
    .set(setClause)
    .where(eq(assetListings.id, listingId))
    .returning();

  await logStorefrontEvent(result.listing.storefrontId, 'listing_updated', ownerPubkey, {
    listingId,
    fields: Object.keys(updates),
  });

  console.log(`[storefront] Updated listing "${updated!.title}" (${listingId})`);
  return updated!;
}

/** Delist a listing. Caller must own the parent storefront. */
export async function delistListing(listingId: string, ownerPubkey: string) {
  // Fetch listing + verify ownership via storefront
  const [result] = await db
    .select({
      listing: assetListings,
      storefrontOwner: storefronts.ownerPubkey,
    })
    .from(assetListings)
    .innerJoin(storefronts, eq(storefronts.id, assetListings.storefrontId))
    .where(eq(assetListings.id, listingId))
    .limit(1);

  if (!result) throw new Error('Listing not found');
  if (result.storefrontOwner !== ownerPubkey) throw new Error('Not the storefront owner');
  if (result.listing.status === 'delisted') throw new Error('Listing is already delisted');

  const [updated] = await db
    .update(assetListings)
    .set({ status: 'delisted', updatedAt: new Date() })
    .where(eq(assetListings.id, listingId))
    .returning();

  await logStorefrontEvent(result.listing.storefrontId, 'listing_delisted', ownerPubkey, {
    listingId,
    title: result.listing.title,
  });

  console.log(`[storefront] Delisted listing "${result.listing.title}" (${listingId})`);
  return updated!;
}

// ── Browse — Public ──

/** Browse listings across all active storefronts with filtering and pagination. */
export async function listPublicListings(filters: ListingFilters = {}) {
  const page = filters.page ?? 1;
  const limit = Math.min(filters.limit ?? 25, 100);
  const offset = (page - 1) * limit;

  // Only active listings in active storefronts
  const conditions = [
    eq(assetListings.status, 'active'),
    eq(storefronts.status, 'active'),
  ];

  if (filters.category) {
    conditions.push(eq(assetListings.category, filters.category));
  }

  if (filters.tag) {
    conditions.push(sql`${assetListings.tags} @> ${JSON.stringify([filters.tag])}::jsonb`);
  }

  if (filters.search) {
    const escaped = filters.search.replace(/[%_\\]/g, '\\$&');
    conditions.push(
      sql`(${ilike(assetListings.title, `%${escaped}%`)} OR ${ilike(assetListings.description, `%${escaped}%`)})`,
    );
  }

  const whereClause = and(...conditions);

  let orderByClause;
  const direction = filters.sortDir === 'asc' ? asc : desc;
  switch (filters.sortBy) {
    case 'purchaseCount':
      orderByClause = direction(assetListings.purchaseCount);
      break;
    case 'avgRating':
      orderByClause = sql`${assetListings.avgRating} ${filters.sortDir === 'asc' ? sql`ASC NULLS LAST` : sql`DESC NULLS LAST`}`;
      break;
    case 'priceSats':
      orderByClause = direction(assetListings.priceSats);
      break;
    case 'createdAt':
    default:
      orderByClause = direction(assetListings.createdAt);
      break;
  }

  const rows = await db
    .select({
      listing: assetListings,
      storefront: {
        id: storefronts.id,
        name: storefronts.name,
        slug: storefronts.slug,
        logoUrl: storefronts.logoUrl,
      },
    })
    .from(assetListings)
    .innerJoin(storefronts, eq(storefronts.id, assetListings.storefrontId))
    .where(whereClause)
    .orderBy(orderByClause)
    .limit(limit)
    .offset(offset);

  const countResult = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(assetListings)
    .innerJoin(storefronts, eq(storefronts.id, assetListings.storefrontId))
    .where(whereClause);

  const total = countResult[0]?.count ?? 0;

  return {
    data: rows,
    meta: { page, limit, total, has_more: offset + limit < total },
  };
}

/** Browse listings within a single storefront. */
export async function listStorefrontListings(storefrontId: string, filters: ListingFilters = {}) {
  const page = filters.page ?? 1;
  const limit = Math.min(filters.limit ?? 25, 100);
  const offset = (page - 1) * limit;

  const conditions = [
    eq(assetListings.storefrontId, storefrontId),
    eq(assetListings.status, 'active'),
  ];

  if (filters.category) {
    conditions.push(eq(assetListings.category, filters.category));
  }

  if (filters.tag) {
    conditions.push(sql`${assetListings.tags} @> ${JSON.stringify([filters.tag])}::jsonb`);
  }

  if (filters.search) {
    const escaped = filters.search.replace(/[%_\\]/g, '\\$&');
    conditions.push(
      sql`(${ilike(assetListings.title, `%${escaped}%`)} OR ${ilike(assetListings.description, `%${escaped}%`)})`,
    );
  }

  const whereClause = and(...conditions);

  let orderByClause;
  const direction = filters.sortDir === 'asc' ? asc : desc;
  switch (filters.sortBy) {
    case 'purchaseCount':
      orderByClause = direction(assetListings.purchaseCount);
      break;
    case 'avgRating':
      orderByClause = sql`${assetListings.avgRating} ${filters.sortDir === 'asc' ? sql`ASC NULLS LAST` : sql`DESC NULLS LAST`}`;
      break;
    case 'priceSats':
      orderByClause = direction(assetListings.priceSats);
      break;
    case 'createdAt':
    default:
      orderByClause = direction(assetListings.createdAt);
      break;
  }

  const rows = await db
    .select()
    .from(assetListings)
    .where(whereClause)
    .orderBy(orderByClause)
    .limit(limit)
    .offset(offset);

  const countResult = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(assetListings)
    .where(whereClause);

  const total = countResult[0]?.count ?? 0;

  return {
    data: rows,
    meta: { page, limit, total, has_more: offset + limit < total },
  };
}

/** Cross-storefront text search on title + description. */
export async function searchListings(query: string, filters: ListingFilters = {}) {
  if (!query || query.trim().length === 0) {
    throw new Error('Search query is required');
  }
  if (query.length > 200) {
    throw new Error('Search query must be under 200 characters');
  }

  return listPublicListings({ ...filters, search: query.trim() });
}

// ── Checkout Flow ──

/**
 * Start checkout for a listing. Creates a Lightning invoice via Alby Hub.
 * Returns invoice details for the buyer to pay.
 */
export async function startCheckout(
  listingId: string,
  buyerPubkey: string,
  method: 'lightning' | 'strike' = 'lightning',
) {
  // Fetch listing + verify it's active in an active storefront
  const result = await getListing(listingId);
  if (!result) throw new Error('Listing not found');
  if (result.listing.status !== 'active') throw new Error(`Listing is ${result.listing.status} — purchase not allowed`);
  if (result.storefront.status !== 'active') throw new Error(`Storefront is ${result.storefront.status} — purchase not allowed`);

  // Prevent creator from purchasing their own listing
  if (result.listing.creatorPubkey === buyerPubkey) {
    throw new Error('Cannot purchase your own listing');
  }

  if (method === 'strike') {
    // Strike integration is future work
    throw new Error('Strike payments are not yet supported — use lightning');
  }

  // Create Lightning invoice via Alby Hub
  const memo = `Vouch Storefront: ${result.listing.title} (${result.storefront.name})`;
  const invoice = await createInvoice(result.listing.priceSats, memo);

  // Calculate expiry (10 minutes from now — standard Lightning invoice window)
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

  console.log(`[storefront] Checkout started: ${buyerPubkey} for listing "${result.listing.title}" (${listingId}), ${result.listing.priceSats} sats`);

  return {
    listingId,
    invoiceId: invoice.paymentHash,
    bolt11: invoice.paymentRequest,
    paymentHash: invoice.paymentHash,
    amountSats: result.listing.priceSats,
    expiresAt,
  };
}

/**
 * Confirm a purchase after Lightning payment is settled.
 * Verifies payment via Alby Hub, creates purchase record, generates download token.
 */
export async function confirmPurchase(
  listingId: string,
  buyerPubkey: string,
  paymentHash: string,
) {
  if (!paymentHash || paymentHash.trim().length === 0) {
    throw new Error('payment_hash is required');
  }
  if (!/^[0-9a-f]{64}$/i.test(paymentHash.trim())) {
    throw new Error('payment_hash must be a 64-character hex string');
  }

  // Verify the invoice was actually paid
  const invoice = await lookupInvoice(paymentHash.trim());
  if (!invoice) {
    throw new Error('Unable to verify payment — invoice not found or Lightning node unreachable');
  }
  if (!invoice.settled) {
    throw new Error('Payment not yet settled — please pay the invoice first');
  }

  return await db.transaction(async (tx) => {
    // Lock listing row and verify it's active
    const [listing] = await tx
      .select()
      .from(assetListings)
      .where(eq(assetListings.id, listingId))
      .for('update');

    if (!listing) throw new Error('Listing not found');
    if (listing.status !== 'active') throw new Error(`Listing is ${listing.status} — purchase not allowed`);

    // Prevent creator from purchasing their own listing
    if (listing.creatorPubkey === buyerPubkey) {
      throw new Error('Cannot purchase your own listing');
    }

    // Check for duplicate purchase (same payment hash)
    const [existingByHash] = await tx
      .select({ id: assetPurchases.id })
      .from(assetPurchases)
      .where(eq(assetPurchases.paymentHash, paymentHash.trim()))
      .limit(1);

    if (existingByHash) {
      throw new Error('Payment hash already used for a purchase');
    }

    // Generate download token and expiry
    const downloadToken = randomUUID();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
    const maxDownloads = 5;

    // Insert purchase record
    const [purchase] = await tx
      .insert(assetPurchases)
      .values({
        listingId,
        buyerPubkey,
        pricePaidSats: listing.priceSats,
        paymentMethod: 'lightning',
        paymentHash: paymentHash.trim(),
        downloadToken,
        downloadCount: 0,
        maxDownloads,
        expiresAt,
      })
      .returning();

    // Increment purchase count on listing (atomic)
    await tx
      .update(assetListings)
      .set({
        purchaseCount: sql`${assetListings.purchaseCount} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(assetListings.id, listingId));

    // Log the event
    await tx
      .insert(storefrontEvents)
      .values({
        storefrontId: listing.storefrontId,
        eventType: 'purchase_completed',
        actorPubkey: buyerPubkey,
        metadata: {
          listingId,
          purchaseId: purchase!.id,
          priceSats: listing.priceSats,
          paymentHash: paymentHash.trim(),
        },
      });

    console.log(`[storefront] Purchase completed: ${buyerPubkey} bought "${listing.title}" (${listingId}) for ${listing.priceSats} sats`);

    return {
      purchaseId: purchase!.id,
      downloadToken,
      expiresAt,
      maxDownloads,
    };
  });
}

/**
 * Get download URL for a purchased asset. Validates token, expiry, and download count.
 * NEVER leaks file URLs without a valid purchase + download token.
 */
export async function getDownload(listingId: string, downloadToken: string, buyerPubkey?: string) {
  if (!downloadToken || downloadToken.trim().length === 0) {
    throw new Error('download_token is required');
  }

  return await db.transaction(async (tx) => {
    // Find purchase by download token and listing
    const [purchase] = await tx
      .select()
      .from(assetPurchases)
      .where(
        and(
          eq(assetPurchases.listingId, listingId),
          eq(assetPurchases.downloadToken, downloadToken.trim()),
        ),
      )
      .for('update');

    if (!purchase) throw new Error('Invalid download token');

    // Verify the requesting user owns this download token
    if (buyerPubkey && purchase.buyerPubkey !== buyerPubkey) {
      throw new Error('Invalid download token');
    }

    // Check expiry
    if (purchase.expiresAt && new Date() > purchase.expiresAt) {
      throw new Error('Download link has expired');
    }

    // Check download count
    if (purchase.downloadCount >= purchase.maxDownloads) {
      throw new Error(`Maximum downloads reached (${purchase.maxDownloads})`);
    }

    // Increment download count
    await tx
      .update(assetPurchases)
      .set({
        downloadCount: sql`${assetPurchases.downloadCount} + 1`,
      })
      .where(eq(assetPurchases.id, purchase.id));

    // Fetch the listing to get file details
    const [listing] = await tx
      .select({
        fileUrl: assetListings.fileUrl,
        fileHash: assetListings.fileHash,
        title: assetListings.title,
      })
      .from(assetListings)
      .where(eq(assetListings.id, listingId))
      .limit(1);

    if (!listing) throw new Error('Listing not found');

    console.log(`[storefront] Download: token ${downloadToken.substring(0, 8)}... for listing ${listingId} (${purchase.downloadCount + 1}/${purchase.maxDownloads})`);

    return {
      fileUrl: listing.fileUrl,
      fileHash: listing.fileHash,
      fileName: listing.title,
    };
  });
}

// ── Rating ──

/** Rate a purchased asset. Updates purchase rating and recalculates listing avgRating. Atomic. */
export async function ratePurchase(purchaseId: string, buyerPubkey: string, rating: number) {
  assertValidRating(rating);

  return await db.transaction(async (tx) => {
    // Lock purchase row
    const [purchase] = await tx
      .select()
      .from(assetPurchases)
      .where(eq(assetPurchases.id, purchaseId))
      .for('update');

    if (!purchase) throw new Error('Purchase not found');
    if (purchase.buyerPubkey !== buyerPubkey) throw new Error('Not the buyer of this purchase');
    if (purchase.rating !== null) throw new Error('Already rated this purchase');

    // Update purchase with rating
    await tx
      .update(assetPurchases)
      .set({
        rating,
        ratedAt: new Date(),
      })
      .where(eq(assetPurchases.id, purchaseId));

    // Recalculate avgRating on the listing from all rated purchases
    // Lock the listing row to prevent concurrent rating races
    await tx
      .select({ id: assetListings.id })
      .from(assetListings)
      .where(eq(assetListings.id, purchase.listingId))
      .for('update');

    const [ratingStats] = await tx
      .select({
        avgRating: sql<number>`AVG(${assetPurchases.rating})::real`,
        ratingCount: sql<number>`COUNT(${assetPurchases.rating})::int`,
      })
      .from(assetPurchases)
      .where(and(
        eq(assetPurchases.listingId, purchase.listingId),
        sql`${assetPurchases.rating} IS NOT NULL`,
      ));

    await tx
      .update(assetListings)
      .set({
        avgRating: ratingStats?.avgRating ?? null,
        ratingCount: ratingStats?.ratingCount ?? 0,
        updatedAt: new Date(),
      })
      .where(eq(assetListings.id, purchase.listingId));

    // Fetch listing for event logging
    const [listing] = await tx
      .select({ storefrontId: assetListings.storefrontId })
      .from(assetListings)
      .where(eq(assetListings.id, purchase.listingId))
      .limit(1);

    if (listing) {
      await tx
        .insert(storefrontEvents)
        .values({
          storefrontId: listing.storefrontId,
          eventType: 'rating_submitted',
          actorPubkey: buyerPubkey,
          metadata: {
            purchaseId,
            listingId: purchase.listingId,
            rating,
          },
        });
    }

    console.log(`[storefront] Rating: purchase ${purchaseId} rated ${rating}/5 for listing ${purchase.listingId}`);
    return { purchaseId, rating, listingId: purchase.listingId };
  });
}

// ── Aliases (match names expected by route handlers) ──

/** Alias for getListing — used by public routes. */
export const getListingDetail = getListing;

/** Alias for listMyStorefronts — used by authenticated routes. */
export const listOwnerStorefronts = listMyStorefronts;

/** Alias for startCheckout — used by authenticated routes. */
export const checkoutListing = startCheckout;

/** Alias for getDownload — used by authenticated routes. */
export const getDownloadUrl = getDownload;

/** Alias for ratePurchase — used by authenticated routes. */
export const rateListing = ratePurchase;

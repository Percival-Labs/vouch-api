// Storefront Routes — Vouch Agent Digital Storefront Commerce
// NIP-98 auth for authenticated routes (create, update, listings, checkout, confirm, rate).
// Public routes (browse, detail) are added to public.ts separately.

import { Hono } from 'hono';
import { success, error } from '../lib/response';
import {
  validate,
  CreateStorefrontSchema,
  UpdateStorefrontSchema,
  CreateListingSchema,
  UpdateListingSchema,
  CheckoutSchema,
  ConfirmPurchaseSchema,
  RateListingSchema,
} from '../lib/schemas';
import type { NostrAuthEnv } from '../middleware/nostr-auth';

const app = new Hono<NostrAuthEnv>();

// ── Helper: get authenticated pubkey ──
function getPubkey(c: { get: (key: string) => string | undefined }) {
  const pubkey = c.get('nostrPubkey');
  if (!pubkey) return null;
  return pubkey;
}

// ── POST / — Create storefront ──
app.post('/', async (c) => {
  const pubkey = getPubkey(c);
  if (!pubkey) return error(c, 401, 'AUTH_REQUIRED', 'Authentication required');

  try {
    const raw = await c.req.json();
    const parsed = validate(CreateStorefrontSchema, raw);
    if (!parsed.success) {
      return error(c, 400, parsed.error.code, parsed.error.message, parsed.error.details);
    }
    const body = parsed.data;

    const { createStorefront } = await import('../services/storefront-service');
    const result = await createStorefront({
      ownerPubkey: pubkey,
      name: body.name,
      slug: body.slug,
      description: body.description,
      logoUrl: body.logo_url,
      bannerUrl: body.banner_url,
      relayUrls: body.relay_urls,
      settings: body.settings,
    });

    return success(c, result, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[storefront] POST / error:', message);
    if (message.includes('slug')) return error(c, 400, 'VALIDATION_ERROR', message);
    if (message.includes('unique')) return error(c, 409, 'DUPLICATE_SLUG', 'A storefront with this slug already exists');
    if (message.includes('already owns')) return error(c, 409, 'DUPLICATE_STOREFRONT', message);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to create storefront');
  }
});

// ── GET /my — List my storefronts ──
app.get('/my', async (c) => {
  const pubkey = getPubkey(c);
  if (!pubkey) return error(c, 401, 'AUTH_REQUIRED', 'Authentication required');

  try {
    const { listMyStorefronts } = await import('../services/storefront-service');
    const result = await listMyStorefronts(pubkey);
    return success(c, result);
  } catch (err) {
    console.error('[storefront] GET /my error:', err);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to list storefronts');
  }
});

// ── PATCH /:id — Update storefront settings ──
app.patch('/:id', async (c) => {
  const pubkey = getPubkey(c);
  if (!pubkey) return error(c, 401, 'AUTH_REQUIRED', 'Authentication required');

  try {
    const storefrontId = c.req.param('id');
    const raw = await c.req.json();
    const parsed = validate(UpdateStorefrontSchema, raw);
    if (!parsed.success) {
      return error(c, 400, parsed.error.code, parsed.error.message, parsed.error.details);
    }
    const body = parsed.data;

    const { updateStorefront } = await import('../services/storefront-service');
    const result = await updateStorefront(storefrontId, pubkey, {
      name: body.name,
      description: body.description,
      logoUrl: body.logo_url ?? undefined,
      bannerUrl: body.banner_url ?? undefined,
      relayUrls: body.relay_urls,
      settings: body.settings,
    });

    return success(c, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[storefront] PATCH /:id error:', message);
    if (message.includes('not found')) return error(c, 404, 'NOT_FOUND', message);
    if (message.includes('owner')) return error(c, 403, 'FORBIDDEN', message);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to update storefront');
  }
});

// ── POST /:id/listings — Create listing ──
app.post('/:id/listings', async (c) => {
  const pubkey = getPubkey(c);
  if (!pubkey) return error(c, 401, 'AUTH_REQUIRED', 'Authentication required');

  try {
    const storefrontId = c.req.param('id');
    const raw = await c.req.json();
    const parsed = validate(CreateListingSchema, raw);
    if (!parsed.success) {
      return error(c, 400, parsed.error.code, parsed.error.message, parsed.error.details);
    }
    const body = parsed.data;

    const { createListing } = await import('../services/storefront-service');
    const result = await createListing({
      storefrontId,
      creatorPubkey: pubkey,
      title: body.title,
      slug: body.slug,
      description: body.description,
      priceSats: body.price_sats,
      priceUsdCents: body.price_usd_cents,
      category: body.category,
      fileHash: body.file_hash,
      fileUrl: body.file_url,
      fileSizeBytes: body.file_size_bytes,
      previewUrls: body.preview_urls,
      metadata: body.metadata,
      tags: body.tags,
    });

    return success(c, result, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[storefront] POST /:id/listings error:', message);
    if (message.includes('not found')) return error(c, 404, 'NOT_FOUND', message);
    if (message.includes('owner')) return error(c, 403, 'FORBIDDEN', message);
    if (message.includes('slug')) return error(c, 400, 'VALIDATION_ERROR', message);
    if (message.includes('unique')) return error(c, 409, 'DUPLICATE_SLUG', 'A listing with this slug already exists in this storefront');
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to create listing');
  }
});

// ── PATCH /:id/listings/:lid — Update listing ──
app.patch('/:id/listings/:lid', async (c) => {
  const pubkey = getPubkey(c);
  if (!pubkey) return error(c, 401, 'AUTH_REQUIRED', 'Authentication required');

  try {
    const listingId = c.req.param('lid');
    const raw = await c.req.json();
    const parsed = validate(UpdateListingSchema, raw);
    if (!parsed.success) {
      return error(c, 400, parsed.error.code, parsed.error.message, parsed.error.details);
    }
    const body = parsed.data;

    const { updateListing } = await import('../services/storefront-service');
    const result = await updateListing(listingId, pubkey, {
      title: body.title,
      description: body.description,
      priceSats: body.price_sats,
      previewUrls: body.preview_urls,
      metadata: body.metadata,
      tags: body.tags,
    });

    return success(c, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[storefront] PATCH /:id/listings/:lid error:', message);
    if (message.includes('not found')) return error(c, 404, 'NOT_FOUND', message);
    if (message.includes('owner')) return error(c, 403, 'FORBIDDEN', message);
    if (message.includes('delisted')) return error(c, 409, 'INVALID_STATE', message);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to update listing');
  }
});

// ── DELETE /:id/listings/:lid — Delist (soft delete) ──
app.delete('/:id/listings/:lid', async (c) => {
  const pubkey = getPubkey(c);
  if (!pubkey) return error(c, 401, 'AUTH_REQUIRED', 'Authentication required');

  try {
    const listingId = c.req.param('lid');

    const { delistListing } = await import('../services/storefront-service');
    await delistListing(listingId, pubkey);

    return success(c, { delisted: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[storefront] DELETE /:id/listings/:lid error:', message);
    if (message.includes('not found')) return error(c, 404, 'NOT_FOUND', message);
    if (message.includes('owner')) return error(c, 403, 'FORBIDDEN', message);
    if (message.includes('already delisted')) return error(c, 409, 'INVALID_STATE', message);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to delist listing');
  }
});

// ── POST /:id/listings/:lid/checkout — Start purchase, returns invoice ──
app.post('/:id/listings/:lid/checkout', async (c) => {
  const pubkey = getPubkey(c);
  if (!pubkey) return error(c, 401, 'AUTH_REQUIRED', 'Authentication required');

  try {
    const listingId = c.req.param('lid');
    const raw = await c.req.json();
    const parsed = validate(CheckoutSchema, raw);
    if (!parsed.success) {
      return error(c, 400, parsed.error.code, parsed.error.message, parsed.error.details);
    }

    const { startCheckout } = await import('../services/storefront-service');
    const result = await startCheckout(listingId, pubkey, parsed.data.method);

    return success(c, result, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[storefront] POST /:id/listings/:lid/checkout error:', message);
    if (message.includes('not found')) return error(c, 404, 'NOT_FOUND', message);
    if (message.includes('not active') || message.includes('not allowed')) return error(c, 409, 'INVALID_STATE', message);
    if (message.includes('your own')) return error(c, 403, 'FORBIDDEN', message);
    if (message.includes('already purchased')) return error(c, 409, 'ALREADY_PURCHASED', message);
    if (message.includes('not yet supported')) return error(c, 400, 'UNSUPPORTED_METHOD', message);
    if (message.includes('invoice') || message.includes('Lightning')) return error(c, 500, 'PAYMENT_ERROR', message);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to create checkout');
  }
});

// ── POST /:id/listings/:lid/confirm — Confirm payment, returns download token ──
app.post('/:id/listings/:lid/confirm', async (c) => {
  const pubkey = getPubkey(c);
  if (!pubkey) return error(c, 401, 'AUTH_REQUIRED', 'Authentication required');

  try {
    const listingId = c.req.param('lid');
    const raw = await c.req.json();
    const parsed = validate(ConfirmPurchaseSchema, raw);
    if (!parsed.success) {
      return error(c, 400, parsed.error.code, parsed.error.message, parsed.error.details);
    }

    const { confirmPurchase } = await import('../services/storefront-service');
    const result = await confirmPurchase(listingId, pubkey, parsed.data.payment_hash);

    return success(c, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[storefront] POST /:id/listings/:lid/confirm error:', message);
    if (message.includes('not found')) return error(c, 404, 'NOT_FOUND', message);
    if (message.includes('payment') || message.includes('settled')) return error(c, 402, 'PAYMENT_FAILED', message);
    if (message.includes('already')) return error(c, 409, 'ALREADY_CONFIRMED', message);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to confirm purchase');
  }
});

// ── GET /:id/listings/:lid/download — Download file (requires valid download token) ──
app.get('/:id/listings/:lid/download', async (c) => {
  const pubkey = getPubkey(c);
  if (!pubkey) return error(c, 401, 'AUTH_REQUIRED', 'Authentication required');

  try {
    const listingId = c.req.param('lid');
    const token = c.req.query('token');

    if (!token) {
      return error(c, 400, 'VALIDATION_ERROR', 'Download token is required as ?token= query parameter');
    }

    const { getDownload } = await import('../services/storefront-service');
    const result = await getDownload(listingId, token, pubkey);

    return success(c, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[storefront] GET /:id/listings/:lid/download error:', message);
    if (message.includes('not found')) return error(c, 404, 'NOT_FOUND', message);
    if (message.includes('Invalid download token')) return error(c, 403, 'INVALID_TOKEN', message);
    if (message.includes('expired')) return error(c, 403, 'TOKEN_EXPIRED', message);
    if (message.includes('Maximum downloads')) return error(c, 403, 'DOWNLOAD_LIMIT', message);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to get download URL');
  }
});

// ── POST /:id/listings/:lid/rate — Rate a purchased listing ──
app.post('/:id/listings/:lid/rate', async (c) => {
  const pubkey = getPubkey(c);
  if (!pubkey) return error(c, 401, 'AUTH_REQUIRED', 'Authentication required');

  try {
    const listingId = c.req.param('lid');
    const raw = await c.req.json();
    const parsed = validate(RateListingSchema, raw);
    if (!parsed.success) {
      return error(c, 400, parsed.error.code, parsed.error.message, parsed.error.details);
    }

    // Find the buyer's purchase for this listing to get the purchaseId
    const { db, assetPurchases } = await import('@percival/vouch-db');
    const { eq, and } = await import('drizzle-orm');

    const [purchase] = await db
      .select({ id: assetPurchases.id })
      .from(assetPurchases)
      .where(
        and(
          eq(assetPurchases.listingId, listingId),
          eq(assetPurchases.buyerPubkey, pubkey),
        ),
      )
      .limit(1);

    if (!purchase) {
      return error(c, 403, 'FORBIDDEN', 'You must purchase this listing before rating it');
    }

    const { ratePurchase } = await import('../services/storefront-service');
    const result = await ratePurchase(purchase.id, pubkey, parsed.data.rating);

    return success(c, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[storefront] POST /:id/listings/:lid/rate error:', message);
    if (message.includes('not found')) return error(c, 404, 'NOT_FOUND', message);
    if (message.includes('Not the buyer')) return error(c, 403, 'FORBIDDEN', 'You must purchase this listing before rating it');
    if (message.includes('Already rated')) return error(c, 409, 'ALREADY_RATED', message);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to rate listing');
  }
});

export default app;

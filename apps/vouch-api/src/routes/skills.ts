// Skill Marketplace Routes — Vouch Agent Skill Commerce
// NIP-98 auth for authenticated routes (create, purchase, rate, my/* queries).
// Public routes (browse, detail) should be added to public.ts separately.

import { Hono } from 'hono';
import { success, error } from '../lib/response';
import { validate, CreateSkillSchema } from '../lib/schemas';
import type { NostrAuthEnv } from '../middleware/nostr-auth';
import {
  createSkill,
  listCreatorSkills,
  listPurchasedSkills,
  purchaseSkill,
  rateSkill,
} from '../services/skill-service';

const app = new Hono<NostrAuthEnv>();

// ── Helper: get authenticated pubkey ──
function getPubkey(c: { get: (key: string) => string | undefined }) {
  const pubkey = c.get('nostrPubkey');
  if (!pubkey) return null;
  return pubkey;
}

// ── POST / — Create skill listing ──
// M1 fix: Added Zod schema validation (was raw JSON type assertion)
app.post('/', async (c) => {
  const pubkey = getPubkey(c);
  if (!pubkey) return error(c, 401, 'AUTH_REQUIRED', 'Authentication required');

  try {
    const raw = await c.req.json();
    const parsed = validate(CreateSkillSchema, raw);
    if (!parsed.success) {
      return error(c, 400, parsed.error.code, parsed.error.message, parsed.error.details);
    }
    const body = parsed.data;

    const result = await createSkill({
      creatorPubkey: pubkey,
      name: body.name,
      slug: body.slug,
      description: body.description,
      priceSats: body.price_sats,
      royaltyRateBps: body.royalty_rate_bps,
      tags: body.tags,
      contentHash: body.content_hash,
      sourceUrl: body.source_url,
    });

    return success(c, result, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[skills] POST / error:', message);
    if (message.includes('slug')) return error(c, 400, 'VALIDATION_ERROR', message);
    if (message.includes('price_sats')) return error(c, 400, 'VALIDATION_ERROR', message);
    if (message.includes('royalty_rate_bps')) return error(c, 400, 'VALIDATION_ERROR', message);
    if (message.includes('name is required')) return error(c, 400, 'VALIDATION_ERROR', message);
    if (message.includes('description is required')) return error(c, 400, 'VALIDATION_ERROR', message);
    if (message.includes('unique')) return error(c, 409, 'DUPLICATE_SLUG', 'A skill with this slug already exists');
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to create skill');
  }
});

// ── GET /my/created — List skills I created ──
app.get('/my/created', async (c) => {
  const pubkey = getPubkey(c);
  if (!pubkey) return error(c, 401, 'AUTH_REQUIRED', 'Authentication required');

  try {
    const result = await listCreatorSkills(pubkey);
    return success(c, result);
  } catch (err) {
    console.error('[skills] GET /my/created error:', err);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to list created skills');
  }
});

// ── GET /my/purchased — List skills I purchased ──
app.get('/my/purchased', async (c) => {
  const pubkey = getPubkey(c);
  if (!pubkey) return error(c, 401, 'AUTH_REQUIRED', 'Authentication required');

  try {
    const result = await listPurchasedSkills(pubkey);
    return success(c, result);
  } catch (err) {
    console.error('[skills] GET /my/purchased error:', err);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to list purchased skills');
  }
});

// ── POST /:id/purchase — Purchase a skill ──
app.post('/:id/purchase', async (c) => {
  const pubkey = getPubkey(c);
  if (!pubkey) return error(c, 401, 'AUTH_REQUIRED', 'Authentication required');

  try {
    const skillId = c.req.param('id');
    const body = await c.req.json<{ payment_hash: string }>();

    if (!body.payment_hash) {
      return error(c, 400, 'VALIDATION_ERROR', 'payment_hash is required');
    }

    const result = await purchaseSkill(skillId, pubkey, body.payment_hash);
    return success(c, result, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[skills] POST /:id/purchase error:', message);
    if (message.includes('not found')) return error(c, 404, 'NOT_FOUND', message);
    if (message.includes('not allowed')) return error(c, 409, 'INVALID_STATE', message);
    if (message.includes('your own')) return error(c, 403, 'FORBIDDEN', message);
    if (message.includes('Already purchased')) return error(c, 409, 'ALREADY_PURCHASED', message);
    if (message.includes('payment_hash')) return error(c, 400, 'VALIDATION_ERROR', message);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to purchase skill');
  }
});

// ── POST /:id/rate — Rate a purchased skill ──
app.post('/:id/rate', async (c) => {
  const pubkey = getPubkey(c);
  if (!pubkey) return error(c, 401, 'AUTH_REQUIRED', 'Authentication required');

  try {
    const skillId = c.req.param('id');
    const body = await c.req.json<{ rating: number }>();

    if (typeof body.rating !== 'number') {
      return error(c, 400, 'VALIDATION_ERROR', 'rating is required and must be a number (1-5)');
    }

    // Find the purchase for this skill by this buyer
    // (rate by skill ID, not purchase ID — more ergonomic for callers)
    const { listPurchasedSkills: getPurchases } = await import('../services/skill-service');
    const purchases = await getPurchases(pubkey);
    const purchase = purchases.find((p) => p.purchase.skillId === skillId);

    if (!purchase) {
      return error(c, 404, 'NOT_FOUND', 'You have not purchased this skill');
    }

    const result = await rateSkill(purchase.purchase.id, body.rating);
    return success(c, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[skills] POST /:id/rate error:', message);
    if (message.includes('not found')) return error(c, 404, 'NOT_FOUND', message);
    if (message.includes('Already rated')) return error(c, 409, 'ALREADY_RATED', message);
    if (message.includes('rating must be')) return error(c, 400, 'VALIDATION_ERROR', message);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to rate skill');
  }
});

export default app;

// ── PUBLIC ROUTES (add to public.ts) ──
//
// Add these two endpoints to apps/vouch-api/src/routes/public.ts:
//
// import { listPublicSkills, getSkill } from '../services/skill-service';
//
// // GET /skills — Browse public skill marketplace
// app.get('/skills', async (c) => {
//   try {
//     const tag = c.req.query('tag');
//     const search = c.req.query('search');
//     const sortBy = (c.req.query('sort_by') || 'createdAt') as 'purchaseCount' | 'avgRating' | 'createdAt';
//     const sortDir = (c.req.query('sort_dir') || 'desc') as 'asc' | 'desc';
//     const page = parseInt(c.req.query('page') || '1', 10);
//     const limit = parseInt(c.req.query('limit') || '25', 10);
//
//     const result = await listPublicSkills({ tag, search, sortBy, sortDir, page, limit });
//     return c.json({ data: result.data, meta: result.meta });
//   } catch (err) {
//     const message = err instanceof Error ? err.message : String(err);
//     console.error('[public] GET /skills error:', message);
//     return error(c, 500, 'INTERNAL_ERROR', 'Failed to list skills');
//   }
// });
//
// // GET /skills/:id — Public skill detail
// app.get('/skills/:id', async (c) => {
//   try {
//     const skillId = c.req.param('id');
//     const skill = await getSkill(skillId);
//     if (!skill) return error(c, 404, 'NOT_FOUND', 'Skill not found');
//     if (skill.status !== 'active') return error(c, 404, 'NOT_FOUND', 'Skill not found');
//     return c.json({ data: skill });
//   } catch (err) {
//     const message = err instanceof Error ? err.message : String(err);
//     console.error('[public] GET /skills/:id error:', message);
//     return error(c, 500, 'INTERNAL_ERROR', 'Failed to get skill');
//   }
// });

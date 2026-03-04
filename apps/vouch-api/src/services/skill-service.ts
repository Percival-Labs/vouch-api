// Vouch — Skill Marketplace Service
// Business logic for agent skill commerce: listing, purchasing, rating, and revenue tracking.
// All financial mutations use db.transaction() for atomicity (matching staking-service pattern).
// Prices are in sats (Lightning-native). Royalty rates in basis points (bps).

import { eq, and, sql, desc, asc, ilike } from 'drizzle-orm';
import { db, skills, skillPurchases } from '@percival/vouch-db';

// ── Types ──

export interface CreateSkillParams {
  creatorPubkey: string;
  name: string;
  slug: string;
  description: string;
  priceSats: number;
  royaltyRateBps?: number;
  tags?: string[];
  contentHash?: string;
  sourceUrl?: string;
}

export interface ListSkillsFilters {
  tag?: string;
  status?: 'active' | 'suspended' | 'delisted';
  search?: string;
  sortBy?: 'purchaseCount' | 'avgRating' | 'createdAt';
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
    throw new Error('slug must be lowercase alphanumeric with hyphens (e.g. "my-skill")');
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

// ── Skill CRUD ──

/** Create a new skill listing. Creator must be authenticated via NIP-98. */
export async function createSkill(params: CreateSkillParams) {
  assertPositiveInt(params.priceSats, 'price_sats', 100_000_000); // 1 BTC cap
  assertValidSlug(params.slug);

  if (params.royaltyRateBps !== undefined) {
    if (!Number.isInteger(params.royaltyRateBps) || params.royaltyRateBps < 0 || params.royaltyRateBps > 5000) {
      throw new Error('royalty_rate_bps must be an integer between 0 and 5000 (0-50%)');
    }
  }

  if (!params.name || params.name.trim().length === 0) {
    throw new Error('name is required');
  }
  if (params.name.trim().length > 200) {
    throw new Error('name must be under 200 characters');
  }
  if (!params.description || params.description.trim().length === 0) {
    throw new Error('description is required');
  }
  if (params.description.trim().length > 10000) {
    throw new Error('description must be under 10,000 characters');
  }

  // Validate tags
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

  // Validate sourceUrl
  if (params.sourceUrl) {
    if (params.sourceUrl.length > 2000) {
      throw new Error('source_url must be under 2000 characters');
    }
    if (!params.sourceUrl.startsWith('https://')) {
      throw new Error('source_url must start with https://');
    }
  }

  const [skill] = await db
    .insert(skills)
    .values({
      creatorPubkey: params.creatorPubkey,
      name: params.name.trim(),
      slug: params.slug,
      description: params.description.trim(),
      priceSats: params.priceSats,
      royaltyRateBps: params.royaltyRateBps ?? 1000, // default 10%
      tags: params.tags ?? [],
      contentHash: params.contentHash ?? null,
      sourceUrl: params.sourceUrl ?? null,
    })
    .returning();

  console.log(`[skills] Created skill "${skill!.name}" (${skill!.id}) by ${params.creatorPubkey}`);
  return skill!;
}

/** List public skills with filtering, search, and pagination. */
export async function listPublicSkills(filters: ListSkillsFilters = {}) {
  const page = filters.page ?? 1;
  const limit = Math.min(filters.limit ?? 25, 100);
  const offset = (page - 1) * limit;
  const status = filters.status ?? 'active';

  // Build WHERE conditions
  const conditions = [eq(skills.status, status)];

  if (filters.tag) {
    // GIN index on jsonb tags column — check if array contains the tag
    conditions.push(sql`${skills.tags} @> ${JSON.stringify([filters.tag])}::jsonb`);
  }

  if (filters.search) {
    // Escape LIKE metacharacters to prevent wildcard injection / DoS
    const escaped = filters.search.replace(/[%_\\]/g, '\\$&');
    conditions.push(
      sql`(${ilike(skills.name, `%${escaped}%`)} OR ${ilike(skills.description, `%${escaped}%`)})`,
    );
  }

  const whereClause = and(...conditions);

  // Determine sort order
  let orderByClause;
  const direction = filters.sortDir === 'asc' ? asc : desc;
  switch (filters.sortBy) {
    case 'purchaseCount':
      orderByClause = direction(skills.purchaseCount);
      break;
    case 'avgRating':
      // NULL ratings sort last when descending
      orderByClause = sql`${skills.avgRating} ${filters.sortDir === 'asc' ? sql`ASC NULLS LAST` : sql`DESC NULLS LAST`}`;
      break;
    case 'createdAt':
    default:
      orderByClause = direction(skills.createdAt);
      break;
  }

  const rows = await db
    .select()
    .from(skills)
    .where(whereClause)
    .orderBy(orderByClause)
    .limit(limit)
    .offset(offset);

  const countResult = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(skills)
    .where(whereClause);

  const total = countResult[0]?.count ?? 0;

  return {
    data: rows,
    meta: { page, limit, total, has_more: offset + limit < total },
  };
}

/** Get a single skill by ID. */
export async function getSkill(skillId: string) {
  const [skill] = await db
    .select()
    .from(skills)
    .where(eq(skills.id, skillId))
    .limit(1);

  return skill ?? null;
}

/** Get a single skill by slug. */
export async function getSkillBySlug(slug: string) {
  const [skill] = await db
    .select()
    .from(skills)
    .where(eq(skills.slug, slug))
    .limit(1);

  return skill ?? null;
}

// ── Purchase & Rating ──

/**
 * Purchase a skill. Inserts purchase record and increments purchaseCount. Atomic.
 *
 * H2 fix: Server-side invoice verification added. The payment hash is verified against
 * the Lightning node via NWC lookupInvoice before recording the purchase. If the
 * node is unreachable or doesn't support lookup_invoice, the purchase is rejected
 * with a clear error (fail-closed).
 */
export async function purchaseSkill(skillId: string, buyerPubkey: string, paymentHash: string) {
  if (!paymentHash || paymentHash.trim().length === 0) {
    throw new Error('payment_hash is required');
  }
  // Validate payment hash format — must be 64-char hex (SHA-256 hash)
  if (!/^[0-9a-f]{64}$/i.test(paymentHash.trim())) {
    throw new Error('payment_hash must be a 64-character hex string');
  }

  // H2 fix: Verify the invoice was actually paid before recording purchase
  const { lookupInvoice } = await import('./albyhub-service');
  const invoice = await lookupInvoice(paymentHash.trim());
  if (!invoice) {
    throw new Error('Unable to verify payment — invoice not found or Lightning node unreachable');
  }
  if (!invoice.settled) {
    throw new Error('Payment not yet settled — please pay the invoice first');
  }

  return await db.transaction(async (tx) => {
    // Lock skill row and verify it's active
    const [skill] = await tx
      .select()
      .from(skills)
      .where(eq(skills.id, skillId))
      .for('update');

    if (!skill) throw new Error('Skill not found');
    if (skill.status !== 'active') throw new Error(`Skill is ${skill.status} — purchase not allowed`);

    // Prevent creator from purchasing their own skill
    if (skill.creatorPubkey === buyerPubkey) {
      throw new Error('Cannot purchase your own skill');
    }

    // Check for duplicate purchase (same buyer + same skill)
    const [existing] = await tx
      .select({ id: skillPurchases.id })
      .from(skillPurchases)
      .where(and(eq(skillPurchases.skillId, skillId), eq(skillPurchases.buyerPubkey, buyerPubkey)))
      .limit(1);

    if (existing) {
      throw new Error('Already purchased this skill');
    }

    // Insert purchase
    const [purchase] = await tx
      .insert(skillPurchases)
      .values({
        skillId,
        buyerPubkey,
        pricePaidSats: skill.priceSats,
        paymentHash: paymentHash.trim(),
      })
      .returning();

    // Increment purchase count on skill
    await tx
      .update(skills)
      .set({
        purchaseCount: sql`${skills.purchaseCount} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(skills.id, skillId));

    console.log(`[skills] Purchase: ${buyerPubkey} bought "${skill.name}" (${skillId}) for ${skill.priceSats} sats`);
    return purchase!;
  });
}

/** Rate a purchased skill. Updates purchase rating and recalculates skill avgRating. Atomic. */
export async function rateSkill(purchaseId: string, rating: number) {
  assertValidRating(rating);

  return await db.transaction(async (tx) => {
    // Lock purchase row
    const [purchase] = await tx
      .select()
      .from(skillPurchases)
      .where(eq(skillPurchases.id, purchaseId))
      .for('update');

    if (!purchase) throw new Error('Purchase not found');
    if (purchase.rating !== null) throw new Error('Already rated this skill');

    // Update purchase with rating
    await tx
      .update(skillPurchases)
      .set({
        rating,
        ratedAt: new Date(),
      })
      .where(eq(skillPurchases.id, purchaseId));

    // Recalculate avgRating on the skill from all rated purchases
    // Lock the skill row for update to prevent concurrent rating races
    await tx
      .select({ id: skills.id })
      .from(skills)
      .where(eq(skills.id, purchase.skillId))
      .for('update');

    const [ratingStats] = await tx
      .select({
        avgRating: sql<number>`AVG(${skillPurchases.rating})::real`,
        ratingCount: sql<number>`COUNT(${skillPurchases.rating})::int`,
      })
      .from(skillPurchases)
      .where(and(
        eq(skillPurchases.skillId, purchase.skillId),
        sql`${skillPurchases.rating} IS NOT NULL`,
      ));

    await tx
      .update(skills)
      .set({
        avgRating: ratingStats?.avgRating ?? null,
        ratingCount: ratingStats?.ratingCount ?? 0,
        updatedAt: new Date(),
      })
      .where(eq(skills.id, purchase.skillId));

    console.log(`[skills] Rating: purchase ${purchaseId} rated ${rating}/5 for skill ${purchase.skillId}`);
    return { purchaseId, rating, skillId: purchase.skillId };
  });
}

// ── Creator & Buyer Queries ──

/** List skills created by a specific pubkey. */
export async function listCreatorSkills(creatorPubkey: string) {
  return db
    .select()
    .from(skills)
    .where(eq(skills.creatorPubkey, creatorPubkey))
    .orderBy(desc(skills.createdAt));
}

/** List purchases by a specific buyer, joined with skill details. */
export async function listPurchasedSkills(buyerPubkey: string) {
  return db
    .select({
      purchase: skillPurchases,
      skill: skills,
    })
    .from(skillPurchases)
    .innerJoin(skills, eq(skills.id, skillPurchases.skillId))
    .where(eq(skillPurchases.buyerPubkey, buyerPubkey))
    .orderBy(desc(skillPurchases.createdAt));
}

// ── Revenue Tracking ──

/** Update revenue tracking on a purchase when the skill is used in a contract. Atomic. */
export async function updateSkillRevenueTracking(
  purchaseId: string,
  contractId: string,
  revenueSats: number,
) {
  assertPositiveInt(revenueSats, 'revenue_sats', 100_000_000);

  return await db.transaction(async (tx) => {
    // Lock purchase row
    const [purchase] = await tx
      .select()
      .from(skillPurchases)
      .where(eq(skillPurchases.id, purchaseId))
      .for('update');

    if (!purchase) throw new Error('Purchase not found');

    await tx
      .update(skillPurchases)
      .set({
        contractsUsingSkill: sql`${skillPurchases.contractsUsingSkill} + 1`,
        revenueFromSkillSats: sql`${skillPurchases.revenueFromSkillSats} + ${revenueSats}`,
      })
      .where(eq(skillPurchases.id, purchaseId));

    console.log(`[skills] Revenue: purchase ${purchaseId} used in contract ${contractId}, +${revenueSats} sats`);
    return { purchaseId, contractId, revenueSats };
  });
}

// Table routes — browse and list tables

import { Hono } from 'hono';
import { db, tables, memberships } from '@percival/vouch-db';
import { eq, desc, sql, and } from 'drizzle-orm';
import { success, paginated, error } from '../lib/response';
import type { AppEnv } from '../middleware/verify-signature';

const app = new Hono<AppEnv>();

// ── GET / — List tables (paginated) ──
app.get('/', async (c) => {
  const limit = Math.min(parseInt(c.req.query('limit') || '25', 10), 100);
  const page = Math.max(parseInt(c.req.query('page') || '1', 10), 1);
  const offset = (page - 1) * limit;
  const type = c.req.query('type'); // 'public' | 'private' | 'paid'

  try {
    const conditions = type ? eq(tables.type, type as 'public' | 'private' | 'paid') : undefined;

    const [rows, countResult] = await Promise.all([
      db.select()
        .from(tables)
        .where(conditions)
        .orderBy(desc(tables.subscriberCount))
        .limit(limit)
        .offset(offset),
      db.select({ count: sql<number>`count(*)` })
        .from(tables)
        .where(conditions),
    ]);

    const total = Number(countResult[0].count);

    return paginated(c, rows.map((t) => ({
      id: t.id,
      slug: t.slug,
      name: t.name,
      description: t.description,
      type: t.type,
      icon_url: t.iconUrl,
      banner_url: t.bannerUrl,
      subscriber_count: t.subscriberCount,
      post_count: t.postCount,
      price_cents: t.priceCents,
      created_at: t.createdAt.toISOString(),
    })), {
      page,
      limit,
      total,
      has_more: offset + limit < total,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[api] GET /v1/tables error:', message);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to list tables');
  }
});

// ── GET /:slug — Table detail ──
app.get('/:slug', async (c) => {
  const slug = c.req.param('slug');

  try {
    const table = await db.select().from(tables).where(eq(tables.slug, slug)).limit(1);
    if (table.length === 0) {
      return error(c, 404, 'NOT_FOUND', `Table "${slug}" not found`);
    }

    return success(c, {
      id: table[0].id,
      slug: table[0].slug,
      name: table[0].name,
      description: table[0].description,
      type: table[0].type,
      icon_url: table[0].iconUrl,
      banner_url: table[0].bannerUrl,
      rules: table[0].rules,
      subscriber_count: table[0].subscriberCount,
      post_count: table[0].postCount,
      price_cents: table[0].priceCents,
      created_at: table[0].createdAt.toISOString(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[api] GET /v1/tables/${slug} error:`, message);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to fetch table');
  }
});

// ── POST /:slug/join — Agent joins a table ──
app.post('/:slug/join', async (c) => {
  const slug = c.req.param('slug');
  const agentId = c.get('verifiedAgentId');
  if (!agentId) {
    return error(c, 401, 'UNAUTHORIZED', 'Authentication required');
  }

  try {
    // Find the table
    const table = await db.select().from(tables).where(eq(tables.slug, slug)).limit(1);
    if (table.length === 0) {
      return error(c, 404, 'NOT_FOUND', `Table "${slug}" not found`);
    }

    // Check if already a member
    const existing = await db.select().from(memberships).where(
      and(
        eq(memberships.tableId, table[0].id),
        eq(memberships.memberId, agentId),
        eq(memberships.memberType, 'agent'),
      ),
    ).limit(1);

    if (existing.length > 0) {
      return error(c, 409, 'ALREADY_MEMBER', 'Agent is already a member of this table');
    }

    // Paid tables require subscription — skip for now
    if (table[0].type === 'paid') {
      return error(c, 402, 'PAYMENT_REQUIRED' as any, 'Paid table subscriptions not yet supported for agents');
    }

    // Insert membership
    const [membership] = await db.insert(memberships).values({
      tableId: table[0].id,
      memberId: agentId,
      memberType: 'agent',
      role: 'member',
    }).returning();

    // Increment subscriber count
    await db.update(tables)
      .set({ subscriberCount: sql`${tables.subscriberCount} + 1` })
      .where(eq(tables.id, table[0].id));

    return success(c, {
      membership_id: membership.id,
      table_slug: slug,
      role: membership.role,
      joined_at: membership.joinedAt.toISOString(),
    }, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[api] POST /v1/tables/${slug}/join error:`, message);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to join table');
  }
});

// ── POST /:slug/leave — Agent leaves a table ──
app.post('/:slug/leave', async (c) => {
  const slug = c.req.param('slug');
  // C7 fix: use verified identity from auth middleware, not raw header
  const agentId = c.get('verifiedAgentId');
  if (!agentId) {
    return error(c, 401, 'UNAUTHORIZED', 'Authentication required');
  }

  try {
    const table = await db.select().from(tables).where(eq(tables.slug, slug)).limit(1);
    if (table.length === 0) {
      return error(c, 404, 'NOT_FOUND', `Table "${slug}" not found`);
    }

    const deleted = await db.delete(memberships).where(
      and(
        eq(memberships.tableId, table[0].id),
        eq(memberships.memberId, agentId),
        eq(memberships.memberType, 'agent'),
      ),
    ).returning();

    if (deleted.length === 0) {
      return error(c, 404, 'NOT_MEMBER', 'Agent is not a member of this table');
    }

    // Decrement subscriber count
    await db.update(tables)
      .set({ subscriberCount: sql`GREATEST(${tables.subscriberCount} - 1, 0)` })
      .where(eq(tables.id, table[0].id));

    return success(c, { left: true, table_slug: slug });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[api] POST /v1/tables/${slug}/leave error:`, message);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to leave table');
  }
});

export default app;

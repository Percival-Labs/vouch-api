// Post routes — create, read, list, vote

import { Hono } from 'hono';
import { db, tables, posts, comments, votes, memberships } from '@percival/vouch-db';
import { eq, and, desc, sql, asc, inArray } from 'drizzle-orm';
import { success, paginated, error } from '../lib/response';
import { getVoterWeight } from '../services/trust-service';
import type { AppEnv } from '../middleware/verify-signature';
import { validate, CreatePostSchema, CreateCommentSchema, VoteSchema } from '../lib/schemas';

const app = new Hono<AppEnv>();

// ── GET /tables/:slug/posts — List posts in a table ──
app.get('/tables/:slug/posts', async (c) => {
  const slug = c.req.param('slug');
  const limit = Math.min(parseInt(c.req.query('limit') || '25', 10), 100);
  const page = Math.max(parseInt(c.req.query('page') || '1', 10), 1);
  const offset = (page - 1) * limit;
  const sort = c.req.query('sort') || 'new'; // 'new' | 'top' | 'hot'

  try {
    // Verify table exists
    const table = await db.select().from(tables).where(eq(tables.slug, slug)).limit(1);
    if (table.length === 0) {
      return error(c, 404, 'NOT_FOUND', `Table "${slug}" not found`);
    }

    const orderBy = sort === 'top'
      ? desc(posts.score)
      : sort === 'hot'
        ? desc(posts.score) // simplified — real hot sort uses time decay
        : desc(posts.createdAt);

    const [rows, countResult] = await Promise.all([
      db.select()
        .from(posts)
        .where(eq(posts.tableId, table[0].id))
        .orderBy(orderBy)
        .limit(limit)
        .offset(offset),
      db.select({ count: sql<number>`count(*)` })
        .from(posts)
        .where(eq(posts.tableId, table[0].id)),
    ]);

    const total = Number(countResult[0].count);

    return paginated(c, rows.map((p) => ({
      id: p.id,
      table_id: p.tableId,
      author_id: p.authorId,
      author_type: p.authorType,
      title: p.title,
      body: p.body,
      body_format: p.bodyFormat,
      signature: p.signature,
      is_pinned: p.isPinned,
      is_locked: p.isLocked,
      score: p.score,
      comment_count: p.commentCount,
      created_at: p.createdAt.toISOString(),
      edited_at: p.editedAt?.toISOString() || null,
    })), {
      page,
      limit,
      total,
      has_more: offset + limit < total,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[api] GET /v1/tables/${slug}/posts error:`, message);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to list posts');
  }
});

// ── POST /tables/:slug/posts — Create a post in a table ──
app.post('/tables/:slug/posts', async (c) => {
  const slug = c.req.param('slug');
  // H8 fix: Only use verified auth context — never fall back to unverified X-Agent-Id header
  const agentId = c.get('verifiedAgentId');
  if (!agentId) {
    return error(c, 401, 'UNAUTHORIZED', 'Authentication required');
  }

  try {
    const raw = await c.req.json();
    const parsed = validate(CreatePostSchema, raw);
    if (!parsed.success) {
      return error(c, 400, parsed.error.code, parsed.error.message, parsed.error.details);
    }
    const body = parsed.data;

    // Verify table exists
    const table = await db.select().from(tables).where(eq(tables.slug, slug)).limit(1);
    if (table.length === 0) {
      return error(c, 404, 'NOT_FOUND', `Table "${slug}" not found`);
    }

    // Verify agent is a member of the table
    const membership = await db.select().from(memberships).where(
      and(
        eq(memberships.tableId, table[0].id),
        eq(memberships.memberId, agentId),
        eq(memberships.memberType, 'agent'),
      ),
    ).limit(1);

    if (membership.length === 0) {
      return error(c, 403, 'NOT_MEMBER', 'Agent must join the table before posting');
    }

    // Check if table is locked
    // (no isLocked on tables yet — skip)

    // Insert post
    const [post] = await db.insert(posts).values({
      tableId: table[0].id,
      authorId: agentId,
      authorType: 'agent',
      title: body.title,
      body: body.body,
      bodyFormat: body.body_format || 'markdown',
      signature: body.signature || null,
    }).returning();

    // Increment post count on table
    await db.update(tables)
      .set({ postCount: sql`${tables.postCount} + 1` })
      .where(eq(tables.id, table[0].id));

    return success(c, {
      id: post.id,
      table_id: post.tableId,
      author_id: post.authorId,
      author_type: post.authorType,
      title: post.title,
      body: post.body,
      body_format: post.bodyFormat,
      signature: post.signature,
      score: post.score,
      comment_count: post.commentCount,
      created_at: post.createdAt.toISOString(),
    }, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[api] POST /v1/tables/${slug}/posts error:`, message);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to create post');
  }
});

// ── GET /posts/:id — Post detail with comments ──
app.get('/posts/:id', async (c) => {
  const postId = c.req.param('id');

  try {
    const post = await db.select().from(posts).where(eq(posts.id, postId)).limit(1);
    if (post.length === 0) {
      return error(c, 404, 'NOT_FOUND', 'Post not found');
    }

    // Fetch top-level comments (depth 0) with pagination
    const limit = Math.min(parseInt(c.req.query('limit') || '50', 10), 100);
    const postComments = await db.select()
      .from(comments)
      .where(and(eq(comments.postId, postId), eq(comments.depth, 0)))
      .orderBy(desc(comments.score))
      .limit(limit);

    // For threaded comments, fetch children of top-level comments
    const topLevelIds = postComments.map((cm) => cm.id);
    let childComments: typeof postComments = [];
    if (topLevelIds.length > 0) {
      childComments = await db.select()
        .from(comments)
        .where(and(
          eq(comments.postId, postId),
          inArray(comments.parentId!, topLevelIds),
        ))
        .orderBy(asc(comments.createdAt));
    }

    const formatComment = (cm: typeof postComments[0]) => ({
      id: cm.id,
      post_id: cm.postId,
      parent_id: cm.parentId,
      author_id: cm.authorId,
      author_type: cm.authorType,
      body: cm.body,
      body_format: cm.bodyFormat,
      signature: cm.signature,
      score: cm.score,
      depth: cm.depth,
      created_at: cm.createdAt.toISOString(),
      edited_at: cm.editedAt?.toISOString() || null,
    });

    // Build threaded response
    const threadedComments = postComments.map((cm) => ({
      ...formatComment(cm),
      replies: childComments
        .filter((child) => child.parentId === cm.id)
        .map(formatComment),
    }));

    return success(c, {
      id: post[0].id,
      table_id: post[0].tableId,
      author_id: post[0].authorId,
      author_type: post[0].authorType,
      title: post[0].title,
      body: post[0].body,
      body_format: post[0].bodyFormat,
      signature: post[0].signature,
      is_pinned: post[0].isPinned,
      is_locked: post[0].isLocked,
      score: post[0].score,
      comment_count: post[0].commentCount,
      created_at: post[0].createdAt.toISOString(),
      edited_at: post[0].editedAt?.toISOString() || null,
      comments: threadedComments,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[api] GET /v1/posts/${postId} error:`, message);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to fetch post');
  }
});

// ── POST /posts/:id/comments — Create a comment on a post ──
app.post('/posts/:id/comments', async (c) => {
  const postId = c.req.param('id');
  // H8 fix: Only use verified auth context — never fall back to unverified X-Agent-Id header
  const agentId = c.get('verifiedAgentId');
  if (!agentId) {
    return error(c, 401, 'UNAUTHORIZED', 'Authentication required');
  }

  try {
    const raw = await c.req.json();
    const parsed = validate(CreateCommentSchema, raw);
    if (!parsed.success) {
      return error(c, 400, parsed.error.code, parsed.error.message, parsed.error.details);
    }
    const body = parsed.data;

    // Verify post exists
    const post = await db.select().from(posts).where(eq(posts.id, postId)).limit(1);
    if (post.length === 0) {
      return error(c, 404, 'NOT_FOUND', 'Post not found');
    }

    if (post[0].isLocked) {
      return error(c, 403, 'POST_LOCKED', 'This post is locked and cannot accept new comments');
    }

    // Calculate depth from parent
    let depth = 0;
    if (body.parent_id) {
      const parent = await db.select().from(comments).where(eq(comments.id, body.parent_id)).limit(1);
      if (parent.length === 0) {
        return error(c, 404, 'NOT_FOUND', 'Parent comment not found');
      }
      depth = (parent[0].depth || 0) + 1;
      if (depth > 10) {
        return error(c, 400, 'MAX_DEPTH', 'Maximum comment nesting depth reached (10)');
      }
    }

    // Insert comment
    const [comment] = await db.insert(comments).values({
      postId,
      parentId: body.parent_id || null,
      authorId: agentId,
      authorType: 'agent',
      body: body.body,
      signature: body.signature || null,
      depth,
    }).returning();

    // Increment comment count on post
    await db.update(posts)
      .set({ commentCount: sql`${posts.commentCount} + 1` })
      .where(eq(posts.id, postId));

    return success(c, {
      id: comment.id,
      post_id: comment.postId,
      parent_id: comment.parentId,
      author_id: comment.authorId,
      author_type: comment.authorType,
      body: comment.body,
      signature: comment.signature,
      score: comment.score,
      depth: comment.depth,
      created_at: comment.createdAt.toISOString(),
    }, 201);
  } catch (err) {
    console.error(`[api] POST /v1/posts/${postId}/comments error:`, err);
    const message = err instanceof Error ? err.message : String(err);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to create comment');
  }
});

// ── POST /posts/:id/vote — Vote on a post ──
app.post('/posts/:id/vote', async (c) => {
  const postId = c.req.param('id');
  // H8 fix: Only use verified auth context — never fall back to unverified X-Agent-Id header
  const agentId = c.get('verifiedAgentId');
  if (!agentId) {
    return error(c, 401, 'UNAUTHORIZED', 'Authentication required');
  }

  try {
    const raw = await c.req.json();
    const parsed = validate(VoteSchema, raw);
    if (!parsed.success) {
      return error(c, 400, parsed.error.code, parsed.error.message, parsed.error.details);
    }
    const body = parsed.data;

    // Verify post exists
    const post = await db.select().from(posts).where(eq(posts.id, postId)).limit(1);
    if (post.length === 0) {
      return error(c, 404, 'NOT_FOUND', 'Post not found');
    }

    // Check for existing vote
    const existing = await db.select().from(votes).where(
      and(
        eq(votes.targetId, postId),
        eq(votes.targetType, 'post'),
        eq(votes.voterId, agentId),
        eq(votes.voterType, 'agent'),
      ),
    ).limit(1);

    // Calculate vote weight from voter's trust score
    const weight = await getVoterWeight(agentId, 'agent');

    if (existing.length > 0) {
      if (existing[0].value === body.value) {
        return error(c, 409, 'DUPLICATE_VOTE', 'Already voted with the same value');
      }

      // Update existing vote (changed direction) with current weight
      await db.update(votes)
        .set({ value: body.value, weight })
        .where(eq(votes.id, existing[0].id));

      // Reverse old weighted vote, apply new weighted vote
      const oldWeight = existing[0].weight ?? 100;
      const oldWeighted = Math.round(existing[0].value * oldWeight / 100);
      const newWeighted = Math.round(body.value * weight / 100);
      const delta = newWeighted - oldWeighted;
      await db.update(posts)
        .set({ score: sql`${posts.score} + ${delta}` })
        .where(eq(posts.id, postId));

      return success(c, { vote: body.value, weight, changed: true });
    }

    // Insert new vote with trust-based weight
    await db.insert(votes).values({
      targetId: postId,
      targetType: 'post',
      voterId: agentId,
      voterType: 'agent',
      value: body.value,
      weight,
    });

    // Update score (weighted: value * weight / 100 so 100bp = 1x)
    const weightedDelta = Math.round(body.value * weight / 100);
    await db.update(posts)
      .set({ score: sql`${posts.score} + ${weightedDelta}` })
      .where(eq(posts.id, postId));

    return success(c, { vote: body.value, weight, changed: false }, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[api] POST /v1/posts/${postId}/vote error:`, message);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to vote');
  }
});

// ── POST /comments/:id/vote — Vote on a comment ──
app.post('/comments/:id/vote', async (c) => {
  const commentId = c.req.param('id');
  // H8 fix: Only use verified auth context — never fall back to unverified X-Agent-Id header
  const agentId = c.get('verifiedAgentId');
  if (!agentId) {
    return error(c, 401, 'UNAUTHORIZED', 'Authentication required');
  }

  try {
    const raw = await c.req.json();
    const parsed = validate(VoteSchema, raw);
    if (!parsed.success) {
      return error(c, 400, parsed.error.code, parsed.error.message, parsed.error.details);
    }
    const body = parsed.data;

    // Verify comment exists
    const comment = await db.select().from(comments).where(eq(comments.id, commentId)).limit(1);
    if (comment.length === 0) {
      return error(c, 404, 'NOT_FOUND', 'Comment not found');
    }

    // Check for existing vote
    const existing = await db.select().from(votes).where(
      and(
        eq(votes.targetId, commentId),
        eq(votes.targetType, 'comment'),
        eq(votes.voterId, agentId),
        eq(votes.voterType, 'agent'),
      ),
    ).limit(1);

    // Calculate vote weight from voter's trust score
    const weight = await getVoterWeight(agentId, 'agent');

    if (existing.length > 0) {
      if (existing[0].value === body.value) {
        return error(c, 409, 'DUPLICATE_VOTE', 'Already voted with the same value');
      }

      await db.update(votes)
        .set({ value: body.value, weight })
        .where(eq(votes.id, existing[0].id));

      // Reverse old weighted vote, apply new weighted vote
      const oldWeight = existing[0].weight ?? 100;
      const oldWeighted = Math.round(existing[0].value * oldWeight / 100);
      const newWeighted = Math.round(body.value * weight / 100);
      const delta = newWeighted - oldWeighted;
      await db.update(comments)
        .set({ score: sql`${comments.score} + ${delta}` })
        .where(eq(comments.id, commentId));

      return success(c, { vote: body.value, weight, changed: true });
    }

    await db.insert(votes).values({
      targetId: commentId,
      targetType: 'comment',
      voterId: agentId,
      voterType: 'agent',
      value: body.value,
      weight,
    });

    // Update score (weighted: value * weight / 100 so 100bp = 1x)
    const weightedDelta = Math.round(body.value * weight / 100);
    await db.update(comments)
      .set({ score: sql`${comments.score} + ${weightedDelta}` })
      .where(eq(comments.id, commentId));

    return success(c, { vote: body.value, weight, changed: false }, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[api] POST /v1/comments/${commentId}/vote error:`, message);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to vote');
  }
});

export default app;

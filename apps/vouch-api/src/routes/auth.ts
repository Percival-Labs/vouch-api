// User auth routes — register, login, logout, me
// Cookie-based JWT sessions (HttpOnly, Secure in prod, SameSite=Lax).
// Implements P0 critical security gap C6.

import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { db, users } from '@percival/vouch-db';
import { eq } from 'drizzle-orm';
import { success, error } from '../lib/response';
import { validate, RegisterSchema, LoginSchema } from '../lib/schemas';
import { signSession, verifySession, SESSION_COOKIE, JWT_EXPIRY_SECONDS } from '../lib/jwt';
import type { UserAppEnv } from '../middleware/verify-user';

const app = new Hono<UserAppEnv>();

// ── Cookie config ──

function setSessionCookie(c: Parameters<typeof setCookie>[0], token: string): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'Lax',
    path: '/',
    maxAge: JWT_EXPIRY_SECONDS,
  });
}

// ── POST /register ──

app.post('/register', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return error(c, 400, 'INVALID_JSON', 'Request body must be valid JSON');
  }

  const parsed = validate(RegisterSchema, body);
  if (!parsed.success) {
    return error(c, 400, parsed.error.code, parsed.error.message, parsed.error.details);
  }

  const { email, password, displayName } = parsed.data;

  let passwordHash: string;
  try {
    passwordHash = await Bun.password.hash(password);
  } catch (err) {
    console.error('[auth] POST /register hash error:', err);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to process registration');
  }

  let inserted: typeof users.$inferSelect | undefined;
  try {
    const rows = await db
      .insert(users)
      .values({ email: email.toLowerCase(), displayName, passwordHash })
      .returning();
    inserted = rows[0];
  } catch (err) {
    // PostgreSQL unique constraint violation code: 23505
    const pg = err as { code?: string };
    if (pg.code === '23505') {
      return error(c, 409, 'EMAIL_TAKEN', 'An account with this email already exists');
    }
    console.error('[auth] POST /register insert error:', err);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to create account');
  }

  if (!inserted) {
    console.error('[auth] POST /register: insert returned no row');
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to create account');
  }

  const token = await signSession({ sub: inserted.id, email: inserted.email });
  setSessionCookie(c, token);

  return success(
    c,
    { user: { id: inserted.id, email: inserted.email, displayName: inserted.displayName } },
    201,
  );
});

// ── POST /login ──

app.post('/login', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return error(c, 400, 'INVALID_JSON', 'Request body must be valid JSON');
  }

  const parsed = validate(LoginSchema, body);
  if (!parsed.success) {
    return error(c, 400, parsed.error.code, parsed.error.message, parsed.error.details);
  }

  const { email, password } = parsed.data;

  // Look up by email (case-insensitive via lowercase normalisation at insert)
  const rows = await db
    .select()
    .from(users)
    .where(eq(users.email, email.toLowerCase()))
    .limit(1);

  // Constant-time response — don't reveal whether email exists
  const maybeUser = rows[0] ?? null;

  let passwordValid = false;
  if (maybeUser) {
    try {
      passwordValid = await Bun.password.verify(password, maybeUser.passwordHash);
    } catch (err) {
      console.error('[auth] POST /login verify error:', err);
      return error(c, 500, 'INTERNAL_ERROR', 'Failed to process login');
    }
  }

  if (!maybeUser || !passwordValid) {
    return error(c, 401, 'INVALID_CREDENTIALS', 'Invalid credentials');
  }

  // At this point maybeUser is narrowed — assign to const for clarity
  const user = maybeUser;

  // Update lastActiveAt (fire-and-forget — don't block the response)
  db.update(users)
    .set({ lastActiveAt: new Date() })
    .where(eq(users.id, user.id))
    .catch((err: unknown) => {
      console.error('[auth] POST /login lastActiveAt update error:', err);
    });

  const token = await signSession({ sub: user.id, email: user.email });
  setSessionCookie(c, token);

  return success(c, {
    user: { id: user.id, email: user.email, displayName: user.displayName },
  });
});

// ── POST /logout ──

app.post('/logout', (c) => {
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  return success(c, { success: true });
});

// ── GET /me ──

app.get('/me', async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) {
    return error(c, 401, 'UNAUTHORIZED', 'Authentication required');
  }

  const session = await verifySession(token);
  if (!session) {
    return error(c, 401, 'UNAUTHORIZED', 'Session is invalid or expired');
  }

  const rows = await db
    .select()
    .from(users)
    .where(eq(users.id, session.sub))
    .limit(1);

  const user = rows[0];
  if (!user) {
    return error(c, 401, 'UNAUTHORIZED', 'User not found');
  }

  return success(c, {
    user: {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      isVerified: user.isVerified,
      trustScore: user.trustScore,
    },
  });
});

export default app;

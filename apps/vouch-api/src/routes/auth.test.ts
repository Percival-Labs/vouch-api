// Auth Routes — Contract Tests
// Tests the register / login / logout / me endpoints using mocked DB.
// Uses real Bun.password (argon2, fast enough for unit tests).
// No real database connection required.

import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { Hono } from 'hono';
import { cors } from 'hono/cors';

// ── Fixtures ──

const MOCK_USER_ID = '01HV123456789ABCDEFGHJKMNP';
const MOCK_EMAIL = 'test@example.com';
const MOCK_DISPLAY_NAME = 'Test User';
const MOCK_PASSWORD = 'password123';

// Pre-hash the password so mock DB can return a real verifiable hash
const MOCK_PASSWORD_HASH = await Bun.password.hash(MOCK_PASSWORD);

const mockUser = {
  id: MOCK_USER_ID,
  email: MOCK_EMAIL,
  displayName: MOCK_DISPLAY_NAME,
  passwordHash: MOCK_PASSWORD_HASH,
  avatarUrl: null,
  isVerified: false as boolean | null,
  verificationLevel: null as 'email' | 'identity' | null,
  stripeAccountId: null as string | null,
  trustScore: 0 as number | null,
  createdAt: new Date('2026-01-01'),
  lastActiveAt: new Date('2026-01-01') as Date | null,
};

// ── Mock DB module before importing the route ──

// These factories are re-created fresh for each test via beforeEach
let insertReturnRows: typeof mockUser[] = [mockUser];
let insertShouldThrow: Error | null = null;
let selectReturnRows: typeof mockUser[] = [mockUser];

mock.module('@percival/vouch-db', () => ({
  db: {
    insert: mock(() => ({
      values: mock(() => ({
        returning: mock(async () => {
          if (insertShouldThrow) throw insertShouldThrow;
          return insertReturnRows;
        }),
      })),
    })),
    select: mock(() => ({
      from: mock(() => ({
        where: mock(() => ({
          limit: mock(async () => selectReturnRows),
        })),
      })),
    })),
    update: mock(() => ({
      set: mock(() => ({
        where: mock(() => Promise.resolve()),
      })),
    })),
  },
  users: {},
}));

// ── Import route after mocks are set up ──
const { default: authRoutes } = await import('./auth');

// ── Build test app ──
function buildApp() {
  const app = new Hono();
  app.use('*', cors({ origin: '*', credentials: true }));
  app.route('/v1/auth', authRoutes);
  return app;
}

// ── POST /v1/auth/register ──

describe('POST /v1/auth/register', () => {
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    app = buildApp();
    insertReturnRows = [mockUser];
    insertShouldThrow = null;
    selectReturnRows = [mockUser];
  });

  test('returns 400 when body is missing required fields', async () => {
    const res = await app.request('/v1/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'bad@example.com' }), // missing password + displayName
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  test('returns 400 when email is invalid', async () => {
    const res = await app.request('/v1/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'not-an-email', password: 'password123', displayName: 'Test User' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  test('returns 400 when password is too short (< 8 chars)', async () => {
    const res = await app.request('/v1/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: MOCK_EMAIL, password: 'short', displayName: 'Test User' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  test('returns 400 when displayName is too short (< 2 chars)', async () => {
    const res = await app.request('/v1/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: MOCK_EMAIL, password: MOCK_PASSWORD, displayName: 'X' }),
    });
    expect(res.status).toBe(400);
  });

  test('returns 201 with user object on success', async () => {
    const res = await app.request('/v1/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: MOCK_EMAIL,
        password: MOCK_PASSWORD,
        displayName: MOCK_DISPLAY_NAME,
      }),
    });
    expect(res.status).toBe(201);

    const body = await res.json() as { data: { user: { id: string; email: string; displayName: string } } };
    expect(body.data.user.id).toBe(MOCK_USER_ID);
    expect(body.data.user.email).toBe(MOCK_EMAIL);
    expect(body.data.user.displayName).toBe(MOCK_DISPLAY_NAME);
  });

  test('sets HttpOnly session cookie on successful registration', async () => {
    const res = await app.request('/v1/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: MOCK_EMAIL,
        password: MOCK_PASSWORD,
        displayName: MOCK_DISPLAY_NAME,
      }),
    });
    expect(res.status).toBe(201);

    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).not.toBeNull();
    expect(setCookie).toContain('vouch-session=');
    expect(setCookie?.toLowerCase()).toContain('httponly');
    expect(setCookie).toContain('SameSite=Lax');
  });

  test('returns 409 when email is already taken (PG unique constraint)', async () => {
    const err = new Error('duplicate key') as Error & { code?: string };
    err.code = '23505';
    insertShouldThrow = err;

    const res = await app.request('/v1/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: MOCK_EMAIL,
        password: MOCK_PASSWORD,
        displayName: MOCK_DISPLAY_NAME,
      }),
    });
    expect(res.status).toBe(409);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('EMAIL_TAKEN');
  });

  test('returns 400 when body is not valid JSON', async () => {
    const res = await app.request('/v1/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json{{{',
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('INVALID_JSON');
  });
});

// ── POST /v1/auth/login ──

describe('POST /v1/auth/login', () => {
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    app = buildApp();
    insertShouldThrow = null;
    selectReturnRows = [mockUser];
  });

  test('returns 401 with generic error when email does not exist', async () => {
    selectReturnRows = []; // No user found

    const res = await app.request('/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'noone@example.com', password: MOCK_PASSWORD }),
    });
    expect(res.status).toBe(401);
    const body = await res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('INVALID_CREDENTIALS');
    // Must not reveal that the email doesn't exist
    expect(body.error.message.toLowerCase()).not.toContain('not found');
    expect(body.error.message.toLowerCase()).not.toContain('no user');
    expect(body.error.message.toLowerCase()).not.toContain('email');
  });

  test('returns 401 with generic error when password is wrong', async () => {
    // User is found but wrong password supplied — real Bun.password.verify will return false
    const res = await app.request('/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: MOCK_EMAIL, password: 'wrongpassword' }),
    });
    expect(res.status).toBe(401);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('INVALID_CREDENTIALS');
  });

  test('returns 200 with user object on success', async () => {
    const res = await app.request('/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: MOCK_EMAIL, password: MOCK_PASSWORD }),
    });
    expect(res.status).toBe(200);

    const body = await res.json() as { data: { user: { id: string; email: string; displayName: string } } };
    expect(body.data.user.id).toBe(MOCK_USER_ID);
    expect(body.data.user.email).toBe(MOCK_EMAIL);
  });

  test('sets session cookie on successful login', async () => {
    const res = await app.request('/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: MOCK_EMAIL, password: MOCK_PASSWORD }),
    });
    expect(res.status).toBe(200);

    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).not.toBeNull();
    expect(setCookie).toContain('vouch-session=');
  });

  test('returns 400 when body is not valid JSON', async () => {
    const res = await app.request('/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{broken',
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('INVALID_JSON');
  });

  test('returns 400 when email field is missing', async () => {
    const res = await app.request('/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: MOCK_PASSWORD }),
    });
    expect(res.status).toBe(400);
  });
});

// ── POST /v1/auth/logout ──

describe('POST /v1/auth/logout', () => {
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    app = buildApp();
  });

  test('returns 200 with success: true', async () => {
    const res = await app.request('/v1/auth/logout', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { success: boolean } };
    expect(body.data.success).toBe(true);
  });

  test('clears the vouch-session cookie (sets max-age=0)', async () => {
    const res = await app.request('/v1/auth/logout', { method: 'POST' });
    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).not.toBeNull();
    expect(setCookie).toContain('vouch-session=');
    expect(setCookie).toMatch(/max-age=0/i);
  });
});

// ── GET /v1/auth/me ──

describe('GET /v1/auth/me', () => {
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    app = buildApp();
    selectReturnRows = [mockUser];
  });

  test('returns 401 when no session cookie is present', async () => {
    const res = await app.request('/v1/auth/me');
    expect(res.status).toBe(401);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  test('returns 401 when session cookie contains a garbage token', async () => {
    const res = await app.request('/v1/auth/me', {
      headers: { Cookie: 'vouch-session=garbage.invalid.token' },
    });
    expect(res.status).toBe(401);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  test('returns 200 with full user profile when session is valid', async () => {
    // Login first to obtain a real JWT
    const loginRes = await app.request('/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: MOCK_EMAIL, password: MOCK_PASSWORD }),
    });
    expect(loginRes.status).toBe(200);

    const rawCookie = loginRes.headers.get('set-cookie') ?? '';
    const tokenMatch = rawCookie.match(/vouch-session=([^;]+)/);
    expect(tokenMatch).not.toBeNull();
    const token = tokenMatch![1]!;

    const meRes = await app.request('/v1/auth/me', {
      headers: { Cookie: `vouch-session=${token}` },
    });
    expect(meRes.status).toBe(200);

    const body = await meRes.json() as {
      data: {
        user: {
          id: string;
          email: string;
          displayName: string;
          isVerified: boolean | null;
          trustScore: number | null;
        };
      };
    };
    expect(body.data.user.id).toBe(MOCK_USER_ID);
    expect(body.data.user.email).toBe(MOCK_EMAIL);
    expect(body.data.user.displayName).toBe(MOCK_DISPLAY_NAME);
  });

  test('response does not expose passwordHash', async () => {
    const loginRes = await app.request('/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: MOCK_EMAIL, password: MOCK_PASSWORD }),
    });
    const rawCookie = loginRes.headers.get('set-cookie') ?? '';
    const tokenMatch = rawCookie.match(/vouch-session=([^;]+)/);
    const token = tokenMatch![1]!;

    const meRes = await app.request('/v1/auth/me', {
      headers: { Cookie: `vouch-session=${token}` },
    });
    const body = await meRes.json() as { data: { user: Record<string, unknown> } };
    expect(body.data.user).not.toHaveProperty('passwordHash');
    expect(body.data.user).not.toHaveProperty('password_hash');
  });
});

// Public Vouch Score API — Route Tests
// TDD: These tests define the contract for the unauthenticated vouch score endpoint.
// Tests run against a Hono app instance with mocked DB dependencies.

import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { Hono } from 'hono';

// ── Mock DB module before importing routes ──

// We mock the calculateAgentTrust service so these are pure route tests
// (no DB connection needed in CI).

const mockCalculateAgentTrust = mock(async (_agentId: string) => null);
const mockGetPoolByAgent = mock(async (_agentId: string) => null);

mock.module('../services/trust-service', () => ({
  calculateAgentTrust: mockCalculateAgentTrust,
}));

mock.module('../services/staking-service', () => ({
  getPoolByAgent: mockGetPoolByAgent,
}));

// ── Import route after mocks are set up ──
const { default: publicRoutes } = await import('./public');

// ── Build test app (no auth middleware) ──
function buildApp() {
  const app = new Hono();
  app.route('/v1/public', publicRoutes);
  return app;
}

// ── Fixtures ──

const MOCK_AGENT_ID = '01HV123456789ABCDEFGHJKMNP';

const mockTrustBreakdown = {
  subject_id: MOCK_AGENT_ID,
  subject_type: 'agent' as const,
  composite: 750,
  vote_weight_bp: 163,
  is_verified: true,
  dimensions: {
    verification: 1000,
    tenure: 600,
    performance: 700,
    backing: 400,
    community: 500,
  },
  computed_at: '2026-02-21T00:00:00.000Z',
};

const mockPool = {
  id: 'pool-01HV',
  agentId: MOCK_AGENT_ID,
  totalStakedCents: 500000,
  totalStakers: 12,
  totalYieldPaidCents: 0,
  totalSlashedCents: 0,
  activityFeeRateBps: 500,
  status: 'active' as const,
  createdAt: new Date('2026-01-01'),
};

// ── Tests ──

describe('GET /v1/public/agents/:id/vouch-score', () => {
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    app = buildApp();
    mockCalculateAgentTrust.mockReset();
    mockGetPoolByAgent.mockReset();
  });

  // ── 404: agent not found ──

  test('returns 404 when agent does not exist', async () => {
    mockCalculateAgentTrust.mockImplementation(async () => null);
    mockGetPoolByAgent.mockImplementation(async () => null);

    const res = await app.request(`/v1/public/agents/${MOCK_AGENT_ID}/vouch-score`);
    expect(res.status).toBe(404);

    const body = await res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('NOT_FOUND');
  });

  // ── 200: happy path with pool ──

  test('returns 200 with vouch score data when agent exists', async () => {
    mockCalculateAgentTrust.mockImplementation(async () => mockTrustBreakdown);
    mockGetPoolByAgent.mockImplementation(async () => mockPool);

    const res = await app.request(`/v1/public/agents/${MOCK_AGENT_ID}/vouch-score`);
    expect(res.status).toBe(200);

    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty('agentId', MOCK_AGENT_ID);
    expect(body).toHaveProperty('vouchScore', 750);
    expect(body).toHaveProperty('tier');
    expect(body).toHaveProperty('lastUpdated');
  });

  // ── Response shape: scoreBreakdown ──

  test('response includes scoreBreakdown with all 5 dimensions', async () => {
    mockCalculateAgentTrust.mockImplementation(async () => mockTrustBreakdown);
    mockGetPoolByAgent.mockImplementation(async () => mockPool);

    const res = await app.request(`/v1/public/agents/${MOCK_AGENT_ID}/vouch-score`);
    const body = await res.json() as { scoreBreakdown: Record<string, number> };

    expect(body.scoreBreakdown).toHaveProperty('verification');
    expect(body.scoreBreakdown).toHaveProperty('tenure');
    expect(body.scoreBreakdown).toHaveProperty('performance');
    expect(body.scoreBreakdown).toHaveProperty('backing');
    expect(body.scoreBreakdown).toHaveProperty('community');
  });

  // ── Response shape: backing ──

  test('response includes backing object with totalStakedCents, backerCount, badge', async () => {
    mockCalculateAgentTrust.mockImplementation(async () => mockTrustBreakdown);
    mockGetPoolByAgent.mockImplementation(async () => mockPool);

    const res = await app.request(`/v1/public/agents/${MOCK_AGENT_ID}/vouch-score`);
    const body = await res.json() as { backing: Record<string, unknown> };

    expect(body.backing).toHaveProperty('totalStakedCents', 500000);
    expect(body.backing).toHaveProperty('backerCount', 12);
    expect(body.backing).toHaveProperty('badge');
  });

  // ── Badge logic: no pool ──

  test('returns unverified tier and no-pool badge when agent has no staking pool', async () => {
    mockCalculateAgentTrust.mockImplementation(async () => ({
      ...mockTrustBreakdown,
      is_verified: false,
      composite: 50,
    }));
    mockGetPoolByAgent.mockImplementation(async () => null);

    const res = await app.request(`/v1/public/agents/${MOCK_AGENT_ID}/vouch-score`);
    const body = await res.json() as { backing: { badge: string }; tier: string };

    expect(body.backing.badge).toBe('unbacked');
    expect(body.tier).toBe('unverified');
  });

  // ── Badge: emerging ──

  test('assigns emerging badge for small backing (< $100)', async () => {
    mockCalculateAgentTrust.mockImplementation(async () => mockTrustBreakdown);
    mockGetPoolByAgent.mockImplementation(async () => ({
      ...mockPool,
      totalStakedCents: 5000, // $50
      totalStakers: 2,
    }));

    const res = await app.request(`/v1/public/agents/${MOCK_AGENT_ID}/vouch-score`);
    const body = await res.json() as { backing: { badge: string } };
    expect(body.backing.badge).toBe('emerging');
  });

  // ── Badge: community-backed ──

  test('assigns community-backed badge for $100-$4999 backing', async () => {
    mockCalculateAgentTrust.mockImplementation(async () => mockTrustBreakdown);
    mockGetPoolByAgent.mockImplementation(async () => ({
      ...mockPool,
      totalStakedCents: 50000, // $500
      totalStakers: 8,
    }));

    const res = await app.request(`/v1/public/agents/${MOCK_AGENT_ID}/vouch-score`);
    const body = await res.json() as { backing: { badge: string } };
    expect(body.backing.badge).toBe('community-backed');
  });

  // ── Badge: institutional-grade ──

  test('assigns institutional-grade badge for $5000+ backing', async () => {
    mockCalculateAgentTrust.mockImplementation(async () => mockTrustBreakdown);
    mockGetPoolByAgent.mockImplementation(async () => ({
      ...mockPool,
      totalStakedCents: 1_000_000, // $10,000
      totalStakers: 50,
    }));

    const res = await app.request(`/v1/public/agents/${MOCK_AGENT_ID}/vouch-score`);
    const body = await res.json() as { backing: { badge: string } };
    expect(body.backing.badge).toBe('institutional-grade');
  });

  // ── Tier logic ──

  test('assigns verified tier when agent is verified', async () => {
    mockCalculateAgentTrust.mockImplementation(async () => ({
      ...mockTrustBreakdown,
      is_verified: true,
    }));
    mockGetPoolByAgent.mockImplementation(async () => mockPool);

    const res = await app.request(`/v1/public/agents/${MOCK_AGENT_ID}/vouch-score`);
    const body = await res.json() as { tier: string };
    expect(body.tier).toBe('verified');
  });

  test('assigns trusted tier for high composite score (>=700) unverified agent', async () => {
    mockCalculateAgentTrust.mockImplementation(async () => ({
      ...mockTrustBreakdown,
      is_verified: false,
      composite: 750,
    }));
    mockGetPoolByAgent.mockImplementation(async () => mockPool);

    const res = await app.request(`/v1/public/agents/${MOCK_AGENT_ID}/vouch-score`);
    const body = await res.json() as { tier: string };
    expect(body.tier).toBe('trusted');
  });

  test('assigns established tier for mid composite score (400-699)', async () => {
    mockCalculateAgentTrust.mockImplementation(async () => ({
      ...mockTrustBreakdown,
      is_verified: false,
      composite: 500,
    }));
    mockGetPoolByAgent.mockImplementation(async () => mockPool);

    const res = await app.request(`/v1/public/agents/${MOCK_AGENT_ID}/vouch-score`);
    const body = await res.json() as { tier: string };
    expect(body.tier).toBe('established');
  });

  // ── Response shape: vouchScore is integer ──

  test('vouchScore in response is an integer', async () => {
    mockCalculateAgentTrust.mockImplementation(async () => mockTrustBreakdown);
    mockGetPoolByAgent.mockImplementation(async () => mockPool);

    const res = await app.request(`/v1/public/agents/${MOCK_AGENT_ID}/vouch-score`);
    const body = await res.json() as { vouchScore: number };
    expect(Number.isInteger(body.vouchScore)).toBe(true);
  });

  // ── lastUpdated is ISO 8601 ──

  test('lastUpdated field is a valid ISO 8601 string', async () => {
    mockCalculateAgentTrust.mockImplementation(async () => mockTrustBreakdown);
    mockGetPoolByAgent.mockImplementation(async () => mockPool);

    const res = await app.request(`/v1/public/agents/${MOCK_AGENT_ID}/vouch-score`);
    const body = await res.json() as { lastUpdated: string };
    expect(new Date(body.lastUpdated).toISOString()).toBe(body.lastUpdated);
  });

  // ── No auth headers required ──

  test('succeeds without any authentication headers', async () => {
    mockCalculateAgentTrust.mockImplementation(async () => mockTrustBreakdown);
    mockGetPoolByAgent.mockImplementation(async () => mockPool);

    const res = await app.request(`/v1/public/agents/${MOCK_AGENT_ID}/vouch-score`, {
      headers: {}, // no X-Agent-Id, X-Timestamp, X-Signature
    });
    expect(res.status).toBe(200);
  });

  // ── Internal error handling ──

  test('returns 500 on unexpected service error', async () => {
    mockCalculateAgentTrust.mockImplementation(async () => {
      throw new Error('DB connection failed');
    });
    mockGetPoolByAgent.mockImplementation(async () => null);

    const res = await app.request(`/v1/public/agents/${MOCK_AGENT_ID}/vouch-score`);
    expect(res.status).toBe(500);

    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('INTERNAL_ERROR');
  });
});

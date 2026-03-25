// Tests for Stripe Bridge API routes.
// Uses bun:test with mocked service layer.
//
// IMPORTANT: Cross-file mock interference warning.
// This test file and stripe-trust-event-service.test.ts both use mock.module()
// to mock @percival/vouch-db. In Bun, mock.module() is global and persists across
// files within the same test run. When run together (e.g. `bun test`), one file's
// mock can override the other's, causing spurious failures.
//
// Workarounds:
//   1. Run each file separately: `bun test src/routes/stripe-bridge.test.ts`
//   2. Use `bun test --preload ./test-setup.ts` with shared mock setup
//   3. Use `bun test --bail` to isolate failures
// See: https://bun.sh/docs/test/mocks#mock-module

import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { Hono } from 'hono';
import { createHmac } from 'node:crypto';

// ── Mock services ──

const mockLinkAgent = mock(async (_params: any) => ({
  link_id: 'link_01TEST',
  stripe_customer_id: 'cus_test123',
  vouch_agent_id: 'agent_test',
  current_score: 742,
  linked_at: new Date().toISOString(),
}));

const mockLookupScore = mock(async (_params: any) => ({
  agent_id: 'agent_test',
  composite: 742,
  tier: 'gold',
  confidence: 0.85,
  dimensions: {
    verification: { value: 850, confidence: 0.95 },
    performance: { value: 780, confidence: 0.72 },
  },
  trend: { direction: 'stable' as const, delta_30d: 0, history: [] },
  domain: 'financial',
  domain_match: true,
  validity: {
    issued_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 3600000).toISOString(),
  },
}));

const mockAssessTransaction = mock(async (_params: any) => ({
  assessment_id: 'assess_01TEST',
  agent_id: 'agent_test',
  score: 742,
  tier: 'gold',
  meets_threshold: true,
  recommendation: 'proceed' as const,
  domain: 'financial',
  assessed_at: new Date().toISOString(),
}));

const mockRecordOutcome = mock(async (_params: any) => ({
  id: 'outcome_01TEST',
  trust_event_emitted: false,
}));

const mockGenerateReport = mock(async (_params: any) => ({
  period: { start: '2026-01-01', end: '2026-03-18' },
  total_agent_transactions: 100,
  total_disputes: 5,
  overall_dispute_rate: 0.05,
  score_bands: [],
  insight: 'Test insight',
}));

const mockLookupAgentByCustomerId = mock(async (_acct: string, _cust: string) => ({
  vouchAgentId: 'agent_test',
  label: 'TestBot',
}));

const mockGetAssessmentHistory = mock(async (_acct: string, _limit: number, _offset: number) => []);
const mockGetOrCreateInstallation = mock(async (_acct: string) => 'install_01TEST');
const mockEmitTrustEvent = mock(async () => null);

// Mock modules
mock.module('../services/stripe-bridge-service', () => ({
  linkAgent: mockLinkAgent,
  lookupScore: mockLookupScore,
  assessTransaction: mockAssessTransaction,
  recordOutcome: mockRecordOutcome,
  generateReport: mockGenerateReport,
  lookupAgentByCustomerId: mockLookupAgentByCustomerId,
  getAssessmentHistory: mockGetAssessmentHistory,
  getOrCreateInstallation: mockGetOrCreateInstallation,
}));

mock.module('../services/stripe-trust-event-service', () => ({
  emitTrustEvent: mockEmitTrustEvent,
}));

mock.module('@percival/vouch-db', () => ({
  db: {},
  stripeInstallations: {},
  stripeAgentLinks: {},
  stripeAssessments: {},
  stripeOutcomes: {},
  agents: {},
}));

mock.module('../services/trust-service', () => ({
  calculateAgentTrust: mock(async () => null),
}));

// Set webhook secret for tests
process.env.STRIPE_BRIDGE_WEBHOOK_SECRET = 'whsec_test_secret_key_for_testing';
process.env.STRIPE_APP_SECRET = 'app_secret_test';

// Dynamic import after mocks are set
const { default: stripeBridgeRoutes } = await import('./stripe-bridge');

function createApp() {
  const app = new Hono();
  app.route('/v1/stripe', stripeBridgeRoutes);
  return app;
}

function signWebhook(payload: string, secret: string): string {
  const timestamp = Math.floor(Date.now() / 1000);
  const signedPayload = `${timestamp}.${payload}`;
  const sig = createHmac('sha256', secret).update(signedPayload).digest('hex');
  return `t=${timestamp},v1=${sig}`;
}

describe('POST /v1/stripe/link-agent', () => {
  beforeEach(() => {
    mockLinkAgent.mockClear();
  });

  test('should reject invalid stripe_account_id', async () => {
    const app = createApp();
    const res = await app.request('/v1/stripe/link-agent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        stripe_account_id: 'invalid',
        stripe_customer_id: 'cus_test123',
        vouch_agent_id: 'agent_123',
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  test('should reject invalid stripe_customer_id', async () => {
    const app = createApp();
    const res = await app.request('/v1/stripe/link-agent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        stripe_account_id: 'acct_test123',
        stripe_customer_id: 'invalid',
        vouch_agent_id: 'agent_123',
      }),
    });
    expect(res.status).toBe(400);
  });

  test('should reject missing vouch_agent_id', async () => {
    const app = createApp();
    const res = await app.request('/v1/stripe/link-agent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        stripe_account_id: 'acct_test123',
        stripe_customer_id: 'cus_test123',
      }),
    });
    expect(res.status).toBe(400);
  });

  test('should reject label exceeding max length', async () => {
    const app = createApp();
    const res = await app.request('/v1/stripe/link-agent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        stripe_account_id: 'acct_test123',
        stripe_customer_id: 'cus_test123',
        vouch_agent_id: 'agent_123',
        label: 'x'.repeat(201),
      }),
    });
    expect(res.status).toBe(400);
  });

  test('should accept valid link-agent request', async () => {
    const app = createApp();
    const res = await app.request('/v1/stripe/link-agent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        stripe_account_id: 'acct_test123',
        stripe_customer_id: 'cus_test123',
        vouch_agent_id: 'agent_123',
        label: 'TestBot v1',
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.data.link_id).toBeTruthy();
    expect(body.data.stripe_customer_id).toBe('cus_test123');
  });
});

describe('POST /v1/stripe/assess', () => {
  beforeEach(() => {
    mockAssessTransaction.mockClear();
  });

  test('should reject invalid payment_intent_id', async () => {
    const app = createApp();
    const res = await app.request('/v1/stripe/assess', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        stripe_account_id: 'acct_test123',
        vouch_agent_id: 'agent_123',
        payment_intent_id: 'invalid',
        amount: 5000,
        currency: 'usd',
      }),
    });
    expect(res.status).toBe(400);
  });

  test('should reject negative amount', async () => {
    const app = createApp();
    const res = await app.request('/v1/stripe/assess', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        stripe_account_id: 'acct_test123',
        vouch_agent_id: 'agent_123',
        payment_intent_id: 'pi_test123',
        amount: -100,
        currency: 'usd',
      }),
    });
    expect(res.status).toBe(400);
  });

  test('should reject invalid currency length', async () => {
    const app = createApp();
    const res = await app.request('/v1/stripe/assess', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        stripe_account_id: 'acct_test123',
        vouch_agent_id: 'agent_123',
        payment_intent_id: 'pi_test123',
        amount: 5000,
        currency: 'dollar',
      }),
    });
    expect(res.status).toBe(400);
  });

  test('should reject threshold above 1000', async () => {
    const app = createApp();
    const res = await app.request('/v1/stripe/assess', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        stripe_account_id: 'acct_test123',
        vouch_agent_id: 'agent_123',
        payment_intent_id: 'pi_test123',
        amount: 5000,
        currency: 'usd',
        threshold: 1500,
      }),
    });
    expect(res.status).toBe(400);
  });

  test('should accept valid assess request', async () => {
    const app = createApp();
    const res = await app.request('/v1/stripe/assess', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        stripe_account_id: 'acct_test123',
        vouch_agent_id: 'agent_123',
        payment_intent_id: 'pi_test123',
        amount: 5000,
        currency: 'usd',
        threshold: 400,
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.assessment_id).toBeTruthy();
    expect(body.data.score).toBe(742);
    expect(body.data.meets_threshold).toBe(true);
  });
});

describe('GET /v1/stripe/score/:stripeCustomerId', () => {
  test('should reject invalid customer ID format', async () => {
    const app = createApp();
    const res = await app.request('/v1/stripe/score/invalid_id?stripe_account_id=acct_test123');
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  test('should reject missing stripe_account_id query param', async () => {
    const app = createApp();
    const res = await app.request('/v1/stripe/score/cus_test123');
    expect(res.status).toBe(400);
  });

  test('should return score for valid customer', async () => {
    const app = createApp();
    const res = await app.request('/v1/stripe/score/cus_test123?stripe_account_id=acct_test123');
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.composite).toBe(742);
    expect(body.data.tier).toBe('gold');
  });
});

describe('POST /v1/stripe/webhook', () => {
  test('should reject missing signature header', async () => {
    const app = createApp();
    const res = await app.request('/v1/stripe/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'payment_intent.succeeded', data: { object: {} } }),
    });
    expect(res.status).toBe(401);
  });

  test('should reject invalid signature', async () => {
    const app = createApp();
    const res = await app.request('/v1/stripe/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'stripe-signature': 't=1234567890,v1=invalid_signature_hex',
      },
      body: JSON.stringify({ type: 'payment_intent.succeeded', data: { object: {} } }),
    });
    expect(res.status).toBe(401);
  });

  test('should reject expired timestamp', async () => {
    const app = createApp();
    const oldTimestamp = Math.floor(Date.now() / 1000) - 600;
    const payload = JSON.stringify({
      id: 'evt_test',
      type: 'payment_intent.succeeded',
      data: { object: { id: 'pi_test', metadata: {} } },
    });
    const signedPayload = `${oldTimestamp}.${payload}`;
    const sig = createHmac('sha256', 'whsec_test_secret_key_for_testing')
      .update(signedPayload)
      .digest('hex');

    const res = await app.request('/v1/stripe/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'stripe-signature': `t=${oldTimestamp},v1=${sig}`,
      },
      body: payload,
    });
    expect(res.status).toBe(401);
  });

  test('should accept valid webhook signature for unknown event', async () => {
    const app = createApp();
    const payload = JSON.stringify({
      id: 'evt_test_123',
      type: 'some.unknown.event',
      data: { object: {} },
    });
    const signature = signWebhook(payload, 'whsec_test_secret_key_for_testing');

    const res = await app.request('/v1/stripe/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'stripe-signature': signature,
      },
      body: payload,
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.received).toBe(true);
  });

  test('should process payment_intent.succeeded with agent metadata', async () => {
    const app = createApp();
    const payload = JSON.stringify({
      id: 'evt_pi_succeeded',
      type: 'payment_intent.succeeded',
      data: {
        object: {
          id: 'pi_test_001',
          metadata: { vouch_agent_id: 'agent_test' },
          amount: 5000,
          currency: 'usd',
          on_behalf_of: 'acct_merchant',
        },
      },
    });
    const signature = signWebhook(payload, 'whsec_test_secret_key_for_testing');

    const res = await app.request('/v1/stripe/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'stripe-signature': signature,
      },
      body: payload,
    });
    expect(res.status).toBe(200);
  });
});

describe('GET /v1/stripe/analytics', () => {
  test('should reject missing stripe_account_id', async () => {
    const app = createApp();
    const res = await app.request('/v1/stripe/analytics');
    expect(res.status).toBe(400);
  });

  test('should reject invalid stripe_account_id format', async () => {
    const app = createApp();
    const res = await app.request('/v1/stripe/analytics?stripe_account_id=invalid');
    expect(res.status).toBe(400);
  });

  test('should return report for valid account', async () => {
    const app = createApp();
    const res = await app.request('/v1/stripe/analytics?stripe_account_id=acct_test123');
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.total_agent_transactions).toBe(100);
  });
});

describe('GET /v1/stripe/assessments', () => {
  test('should reject missing stripe_account_id', async () => {
    const app = createApp();
    const res = await app.request('/v1/stripe/assessments');
    expect(res.status).toBe(400);
  });

  test('should return assessments for valid account', async () => {
    const app = createApp();
    const res = await app.request('/v1/stripe/assessments?stripe_account_id=acct_test123');
    expect(res.status).toBe(200);
  });
});

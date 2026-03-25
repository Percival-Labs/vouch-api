// ACP Seller Checkout Routes — Tests
// TDD: These tests define the contract for the ACP seller checkout endpoints.
// Tests run against a Hono app instance with mocked service dependencies.

import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { Hono } from 'hono';

// ── Mock ACP seller service before importing routes ──

const mockCreateCheckout = mock(async (_productId: string, _buyerAddress: string, _metadata?: Record<string, unknown>) => ({
  id: 'session-01',
  productId: 'engram-starter',
  buyerAddress: '0x1234567890abcdef1234567890abcdef12345678',
  status: 'pending' as const,
  priceUsdcCents: 1900,
  expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
  createdAt: new Date().toISOString(),
}));

const mockUpdateCheckout = mock(async (_checkoutId: string, _updates: Record<string, unknown>) => ({
  id: 'session-01',
  status: 'pending' as const,
  updatedAt: new Date().toISOString(),
}));

const mockCompleteCheckout = mock(async (_checkoutId: string, _paymentToken: string) => ({
  id: 'session-01',
  status: 'completed' as const,
  agentKey: 'ak_' + 'a'.repeat(60),
  agentId: 'agent-01',
  gatewayUrl: 'https://gateway.percival-labs.ai',
}));

const mockCancelCheckout = mock(async (_checkoutId: string) => ({
  id: 'session-01',
  status: 'cancelled' as const,
}));

const mockGetProducts = mock(() => [
  {
    id: 'engram-starter',
    name: 'Engram Starter',
    description: 'AI agent with basic capabilities',
    priceUsdcCents: 1900,
    features: ['Basic inference', '10K tokens/day'],
    gatewayTier: 'standard',
  },
  {
    id: 'engram-pro',
    name: 'Engram Pro',
    description: 'AI agent with advanced capabilities',
    priceUsdcCents: 4900,
    features: ['Advanced inference', '100K tokens/day', 'Priority routing'],
    gatewayTier: 'verified',
  },
]);

mock.module('../services/acp-seller-service', () => ({
  createCheckout: mockCreateCheckout,
  updateCheckout: mockUpdateCheckout,
  completeCheckout: mockCompleteCheckout,
  cancelCheckout: mockCancelCheckout,
  getProducts: mockGetProducts,
}));

// ── Import routes after mocks are set up ──
const { default: acpSellerRoutes } = await import('./acp-seller');

// ── Build test app (no auth middleware) ──
function buildApp() {
  const app = new Hono();
  app.route('/v1/acp/checkout', acpSellerRoutes);
  return app;
}

// ── Tests ──

describe('POST /v1/acp/checkout/create', () => {
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    app = buildApp();
    mockCreateCheckout.mockReset();
    mockCreateCheckout.mockImplementation(async () => ({
      id: 'session-01',
      productId: 'engram-starter',
      buyerAddress: '0x1234567890abcdef1234567890abcdef12345678',
      status: 'pending' as const,
      priceUsdcCents: 1900,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      createdAt: new Date().toISOString(),
    }));
  });

  test('returns 200 with checkout session for valid request', async () => {
    const res = await app.request('/v1/acp/checkout/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        productId: 'engram-starter',
        buyerAddress: '0x1234567890abcdef1234567890abcdef12345678',
      }),
    });
    expect(res.status).toBe(200);

    const body = await res.json() as { data: Record<string, unknown> };
    expect(body.data).toHaveProperty('id', 'session-01');
    expect(body.data).toHaveProperty('productId', 'engram-starter');
    expect(body.data).toHaveProperty('status', 'pending');
    expect(body.data).toHaveProperty('priceUsdcCents', 1900);
    expect(body.data).toHaveProperty('expiresAt');
  });

  test('returns 400 when productId is missing', async () => {
    const res = await app.request('/v1/acp/checkout/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        buyerAddress: '0x1234567890abcdef1234567890abcdef12345678',
      }),
    });
    expect(res.status).toBe(400);

    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  test('returns 400 when buyerAddress is missing', async () => {
    const res = await app.request('/v1/acp/checkout/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        productId: 'engram-starter',
      }),
    });
    expect(res.status).toBe(400);

    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  test('returns 400 for invalid EVM address format', async () => {
    const res = await app.request('/v1/acp/checkout/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        productId: 'engram-starter',
        buyerAddress: 'not-an-address',
      }),
    });
    expect(res.status).toBe(400);

    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  test('passes metadata through to service', async () => {
    await app.request('/v1/acp/checkout/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        productId: 'engram-starter',
        buyerAddress: '0x1234567890abcdef1234567890abcdef12345678',
        metadata: { referrer: 'chatgpt' },
      }),
    });

    expect(mockCreateCheckout).toHaveBeenCalledWith(
      'engram-starter',
      '0x1234567890abcdef1234567890abcdef12345678',
      { referrer: 'chatgpt' },
    );
  });

  test('returns 500 on service error', async () => {
    mockCreateCheckout.mockImplementation(async () => {
      throw new Error('DB connection failed');
    });

    const res = await app.request('/v1/acp/checkout/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        productId: 'engram-starter',
        buyerAddress: '0x1234567890abcdef1234567890abcdef12345678',
      }),
    });
    expect(res.status).toBe(500);
  });
});

describe('POST /v1/acp/checkout/update', () => {
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    app = buildApp();
    mockUpdateCheckout.mockReset();
    mockUpdateCheckout.mockImplementation(async () => ({
      id: 'session-01',
      status: 'pending' as const,
      updatedAt: new Date().toISOString(),
    }));
  });

  test('returns 200 on valid update', async () => {
    const res = await app.request('/v1/acp/checkout/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        checkoutId: 'session-01',
        updates: { metadata: { note: 'updated' } },
      }),
    });
    expect(res.status).toBe(200);

    const body = await res.json() as { data: Record<string, unknown> };
    expect(body.data).toHaveProperty('id', 'session-01');
  });

  test('returns 400 when checkoutId is missing', async () => {
    const res = await app.request('/v1/acp/checkout/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        updates: { metadata: { note: 'updated' } },
      }),
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /v1/acp/checkout/complete', () => {
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    app = buildApp();
    mockCompleteCheckout.mockReset();
    mockCompleteCheckout.mockImplementation(async () => ({
      id: 'session-01',
      status: 'completed' as const,
      agentKey: 'ak_' + 'a'.repeat(60),
      agentId: 'agent-01',
      gatewayUrl: 'https://gateway.percival-labs.ai',
    }));
  });

  test('returns 200 with agent key on successful completion', async () => {
    const res = await app.request('/v1/acp/checkout/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        checkoutId: 'session-01',
        paymentToken: 'spt_test_token_abc123',
      }),
    });
    expect(res.status).toBe(200);

    const body = await res.json() as { data: Record<string, unknown> };
    expect(body.data).toHaveProperty('status', 'completed');
    expect(body.data).toHaveProperty('agentKey');
    expect(body.data).toHaveProperty('agentId');
    expect(body.data).toHaveProperty('gatewayUrl');
  });

  test('returns 400 when checkoutId is missing', async () => {
    const res = await app.request('/v1/acp/checkout/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        paymentToken: 'spt_test_token_abc123',
      }),
    });
    expect(res.status).toBe(400);
  });

  test('returns 400 when paymentToken is missing', async () => {
    const res = await app.request('/v1/acp/checkout/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        checkoutId: 'session-01',
      }),
    });
    expect(res.status).toBe(400);
  });

  test('returns 402 on Stripe payment failure', async () => {
    mockCompleteCheckout.mockImplementation(async () => {
      throw new Error('Stripe payment failed');
    });

    const res = await app.request('/v1/acp/checkout/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        checkoutId: 'session-01',
        paymentToken: 'spt_test_token_abc123',
      }),
    });
    expect(res.status).toBe(402);

    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('PAYMENT_FAILED');
  });
});

describe('POST /v1/acp/checkout/cancel', () => {
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    app = buildApp();
    mockCancelCheckout.mockReset();
    mockCancelCheckout.mockImplementation(async () => ({
      id: 'session-01',
      status: 'cancelled' as const,
    }));
  });

  test('returns 200 on valid cancellation', async () => {
    const res = await app.request('/v1/acp/checkout/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        checkoutId: 'session-01',
      }),
    });
    expect(res.status).toBe(200);

    const body = await res.json() as { data: Record<string, unknown> };
    expect(body.data).toHaveProperty('status', 'cancelled');
  });

  test('returns 400 when checkoutId is missing', async () => {
    const res = await app.request('/v1/acp/checkout/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

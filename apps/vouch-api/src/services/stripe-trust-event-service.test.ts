// Tests for Stripe Trust Event Service — MCP-T trust event mapping.
//
// IMPORTANT: Cross-file mock interference warning.
// This test file and stripe-bridge.test.ts both use mock.module() to mock
// @percival/vouch-db. In Bun, mock.module() is global and persists across files
// within the same test run. When run together (e.g. `bun test`), one file's mock
// can override the other's, causing spurious failures.
//
// Workarounds:
//   1. Run each file separately: `bun test src/services/stripe-trust-event-service.test.ts`
//   2. Use `bun test --preload ./test-setup.ts` with shared mock setup
//   3. Use `bun test --bail` to isolate failures
// See: https://bun.sh/docs/test/mocks#mock-module

import { describe, test, expect, mock } from 'bun:test';

// Mock vouch-db before dynamic import of service
mock.module('@percival/vouch-db', () => ({
  db: {
    update: () => ({
      set: () => ({
        where: () => Promise.resolve(),
      }),
    }),
  },
  stripeOutcomes: {},
}));

const { mapStripeEventToMcpT, signTrustEvent } = await import('./stripe-trust-event-service');

describe('mapStripeEventToMcpT', () => {
  const agentId = 'did:key:z6MkTestAgent';
  const piId = 'pi_test_123';

  test('should map payment_intent.succeeded to contract.completed', () => {
    const event = mapStripeEventToMcpT(
      'payment_intent.succeeded',
      agentId,
      piId,
      { amount: 5000, currency: 'usd' },
    );

    expect(event).not.toBeNull();
    expect(event!.event_type).toBe('contract.completed');
    expect(event!.subject_id).toBe(agentId);
    expect(event!.issuer_id).toBe('did:web:vouch.percival-labs.ai');
    expect(event!.domain).toBe('financial');
    expect(event!.payload.contract_id).toBe(piId);
    expect(event!.payload.outcome).toBe('success');
    expect(event!.payload.amount).toBe(5000);
    expect(event!.payload.currency).toBe('usd');
    expect(event!.payload.source).toBe('stripe');
    expect(event!.dimensions_affected).toContain('performance');
    expect(event!.dimensions_affected).toContain('consistency');
  });

  test('should map charge.dispute.created to contract.disputed', () => {
    const event = mapStripeEventToMcpT(
      'charge.dispute.created',
      agentId,
      piId,
      { reason: 'fraudulent', amount: 5000 },
    );

    expect(event).not.toBeNull();
    expect(event!.event_type).toBe('contract.disputed');
    expect(event!.payload.dispute_reason).toBe('fraudulent');
    expect(event!.dimensions_affected).toContain('performance');
    expect(event!.dimensions_affected).toContain('commitment');
    expect(event!.dimensions_affected).toContain('community');
  });

  test('should map charge.refunded to contract.failed', () => {
    const event = mapStripeEventToMcpT(
      'charge.refunded',
      agentId,
      piId,
      { amount: 3000, refundRatio: 0.6 },
    );

    expect(event).not.toBeNull();
    expect(event!.event_type).toBe('contract.failed');
    expect(event!.payload.reason).toBe('refunded');
    expect(event!.payload.refund_ratio).toBe(0.6);
    expect(event!.dimensions_affected).toContain('performance');
  });

  test('should map payment_intent.payment_failed to contract.failed', () => {
    const event = mapStripeEventToMcpT(
      'payment_intent.payment_failed',
      agentId,
      piId,
      { failureMessage: 'Insufficient funds' },
    );

    expect(event).not.toBeNull();
    expect(event!.event_type).toBe('contract.failed');
    expect(event!.payload.reason).toBe('Insufficient funds');
  });

  test('should map charge.dispute.closed (won) to contract.completed', () => {
    const event = mapStripeEventToMcpT(
      'charge.dispute.closed',
      agentId,
      piId,
      { status: 'won' },
    );

    expect(event).not.toBeNull();
    expect(event!.event_type).toBe('contract.completed');
    expect(event!.payload.note).toBe('dispute resolved in favor');
  });

  test('should return null for charge.dispute.closed (lost)', () => {
    const event = mapStripeEventToMcpT(
      'charge.dispute.closed',
      agentId,
      piId,
      { status: 'lost' },
    );

    expect(event).toBeNull();
  });

  test('should return null for unknown event types', () => {
    const event = mapStripeEventToMcpT(
      'unknown.event.type',
      agentId,
      piId,
    );

    expect(event).toBeNull();
  });

  test('should include event_id and timestamp on all events', () => {
    const event = mapStripeEventToMcpT(
      'payment_intent.succeeded',
      agentId,
      piId,
    );

    expect(event!.event_id).toBeTruthy();
    expect(event!.event_id.length).toBeGreaterThan(0);
    expect(event!.timestamp).toBeTruthy();
    const parsed = new Date(event!.timestamp);
    expect(parsed.getTime()).not.toBeNaN();
  });

  test('should use default values when metadata is empty', () => {
    const event = mapStripeEventToMcpT(
      'charge.dispute.created',
      agentId,
      piId,
      {},
    );

    expect(event!.payload.dispute_reason).toBe('unknown');
  });
});

describe('signTrustEvent', () => {
  test('should return event unchanged when VOUCH_SIGNING_KEY is not set', () => {
    const originalKey = process.env.VOUCH_SIGNING_KEY;
    delete process.env.VOUCH_SIGNING_KEY;

    const event = mapStripeEventToMcpT(
      'payment_intent.succeeded',
      'agent_123',
      'pi_test',
    )!;

    const signed = signTrustEvent(event);
    expect(signed.signature).toBeUndefined();

    if (originalKey) process.env.VOUCH_SIGNING_KEY = originalKey;
  });
});

describe('Trust Event Dimension Mapping', () => {
  test('should affect correct dimensions for each event type', () => {
    const succeeded = mapStripeEventToMcpT('payment_intent.succeeded', 'a', 'pi')!;
    expect(succeeded.dimensions_affected).toEqual(['performance', 'consistency']);

    const disputed = mapStripeEventToMcpT('charge.dispute.created', 'a', 'pi')!;
    expect(disputed.dimensions_affected).toEqual(['performance', 'commitment', 'community']);

    const refunded = mapStripeEventToMcpT('charge.refunded', 'a', 'pi')!;
    expect(refunded.dimensions_affected).toEqual(['performance']);

    const failed = mapStripeEventToMcpT('payment_intent.payment_failed', 'a', 'pi')!;
    expect(failed.dimensions_affected).toEqual(['performance']);
  });
});

// Stripe Trust Event Service — maps Stripe webhook events to MCP-T trust events.
// Closes the feedback loop between transaction outcomes and agent reputation.

import { db, stripeOutcomes } from '@percival/vouch-db';
import { eq } from 'drizzle-orm';
import { ed25519 } from '@noble/curves/ed25519';
import { ulid } from 'ulid';

// ── Types ──

export interface McpTTrustEvent {
  event_id: string;
  event_type: string;
  subject_id: string;
  issuer_id: string;
  timestamp: string;
  domain: string;
  payload: Record<string, any>;
  dimensions_affected: string[];
  signature?: string;
}

// ── Event Mapping ──

/**
 * Map a Stripe webhook event type to an MCP-T trust event.
 * Per architecture doc Section 9.
 */
export function mapStripeEventToMcpT(
  stripeEventType: string,
  agentId: string,
  paymentIntentId: string,
  metadata: Record<string, any> = {},
): McpTTrustEvent | null {
  const now = new Date().toISOString();
  const eventId = ulid();
  const issuerId = 'did:web:vouch.percival-labs.ai';

  switch (stripeEventType) {
    case 'payment_intent.succeeded':
      return {
        event_id: eventId,
        event_type: 'contract.completed',
        subject_id: agentId,
        issuer_id: issuerId,
        timestamp: now,
        domain: 'financial',
        payload: {
          contract_id: paymentIntentId,
          outcome: 'success',
          amount: metadata.amount,
          currency: metadata.currency,
          source: 'stripe',
        },
        dimensions_affected: ['performance', 'consistency'],
      };

    case 'charge.dispute.created':
      return {
        event_id: eventId,
        event_type: 'contract.disputed',
        subject_id: agentId,
        issuer_id: issuerId,
        timestamp: now,
        domain: 'financial',
        payload: {
          contract_id: paymentIntentId,
          dispute_reason: metadata.reason || 'unknown',
          amount: metadata.amount,
          source: 'stripe',
        },
        dimensions_affected: ['performance', 'commitment', 'community'],
      };

    case 'charge.refunded':
      return {
        event_id: eventId,
        event_type: 'contract.failed',
        subject_id: agentId,
        issuer_id: issuerId,
        timestamp: now,
        domain: 'financial',
        payload: {
          contract_id: paymentIntentId,
          outcome: 'failure',
          reason: 'refunded',
          refund_ratio: metadata.refundRatio ?? 1.0,
          amount: metadata.amount,
          source: 'stripe',
        },
        dimensions_affected: ['performance'],
      };

    case 'payment_intent.payment_failed':
      return {
        event_id: eventId,
        event_type: 'contract.failed',
        subject_id: agentId,
        issuer_id: issuerId,
        timestamp: now,
        domain: 'financial',
        payload: {
          contract_id: paymentIntentId,
          outcome: 'failure',
          reason: metadata.failureMessage || 'payment_failed',
          source: 'stripe',
        },
        dimensions_affected: ['performance'],
      };

    case 'charge.dispute.closed':
      // Dispute resolved in agent's favor — positive correction
      if (metadata.status === 'won') {
        return {
          event_id: eventId,
          event_type: 'contract.completed',
          subject_id: agentId,
          issuer_id: issuerId,
          timestamp: now,
          domain: 'financial',
          payload: {
            contract_id: paymentIntentId,
            outcome: 'success',
            note: 'dispute resolved in favor',
            source: 'stripe',
          },
          dimensions_affected: ['performance'],
        };
      }
      return null;

    default:
      return null;
  }
}

/**
 * Sign an MCP-T trust event with Ed25519.
 * Uses the Vouch platform signing key from environment.
 */
export function signTrustEvent(event: McpTTrustEvent): McpTTrustEvent {
  const signingKeyHex = process.env.VOUCH_SIGNING_KEY;
  if (!signingKeyHex) {
    console.warn('[stripe-trust] VOUCH_SIGNING_KEY not configured, skipping signature');
    return event;
  }

  try {
    const signingKey = hexToBytes(signingKeyHex);
    const payload = JSON.stringify({
      event_id: event.event_id,
      event_type: event.event_type,
      subject_id: event.subject_id,
      issuer_id: event.issuer_id,
      timestamp: event.timestamp,
      payload: event.payload,
    });

    const messageBytes = new TextEncoder().encode(payload);
    const signature = ed25519.sign(messageBytes, signingKey);

    return {
      ...event,
      signature: bytesToHex(signature),
    };
  } catch (err) {
    console.error('[stripe-trust] Failed to sign trust event:', err);
    return event;
  }
}

/**
 * Process a Stripe webhook event and emit a corresponding MCP-T trust event.
 * Updates the outcome record to mark the trust event as emitted.
 */
export async function emitTrustEvent(
  outcomeId: string,
  stripeEventType: string,
  agentId: string,
  paymentIntentId: string,
  metadata: Record<string, any> = {},
): Promise<McpTTrustEvent | null> {
  const event = mapStripeEventToMcpT(stripeEventType, agentId, paymentIntentId, metadata);

  if (!event) return null;

  const signedEvent = signTrustEvent(event);

  // Mark the outcome as having emitted a trust event
  await db.update(stripeOutcomes)
    .set({ trustEventEmitted: true })
    .where(eq(stripeOutcomes.id, outcomeId));

  console.log(`[stripe-trust] Emitted ${signedEvent.event_type} for agent ${agentId} (PI: ${paymentIntentId})`);

  return signedEvent;
}

// ── Helpers ──

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// Gateway Service — manages agent keys on the Vouch Gateway for credits-based payouts.
// Uses the Gateway admin API (X-Gateway-Secret auth).

import { createHmac } from 'crypto';

const GATEWAY_ADMIN_URL = process.env.GATEWAY_ADMIN_URL || 'https://gateway.percival-labs.ai';
const GATEWAY_SECRET = process.env.GATEWAY_SECRET || '';

export interface AgentKeyEntry {
  pubkey: string;
  agentId: string;
  name: string;
  tier?: string;
  budget?: { maxSats: number; periodDays: number };
  billingMode?: string;
}

/**
 * S12 fix: Derive a deterministic but unguessable token from the agent's pubkey.
 * Uses HMAC-SHA256(GATEWAY_SECRET, pubkey) so knowing the pubkey alone isn't enough.
 */
export function deriveAgentToken(agentPubkey: string): string {
  if (!GATEWAY_SECRET) {
    throw new Error('GATEWAY_SECRET not configured — cannot derive agent token');
  }
  return createHmac('sha256', GATEWAY_SECRET).update(agentPubkey).digest('hex');
}

// S13 fix: Serialize concurrent credit operations per agent to prevent TOCTOU.
// Simple in-process mutex — maps agentPubkey to a promise chain.
const creditLocks = new Map<string, Promise<unknown>>();

function withCreditLock<T>(agentPubkey: string, fn: () => Promise<T>): Promise<T> {
  const prev = creditLocks.get(agentPubkey) ?? Promise.resolve();
  const next = prev.then(fn, fn); // Run fn after previous completes (even if it failed)
  creditLocks.set(agentPubkey, next);
  // Clean up after completion to prevent memory leak
  next.finally(() => {
    if (creditLocks.get(agentPubkey) === next) {
      creditLocks.delete(agentPubkey);
    }
  });
  return next;
}

/**
 * Get an agent's Gateway credentials. The agent authenticates via NIP-98 or Ed25519,
 * then calls this to retrieve their AgentKey token and current budget.
 * Returns null if the agent has no Gateway key.
 */
export async function getAgentGatewayCredentials(
  agentPubkey: string,
): Promise<{ token: string; gatewayUrl: string; budget: { maxSats: number; periodDays: number } | null } | null> {
  if (!GATEWAY_SECRET) {
    throw new Error('GATEWAY_SECRET not configured');
  }

  const token = deriveAgentToken(agentPubkey);

  const res = await fetch(`${GATEWAY_ADMIN_URL}/admin/v1/agents/${token}`, {
    method: 'GET',
    headers: { 'X-Gateway-Secret': GATEWAY_SECRET },
  });

  if (!res.ok) return null; // Agent has no Gateway key

  const data = await res.json() as { data?: AgentKeyEntry };
  if (!data.data) return null;

  return {
    token,
    gatewayUrl: GATEWAY_ADMIN_URL,
    budget: data.data.budget ?? null,
  };
}

/**
 * Pay an agent via Gateway credits by creating or topping up their AgentKey budget.
 * Calls PUT /admin/v1/agents/{token} on the Gateway.
 *
 * @param agentPubkey - hex pubkey of the agent
 * @param creditSats - sats to add to the agent's Gateway budget
 * @param reason - audit trail description
 * @returns the agent key token (64-char hex)
 */
export async function payAgentGatewayCredits(
  agentPubkey: string,
  creditSats: number,
  reason: string,
): Promise<{ token: string; totalBudgetSats: number }> {
  if (!GATEWAY_SECRET) {
    throw new Error('GATEWAY_SECRET not configured — cannot manage Gateway agent keys');
  }

  // S12 fix: Token is HMAC-derived, not the raw pubkey
  const token = deriveAgentToken(agentPubkey);

  // S13 fix: Serialize operations per agent to prevent read-check-write race
  return withCreditLock(agentPubkey, async () => {
    // Check if agent key already exists
    const existingRes = await fetch(`${GATEWAY_ADMIN_URL}/admin/v1/agents/${token}`, {
      method: 'GET',
      headers: { 'X-Gateway-Secret': GATEWAY_SECRET },
    });

    let currentBudget = 0;
    if (existingRes.ok) {
      const existing = await existingRes.json() as { data?: AgentKeyEntry };
      currentBudget = existing.data?.budget?.maxSats ?? 0;
    }

    const newBudget = currentBudget + creditSats;

    // Create or update the agent key
    const res = await fetch(`${GATEWAY_ADMIN_URL}/admin/v1/agents/${token}`, {
      method: 'PUT',
      headers: {
        'X-Gateway-Secret': GATEWAY_SECRET,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        pubkey: agentPubkey,
        agentId: `contract-agent-${agentPubkey.slice(0, 8)}`,
        name: `Contract Agent ${agentPubkey.slice(0, 8)}`,
        tier: 'standard',
        budget: {
          maxSats: newBudget,
          periodDays: 365, // annual budget window
        },
        billingMode: 'credits',
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Gateway admin API error (${res.status}): ${body}`);
    }

    console.log(`[gateway] Credits payout: ${creditSats} sats to ${agentPubkey.slice(0, 8)}... (total: ${newBudget}). Reason: ${reason}`);
    return { token, totalBudgetSats: newBudget };
  });
}

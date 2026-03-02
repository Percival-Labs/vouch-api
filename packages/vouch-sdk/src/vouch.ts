/**
 * Vouch — High-Level Agent SDK
 *
 * The primary interface for agents to interact with the Vouch trust network.
 * Handles identity, trust verification, outcome reporting, and score management.
 *
 * Usage:
 *   const vouch = new Vouch({ nsec: process.env.VOUCH_NSEC });
 *   await vouch.register({ name: 'MyAgent', model: 'claude-sonnet-4-6' });
 *   const trust = await vouch.verify('npub1abc...');
 */

import {
  generateNostrKeypair,
  identityFromNsec,
  identityFromHex,
  signEvent,
  verifyEvent,
  npubToHex,
  type NostrIdentity,
  type NostrEvent,
  type UnsignedEvent,
} from './nostr-identity.js';

// ── Types ──

export interface VouchOptions {
  /** Existing Nostr private key (bech32 nsec format). Omit to auto-generate. */
  nsec?: string;
  /** Existing Nostr private key (hex format). Omit to auto-generate. */
  secretKeyHex?: string;
  /** Vouch relay URL */
  relay?: string;
  /** Vouch API base URL */
  apiUrl?: string;
}

export interface RegisterOptions {
  name: string;
  model?: string;
  capabilities?: string[];
  description?: string;
  /** Optional ERC-8004 on-chain identity linkage */
  erc8004?: {
    agentId: string | number;
    chain: 'base' | 'base-sepolia';
    signature: string;
  };
}

export interface RegisterResult {
  npub: string;
  nip05: string;
  score: number;
  agentId: string;
}

export interface TrustResult {
  npub: string;
  score: number;
  tier: 'unranked' | 'bronze' | 'silver' | 'gold' | 'diamond';
  backed: boolean;
  poolSats: number;
  stakerCount: number;
  performance: {
    successRate: number;
    totalOutcomes: number;
  };
  dimensions: {
    verification: number;
    tenure: number;
    performance: number;
    backing: number;
    community: number;
  };
}

export interface OutcomeOptions {
  /** Counterparty's npub */
  counterparty: string;
  /** Your role in this interaction */
  role: 'performer' | 'purchaser';
  /** Task type for categorization */
  taskType: string;
  /** Whether the task succeeded */
  success: boolean;
  /** Rating (1-5, optional, typically from purchaser) */
  rating?: number;
  /** Free-form evidence or description */
  evidence?: string;
  /** Task reference ID (both parties should use the same ID for matching) */
  taskRef?: string;
}

export interface ScoreResult {
  score: number;
  tier: 'unranked' | 'bronze' | 'silver' | 'gold' | 'diamond';
  breakdown: {
    verification: number;
    tenure: number;
    performance: number;
    backing: number;
    community: number;
  };
}

export interface ProveResult {
  /** Signed NIP-85 event that any Nostr client can verify */
  event: NostrEvent;
  /** Score at time of proof */
  score: number;
  tier: string;
}

// ── Score Tier Thresholds ──

function scoreTier(score: number): TrustResult['tier'] {
  if (score >= 850) return 'diamond';
  if (score >= 700) return 'gold';
  if (score >= 400) return 'silver';
  if (score >= 200) return 'bronze';
  return 'unranked';
}

// ── Main Class ──

export class Vouch {
  readonly identity: NostrIdentity;
  readonly relay: string;
  readonly apiUrl: string;

  private _agentId: string | null = null;
  private _scoreCache: { score: TrustResult; fetchedAt: number } | null = null;
  private static readonly CACHE_TTL_MS = 60_000; // 1 minute

  constructor(opts: VouchOptions = {}) {
    // Initialize identity
    if (opts.nsec) {
      this.identity = identityFromNsec(opts.nsec);
    } else if (opts.secretKeyHex) {
      this.identity = identityFromHex(opts.secretKeyHex);
    } else {
      this.identity = generateNostrKeypair();
    }

    this.relay = opts.relay ?? 'wss://relay.vouch.xyz';
    this.apiUrl = opts.apiUrl ?? 'https://percivalvouch-api-production.up.railway.app';
  }

  /** The agent's npub (bech32 Nostr public key) */
  get npub(): string {
    return this.identity.npub;
  }

  /** The agent's hex pubkey */
  get pubkey(): string {
    return this.identity.pubkeyHex;
  }

  // ── Core API ──

  /**
   * Register this agent with Vouch.
   * One-time operation — creates the agent record, generates NIP-05, publishes initial profile.
   */
  async register(opts: RegisterOptions): Promise<RegisterResult> {
    const body: Record<string, unknown> = {
      pubkey: this.identity.pubkeyHex,
      npub: this.identity.npub,
      name: opts.name,
      model: opts.model,
      capabilities: opts.capabilities,
      description: opts.description,
    };

    if (opts.erc8004) {
      body.erc8004 = {
        agentId: String(opts.erc8004.agentId),
        chain: opts.erc8004.chain === 'base' ? 'eip155:8453' : 'eip155:84532',
        signature: opts.erc8004.signature,
      };
    }

    const res = await this.signedFetch('POST', '/v1/sdk/agents/register', body);
    const data = res as {
      agent_id: string;
      npub: string;
      nip05: string;
      score: number;
    };

    this._agentId = data.agent_id;

    return {
      npub: data.npub,
      nip05: data.nip05,
      score: data.score,
      agentId: data.agent_id,
    };
  }

  /**
   * Verify another agent's trust score.
   * Fetches the NIP-85 assertion from the Vouch relay (or falls back to HTTP API).
   */
  async verify(npub: string): Promise<TrustResult> {
    const hexPubkey = npubToHex(npub);

    // Fetch from API (faster, more complete than relay query for now)
    const res = await this.fetch('GET', `/v1/sdk/agents/${hexPubkey}/score`);
    const data = res as {
      score: number;
      dimensions: TrustResult['dimensions'];
      backed: boolean;
      pool_sats: number;
      staker_count: number;
      performance: { success_rate: number; total_outcomes: number };
    };

    return {
      npub,
      score: data.score,
      tier: scoreTier(data.score),
      backed: data.backed,
      poolSats: data.pool_sats,
      stakerCount: data.staker_count,
      performance: {
        successRate: data.performance.success_rate,
        totalOutcomes: data.performance.total_outcomes,
      },
      dimensions: data.dimensions,
    };
  }

  /**
   * Generate a signed proof of your current trust score.
   * Returns a NIP-85 kind 30382 event signed by the Vouch service key,
   * plus a self-signed attestation that you're requesting this proof.
   */
  async prove(): Promise<ProveResult> {
    const res = await this.signedFetch('POST', '/v1/sdk/agents/me/prove', {});
    const data = res as {
      event: NostrEvent;
      score: number;
      tier: string;
    };

    return data;
  }

  /**
   * Report a task outcome.
   * Both performer and purchaser should report for full credit.
   * Matching is done by taskRef — both parties must use the same one.
   */
  async reportOutcome(opts: OutcomeOptions): Promise<{ outcomeId: string; creditAwarded: 'full' | 'partial' | 'pending' }> {
    const taskRef = opts.taskRef ?? crypto.randomUUID();
    const counterpartyHex = npubToHex(opts.counterparty);

    // Prevent self-play: cannot report outcomes with yourself as counterparty
    if (counterpartyHex.toLowerCase() === this.identity.pubkeyHex.toLowerCase()) {
      throw new Error('Cannot report outcome with yourself as counterparty');
    }

    // Publish outcome event to relay via API
    const res = await this.signedFetch('POST', '/v1/outcomes', {
      counterparty: counterpartyHex,
      role: opts.role,
      task_type: opts.taskType,
      success: opts.success,
      rating: opts.rating,
      evidence: opts.evidence,
      task_ref: taskRef,
    });

    return res as { outcomeId: string; creditAwarded: 'full' | 'partial' | 'pending' };
  }

  /**
   * Get your own current trust score.
   */
  async getScore(): Promise<ScoreResult> {
    const res = await this.signedFetch('GET', '/v1/sdk/agents/me/score', undefined);
    const data = res as {
      score: number;
      dimensions: ScoreResult['breakdown'];
    };

    return {
      score: data.score,
      tier: scoreTier(data.score),
      breakdown: data.dimensions,
    };
  }

  /**
   * Get score for any agent by npub.
   */
  async getScoreFor(npub: string): Promise<ScoreResult> {
    const trust = await this.verify(npub);
    return {
      score: trust.score,
      tier: trust.tier,
      breakdown: trust.dimensions,
    };
  }

  // ── Contract API ──

  /**
   * Create a new contract (as customer). Returns contractId.
   */
  async createContract(opts: import('./types.js').CreateContractOptions): Promise<{ contractId: string; milestoneCount: number }> {
    const res = await this.signedFetch('POST', '/v1/contracts', {
      agent_pubkey: opts.agentPubkey,
      title: opts.title,
      description: opts.description,
      sow: opts.sow,
      total_sats: opts.totalSats,
      retention_bps: opts.retentionBps,
      retention_release_after_days: opts.retentionReleaseAfterDays,
      milestones: opts.milestones,
    });
    return res as { contractId: string; milestoneCount: number };
  }

  /**
   * List contracts for the authenticated user.
   */
  async listContracts(opts?: { role?: 'customer' | 'agent' | 'any'; status?: string; page?: number; limit?: number }): Promise<import('./types.js').PaginatedResponse<import('./types.js').ContractSummary>> {
    const params = new URLSearchParams();
    if (opts?.role) params.set('role', opts.role);
    if (opts?.status) params.set('status', opts.status);
    if (opts?.page) params.set('page', String(opts.page));
    if (opts?.limit) params.set('limit', String(opts.limit));
    const qs = params.toString();
    const res = await this.signedFetch('GET', `/v1/contracts${qs ? `?${qs}` : ''}`, undefined);
    return res as import('./types.js').PaginatedResponse<import('./types.js').ContractSummary>;
  }

  /**
   * Get full contract detail including milestones, change orders, and events.
   */
  async getContract(contractId: string): Promise<import('./types.js').ContractDetail> {
    const res = await this.signedFetch('GET', `/v1/contracts/${contractId}`, undefined);
    return res as import('./types.js').ContractDetail;
  }

  /**
   * Activate a draft contract (customer only).
   */
  async activateContract(contractId: string): Promise<{ status: string }> {
    const res = await this.signedFetch('POST', `/v1/contracts/${contractId}/activate`, {});
    return res as { status: string };
  }

  /**
   * Submit a milestone deliverable (agent only).
   */
  async submitMilestone(contractId: string, milestoneId: string, opts?: { deliverableUrl?: string; deliverableNotes?: string }): Promise<void> {
    await this.signedFetch('POST', `/v1/contracts/${contractId}/milestones/${milestoneId}/submit`, {
      deliverable_url: opts?.deliverableUrl,
      deliverable_notes: opts?.deliverableNotes,
    });
  }

  /**
   * Accept a submitted milestone (customer only). Triggers payment release.
   */
  async acceptMilestone(contractId: string, milestoneId: string): Promise<{ milestoneAccepted: boolean; contractCompleted: boolean }> {
    const res = await this.signedFetch('POST', `/v1/contracts/${contractId}/milestones/${milestoneId}/accept`, {});
    return res as { milestoneAccepted: boolean; contractCompleted: boolean };
  }

  /**
   * Reject a submitted milestone (customer only). Agent can re-submit.
   */
  async rejectMilestone(contractId: string, milestoneId: string, reason: string): Promise<void> {
    await this.signedFetch('POST', `/v1/contracts/${contractId}/milestones/${milestoneId}/reject`, { reason });
  }

  /**
   * Propose a change order (either party on active contract).
   */
  async proposeChangeOrder(contractId: string, opts: import('./types.js').ChangeOrderOptions): Promise<{ changeOrderId: string; sequence: number }> {
    const res = await this.signedFetch('POST', `/v1/contracts/${contractId}/change-orders`, {
      title: opts.title,
      description: opts.description,
      cost_delta_sats: opts.costDeltaSats ?? 0,
      timeline_delta_days: opts.timelineDeltaDays ?? 0,
    });
    return res as { changeOrderId: string; sequence: number };
  }

  /**
   * Approve a change order (the other party).
   */
  async approveChangeOrder(contractId: string, changeOrderId: string): Promise<void> {
    await this.signedFetch('POST', `/v1/contracts/${contractId}/change-orders/${changeOrderId}/approve`, {});
  }

  /**
   * Reject a change order (the other party).
   */
  async rejectChangeOrder(contractId: string, changeOrderId: string, reason?: string): Promise<void> {
    await this.signedFetch('POST', `/v1/contracts/${contractId}/change-orders/${changeOrderId}/reject`, { reason });
  }

  /**
   * Rate the other party after contract completion.
   */
  async rateContract(contractId: string, rating: number, review?: string): Promise<{ rated: boolean; bothRated: boolean }> {
    const res = await this.signedFetch('POST', `/v1/contracts/${contractId}/rate`, { rating, review });
    return res as { rated: boolean; bothRated: boolean };
  }

  /**
   * Cancel a draft/awaiting contract.
   */
  async cancelContract(contractId: string, reason: string): Promise<void> {
    await this.signedFetch('POST', `/v1/contracts/${contractId}/cancel`, { reason });
  }

  // ── ISC (Ideal State Criteria) API ──

  /**
   * Get ISC criteria for a specific milestone.
   * Returns null if no ISC criteria are set.
   */
  async getMilestoneISC(contractId: string, milestoneId: string): Promise<import('./types.js').MilestoneISC | null> {
    const res = await this.signedFetch('GET', `/v1/contracts/${contractId}/milestones/${milestoneId}/isc`, undefined);
    return (res as { isc: import('./types.js').MilestoneISC | null }).isc;
  }

  /**
   * Submit a milestone with ISC evidence for each criterion.
   * Evidence is a map of criterion ID to proof string.
   * All CRITICAL criteria must have evidence or submission will fail.
   */
  async submitMilestoneWithISC(
    contractId: string,
    milestoneId: string,
    evidence: Record<string, string>,
    opts?: { deliverableUrl?: string; deliverableNotes?: string },
  ): Promise<void> {
    await this.signedFetch('POST', `/v1/contracts/${contractId}/milestones/${milestoneId}/submit`, {
      deliverable_url: opts?.deliverableUrl,
      deliverable_notes: opts?.deliverableNotes,
      isc_evidence: evidence,
    });
  }

  /**
   * Accept a milestone with optional ISC criterion overrides.
   * Overrides allow the customer to mark criteria as passed/failed with a note.
   * All CRITICAL criteria must be passed or the acceptance will fail.
   */
  async acceptMilestoneWithISC(
    contractId: string,
    milestoneId: string,
    overrides?: Record<string, { status: 'passed' | 'failed'; note?: string }>,
  ): Promise<{ milestoneAccepted: boolean; contractCompleted: boolean }> {
    const res = await this.signedFetch('POST', `/v1/contracts/${contractId}/milestones/${milestoneId}/accept`, {
      isc_overrides: overrides,
    });
    return res as { milestoneAccepted: boolean; contractCompleted: boolean };
  }

  // ── Nostr Event Helpers ──

  /**
   * Sign a Nostr event with this agent's key.
   */
  async sign(event: UnsignedEvent): Promise<NostrEvent> {
    return signEvent(event, this.identity.secretKeyHex);
  }

  /**
   * Verify a Nostr event's signature.
   */
  async verifyEventSignature(event: NostrEvent): Promise<boolean> {
    return verifyEvent(event);
  }

  // ── Internal HTTP Methods ──

  /**
   * Fetch with NIP-98 HTTP Auth (signed Nostr event in Authorization header).
   */
  private async signedFetch(method: string, path: string, body?: unknown): Promise<unknown> {
    // Serialize body first so we can hash it for the auth event
    let bodyStr: string | undefined;
    if (body !== undefined) {
      bodyStr = JSON.stringify(body);
    }

    // Create NIP-98 auth event
    const tags: string[][] = [
      ['u', `${this.apiUrl}${path}`],
      ['method', method],
    ];

    // Add SHA-256 body hash tag for POST/PUT/PATCH requests (NIP-98 payload binding)
    if (bodyStr) {
      const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(bodyStr));
      const hashHex = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
      tags.push(['payload', hashHex]);
    }

    const authEvent: UnsignedEvent = {
      pubkey: this.identity.pubkeyHex,
      created_at: Math.floor(Date.now() / 1000),
      kind: 27235, // NIP-98 HTTP Auth
      tags,
      content: '',
    };

    const signedAuth = await signEvent(authEvent, this.identity.secretKeyHex);
    const authHeader = `Nostr ${btoa(JSON.stringify(signedAuth))}`;

    const headers: Record<string, string> = {
      Authorization: authHeader,
    };

    if (bodyStr !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    const res = await fetch(`${this.apiUrl}${path}`, {
      method,
      headers,
      body: bodyStr,
    });

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({})) as Record<string, unknown>;
      const errMsg = (errBody as { error?: { message?: string } })?.error?.message ?? res.statusText;
      throw new Error(`Vouch API error ${res.status}: ${errMsg}`);
    }

    const json = await res.json() as { data: unknown };
    return json.data;
  }

  /**
   * Unauthenticated fetch (for public endpoints).
   */
  private async fetch(method: string, path: string): Promise<unknown> {
    const res = await fetch(`${this.apiUrl}${path}`, { method });

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({})) as Record<string, unknown>;
      const errMsg = (errBody as { error?: { message?: string } })?.error?.message ?? res.statusText;
      throw new Error(`Vouch API error ${res.status}: ${errMsg}`);
    }

    const json = await res.json() as { data: unknown };
    return json.data;
  }
}

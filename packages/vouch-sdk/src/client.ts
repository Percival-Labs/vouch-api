// VouchClient — typed SDK for the Vouch Agent API.
// Zero external dependencies. Ed25519 auth via crypto.subtle.

import { generateKeyPair, signRequest, importPrivateKey, importPublicKey, buildRegistrationMessage } from './crypto';
import { VouchApiError } from './errors';
import type {
  Agent,
  Table,
  Post,
  PostDetail,
  Comment,
  Pool,
  VouchBreakdown,
  StakeResult,
  UnstakeResult,
  StakerPosition,
  PaginatedResponse,
  SingleResponse,
  VouchCredentials,
} from './types';

// ── Options ──

export interface VouchClientOptions {
  /** On-chain ERC-8004 token ID (as string for bigint) */
  erc8004AgentId: string;
  /** Chain identifier, e.g. "eip155:8453" (Base) or "eip155:84532" (Base Sepolia) */
  erc8004Chain: string;
  /** Ethereum address that owns the ERC-8004 NFT */
  ownerAddress: string;
  /** EIP-191 hex signature of the registration message */
  ownerSignature: string;
  name?: string;
  modelFamily?: string;
  description?: string;
  baseUrl?: string;
}

export interface VouchFromCredentials {
  agentId: string;
  erc8004AgentId?: string;
  erc8004Chain?: string;
  privateKeyBase64: string;
  publicKeyBase64: string;
  baseUrl?: string;
}

// ── Pagination Params ──

interface PaginationParams {
  page?: number;
  limit?: number;
}

// ── Post Creation ──

interface CreatePostParams {
  title: string;
  body: string;
  body_format?: 'markdown' | 'plaintext';
  signature?: string;
}

// ── Comment Creation ──

interface CreateCommentParams {
  body: string;
  parent_id?: string;
  signature?: string;
}

// ── Pool Creation ──

interface CreatePoolParams {
  agent_id: string;
  activity_fee_rate_bps?: number;
}

// ── Stake Params ──

interface StakeParams {
  staker_id: string;
  staker_type: 'user' | 'agent';
  amount_sats: number;
}

// ── Fee Params ──

interface RecordFeeParams {
  agent_id: string;
  action_type: string;
  gross_revenue_sats: number;
}

// ── Distribute Params ──

interface DistributeParams {
  period_start: string;
  period_end: string;
}

// ── Agent Update Params ──

interface UpdateAgentParams {
  name?: string;
  description?: string;
  avatarUrl?: string;
}

// ── Post List Params ──

interface ListPostsParams extends PaginationParams {
  sort?: 'new' | 'top' | 'hot';
}

const DEFAULT_BASE_URL = 'https://percivalvouch-api-production.up.railway.app';

export class VouchClient {
  private readonly baseUrl: string;
  private readonly agentId: string;
  private readonly privateKey: CryptoKey;
  private readonly publicKeyBase64: string;
  private readonly privateKeyBase64: string;

  private constructor(
    agentId: string,
    privateKey: CryptoKey,
    publicKeyBase64: string,
    privateKeyBase64: string,
    baseUrl: string,
  ) {
    this.agentId = agentId;
    this.privateKey = privateKey;
    this.publicKeyBase64 = publicKeyBase64;
    this.privateKeyBase64 = privateKeyBase64;
    this.baseUrl = baseUrl;
  }

  /**
   * Register a new agent with ERC-8004 on-chain identity and return an authenticated client.
   *
   * The caller is responsible for:
   * 1. Minting the ERC-8004 NFT on Base (using @agentic-trust/8004-sdk or any method)
   * 2. Signing the ownership proof with their Ethereum wallet (EIP-191)
   * 3. Passing the pre-computed ownerSignature
   *
   * This method generates a fresh Ed25519 key pair for API authentication.
   */
  static async create(opts: VouchClientOptions): Promise<VouchClient> {
    const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    const kp = await generateKeyPair();

    const body = JSON.stringify({
      erc8004AgentId: opts.erc8004AgentId,
      erc8004Chain: opts.erc8004Chain,
      ownerAddress: opts.ownerAddress,
      ownerSignature: opts.ownerSignature,
      publicKey: kp.publicKeyBase64,
      name: opts.name,
      modelFamily: opts.modelFamily,
      description: opts.description,
    });

    // Registration does NOT require Ed25519 signature auth
    const res = await fetch(`${baseUrl}/v1/agents/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

    if (!res.ok) {
      await throwApiError(res);
    }

    const json = await res.json() as SingleResponse<{
      agent_id: string;
      erc8004_agent_id: string;
      erc8004_chain: string;
    }>;

    return new VouchClient(
      json.data.agent_id,
      kp.privateKey,
      kp.publicKeyBase64,
      kp.privateKeyBase64,
      baseUrl,
    );
  }

  /**
   * Restore a client from previously exported credentials.
   * No network request — just imports keys and returns a ready client.
   */
  static async fromCredentials(creds: VouchFromCredentials): Promise<VouchClient> {
    const baseUrl = creds.baseUrl ?? DEFAULT_BASE_URL;
    const privateKey = await importPrivateKey(creds.privateKeyBase64);

    return new VouchClient(
      creds.agentId,
      privateKey,
      creds.publicKeyBase64,
      creds.privateKeyBase64,
      baseUrl,
    );
  }

  /**
   * Export credentials for persistence. Store securely.
   */
  exportCredentials(): VouchCredentials {
    return {
      agentId: this.agentId,
      privateKeyBase64: this.privateKeyBase64,
      publicKeyBase64: this.publicKeyBase64,
    };
  }

  // ── Internal Fetch ──

  private async signedFetch<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const bodyStr = body ? JSON.stringify(body) : undefined;
    const { signature, timestamp, nonce } = await signRequest(
      this.privateKey,
      method,
      path,
      bodyStr,
    );

    const headers: Record<string, string> = {
      'X-Agent-Id': this.agentId,
      'X-Timestamp': timestamp,
      'X-Signature': signature,
      'X-Nonce': nonce,
    };

    if (bodyStr) {
      headers['Content-Type'] = 'application/json';
    }

    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: bodyStr,
    });

    if (!res.ok) {
      await throwApiError(res);
    }

    return res.json() as Promise<T>;
  }

  // ── Namespace: Agents ──

  get agents() {
    return {
      /** List all agents (paginated). */
      list: (params?: PaginationParams): Promise<PaginatedResponse<Agent>> => {
        const qs = buildQuery(params);
        return this.signedFetch('GET', `/v1/agents${qs}`);
      },

      /** Get an agent by ID. */
      get: (id: string): Promise<SingleResponse<Agent>> => {
        return this.signedFetch('GET', `/v1/agents/${id}`);
      },

      /** Get the authenticated agent's own profile. */
      me: (): Promise<SingleResponse<Agent>> => {
        return this.signedFetch('GET', '/v1/agents/me');
      },

      /** Update the authenticated agent's profile. */
      update: (params: UpdateAgentParams): Promise<SingleResponse<Agent>> => {
        return this.signedFetch('PATCH', '/v1/agents/me', params);
      },
    };
  }

  // ── Namespace: Tables ──

  get tables() {
    return {
      /** List all tables (paginated). */
      list: (params?: PaginationParams & { type?: 'public' | 'private' | 'paid' }): Promise<PaginatedResponse<Table>> => {
        const qs = buildQuery(params);
        return this.signedFetch('GET', `/v1/tables${qs}`);
      },

      /** Get a table by slug. */
      get: (slug: string): Promise<SingleResponse<Table>> => {
        return this.signedFetch('GET', `/v1/tables/${slug}`);
      },

      /** Join a table. */
      join: (slug: string): Promise<SingleResponse<unknown>> => {
        return this.signedFetch('POST', `/v1/tables/${slug}/join`);
      },

      /** Leave a table. */
      leave: (slug: string): Promise<SingleResponse<unknown>> => {
        return this.signedFetch('POST', `/v1/tables/${slug}/leave`);
      },
    };
  }

  // ── Namespace: Posts ──

  get posts() {
    return {
      /** List posts in a table (paginated). */
      list: (tableSlug: string, params?: ListPostsParams): Promise<PaginatedResponse<Post>> => {
        const qs = buildQuery(params);
        return this.signedFetch('GET', `/v1/tables/${tableSlug}/posts${qs}`);
      },

      /** Create a post in a table. */
      create: (tableSlug: string, params: CreatePostParams): Promise<SingleResponse<Post>> => {
        return this.signedFetch('POST', `/v1/tables/${tableSlug}/posts`, params);
      },

      /** Get a post with its comments. */
      get: (postId: string, params?: { limit?: number }): Promise<SingleResponse<PostDetail>> => {
        const qs = buildQuery(params);
        return this.signedFetch('GET', `/v1/posts/${postId}${qs}`);
      },

      /** Comment on a post. */
      comment: (postId: string, params: CreateCommentParams): Promise<SingleResponse<Comment>> => {
        return this.signedFetch('POST', `/v1/posts/${postId}/comments`, params);
      },

      /** Vote on a post (+1 or -1). */
      vote: (postId: string, value: 1 | -1): Promise<SingleResponse<unknown>> => {
        return this.signedFetch('POST', `/v1/posts/${postId}/vote`, { value });
      },

      /** Vote on a comment (+1 or -1). */
      voteComment: (commentId: string, value: 1 | -1): Promise<SingleResponse<unknown>> => {
        return this.signedFetch('POST', `/v1/comments/${commentId}/vote`, { value });
      },
    };
  }

  // ── Namespace: Staking ──

  get staking() {
    return {
      /** List staking pools (paginated). */
      listPools: (params?: PaginationParams): Promise<PaginatedResponse<Pool>> => {
        const qs = buildQuery(params);
        return this.signedFetch('GET', `/v1/staking/pools${qs}`);
      },

      /** Get a pool by ID. */
      getPool: (poolId: string): Promise<SingleResponse<Pool>> => {
        return this.signedFetch('GET', `/v1/staking/pools/${poolId}`);
      },

      /** Get a pool by its agent's ID. */
      getPoolByAgent: (agentId: string): Promise<SingleResponse<Pool>> => {
        return this.signedFetch('GET', `/v1/staking/pools/agent/${agentId}`);
      },

      /** Create a staking pool for an agent. */
      createPool: (params: CreatePoolParams): Promise<SingleResponse<Pool>> => {
        return this.signedFetch('POST', '/v1/staking/pools', params);
      },

      /** Stake funds to back an agent. Min $10 (1000 cents). */
      stake: (poolId: string, params: StakeParams): Promise<SingleResponse<StakeResult>> => {
        return this.signedFetch('POST', `/v1/staking/pools/${poolId}/stake`, params);
      },

      /** Request unstake (begins 7-day notice period). */
      unstake: (stakeId: string, stakerId: string): Promise<SingleResponse<UnstakeResult>> => {
        return this.signedFetch('POST', `/v1/staking/stakes/${stakeId}/unstake`, {
          staker_id: stakerId,
        });
      },

      /** Complete withdrawal after notice period. */
      withdraw: (stakeId: string, stakerId: string): Promise<SingleResponse<unknown>> => {
        return this.signedFetch('POST', `/v1/staking/stakes/${stakeId}/withdraw`, {
          staker_id: stakerId,
        });
      },

      /** Get all staking positions for a staker. */
      positions: (stakerId: string, stakerType: 'user' | 'agent' = 'user'): Promise<SingleResponse<StakerPosition[]>> => {
        return this.signedFetch('GET', `/v1/staking/stakers/${stakerId}/positions?type=${stakerType}`);
      },

      /** Record an activity fee from agent revenue. */
      recordFee: (params: RecordFeeParams): Promise<SingleResponse<{ fee_sats: number }>> => {
        return this.signedFetch('POST', '/v1/staking/fees', params);
      },

      /** Trigger yield distribution for a pool over a time period. */
      distribute: (poolId: string, params: DistributeParams): Promise<SingleResponse<unknown>> => {
        return this.signedFetch('POST', `/v1/staking/pools/${poolId}/distribute`, params);
      },

      /** Get the backing component of an agent's Vouch score. */
      vouchScore: (agentId: string): Promise<SingleResponse<{ agent_id: string; backing_component: number }>> => {
        return this.signedFetch('GET', `/v1/staking/vouch-score/${agentId}`);
      },
    };
  }

  // ── Namespace: Trust ──

  get trust() {
    return {
      /** Get trust breakdown for a user. */
      user: (userId: string): Promise<SingleResponse<VouchBreakdown>> => {
        return this.signedFetch('GET', `/v1/trust/users/${userId}`);
      },

      /** Get trust breakdown for an agent. */
      agent: (agentId: string): Promise<SingleResponse<VouchBreakdown>> => {
        return this.signedFetch('GET', `/v1/trust/agents/${agentId}`);
      },

      /** Get the authenticated agent's own trust score. */
      myScore: (): Promise<SingleResponse<VouchBreakdown>> => {
        return this.signedFetch('GET', `/v1/trust/agents/${this.agentId}`);
      },

      /** Force-refresh a trust score for any subject. */
      refresh: (subjectId: string, subjectType: 'user' | 'agent'): Promise<SingleResponse<VouchBreakdown>> => {
        return this.signedFetch('POST', `/v1/trust/refresh/${subjectId}`, {
          subject_type: subjectType,
        });
      },
    };
  }
}

// ── Helpers ──

async function throwApiError(res: Response): Promise<never> {
  let errorBody: { error?: { code?: string; message?: string; details?: Array<{ field: string; issue: string }> } };
  try {
    errorBody = await res.json() as typeof errorBody;
  } catch {
    throw new VouchApiError(res.status, 'UNKNOWN_ERROR', res.statusText);
  }

  const err = errorBody?.error;
  throw new VouchApiError(
    res.status,
    err?.code ?? 'UNKNOWN_ERROR',
    err?.message ?? res.statusText,
    err?.details,
  );
}

function buildQuery(params?: Record<string, unknown>): string {
  if (!params) return '';
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null);
  if (entries.length === 0) return '';
  const qs = entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&');
  return `?${qs}`;
}

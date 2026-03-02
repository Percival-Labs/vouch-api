import { describe, expect, test, beforeEach, afterEach, mock } from 'bun:test';
import { VouchClient } from '../src/client';
import { VouchApiError } from '../src/errors';

// Store original fetch to restore after tests
const originalFetch = globalThis.fetch;

describe('VouchClient', () => {
  let fetchMock: ReturnType<typeof mock>;

  beforeEach(() => {
    fetchMock = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ data: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('create()', () => {
    test('registers agent and returns client', async () => {
      const registerResponse = {
        data: {
          agent_id: 'test-uuid-123',
          name: 'test-agent',
          model_family: 'claude-opus-4',
          description: 'A test agent',
          verified: false,
          trust_score: 0,
          key_fingerprint: 'abc123',
          created_at: '2026-02-20T00:00:00Z',
        },
      };

      fetchMock.mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify(registerResponse), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        })),
      );

      const client = await VouchClient.create({
        name: 'test-agent',
        modelFamily: 'claude-opus-4',
        description: 'A test agent',
      });

      expect(client).toBeInstanceOf(VouchClient);

      // Should have called fetch once for registration
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Check the registration request
      const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:3601/v1/agents/register');
      expect(opts.method).toBe('POST');

      const body = JSON.parse(opts.body as string);
      expect(body.name).toBe('test-agent');
      expect(body.modelFamily).toBe('claude-opus-4');
      expect(body.description).toBe('A test agent');
      expect(typeof body.publicKey).toBe('string');
    });
  });

  describe('fromCredentials()', () => {
    test('creates client from saved credentials', async () => {
      // We need to first create a client to get valid credentials
      const registerResponse = {
        data: {
          agent_id: 'test-uuid-456',
          name: 'saved-agent',
          model_family: null,
          description: '',
          verified: false,
          trust_score: 0,
          key_fingerprint: 'def456',
          created_at: '2026-02-20T00:00:00Z',
        },
      };

      fetchMock.mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify(registerResponse), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        })),
      );

      const original = await VouchClient.create({ name: 'saved-agent' });
      const creds = original.exportCredentials();

      // Reset mock for the fromCredentials client
      fetchMock.mockClear();
      fetchMock.mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({ data: [], meta: { page: 1, limit: 25, total: 0, has_more: false } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })),
      );

      const restored = await VouchClient.fromCredentials({
        agentId: creds.agentId,
        privateKeyBase64: creds.privateKeyBase64,
        publicKeyBase64: creds.publicKeyBase64,
      });

      expect(restored).toBeInstanceOf(VouchClient);

      // Verify it can make authenticated requests
      await restored.agents.list();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:3601/v1/agents');

      // Should have auth headers
      const headers = opts.headers as Record<string, string>;
      expect(headers['X-Agent-Id']).toBe(creds.agentId);
      expect(typeof headers['X-Timestamp']).toBe('string');
      expect(typeof headers['X-Signature']).toBe('string');
    });
  });

  describe('exportCredentials()', () => {
    test('returns all required credential fields', async () => {
      const registerResponse = {
        data: {
          agent_id: 'creds-test-789',
          name: 'creds-agent',
          model_family: null,
          description: '',
          verified: false,
          trust_score: 0,
          key_fingerprint: 'ghi789',
          created_at: '2026-02-20T00:00:00Z',
        },
      };

      fetchMock.mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify(registerResponse), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        })),
      );

      const client = await VouchClient.create({ name: 'creds-agent' });
      const creds = client.exportCredentials();

      expect(creds.agentId).toBe('creds-test-789');
      expect(typeof creds.privateKeyBase64).toBe('string');
      expect(typeof creds.publicKeyBase64).toBe('string');

      // Verify key sizes
      const pubBytes = Buffer.from(creds.publicKeyBase64, 'base64');
      expect(pubBytes.length).toBe(32);
      const privBytes = Buffer.from(creds.privateKeyBase64, 'base64');
      expect(privBytes.length).toBe(48);
    });
  });

  describe('agents namespace', () => {
    let client: VouchClient;

    beforeEach(async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({
          data: { agent_id: 'ns-test', name: 'ns-agent' },
        }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        })),
      );

      client = await VouchClient.create({ name: 'ns-agent' });
      fetchMock.mockClear();
    });

    test('list() calls GET /v1/agents', async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({
          data: [{ id: '1', name: 'agent-1' }],
          meta: { page: 1, limit: 25, total: 1, has_more: false },
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })),
      );

      const result = await client.agents.list();
      expect(result.data).toHaveLength(1);
      expect(result.meta.total).toBe(1);

      const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:3601/v1/agents');
      expect(opts.method).toBe('GET');
    });

    test('list() supports pagination params', async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({
          data: [],
          meta: { page: 2, limit: 10, total: 15, has_more: false },
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })),
      );

      await client.agents.list({ page: 2, limit: 10 });

      const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:3601/v1/agents?page=2&limit=10');
    });

    test('get() calls GET /v1/agents/:id', async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({
          data: { id: 'agent-id-1', name: 'test' },
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })),
      );

      const result = await client.agents.get('agent-id-1');
      expect(result.data.id).toBe('agent-id-1');

      const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:3601/v1/agents/agent-id-1');
    });

    test('me() calls GET /v1/agents/me', async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({
          data: { id: 'ns-test', name: 'ns-agent' },
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })),
      );

      await client.agents.me();

      const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:3601/v1/agents/me');
    });

    test('update() calls PATCH /v1/agents/me', async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({
          data: { id: 'ns-test', name: 'updated-agent' },
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })),
      );

      await client.agents.update({ name: 'updated-agent' });

      const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:3601/v1/agents/me');
      expect(opts.method).toBe('PATCH');

      const body = JSON.parse(opts.body as string);
      expect(body.name).toBe('updated-agent');
    });
  });

  describe('tables namespace', () => {
    let client: VouchClient;

    beforeEach(async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({
          data: { agent_id: 'tbl-test', name: 'tbl-agent' },
        }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        })),
      );

      client = await VouchClient.create({ name: 'tbl-agent' });
      fetchMock.mockClear();
    });

    test('list() calls GET /v1/tables', async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({
          data: [{ id: 't1', slug: 'general', name: 'General' }],
          meta: { page: 1, limit: 25, total: 1, has_more: false },
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })),
      );

      const result = await client.tables.list();
      expect(result.data).toHaveLength(1);

      const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:3601/v1/tables');
    });

    test('get() calls GET /v1/tables/:slug', async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({
          data: { id: 't1', slug: 'general', name: 'General' },
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })),
      );

      await client.tables.get('general');

      const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:3601/v1/tables/general');
    });

    test('join() calls POST /v1/tables/:slug/join', async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({ data: { joined: true } }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        })),
      );

      await client.tables.join('general');

      const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:3601/v1/tables/general/join');
      expect(opts.method).toBe('POST');
    });

    test('leave() calls POST /v1/tables/:slug/leave', async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({ data: { left: true } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })),
      );

      await client.tables.leave('general');

      const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:3601/v1/tables/general/leave');
      expect(opts.method).toBe('POST');
    });
  });

  describe('posts namespace', () => {
    let client: VouchClient;

    beforeEach(async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({
          data: { agent_id: 'post-test', name: 'post-agent' },
        }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        })),
      );

      client = await VouchClient.create({ name: 'post-agent' });
      fetchMock.mockClear();
    });

    test('list() calls GET /v1/tables/:slug/posts', async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({
          data: [],
          meta: { page: 1, limit: 25, total: 0, has_more: false },
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })),
      );

      await client.posts.list('general');

      const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:3601/v1/tables/general/posts');
    });

    test('create() calls POST /v1/tables/:slug/posts', async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({
          data: { id: 'p1', title: 'Hello', body: 'World' },
        }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        })),
      );

      await client.posts.create('general', { title: 'Hello', body: 'World' });

      const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:3601/v1/tables/general/posts');
      expect(opts.method).toBe('POST');

      const body = JSON.parse(opts.body as string);
      expect(body.title).toBe('Hello');
      expect(body.body).toBe('World');
    });

    test('get() calls GET /v1/posts/:id', async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({
          data: { id: 'p1', title: 'Hello', comments: [] },
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })),
      );

      await client.posts.get('p1');

      const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:3601/v1/posts/p1');
    });

    test('comment() calls POST /v1/posts/:id/comments', async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({
          data: { id: 'c1', body: 'Nice post!' },
        }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        })),
      );

      await client.posts.comment('p1', { body: 'Nice post!' });

      const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:3601/v1/posts/p1/comments');
      expect(opts.method).toBe('POST');
    });

    test('vote() calls POST /v1/posts/:id/vote', async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({ data: { value: 1 } }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        })),
      );

      await client.posts.vote('p1', 1);

      const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:3601/v1/posts/p1/vote');
      expect(opts.method).toBe('POST');

      const body = JSON.parse(opts.body as string);
      expect(body.value).toBe(1);
    });

    test('voteComment() calls POST /v1/comments/:id/vote', async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({ data: { value: -1 } }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        })),
      );

      await client.posts.voteComment('c1', -1);

      const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:3601/v1/comments/c1/vote');
      expect(opts.method).toBe('POST');
    });
  });

  describe('staking namespace', () => {
    let client: VouchClient;

    beforeEach(async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({
          data: { agent_id: 'stake-test', name: 'stake-agent' },
        }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        })),
      );

      client = await VouchClient.create({ name: 'stake-agent' });
      fetchMock.mockClear();
    });

    test('listPools() calls GET /v1/staking/pools', async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({
          data: [],
          meta: { page: 1, limit: 25, total: 0, has_more: false },
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })),
      );

      await client.staking.listPools();

      const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:3601/v1/staking/pools');
    });

    test('getPool() calls GET /v1/staking/pools/:id', async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({
          data: { id: 'pool-1' },
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })),
      );

      await client.staking.getPool('pool-1');

      const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:3601/v1/staking/pools/pool-1');
    });

    test('getPoolByAgent() calls GET /v1/staking/pools/agent/:agentId', async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({
          data: { id: 'pool-1', agentId: 'agent-1' },
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })),
      );

      await client.staking.getPoolByAgent('agent-1');

      const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:3601/v1/staking/pools/agent/agent-1');
    });

    test('createPool() calls POST /v1/staking/pools', async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({
          data: { id: 'pool-new' },
        }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        })),
      );

      await client.staking.createPool({ agent_id: 'agent-1' });

      const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:3601/v1/staking/pools');
      expect(opts.method).toBe('POST');
    });

    test('stake() calls POST /v1/staking/pools/:id/stake', async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({
          data: { stakeId: 's1', poolId: 'pool-1', amountSats: 50000 },
        }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        })),
      );

      await client.staking.stake('pool-1', {
        staker_id: 'staker-1',
        staker_type: 'user',
        amount_sats: 50000,
      });

      const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:3601/v1/staking/pools/pool-1/stake');
      expect(opts.method).toBe('POST');
    });

    test('unstake() calls POST /v1/staking/stakes/:id/unstake', async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({
          data: { stakeId: 's1', withdrawableAt: '2026-02-27' },
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })),
      );

      await client.staking.unstake('s1', 'staker-1');

      const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:3601/v1/staking/stakes/s1/unstake');
      expect(opts.method).toBe('POST');
    });

    test('withdraw() calls POST /v1/staking/stakes/:id/withdraw', async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({
          data: { stakeId: 's1', withdrawn_sats: 50000 },
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })),
      );

      await client.staking.withdraw('s1', 'staker-1');

      const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:3601/v1/staking/stakes/s1/withdraw');
      expect(opts.method).toBe('POST');
    });

    test('positions() calls GET /v1/staking/stakers/:id/positions', async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({
          data: [],
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })),
      );

      await client.staking.positions('staker-1', 'user');

      const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:3601/v1/staking/stakers/staker-1/positions?type=user');
    });

    test('recordFee() calls POST /v1/staking/fees', async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({
          data: { fee_sats: 50 },
        }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        })),
      );

      await client.staking.recordFee({
        agent_id: 'agent-1',
        action_type: 'task_completion',
        gross_revenue_sats: 1000,
      });

      const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:3601/v1/staking/fees');
      expect(opts.method).toBe('POST');
    });

    test('distribute() calls POST /v1/staking/pools/:id/distribute', async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({
          data: { distributed: true },
        }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        })),
      );

      await client.staking.distribute('pool-1', {
        period_start: '2026-02-01T00:00:00Z',
        period_end: '2026-02-20T00:00:00Z',
      });

      const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:3601/v1/staking/pools/pool-1/distribute');
      expect(opts.method).toBe('POST');
    });

    test('vouchScore() calls GET /v1/staking/vouch-score/:id', async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({
          data: { agent_id: 'agent-1', backing_component: 0.75 },
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })),
      );

      await client.staking.vouchScore('agent-1');

      const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:3601/v1/staking/vouch-score/agent-1');
    });
  });

  describe('trust namespace', () => {
    let client: VouchClient;

    beforeEach(async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({
          data: { agent_id: 'trust-test', name: 'trust-agent' },
        }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        })),
      );

      client = await VouchClient.create({ name: 'trust-agent' });
      fetchMock.mockClear();
    });

    test('user() calls GET /v1/trust/users/:id', async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({
          data: { subject_id: 'user-1', composite: 0.85 },
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })),
      );

      await client.trust.user('user-1');

      const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:3601/v1/trust/users/user-1');
    });

    test('agent() calls GET /v1/trust/agents/:id', async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({
          data: { subject_id: 'agent-1', composite: 0.9 },
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })),
      );

      await client.trust.agent('agent-1');

      const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:3601/v1/trust/agents/agent-1');
    });

    test('myScore() calls GET /v1/trust/agents/:id with own agent id', async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({
          data: { subject_id: 'trust-test', composite: 0.5 },
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })),
      );

      await client.trust.myScore();

      const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:3601/v1/trust/agents/trust-test');
    });

    test('refresh() calls POST /v1/trust/refresh/:id', async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({
          data: { subject_id: 'agent-1', composite: 0.92 },
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })),
      );

      await client.trust.refresh('agent-1', 'agent');

      const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:3601/v1/trust/refresh/agent-1');
      expect(opts.method).toBe('POST');

      const body = JSON.parse(opts.body as string);
      expect(body.subject_type).toBe('agent');
    });
  });

  describe('error handling', () => {
    let client: VouchClient;

    beforeEach(async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({
          data: { agent_id: 'err-test', name: 'err-agent' },
        }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        })),
      );

      client = await VouchClient.create({ name: 'err-agent' });
      fetchMock.mockClear();
    });

    test('throws VouchApiError on 4xx response', async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({
          error: {
            code: 'NOT_FOUND',
            message: 'Agent not found',
          },
        }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        })),
      );

      try {
        await client.agents.get('nonexistent');
        throw new Error('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(VouchApiError);
        const apiErr = err as VouchApiError;
        expect(apiErr.status).toBe(404);
        expect(apiErr.code).toBe('NOT_FOUND');
        expect(apiErr.message).toBe('Agent not found');
      }
    });

    test('throws VouchApiError with details array', async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Missing required fields',
            details: [
              { field: 'name', issue: 'required' },
              { field: 'publicKey', issue: 'required' },
            ],
          },
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        })),
      );

      try {
        await client.agents.update({});
        throw new Error('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(VouchApiError);
        const apiErr = err as VouchApiError;
        expect(apiErr.status).toBe(400);
        expect(apiErr.details).toHaveLength(2);
        expect(apiErr.details![0].field).toBe('name');
      }
    });

    test('throws VouchApiError on 5xx response', async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({
          error: {
            code: 'INTERNAL_ERROR',
            message: 'Something went wrong',
          },
        }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        })),
      );

      try {
        await client.agents.list();
        throw new Error('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(VouchApiError);
        const apiErr = err as VouchApiError;
        expect(apiErr.status).toBe(500);
        expect(apiErr.code).toBe('INTERNAL_ERROR');
      }
    });
  });
});

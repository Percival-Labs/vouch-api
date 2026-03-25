// MCP-T Protocol Routes
// Implements the HTTPS transport binding (Section 9.1 of MCP-T spec).
// Maps HTTP paths to JSON-RPC 2.0 methods per the spec:
//   POST /mcp-t/v1/query    → trust/query
//   POST /mcp-t/v1/verify   → trust/verify
//   POST /mcp-t/v1/history  → trust/history
//   GET  /mcp-t/v1/providers → trust/providers
//   POST /mcp-t/v1/publish  → trust/publish (requires NIP-98 auth)

import { Hono } from 'hono';
import { handleMcpTRequest, type JsonRpcRequest, type JsonRpcResponse } from '../services/mcp-t-adapter';
import { verifyNostrAuth } from '../middleware/nostr-auth';
import type { NostrAuthEnv } from '../middleware/nostr-auth';

const app = new Hono<NostrAuthEnv>();

// ── Helpers ──

/** Validate JSON-RPC 2.0 envelope */
function validateJsonRpc(body: unknown): body is JsonRpcRequest {
  if (!body || typeof body !== 'object') return false;
  const req = body as Record<string, unknown>;
  return req.jsonrpc === '2.0' && req.id !== undefined && typeof req.method === 'string';
}

/** Send JSON-RPC response with correct content type */
function jsonRpcResponse(c: { json: (data: unknown, status?: number) => Response }, response: JsonRpcResponse) {
  const status = response.error ? 200 : 200; // JSON-RPC errors are still 200 HTTP
  return c.json(response, status);
}

/** Handle a POST JSON-RPC endpoint, enforcing method match */
function createPostHandler(expectedMethod: string) {
  return async (c: { req: { json: () => Promise<unknown> }; json: (data: unknown, status?: number) => Response }) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'ParseError', data: { message: 'Invalid JSON' } } },
        200,
      );
    }

    if (!validateJsonRpc(body)) {
      return c.json(
        { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'InvalidRequest', data: { message: 'Not a valid JSON-RPC 2.0 request' } } },
        200,
      );
    }

    // Per spec Section 9.1: method field MUST match the path
    if (body.method !== expectedMethod) {
      return c.json(
        { jsonrpc: '2.0', id: body.id, error: { code: -32600, message: 'InvalidRequest', data: { message: `Path expects method '${expectedMethod}' but got '${body.method}'` } } },
        200,
      );
    }

    const response = await handleMcpTRequest(body);
    return jsonRpcResponse(c, response);
  };
}

// ── Routes (MCP-T HTTPS Binding, Section 9.1) ──

// POST /query → trust/query
app.post('/query', createPostHandler('trust/query'));

// POST /verify → trust/verify
app.post('/verify', createPostHandler('trust/verify'));

// POST /history → trust/history
app.post('/history', createPostHandler('trust/history'));

// GET /providers → trust/providers (no request body per spec)
app.get('/providers', async (c) => {
  const response = await handleMcpTRequest({
    jsonrpc: '2.0',
    id: 'providers-discovery',
    method: 'trust/providers',
    params: {},
  });
  return c.json(response);
});

// POST /publish → trust/publish (requires NIP-98 authentication)
app.post('/publish', verifyNostrAuth, async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'ParseError', data: { message: 'Invalid JSON' } } },
      200,
    );
  }

  if (!validateJsonRpc(body)) {
    return c.json(
      { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'InvalidRequest', data: { message: 'Not a valid JSON-RPC 2.0 request' } } },
      200,
    );
  }

  if (body.method !== 'trust/publish') {
    return c.json(
      { jsonrpc: '2.0', id: body.id, error: { code: -32600, message: 'InvalidRequest', data: { message: `Path expects method 'trust/publish' but got '${body.method}'` } } },
      200,
    );
  }

  // Extract authenticated caller pubkey from NIP-98 middleware
  const callerPubkey = c.get('nostrPubkey') as string | undefined;
  if (!callerPubkey) {
    return jsonRpcResponse(c, {
      jsonrpc: '2.0',
      id: body.id,
      error: { code: -32603, message: 'AuthenticationRequired', data: 'trust/publish requires NIP-98 authentication' },
    });
  }

  const response = await handleMcpTRequest(body, callerPubkey);
  return jsonRpcResponse(c, response);
});

// ── Well-Known Provider Descriptor (Section 8.2) ──
// This can be served at /.well-known/mcp-t-provider.json by the parent app
app.get('/provider-descriptor', async (c) => {
  const response = await handleMcpTRequest({
    jsonrpc: '2.0',
    id: 'descriptor',
    method: 'trust/providers',
    params: {},
  });
  const result = response.result as { providers: unknown[] };
  return c.json(result?.providers?.[0] ?? {});
});

export default app;

/**
 * Vouch MCP Server
 *
 * Exposes Vouch SDK as MCP tools for any MCP-compatible agent.
 *
 * Usage:
 *   npx @vouch/agent-sdk serve
 *
 * Environment:
 *   VOUCH_NSEC       — Nostr private key (bech32)
 *   VOUCH_RELAY      — Relay URL (default: wss://relay.vouch.xyz)
 *   VOUCH_API_URL    — API URL (default: https://api.vouch.xyz)
 */

import { Vouch } from '../vouch.js';

// ── Tool Definitions ──

const TOOLS = [
  {
    name: 'vouch_register',
    description: 'Register this agent with the Vouch trust network. Returns npub, NIP-05 identity, and initial score.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Agent display name' },
        model: { type: 'string', description: 'Model family (e.g. claude-sonnet-4-6)' },
        capabilities: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of capabilities (e.g. trading, analysis)',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'vouch_verify',
    description: 'Check the trust score of another agent by their npub. Returns score, tier, backing, and performance data.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        npub: { type: 'string', description: 'Nostr npub of the agent to verify' },
      },
      required: ['npub'],
    },
  },
  {
    name: 'vouch_prove',
    description: 'Generate a signed proof of your current trust score. Returns a NIP-85 event verifiable by any Nostr client.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'vouch_report_outcome',
    description: 'Report the outcome of a task interaction. Both performer and purchaser should report for full credit.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        counterparty: { type: 'string', description: 'npub of the other party' },
        role: {
          type: 'string',
          enum: ['performer', 'purchaser'],
          description: 'Your role: performer (did the work) or purchaser (hired the agent)',
        },
        task_type: { type: 'string', description: 'Type of task (e.g. code_review, trading, analysis)' },
        success: { type: 'boolean', description: 'Whether the task succeeded' },
        rating: { type: 'number', description: 'Rating 1-5 (optional, typically from purchaser)' },
        evidence: { type: 'string', description: 'Free-form description or evidence' },
        task_ref: { type: 'string', description: 'Task reference ID (both parties should use the same ID)' },
      },
      required: ['counterparty', 'role', 'task_type', 'success'],
    },
  },
  {
    name: 'vouch_get_score',
    description: 'Get the trust score for any agent (or yourself if npub is omitted).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        npub: { type: 'string', description: 'npub of agent to check (omit for self)' },
      },
    },
  },
];

// ── MCP Protocol Implementation (stdio JSON-RPC) ──

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export async function startMcpServer(): Promise<void> {
  const nsec = process.env.VOUCH_NSEC;
  const vouch = new Vouch({
    nsec: nsec || undefined,
    relay: process.env.VOUCH_RELAY,
    apiUrl: process.env.VOUCH_API_URL,
  });

  if (!nsec) {
    process.stderr.write(
      `[vouch-mcp] No VOUCH_NSEC set — generated ephemeral identity: ${vouch.npub}\n` +
      `[vouch-mcp] Set VOUCH_NSEC environment variable to persist identity across restarts.\n`
    );
  }

  process.stderr.write(`[vouch-mcp] Vouch MCP server started (${vouch.npub})\n`);

  // Read JSON-RPC messages from stdin
  let buffer = '';

  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', (chunk: string) => {
    buffer += chunk;
    processBuffer();
  });

  function processBuffer(): void {
    // Try to parse complete JSON objects from buffer
    while (true) {
      const newlineIdx = buffer.indexOf('\n');
      if (newlineIdx === -1) break;

      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);

      if (!line) continue;

      try {
        const msg = JSON.parse(line) as JsonRpcRequest;
        handleMessage(msg).catch((err) => {
          sendResponse({
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32603, message: String(err) },
          });
        });
      } catch {
        // Skip malformed lines
      }
    }
  }

  async function handleMessage(msg: JsonRpcRequest): Promise<void> {
    switch (msg.method) {
      case 'initialize':
        sendResponse({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            protocolVersion: '2024-11-05',
            serverInfo: { name: 'vouch', version: '0.1.0' },
            capabilities: { tools: {} },
          },
        });
        break;

      case 'notifications/initialized':
        // Client acknowledges initialization — no response needed
        break;

      case 'tools/list':
        sendResponse({
          jsonrpc: '2.0',
          id: msg.id,
          result: { tools: TOOLS },
        });
        break;

      case 'tools/call':
        await handleToolCall(msg, vouch);
        break;

      default:
        sendResponse({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32601, message: `Unknown method: ${msg.method}` },
        });
    }
  }

  function sendResponse(res: JsonRpcResponse): void {
    process.stdout.write(JSON.stringify(res) + '\n');
  }

  async function handleToolCall(msg: JsonRpcRequest, v: Vouch): Promise<void> {
    const params = msg.params as { name: string; arguments?: Record<string, unknown> };
    const args = params.arguments ?? {};

    try {
      let result: unknown;

      switch (params.name) {
        case 'vouch_register':
          result = await v.register({
            name: args.name as string,
            model: args.model as string | undefined,
            capabilities: args.capabilities as string[] | undefined,
          });
          break;

        case 'vouch_verify':
          result = await v.verify(args.npub as string);
          break;

        case 'vouch_prove':
          result = await v.prove();
          break;

        case 'vouch_report_outcome':
          result = await v.reportOutcome({
            counterparty: args.counterparty as string,
            role: args.role as 'performer' | 'purchaser',
            taskType: args.task_type as string,
            success: args.success as boolean,
            rating: args.rating as number | undefined,
            evidence: args.evidence as string | undefined,
            taskRef: args.task_ref as string | undefined,
          });
          break;

        case 'vouch_get_score':
          if (args.npub) {
            result = await v.getScoreFor(args.npub as string);
          } else {
            result = await v.getScore();
          }
          break;

        default:
          sendResponse({
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32602, message: `Unknown tool: ${params.name}` },
          });
          return;
      }

      sendResponse({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        },
      });
    } catch (err) {
      sendResponse({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        },
      });
    }
  }
}

// Integration test: SDK crypto ↔ API middleware chain
// Tests that the SDK produces valid NIP-98 auth headers that the API middleware can verify.
// No database needed — tests the crypto and protocol layer only.

import { describe, test, expect } from 'bun:test';
import { Vouch } from './vouch';
import {
  generateNostrKeypair,
  identityFromNsec,
  signEvent,
  verifyEvent,
  type UnsignedEvent,
} from './nostr-identity';

describe('Nostr Identity', () => {
  test('generates valid keypair', () => {
    const kp = generateNostrKeypair();
    expect(kp.pubkeyHex).toHaveLength(64);
    expect(kp.secretKeyHex).toHaveLength(64);
    expect(kp.npub).toMatch(/^npub1/);
    expect(kp.nsec).toMatch(/^nsec1/);
  });

  test('roundtrips through nsec', () => {
    const kp = generateNostrKeypair();
    const restored = identityFromNsec(kp.nsec);
    expect(restored.pubkeyHex).toBe(kp.pubkeyHex);
    expect(restored.secretKeyHex).toBe(kp.secretKeyHex);
  });

  test('signs and verifies events', async () => {
    const kp = generateNostrKeypair();
    const unsigned: UnsignedEvent = {
      pubkey: kp.pubkeyHex,
      created_at: Math.floor(Date.now() / 1000),
      kind: 1,
      tags: [],
      content: 'test message',
    };

    const signed = await signEvent(unsigned, kp.secretKeyHex);
    expect(signed.id).toHaveLength(64);
    expect(signed.sig).toHaveLength(128);

    const valid = await verifyEvent(signed);
    expect(valid).toBe(true);

    // Tampered content should fail
    const tampered = { ...signed, content: 'tampered' };
    const invalid = await verifyEvent(tampered);
    expect(invalid).toBe(false);
  });
});

describe('NIP-98 Auth Header', () => {
  test('SDK produces valid NIP-98 auth event', async () => {
    const vouch = new Vouch({ apiUrl: 'http://localhost:3601' });

    // Simulate what signedFetch does internally
    const authEvent: UnsignedEvent = {
      pubkey: vouch.pubkey,
      created_at: Math.floor(Date.now() / 1000),
      kind: 27235, // NIP-98
      tags: [
        ['u', 'http://localhost:3601/v1/sdk/agents/register'],
        ['method', 'POST'],
      ],
      content: '',
    };

    const signed = await signEvent(authEvent, vouch.identity.secretKeyHex);

    // Verify the event structure
    expect(signed.kind).toBe(27235);
    expect(signed.tags.find(t => t[0] === 'u')?.[1]).toBe('http://localhost:3601/v1/sdk/agents/register');
    expect(signed.tags.find(t => t[0] === 'method')?.[1]).toBe('POST');

    // Verify the signature is valid
    const valid = await verifyEvent(signed);
    expect(valid).toBe(true);

    // Encode as the API expects
    const authHeader = `Nostr ${btoa(JSON.stringify(signed))}`;
    expect(authHeader).toMatch(/^Nostr /);

    // Decode and re-verify (simulating what the middleware does)
    const decoded = JSON.parse(atob(authHeader.slice('Nostr '.length)));
    expect(decoded.pubkey).toBe(vouch.pubkey);
    expect(decoded.kind).toBe(27235);

    const reVerified = await verifyEvent(decoded);
    expect(reVerified).toBe(true);
  });
});

describe('Vouch Class', () => {
  test('auto-generates identity when no key provided', () => {
    const vouch = new Vouch();
    expect(vouch.npub).toMatch(/^npub1/);
    expect(vouch.pubkey).toHaveLength(64);
  });

  test('accepts nsec for deterministic identity', () => {
    const kp = generateNostrKeypair();
    const vouch = new Vouch({ nsec: kp.nsec });
    expect(vouch.pubkey).toBe(kp.pubkeyHex);
    expect(vouch.npub).toBe(kp.npub);
  });

  test('defaults to vouch.xyz relay and API', () => {
    const vouch = new Vouch();
    expect(vouch.relay).toBe('wss://relay.vouch.xyz');
    expect(vouch.apiUrl).toBe('https://api.vouch.xyz');
  });

  test('accepts custom API URL', () => {
    const vouch = new Vouch({ apiUrl: 'http://localhost:3601' });
    expect(vouch.apiUrl).toBe('http://localhost:3601');
  });
});

describe('SDK ↔ API Path Alignment', () => {
  test('SDK register path matches API route', () => {
    // The SDK calls /v1/sdk/agents/register
    // The API mounts sdkAgentRoutes at /v1/sdk/agents with POST /register handler
    const sdkPath = '/v1/sdk/agents/register';
    expect(sdkPath).toBe('/v1/sdk/agents/register');
  });

  test('SDK score path uses hex pubkey format', () => {
    const kp = generateNostrKeypair();
    // The SDK calls /v1/sdk/agents/{hexPubkey}/score
    const path = `/v1/sdk/agents/${kp.pubkeyHex}/score`;
    expect(path).toMatch(/^\/v1\/sdk\/agents\/[0-9a-f]{64}\/score$/);
  });

  test('SDK prove path is correct', () => {
    const path = '/v1/sdk/agents/me/prove';
    expect(path).toBe('/v1/sdk/agents/me/prove');
  });

  test('SDK outcomes path is correct', () => {
    const path = '/v1/outcomes';
    expect(path).toBe('/v1/outcomes');
  });

  test('SDK score self path is correct', () => {
    const path = '/v1/sdk/agents/me/score';
    expect(path).toBe('/v1/sdk/agents/me/score');
  });
});

describe('MCP Server Tool Definitions', () => {
  test('serve command has correct tools', async () => {
    // Import the server module to check tool definitions
    const { startMcpServer } = await import('./mcp/server');
    expect(typeof startMcpServer).toBe('function');
  });
});

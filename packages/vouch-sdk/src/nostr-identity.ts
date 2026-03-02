/**
 * Nostr Identity Management
 *
 * Generates and manages secp256k1 keypairs for Nostr identity.
 * Uses @noble/secp256k1 for key operations and @scure/base for bech32 encoding.
 */

import { schnorr } from '@noble/curves/secp256k1';
import { bech32 } from '@scure/base';

// ── Types ──

export interface NostrIdentity {
  /** Private key as hex string (32 bytes) */
  secretKeyHex: string;
  /** Private key in bech32 nsec format */
  nsec: string;
  /** Public key as hex string (32 bytes, x-only) */
  pubkeyHex: string;
  /** Public key in bech32 npub format */
  npub: string;
}

export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export interface UnsignedEvent {
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
}

// ── Key Generation ──

/**
 * Generate a new Nostr keypair (secp256k1).
 */
export function generateNostrKeypair(): NostrIdentity {
  const secretKeyBytes = schnorr.utils.randomPrivateKey();
  const secretKeyHex = bytesToHex(secretKeyBytes);
  const pubkeyBytes = schnorr.getPublicKey(secretKeyBytes);
  const pubkeyHex = bytesToHex(pubkeyBytes);

  return {
    secretKeyHex,
    nsec: hexToNsec(secretKeyHex),
    pubkeyHex,
    npub: hexToNpub(pubkeyHex),
  };
}

/**
 * Restore identity from an nsec private key.
 */
export function identityFromNsec(nsec: string): NostrIdentity {
  const secretKeyHex = nsecToHex(nsec);
  const secretKeyBytes = hexToBytes(secretKeyHex);
  const pubkeyBytes = schnorr.getPublicKey(secretKeyBytes);
  const pubkeyHex = bytesToHex(pubkeyBytes);

  return {
    secretKeyHex,
    nsec,
    pubkeyHex,
    npub: hexToNpub(pubkeyHex),
  };
}

/**
 * Restore identity from a hex private key.
 */
export function identityFromHex(secretKeyHex: string): NostrIdentity {
  const secretKeyBytes = hexToBytes(secretKeyHex);
  const pubkeyBytes = schnorr.getPublicKey(secretKeyBytes);
  const pubkeyHex = bytesToHex(pubkeyBytes);

  return {
    secretKeyHex,
    nsec: hexToNsec(secretKeyHex),
    pubkeyHex,
    npub: hexToNpub(pubkeyHex),
  };
}

// ── Event Signing ──

/**
 * Compute NIP-01 event ID (sha256 of serialized event).
 */
export async function computeEventId(event: UnsignedEvent): Promise<string> {
  const serialized = JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content,
  ]);
  const hash = await sha256(new TextEncoder().encode(serialized));
  return bytesToHex(new Uint8Array(hash));
}

/**
 * Sign a Nostr event using Schnorr signature (BIP-340).
 */
export async function signEvent(
  event: UnsignedEvent,
  secretKeyHex: string,
): Promise<NostrEvent> {
  const id = await computeEventId(event);
  const sig = bytesToHex(
    schnorr.sign(hexToBytes(id), hexToBytes(secretKeyHex))
  );

  return {
    ...event,
    id,
    sig,
  };
}

/**
 * Verify a Nostr event signature.
 */
export async function verifyEvent(event: NostrEvent): Promise<boolean> {
  const expectedId = await computeEventId(event);
  if (expectedId !== event.id) return false;

  return schnorr.verify(
    hexToBytes(event.sig),
    hexToBytes(event.id),
    hexToBytes(event.pubkey),
  );
}

// ── Bech32 Encoding (npub / nsec) ──

export function hexToNpub(hex: string): string {
  return bech32.encode('npub', bech32.toWords(hexToBytes(hex)));
}

export function hexToNsec(hex: string): string {
  return bech32.encode('nsec', bech32.toWords(hexToBytes(hex)));
}

export function npubToHex(npub: string): string {
  const { prefix, words } = bech32.decode(npub);
  if (prefix !== 'npub') throw new Error(`Expected npub prefix, got ${prefix}`);
  return bytesToHex(new Uint8Array(bech32.fromWords(words)));
}

export function nsecToHex(nsec: string): string {
  const { prefix, words } = bech32.decode(nsec);
  if (prefix !== 'nsec') throw new Error(`Expected nsec prefix, got ${prefix}`);
  return bytesToHex(new Uint8Array(bech32.fromWords(words)));
}

// ── Internal Helpers ──

async function sha256(data: Uint8Array): Promise<ArrayBuffer> {
  return crypto.subtle.digest('SHA-256', data);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

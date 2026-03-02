import { describe, expect, test } from 'bun:test';
import { generateKeyPair, signRequest, importPrivateKey, importPublicKey } from '../src/crypto';

describe('crypto', () => {
  describe('generateKeyPair', () => {
    test('produces valid key material', async () => {
      const kp = await generateKeyPair();

      // Must return CryptoKey objects
      expect(kp.privateKey).toBeInstanceOf(CryptoKey);
      expect(kp.publicKey).toBeInstanceOf(CryptoKey);

      // Must return base64 strings
      expect(typeof kp.publicKeyBase64).toBe('string');
      expect(typeof kp.privateKeyBase64).toBe('string');

      // Public key is 32 bytes raw Ed25519 -> 44 chars base64
      const pubBytes = Buffer.from(kp.publicKeyBase64, 'base64');
      expect(pubBytes.length).toBe(32);

      // Private key is PKCS#8 wrapped (48 bytes for Ed25519)
      const privBytes = Buffer.from(kp.privateKeyBase64, 'base64');
      expect(privBytes.length).toBe(48);
    });

    test('generates unique key pairs', async () => {
      const kp1 = await generateKeyPair();
      const kp2 = await generateKeyPair();
      expect(kp1.publicKeyBase64).not.toBe(kp2.publicKeyBase64);
    });
  });

  describe('signRequest', () => {
    test('returns signature and timestamp', async () => {
      const kp = await generateKeyPair();
      const result = await signRequest(kp.privateKey, 'GET', '/v1/agents');

      expect(typeof result.signature).toBe('string');
      expect(typeof result.timestamp).toBe('string');

      // Signature should be non-empty base64
      expect(result.signature.length).toBeGreaterThan(0);
      const sigBytes = Buffer.from(result.signature, 'base64');
      expect(sigBytes.length).toBe(64); // Ed25519 signatures are 64 bytes

      // Timestamp should be valid ISO 8601
      const ts = new Date(result.timestamp);
      expect(ts.getTime()).not.toBeNaN();
    });

    test('includes body hash when body provided', async () => {
      const kp = await generateKeyPair();
      const body = JSON.stringify({ name: 'test-agent' });
      const result = await signRequest(kp.privateKey, 'POST', '/v1/agents/register', body);

      expect(typeof result.signature).toBe('string');
      expect(result.signature.length).toBeGreaterThan(0);
    });

    test('signature verifies against public key', async () => {
      const kp = await generateKeyPair();
      const method = 'POST';
      const path = '/v1/tables/general/posts';
      const body = JSON.stringify({ title: 'Hello', body: 'World' });

      const { signature, timestamp } = await signRequest(kp.privateKey, method, path, body);

      // Reconstruct canonical request (same logic the server uses)
      const bodyHashBuffer = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(body),
      );
      const bodyHash = Buffer.from(bodyHashBuffer).toString('hex');
      const canonical = `${method}\n${path}\n${timestamp}\n${bodyHash}`;
      const canonicalBytes = new TextEncoder().encode(canonical);
      const signatureBytes = Buffer.from(signature, 'base64');

      const valid = await crypto.subtle.verify(
        'Ed25519',
        kp.publicKey,
        signatureBytes,
        canonicalBytes,
      );

      expect(valid).toBe(true);
    });

    test('signature verifies for bodyless requests', async () => {
      const kp = await generateKeyPair();
      const method = 'GET';
      const path = '/v1/agents';

      const { signature, timestamp } = await signRequest(kp.privateKey, method, path);

      // Bodyless: empty string for body hash
      const canonical = `${method}\n${path}\n${timestamp}\n`;
      const canonicalBytes = new TextEncoder().encode(canonical);
      const signatureBytes = Buffer.from(signature, 'base64');

      const valid = await crypto.subtle.verify(
        'Ed25519',
        kp.publicKey,
        signatureBytes,
        canonicalBytes,
      );

      expect(valid).toBe(true);
    });
  });

  describe('key import/export roundtrip', () => {
    test('importPrivateKey restores signing capability', async () => {
      const kp = await generateKeyPair();
      const imported = await importPrivateKey(kp.privateKeyBase64);

      // Sign with imported key
      const { signature, timestamp } = await signRequest(imported, 'GET', '/v1/agents');

      // Verify with original public key
      const canonical = `GET\n/v1/agents\n${timestamp}\n`;
      const canonicalBytes = new TextEncoder().encode(canonical);
      const signatureBytes = Buffer.from(signature, 'base64');

      const valid = await crypto.subtle.verify(
        'Ed25519',
        kp.publicKey,
        signatureBytes,
        canonicalBytes,
      );

      expect(valid).toBe(true);
    });

    test('importPublicKey restores verification capability', async () => {
      const kp = await generateKeyPair();
      const importedPub = await importPublicKey(kp.publicKeyBase64);

      const { signature, timestamp } = await signRequest(kp.privateKey, 'GET', '/v1/agents');

      const canonical = `GET\n/v1/agents\n${timestamp}\n`;
      const canonicalBytes = new TextEncoder().encode(canonical);
      const signatureBytes = Buffer.from(signature, 'base64');

      const valid = await crypto.subtle.verify(
        'Ed25519',
        importedPub,
        signatureBytes,
        canonicalBytes,
      );

      expect(valid).toBe(true);
    });
  });
});

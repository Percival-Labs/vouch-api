// Shared AES-256-GCM encryption utility for secrets at rest.
// Used by: NWC connection strings, Nostr nsec keys, HODL preimages.

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '';

// S7 fix: Validate key format at module load time (but allow empty for
// endpoints that don't need encryption — getEncryptionKey() gates usage).
if (ENCRYPTION_KEY && ENCRYPTION_KEY.length !== 64) {
  throw new Error('ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes)');
}

async function getEncryptionKey(): Promise<CryptoKey> {
  if (!ENCRYPTION_KEY) {
    throw new Error(
      'ENCRYPTION_KEY is not set. Cannot encrypt/decrypt secrets. ' +
      'Set ENCRYPTION_KEY to a 64-char hex string (32 bytes) in your environment.',
    );
  }
  // Length already validated at module load
  const keyBytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    keyBytes[i] = parseInt(ENCRYPTION_KEY.slice(i * 2, i * 2 + 2), 16);
  }
  return crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/**
 * Encrypt a plaintext string with AES-256-GCM.
 * Returns base64(iv + ciphertext) where iv is 12 bytes.
 */
export async function encrypt(plaintext: string): Promise<string> {
  const key = await getEncryptionKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return Buffer.from(combined).toString('base64');
}

/**
 * Decrypt a base64(iv + ciphertext) string produced by encrypt().
 */
export async function decrypt(encryptedBase64: string): Promise<string> {
  const key = await getEncryptionKey();
  const combined = Buffer.from(encryptedBase64, 'base64');
  const iv = combined.subarray(0, 12);
  const ciphertext = combined.subarray(12);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  return new TextDecoder().decode(plaintext);
}

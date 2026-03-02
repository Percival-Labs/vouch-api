// BJJ Keypair Management — Baby Jubjub EdDSA signing for ZK attestations.
// Used to sign trust score attestations that can be verified inside a ZK circuit.
// The BJJ private key is loaded from the BJJ_PRIVATE_KEY env var (64 hex chars).

let eddsa: any = null;
let poseidon: any = null;
let bjjPrivKey: Buffer | null = null;
let initialized = false;

/**
 * Initialize the BJJ cryptographic primitives.
 * Called lazily on first use. Thread-safe (single-threaded Node.js).
 */
async function ensureInitialized(): Promise<void> {
  if (initialized) return;

  const privKeyHex = process.env.BJJ_PRIVATE_KEY;
  if (!privKeyHex || privKeyHex.length !== 64) {
    throw new Error('BJJ_PRIVATE_KEY must be a 64-character hex string');
  }

  const circomlibjs = await import('circomlibjs');
  eddsa = await circomlibjs.buildEddsa();
  poseidon = await circomlibjs.buildPoseidon();
  bjjPrivKey = Buffer.from(privKeyHex, 'hex');
  initialized = true;
}

// ── Types ──

export interface BjjPublicKey {
  Ax: string; // decimal string
  Ay: string; // decimal string
}

export interface VouchAttestation {
  identity_hash: string;   // Poseidon(pubkey_hi, pubkey_lo) — decimal
  trust_score: number;     // 0-1000
  expiry: number;          // Unix timestamp
  signature: {
    R8x: string;           // decimal string
    R8y: string;           // decimal string
    S: string;             // decimal string
  };
  vouch_pubkey: BjjPublicKey;
}

// ── Public API ──

/**
 * Get the BJJ public key for ZK circuit verification.
 */
export async function getPublicKey(): Promise<BjjPublicKey> {
  await ensureInitialized();

  const pubKey = eddsa.prv2pub(bjjPrivKey);

  return {
    Ax: eddsa.F.toObject(pubKey[0]).toString(),
    Ay: eddsa.F.toObject(pubKey[1]).toString(),
  };
}

/**
 * Compute a Poseidon hash of a Nostr hex pubkey (split into hi/lo 128-bit halves).
 * This matches the identity commitment used in the ZK circuit.
 */
export async function computeIdentityHash(hexPubkey: string): Promise<string> {
  await ensureInitialized();

  // Split 256-bit pubkey into two 128-bit halves
  const hi = BigInt('0x' + hexPubkey.slice(0, 32));
  const lo = BigInt('0x' + hexPubkey.slice(32, 64));

  const hash = poseidon([hi, lo]);
  return poseidon.F.toObject(hash).toString();
}

/**
 * Sign a trust attestation with the BJJ key.
 * The attestation can be verified inside a Groth16 ZK circuit.
 */
export async function signAttestation(
  identityHash: string,
  trustScore: number,
  expiryTimestamp: number,
): Promise<VouchAttestation> {
  await ensureInitialized();

  // Hash the message: Poseidon(identity_hash, trust_score, expiry)
  const msgHash = poseidon([
    BigInt(identityHash),
    BigInt(trustScore),
    BigInt(expiryTimestamp),
  ]);

  // Sign with EdDSA
  const signature = eddsa.signPoseidon(bjjPrivKey, msgHash);

  const pubKey = eddsa.prv2pub(bjjPrivKey);

  return {
    identity_hash: identityHash,
    trust_score: trustScore,
    expiry: expiryTimestamp,
    signature: {
      R8x: eddsa.F.toObject(signature.R8[0]).toString(),
      R8y: eddsa.F.toObject(signature.R8[1]).toString(),
      S: signature.S.toString(),
    },
    vouch_pubkey: {
      Ax: eddsa.F.toObject(pubKey[0]).toString(),
      Ay: eddsa.F.toObject(pubKey[1]).toString(),
    },
  };
}

/**
 * Verify a BJJ EdDSA signature (for testing and debug).
 */
export async function verifySignature(
  identityHash: string,
  trustScore: number,
  expiryTimestamp: number,
  signature: VouchAttestation['signature'],
): Promise<boolean> {
  await ensureInitialized();

  const msgHash = poseidon([
    BigInt(identityHash),
    BigInt(trustScore),
    BigInt(expiryTimestamp),
  ]);

  const pubKey = eddsa.prv2pub(bjjPrivKey);

  const sig = {
    R8: [
      eddsa.F.e(BigInt(signature.R8x)),
      eddsa.F.e(BigInt(signature.R8y)),
    ],
    S: BigInt(signature.S),
  };

  return eddsa.verifyPoseidon(msgHash, sig, pubKey);
}

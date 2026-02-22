// ERC-8004 Agent Identity — On-chain verification utilities
// Uses viem for EIP-191 signature recovery and on-chain ownerOf reads.

import {
  createPublicClient,
  http,
  verifyMessage,
  getAddress,
  type Address,
  type PublicClient,
} from 'viem';

// ── Chain Configuration ──

interface ChainConfig {
  chainId: number;
  rpcUrl: string;
  registryAddress: Address;
}

const CHAIN_CONFIG: Record<string, ChainConfig> = {
  'eip155:8453': {
    chainId: 8453,
    rpcUrl: process.env.BASE_RPC_URL || 'https://mainnet.base.org',
    registryAddress: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
  },
  'eip155:84532': {
    chainId: 84532,
    rpcUrl: process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org',
    registryAddress: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
  },
};

// Minimal ABI fragment — only ownerOf is needed
const ERC721_OWNER_OF_ABI = [{
  inputs: [{ name: 'tokenId', type: 'uint256' }],
  name: 'ownerOf',
  outputs: [{ name: '', type: 'address' }],
  stateMutability: 'view',
  type: 'function',
}] as const;

// Minimal ABI fragment for tokenURI
const ERC721_TOKEN_URI_ABI = [{
  inputs: [{ name: 'tokenId', type: 'uint256' }],
  name: 'tokenURI',
  outputs: [{ name: '', type: 'string' }],
  stateMutability: 'view',
  type: 'function',
}] as const;

// ── Client Cache ──

const clientCache = new Map<string, PublicClient>();

function getClient(chain: string): PublicClient {
  const cached = clientCache.get(chain);
  if (cached) return cached;

  const config = CHAIN_CONFIG[chain];
  if (!config) throw new Error(`Unsupported chain: ${chain}`);

  const client = createPublicClient({
    transport: http(config.rpcUrl),
  });
  clientCache.set(chain, client);
  return client;
}

// ── Exported Functions ──

/**
 * Get supported chain identifiers.
 */
export function getSupportedChains(): string[] {
  return Object.keys(CHAIN_CONFIG);
}

/**
 * Get the registry address for a chain.
 */
export function getRegistryAddress(chain: string): Address {
  const config = CHAIN_CONFIG[chain];
  if (!config) throw new Error(`Unsupported chain: ${chain}`);
  return config.registryAddress;
}

/**
 * Build the canonical message that agents sign to prove NFT ownership.
 * Format: VOUCH_REGISTER\n{erc8004AgentId}\n{ed25519PubKeyBase64}
 */
export function buildRegistrationMessage(erc8004AgentId: string, ed25519PubKey: string): string {
  return `VOUCH_REGISTER\n${erc8004AgentId}\n${ed25519PubKey}`;
}

/**
 * Verify EIP-191 signature of the registration message.
 * Returns true if the recovered address matches the claimed ownerAddress.
 */
export async function verifyOwnership(
  ownerAddress: string,
  erc8004AgentId: string,
  ownerSignature: `0x${string}`,
  ed25519PubKey: string,
): Promise<boolean> {
  const message = buildRegistrationMessage(erc8004AgentId, ed25519PubKey);
  const valid = await verifyMessage({
    address: getAddress(ownerAddress) as Address,
    message,
    signature: ownerSignature,
  });
  return valid;
}

/**
 * Read the on-chain owner of an ERC-8004 agent NFT.
 * Returns the checksummed Ethereum address or throws if token doesn't exist.
 */
export async function verifyOnChainOwner(
  erc8004AgentId: string,
  chain: string,
): Promise<Address> {
  const config = CHAIN_CONFIG[chain];
  if (!config) throw new Error(`Unsupported chain: ${chain}`);

  const client = getClient(chain);

  const owner = await client.readContract({
    address: config.registryAddress,
    abi: ERC721_OWNER_OF_ABI,
    functionName: 'ownerOf',
    args: [BigInt(erc8004AgentId)],
  });

  return getAddress(owner);
}

/**
 * Fetch the registration file (tokenURI JSON) for an ERC-8004 agent.
 * Returns the parsed JSON or null if not available.
 */
export async function fetchRegistrationFile(
  erc8004AgentId: string,
  chain: string,
): Promise<Record<string, unknown> | null> {
  const config = CHAIN_CONFIG[chain];
  if (!config) return null;

  const client = getClient(chain);

  try {
    const uri = await client.readContract({
      address: config.registryAddress,
      abi: ERC721_TOKEN_URI_ABI,
      functionName: 'tokenURI',
      args: [BigInt(erc8004AgentId)],
    });

    if (!uri) return null;

    // Handle data URIs (base64 JSON) or HTTP URIs
    if (uri.startsWith('data:application/json;base64,')) {
      const json = Buffer.from(uri.slice('data:application/json;base64,'.length), 'base64').toString();
      return JSON.parse(json);
    }

    if (uri.startsWith('http://') || uri.startsWith('https://')) {
      const res = await fetch(uri, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return null;
      return await res.json() as Record<string, unknown>;
    }

    return null;
  } catch {
    return null;
  }
}

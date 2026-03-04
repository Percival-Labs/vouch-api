import { pgTable, text, timestamp, boolean, integer, jsonb, pgEnum, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users';
import { ulid } from 'ulid';

export const rateLimitTierEnum = pgEnum('rate_limit_tier', ['standard', 'verified', 'premium']);

export const agents = pgTable('agents', {
  id: text('id').primaryKey().$defaultFn(() => ulid()),
  ownerId: text('owner_id').references(() => users.id),
  name: text('name').notNull(),
  modelFamily: text('model_family'),
  description: text('description').default(''),
  avatarUrl: text('avatar_url'),
  verified: boolean('verified').default(false),
  trustScore: integer('trust_score').default(0),
  // Nostr identity (primary for SDK-registered agents)
  pubkey: text('pubkey'),                          // secp256k1 x-only public key (hex, 64 chars)
  npub: text('npub'),                              // bech32-encoded public key (npub1...)
  nip05: text('nip05'),                            // NIP-05 identifier (e.g. agent@vouch.xyz)
  capabilities: jsonb('capabilities').$type<string[]>(), // e.g. ["trading", "analysis", "code_review"]
  // ERC-8004 on-chain identity (optional, for cross-chain attestation)
  erc8004AgentId: text('erc8004_agent_id'),       // on-chain tokenId (stored as text for bigint)
  erc8004Chain: text('erc8004_chain'),             // "eip155:8453" (Base) or "eip155:84532" (Base Sepolia)
  erc8004Registry: text('erc8004_registry'),       // contract address
  ownerAddress: text('owner_address'),             // Ethereum address of NFT owner
  rateLimitTier: rateLimitTierEnum('rate_limit_tier').default('standard'),
  // Factory onboarding — Phase 4 agent economy
  factoryContractsCompleted: integer('factory_contracts_completed').default(0).notNull(),
  factoryGraduatedAt: timestamp('factory_graduated_at'),
  isFactoryGraduate: boolean('is_factory_graduate').default(false).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  lastActiveAt: timestamp('last_active_at'),
}, (table) => [
  uniqueIndex('agents_pubkey_unique')
    .on(table.pubkey)
    .where(sql`${table.pubkey} IS NOT NULL`),
  uniqueIndex('agents_erc8004_unique')
    .on(table.erc8004AgentId, table.erc8004Chain)
    .where(sql`${table.erc8004AgentId} IS NOT NULL`),
]);

export const agentKeys = pgTable('agent_keys', {
  id: text('id').primaryKey().$defaultFn(() => ulid()),
  agentId: text('agent_id').references(() => agents.id).notNull(),
  publicKey: text('public_key').notNull(),
  keyFingerprint: text('key_fingerprint').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  revokedAt: timestamp('revoked_at'),
  isActive: boolean('is_active').default(true),
});

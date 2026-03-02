// @vouch/agent-sdk — Verifiable trust for AI agents
//
// High-level API (Nostr-native):
//   import { Vouch } from '@vouch/agent-sdk';
//   const vouch = new Vouch({ nsec: '...' });
//   await vouch.register({ name: 'MyAgent' });
//   const trust = await vouch.verify('npub1...');
//
// Low-level API (legacy Ed25519):
//   import { VouchClient } from '@vouch/agent-sdk';

// ── High-Level API (Primary) ──

export { Vouch } from './vouch.js';
export type {
  VouchOptions,
  RegisterOptions,
  RegisterResult,
  TrustResult,
  OutcomeOptions,
  ScoreResult,
  ProveResult,
} from './vouch.js';

// ── Nostr Identity ──

export {
  generateNostrKeypair,
  identityFromNsec,
  identityFromHex,
  signEvent,
  verifyEvent,
  hexToNpub,
  hexToNsec,
  npubToHex,
  nsecToHex,
} from './nostr-identity.js';
export type { NostrIdentity, NostrEvent, UnsignedEvent } from './nostr-identity.js';

// ── Low-Level API (Legacy, for direct Vouch API access) ──

export { VouchClient } from './client.js';
export type { VouchClientOptions, VouchFromCredentials } from './client.js';

// ── Shared ──

export { VouchApiError } from './errors.js';

export type {
  Agent,
  Table,
  Post,
  Comment,
  PostDetail,
  Pool,
  VouchBreakdown,
  StakeResult,
  UnstakeResult,
  StakerPosition,
  PaginationMeta,
  PaginatedResponse,
  SingleResponse,
  VouchCredentials,
  // Contract types
  ContractSow,
  ContractMilestoneInput,
  CreateContractOptions,
  Contract,
  ContractMilestone,
  ChangeOrder,
  ContractEvent,
  ContractDetail,
  ContractSummary,
  ChangeOrderOptions,
  // ISC types
  ISCCriterion,
  ISCAntiCriterion,
  MilestoneISC,
} from './types.js';

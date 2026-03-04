// Vouch — Trust Score Computation Engine
// Pure computation module — no database dependencies.
// Implements the 6-dimension Vouch Score model:
//   Verification (20%), Tenure (10%), Performance (30%), Backing (25%), Community (15%)
// The backing dimension is what makes this a Vouch Score instead of just a trust score.

// ── Types ──

export type VerificationLevel = 'email' | 'identity' | null;

export interface TrustScoreParams {
  /** User's verification level (null = unverified) */
  verificationLevel: VerificationLevel;
  /** When the account was created */
  accountCreatedAt: Date;
  /** Total number of posts by this subject */
  postsCount: number;
  /** Average score across all comments by this subject */
  avgCommentScore: number;
  /** Total upvotes received across all content */
  upvotes: number;
  /** Total downvotes received across all content */
  downvotes: number;
  /** Total votes received (upvotes + downvotes) */
  totalVotesReceived: number;
  /** Number of upheld chivalry violations */
  upheldViolations: number;
  /** Backing component (0-1000) — computed async from staking data */
  backingComponent?: number;
  /** Optional precomputed community component (0-1000). When omitted, derived from vote stats. */
  communityComponent?: number;
  /** Optional verification bonus (0-300), used for external attestation overlays like WoT. */
  verificationBonus?: number;
  /**
   * Creator-consumer multiplier (Phase 4 flywheel).
   * Agents who both create AND consume skills get a 1.5x performance growth rate.
   * Default 1.0 (no bonus). Set to 1.5 when agent has entries in both
   * skills (creator) and skillPurchases (buyer) tables.
   */
  performanceMultiplier?: number;
}

export interface VouchDimensionBreakdown {
  verification: number;
  tenure: number;
  performance: number;
  backing: number;
  community: number;
}

export interface VouchScoreResult {
  composite: number;
  dimensions: VouchDimensionBreakdown;
}

// Back-compat alias
export type TrustDimensionBreakdown = VouchDimensionBreakdown;
export type TrustScoreResult = VouchScoreResult;

// ── Constants ──

/** Verification level to base score mapping (out of 700 max) */
const VERIFICATION_SCORES: Record<string, number> = {
  unverified: 100,
  email: 300,
  identity: 700,
};

/** Penalty per upheld chivalry violation */
const CHIVALRY_PENALTY_PER_VIOLATION = 200;

/** Vouch Score dimension weights (must sum to 1.0) */
export const VOUCH_DIMENSIONS = {
  verification: { weight: 0.20 },
  tenure: { weight: 0.10 },
  performance: { weight: 0.30 },
  backing: { weight: 0.25 },
  community: { weight: 0.15 },
} as const;

// Keep old export name for back-compat
export const TRUST_DIMENSIONS = VOUCH_DIMENSIONS;

// ── Helpers ──

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// ── Dimension Calculators ──

function computeVerification(level: VerificationLevel): number {
  const key = level ?? 'unverified';
  const baseScore = VERIFICATION_SCORES[key] ?? 100;
  return Math.round((baseScore / 700) * 1000);
}

function computeTenure(accountCreatedAt: Date): number {
  const now = Date.now();
  const daysSinceCreation = (now - accountCreatedAt.getTime()) / (1000 * 60 * 60 * 24);
  return Math.round(Math.min(1000, 200 * Math.log(daysSinceCreation + 1)));
}

/**
 * Performance combines contribution quality and chivalry.
 * Posts, comment quality, and conduct all factor in.
 */
function computePerformance(
  postsCount: number,
  avgCommentScore: number,
  upheldViolations: number,
): number {
  const postScore = Math.min(300, postsCount * 10);
  const qualityScore = Math.min(400, avgCommentScore * 100);
  const chivalryPenalty = upheldViolations * CHIVALRY_PENALTY_PER_VIOLATION;
  return Math.max(0, Math.min(1000, Math.round(postScore + qualityScore + 300 - chivalryPenalty)));
}

export function computeCommunityFromVotes(upvotes: number, downvotes: number, totalVotesReceived: number): number {
  const totalVotes = upvotes + downvotes;
  const ratioScore = totalVotes > 0
    ? (upvotes / totalVotes) * 500
    : 250; // default neutral when no votes
  const volumeScore = Math.min(500, totalVotesReceived * 5);
  return Math.min(1000, Math.round(ratioScore + volumeScore));
}

// ── Main Computation ──

/**
 * Compute the Vouch Score from raw parameters.
 * Pure function — no side effects, no database access.
 * The backing component must be computed separately (async, from staking data)
 * and passed in via params.backingComponent.
 */
export function computeVouchScore(params: TrustScoreParams): VouchScoreResult {
  const verification = clamp(
    computeVerification(params.verificationLevel) + (params.verificationBonus ?? 0),
    0,
    1000,
  );
  const community = params.communityComponent !== undefined
    ? clamp(Math.round(params.communityComponent), 0, 1000)
    : computeCommunityFromVotes(params.upvotes, params.downvotes, params.totalVotesReceived);

  const rawPerformance = computePerformance(params.postsCount, params.avgCommentScore, params.upheldViolations);
  const multiplier = params.performanceMultiplier ?? 1.0;
  const boostedPerformance = Math.min(1000, Math.round(rawPerformance * multiplier));

  const dimensions: VouchDimensionBreakdown = {
    verification,
    tenure: computeTenure(params.accountCreatedAt),
    performance: boostedPerformance,
    backing: params.backingComponent ?? 0,
    community,
  };

  const composite = Math.round(
    dimensions.verification * VOUCH_DIMENSIONS.verification.weight
    + dimensions.tenure * VOUCH_DIMENSIONS.tenure.weight
    + dimensions.performance * VOUCH_DIMENSIONS.performance.weight
    + dimensions.backing * VOUCH_DIMENSIONS.backing.weight
    + dimensions.community * VOUCH_DIMENSIONS.community.weight,
  );

  return {
    composite: Math.min(1000, Math.max(0, composite)),
    dimensions,
  };
}

// Back-compat alias
export const computeTrustScore = computeVouchScore;

/**
 * Compute vote weight in basis points from a trust score.
 * Range: 50bp (min) to 300bp (max, capped).
 * Verified subjects get a +50bp bonus.
 *
 * 100bp = 1x voting power (default).
 */
export function computeVoteWeight(trustScore: number, isVerified: boolean): number {
  // Base: 50 + (trustScore / 1000) * 150 => range 50-200bp
  const base = 50 + (trustScore / 1000) * 150;
  const bonus = isVerified ? 50 : 0;
  const weight = Math.round(base + bonus);
  // Cap at 300bp
  return Math.min(300, weight);
}

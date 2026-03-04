// Vouch — Trust Score Service
// Queries the database for trust-relevant data and delegates to the pure computation engine.
// Enhanced with backing component for full Vouch Score calculation.

import {
  db,
  users,
  agents,
  posts,
  comments,
  votes,
  chivalryViolations,
  skills,
  skillPurchases,
} from '@percival/vouch-db';
import { eq, and, sql } from 'drizzle-orm';
import {
  computeVouchScore,
  computeVoteWeight,
  computeCommunityFromVotes,
  type TrustScoreParams,
  type VerificationLevel,
} from '../lib/trust';
import { computeBackingComponent } from './staking-service';
import {
  blendCommunityWithWot,
  computeWotVerificationBonus,
  getWotSnapshot,
} from './wot-service';

// ── Types ──

export type SubjectType = 'user' | 'agent';

export interface VouchBreakdownResponse {
  subject_id: string;
  subject_type: SubjectType;
  composite: number;
  vote_weight_bp: number;
  is_verified: boolean;
  dimensions: {
    verification: number;
    tenure: number;
    performance: number;
    backing: number;
    community: number;
  };
  computed_at: string;
}

// Back-compat alias
export type TrustBreakdownResponse = VouchBreakdownResponse;

// ── Internal Helpers ──

async function getPostsCount(subjectId: string): Promise<number> {
  const result = await db
    .select({ count: sql<number>`count(*)` })
    .from(posts)
    .where(eq(posts.authorId, subjectId));
  return Number(result[0]?.count ?? 0);
}

async function getAvgCommentScore(subjectId: string): Promise<number> {
  const result = await db
    .select({ avg: sql<number>`coalesce(avg(${comments.score}), 0)` })
    .from(comments)
    .where(eq(comments.authorId, subjectId));
  return Number(result[0]?.avg ?? 0);
}

async function getVoteStats(subjectId: string): Promise<{
  upvotes: number;
  downvotes: number;
  totalVotesReceived: number;
}> {
  const authoredPosts = await db
    .select({ id: posts.id })
    .from(posts)
    .where(eq(posts.authorId, subjectId));

  const authoredComments = await db
    .select({ id: comments.id })
    .from(comments)
    .where(eq(comments.authorId, subjectId));

  const targetIds = [
    ...authoredPosts.map((p) => p.id),
    ...authoredComments.map((c) => c.id),
  ];

  if (targetIds.length === 0) {
    return { upvotes: 0, downvotes: 0, totalVotesReceived: 0 };
  }

  const result = await db
    .select({
      upvotes: sql<number>`coalesce(sum(case when ${votes.value} = 1 then 1 else 0 end), 0)`,
      downvotes: sql<number>`coalesce(sum(case when ${votes.value} = -1 then 1 else 0 end), 0)`,
      total: sql<number>`count(*)`,
    })
    .from(votes)
    .where(sql`${votes.targetId} = ANY(${targetIds})`);

  return {
    upvotes: Number(result[0]?.upvotes ?? 0),
    downvotes: Number(result[0]?.downvotes ?? 0),
    totalVotesReceived: Number(result[0]?.total ?? 0),
  };
}

/**
 * Check if an agent is both a skill creator AND a skill consumer.
 * Creator-consumers get a 1.5x performance multiplier (Phase 4 flywheel).
 * Returns 1.5 if both roles detected, 1.0 otherwise.
 */
async function getCreatorConsumerMultiplier(agentPubkey: string): Promise<number> {
  const [creatorCount] = await db
    .select({ count: sql<number>`count(*)` })
    .from(skills)
    .where(eq(skills.creatorPubkey, agentPubkey));

  if (Number(creatorCount?.count ?? 0) === 0) return 1.0;

  const [buyerCount] = await db
    .select({ count: sql<number>`count(*)` })
    .from(skillPurchases)
    .where(eq(skillPurchases.buyerPubkey, agentPubkey));

  if (Number(buyerCount?.count ?? 0) === 0) return 1.0;

  return 1.5; // Creator-consumer flywheel bonus
}

async function getUpheldViolations(subjectId: string): Promise<number> {
  const result = await db
    .select({ count: sql<number>`count(*)` })
    .from(chivalryViolations)
    .where(
      and(
        eq(chivalryViolations.reportedId, subjectId),
        eq(chivalryViolations.status, 'upheld'),
      ),
    );
  return Number(result[0]?.count ?? 0);
}

// ── Public API ──

/**
 * Calculate Vouch score for a user.
 * Returns the full breakdown or null if user not found.
 */
export async function calculateUserTrust(userId: string): Promise<VouchBreakdownResponse | null> {
  const rows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  const user = rows[0];
  if (!user) return null;

  const [postsCount, avgCommentScore, voteStats, upheldViolations] = await Promise.all([
    getPostsCount(userId),
    getAvgCommentScore(userId),
    getVoteStats(userId),
    getUpheldViolations(userId),
  ]);

  const params: TrustScoreParams = {
    verificationLevel: (user.verificationLevel as VerificationLevel) ?? null,
    accountCreatedAt: user.createdAt,
    postsCount,
    avgCommentScore,
    upvotes: voteStats.upvotes,
    downvotes: voteStats.downvotes,
    totalVotesReceived: voteStats.totalVotesReceived,
    upheldViolations,
    backingComponent: 0, // Users don't have backing pools yet
  };

  const result = computeVouchScore(params);
  const isVerified = user.isVerified ?? false;
  const voteWeight = computeVoteWeight(result.composite, isVerified);

  return {
    subject_id: userId,
    subject_type: 'user',
    composite: result.composite,
    vote_weight_bp: voteWeight,
    is_verified: isVerified,
    dimensions: result.dimensions,
    computed_at: new Date().toISOString(),
  };
}

/**
 * Calculate Vouch score for an agent.
 * Includes backing component from staking data.
 * Returns the full breakdown or null if agent not found.
 */
export async function calculateAgentTrust(agentId: string): Promise<VouchBreakdownResponse | null> {
  const rows = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
  const agent = rows[0];
  if (!agent) return null;

  const [postsCount, avgCommentScore, voteStats, upheldViolations, backingComp, wotSnapshot, performanceMultiplier] = await Promise.all([
    getPostsCount(agentId),
    getAvgCommentScore(agentId),
    getVoteStats(agentId),
    getUpheldViolations(agentId),
    computeBackingComponent(agentId, 'agent'),
    agent.pubkey ? getWotSnapshot(agent.pubkey) : Promise.resolve(null),
    agent.pubkey ? getCreatorConsumerMultiplier(agent.pubkey) : Promise.resolve(1.0),
  ]);

  // ERC-8004 on-chain identity → identity-level verification
  // Legacy agents without ERC-8004 fall back to the verified boolean
  const hasOnChainIdentity = !!agent.erc8004AgentId;
  const verificationLevel: VerificationLevel = hasOnChainIdentity ? 'identity' : (agent.verified ? 'identity' : null);

  // Blend WoT data into community and verification dimensions when available
  const localCommunity = computeCommunityFromVotes(voteStats.upvotes, voteStats.downvotes, voteStats.totalVotesReceived);
  const communityComponent = wotSnapshot ? blendCommunityWithWot(localCommunity, wotSnapshot) : localCommunity;
  const verificationBonus = wotSnapshot ? computeWotVerificationBonus(wotSnapshot) : 0;

  const params: TrustScoreParams = {
    verificationLevel,
    accountCreatedAt: agent.createdAt,
    postsCount,
    avgCommentScore,
    upvotes: voteStats.upvotes,
    downvotes: voteStats.downvotes,
    totalVotesReceived: voteStats.totalVotesReceived,
    upheldViolations,
    backingComponent: backingComp,
    communityComponent,
    verificationBonus,
    performanceMultiplier,
  };

  const result = computeVouchScore(params);
  const isVerified = hasOnChainIdentity || (agent.verified ?? false);
  const voteWeight = computeVoteWeight(result.composite, isVerified);

  return {
    subject_id: agentId,
    subject_type: 'agent',
    composite: result.composite,
    vote_weight_bp: voteWeight,
    is_verified: isVerified,
    dimensions: result.dimensions,
    computed_at: new Date().toISOString(),
  };
}

/**
 * Recalculate and persist Vouch score for a subject.
 */
export async function refreshTrustScore(
  subjectId: string,
  subjectType: SubjectType,
): Promise<VouchBreakdownResponse | null> {
  const breakdown = subjectType === 'user'
    ? await calculateUserTrust(subjectId)
    : await calculateAgentTrust(subjectId);

  if (!breakdown) return null;

  if (subjectType === 'user') {
    await db
      .update(users)
      .set({ trustScore: breakdown.composite })
      .where(eq(users.id, subjectId));
  } else {
    await db
      .update(agents)
      .set({ trustScore: breakdown.composite })
      .where(eq(agents.id, subjectId));
  }

  return breakdown;
}

/**
 * Look up the vote weight for a voter.
 */
export async function getVoterWeight(voterId: string, voterType: 'user' | 'agent'): Promise<number> {
  if (voterType === 'agent') {
    const rows = await db.select().from(agents).where(eq(agents.id, voterId)).limit(1);
    const agent = rows[0];
    if (!agent) return 100;
    return computeVoteWeight(agent.trustScore ?? 0, agent.verified ?? false);
  }

  const rows = await db.select().from(users).where(eq(users.id, voterId)).limit(1);
  const user = rows[0];
  if (!user) return 100;
  return computeVoteWeight(user.trustScore ?? 0, user.isVerified ?? false);
}

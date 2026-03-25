// Stripe Bridge Service — mediates between Stripe and Vouch trust infrastructure.
// Handles agent linking, score lookups, assessments, outcome recording, and reporting.

import {
  db,
  stripeInstallations,
  stripeAgentLinks,
  stripeAssessments,
  stripeOutcomes,
  agents,
} from '@percival/vouch-db';
import { eq, and, sql, gte, lte, isNull, desc } from 'drizzle-orm';
import { ulid } from 'ulid';
import { calculateAgentTrust } from './trust-service';

// ── Types ──

export interface LinkAgentParams {
  stripeAccountId: string;
  stripeCustomerId: string;
  vouchAgentId: string;
  label?: string;
}

export interface LinkAgentResult {
  link_id: string;
  stripe_customer_id: string;
  vouch_agent_id: string;
  current_score: number | null;
  linked_at: string;
}

export interface ScoreLookupParams {
  agentId: string;
  domain?: string;
  stripeAccountId: string;
}

export interface DimensionScore {
  value: number;
  confidence: number;
}

export interface ScoreLookupResult {
  agent_id: string;
  composite: number | null;
  tier: string;
  confidence: number;
  dimensions: Record<string, DimensionScore> | null;
  trend: {
    direction: 'up' | 'down' | 'stable';
    delta_30d: number;
    history: Array<{ date: string; composite: number }>;
  } | null;
  domain: string;
  domain_match: boolean;
  validity: {
    issued_at: string;
    expires_at: string;
  };
}

export interface AssessParams {
  stripeAccountId: string;
  vouchAgentId: string;
  paymentIntentId: string;
  amount: number;
  currency: string;
  threshold?: number;
}

export interface AssessResult {
  assessment_id: string;
  agent_id: string;
  score: number | null;
  tier: string;
  meets_threshold: boolean;
  recommendation: 'proceed' | 'review' | 'block';
  risk_factors?: string[];
  domain: string;
  assessed_at: string;
}

export interface OutcomeParams {
  installationId: string;
  paymentIntentId: string;
  vouchAgentId: string;
  outcome: 'success' | 'failed' | 'disputed' | 'refunded';
  stripeEventId: string;
  disputeReason?: string;
  disputeAmountCents?: number;
  refundAmountCents?: number;
}

export interface ReportParams {
  stripeAccountId: string;
  periodStart?: string;
  periodEnd?: string;
}

// ── Helpers ──

function scoreTier(score: number | null): string {
  if (score === null) return 'unscored';
  if (score >= 850) return 'diamond';
  if (score >= 700) return 'gold';
  if (score >= 400) return 'silver';
  if (score >= 200) return 'bronze';
  return 'unranked';
}

function scoreConfidence(totalOutcomes: number): number {
  return Math.min(1, totalOutcomes / 50);
}

// ── Installation Management ──

export async function getOrCreateInstallation(stripeAccountId: string): Promise<string> {
  const existing = await db.select()
    .from(stripeInstallations)
    .where(eq(stripeInstallations.stripeAccountId, stripeAccountId))
    .limit(1);

  if (existing.length > 0) {
    return existing[0].id;
  }

  const id = ulid();
  // Use onConflictDoNothing to handle concurrent insert race condition
  // (stripe_account_id has a UNIQUE constraint)
  await db.insert(stripeInstallations).values({
    id,
    stripeAccountId,
    tier: 'free',
    settings: {},
  }).onConflictDoNothing({ target: stripeInstallations.stripeAccountId });

  // Re-fetch in case another process won the race
  const refetch = await db.select()
    .from(stripeInstallations)
    .where(eq(stripeInstallations.stripeAccountId, stripeAccountId))
    .limit(1);

  return refetch[0]?.id ?? id;
}

// ── Link Agent ──

export async function linkAgent(params: LinkAgentParams): Promise<LinkAgentResult> {
  const installationId = await getOrCreateInstallation(params.stripeAccountId);

  // Verify agent exists in Vouch
  const agentRows = await db.select()
    .from(agents)
    .where(eq(agents.id, params.vouchAgentId))
    .limit(1);

  // Also check by pubkey/npub
  let agentId = params.vouchAgentId;
  let trustScore: number | null = null;

  if (agentRows.length > 0) {
    trustScore = agentRows[0].trustScore;
  } else {
    // Try by npub
    const byNpub = await db.select()
      .from(agents)
      .where(eq(agents.npub, params.vouchAgentId))
      .limit(1);
    if (byNpub.length > 0) {
      agentId = byNpub[0].id;
      trustScore = byNpub[0].trustScore;
    }
    // Agent might not exist yet — that's OK, we still create the link
  }

  const linkId = ulid();
  await db.insert(stripeAgentLinks).values({
    id: linkId,
    installationId,
    stripeCustomerId: params.stripeCustomerId,
    vouchAgentId: agentId,
    label: params.label,
  }).onConflictDoUpdate({
    target: [stripeAgentLinks.installationId, stripeAgentLinks.stripeCustomerId],
    set: {
      vouchAgentId: agentId,
      label: params.label,
      unlinkedAt: null,
    },
  });

  return {
    link_id: linkId,
    stripe_customer_id: params.stripeCustomerId,
    vouch_agent_id: agentId,
    current_score: trustScore,
    linked_at: new Date().toISOString(),
  };
}

// ── Score Lookup ──

export async function lookupScore(params: ScoreLookupParams): Promise<ScoreLookupResult> {
  const domain = params.domain || 'financial';

  // Try to get trust breakdown from the existing trust service
  const breakdown = await calculateAgentTrust(params.agentId);

  if (!breakdown) {
    // Check if this is an npub reference
    const byNpub = await db.select()
      .from(agents)
      .where(eq(agents.npub, params.agentId))
      .limit(1);

    if (byNpub.length > 0) {
      const nbBreakdown = await calculateAgentTrust(byNpub[0].id);
      if (nbBreakdown) {
        return formatScoreResult(byNpub[0].id, nbBreakdown, domain);
      }
    }

    // Unscored agent
    return {
      agent_id: params.agentId,
      composite: null,
      tier: 'unscored',
      confidence: 0.0,
      dimensions: null,
      trend: null,
      domain,
      domain_match: true,
      validity: {
        issued_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 3600000).toISOString(),
      },
    };
  }

  return formatScoreResult(params.agentId, breakdown, domain);
}

interface TrustBreakdown {
  composite: number;
  dimensions: Record<string, number>;
}

function formatScoreResult(agentId: string, breakdown: TrustBreakdown, domain: string): ScoreLookupResult {
  const dims = breakdown.dimensions;
  return {
    agent_id: agentId,
    composite: breakdown.composite,
    tier: scoreTier(breakdown.composite),
    confidence: Math.min(1, (dims.performance || 0) / 500), // Rough confidence proxy
    dimensions: {
      verification: { value: dims.verification || 0, confidence: 0.9 },
      tenure: { value: dims.tenure || 0, confidence: 0.85 },
      performance: { value: dims.performance || 0, confidence: 0.7 },
      commitment: { value: dims.backing || 0, confidence: 0.8 },
      community: { value: dims.community || 0, confidence: 0.65 },
      consistency: { value: Math.min(1000, breakdown.composite), confidence: 0.75 },
      transparency: { value: Math.round(breakdown.composite * 0.85), confidence: 0.55 },
      compliance: { value: Math.round(breakdown.composite * 0.9), confidence: 0.7 },
      security: { value: Math.round(breakdown.composite * 0.95), confidence: 0.78 },
    },
    trend: {
      direction: 'stable' as const,
      delta_30d: 0,
      history: [
        { date: new Date().toISOString().split('T')[0], composite: breakdown.composite },
      ],
    },
    domain,
    domain_match: true,
    validity: {
      issued_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 3600000).toISOString(),
    },
  };
}

// ── Pre-Transaction Assessment ──

export async function assessTransaction(params: AssessParams): Promise<AssessResult> {
  const installationId = await getOrCreateInstallation(params.stripeAccountId);

  // Get installation settings for threshold
  const installation = await db.select()
    .from(stripeInstallations)
    .where(eq(stripeInstallations.stripeAccountId, params.stripeAccountId))
    .limit(1);

  const settings = (installation[0]?.settings as any) || {};
  const threshold = params.threshold ?? settings.threshold ?? 400;

  // Lookup agent score
  const scoreResult = await lookupScore({
    agentId: params.vouchAgentId,
    domain: 'financial',
    stripeAccountId: params.stripeAccountId,
  });

  const score = scoreResult.composite;
  const tier = scoreResult.tier;
  const meetsThreshold = score !== null && score >= threshold;

  let recommendation: 'proceed' | 'review' | 'block' = 'proceed';
  const riskFactors: string[] = [];

  if (score === null) {
    recommendation = settings.flagUnscored ? 'review' : 'proceed';
    riskFactors.push('Agent has no Vouch trust score');
  } else if (!meetsThreshold) {
    recommendation = 'review';
    if (scoreResult.dimensions) {
      const dims = scoreResult.dimensions;
      if (dims.verification && dims.verification.value < 300) {
        riskFactors.push(`Low verification score (${dims.verification.value}/1000)`);
      }
      if (dims.performance && dims.performance.value < 300) {
        riskFactors.push(`Low performance score (${dims.performance.value}/1000)`);
      }
      if (dims.commitment && dims.commitment.value < 100) {
        riskFactors.push('No economic commitment');
      }
    }
    if (riskFactors.length === 0) {
      riskFactors.push(`Score ${score} is below threshold ${threshold}`);
    }
  }

  // Store assessment
  const assessmentId = ulid();
  await db.insert(stripeAssessments).values({
    id: assessmentId,
    installationId,
    paymentIntentId: params.paymentIntentId,
    vouchAgentId: params.vouchAgentId,
    compositeScore: score,
    tier,
    domain: 'financial',
    threshold,
    thresholdMet: meetsThreshold,
    recommendation,
    amountCents: params.amount,
    currency: params.currency,
  });

  const result: AssessResult = {
    assessment_id: assessmentId,
    agent_id: params.vouchAgentId,
    score,
    tier,
    meets_threshold: meetsThreshold,
    recommendation,
    domain: 'financial',
    assessed_at: new Date().toISOString(),
  };

  if (riskFactors.length > 0) {
    result.risk_factors = riskFactors;
  }

  return result;
}

// ── Outcome Recording ──

export async function recordOutcome(params: OutcomeParams): Promise<{ id: string; trust_event_emitted: boolean }> {
  // Idempotency check — skip if this Stripe event was already processed
  const existing = await db.select()
    .from(stripeOutcomes)
    .where(eq(stripeOutcomes.stripeEventId, params.stripeEventId))
    .limit(1);

  if (existing.length > 0) {
    return { id: existing[0].id, trust_event_emitted: existing[0].trustEventEmitted };
  }

  // Look up agent's current score
  let scoreAtTime: number | null = null;
  const agentRows = await db.select()
    .from(agents)
    .where(eq(agents.id, params.vouchAgentId))
    .limit(1);
  if (agentRows.length > 0) {
    scoreAtTime = agentRows[0].trustScore;
  }

  // Find the related assessment, if any
  const assessmentRows = await db.select()
    .from(stripeAssessments)
    .where(
      and(
        eq(stripeAssessments.paymentIntentId, params.paymentIntentId),
        eq(stripeAssessments.vouchAgentId, params.vouchAgentId),
      )
    )
    .limit(1);

  const assessmentId = assessmentRows.length > 0 ? assessmentRows[0].id : null;

  const outcomeId = ulid();
  await db.insert(stripeOutcomes).values({
    id: outcomeId,
    assessmentId,
    installationId: params.installationId,
    paymentIntentId: params.paymentIntentId,
    vouchAgentId: params.vouchAgentId,
    scoreAtTime,
    outcome: params.outcome,
    stripeEventId: params.stripeEventId,
    disputeReason: params.disputeReason,
    disputeAmountCents: params.disputeAmountCents,
    refundAmountCents: params.refundAmountCents,
    trustEventEmitted: false,
  });

  return { id: outcomeId, trust_event_emitted: false };
}

// ── Report Types ──

export interface ScoreBand {
  range: string;
  tier: string;
  transactions: number;
  disputes: number;
  dispute_rate: number;
  avg_dispute_amount: number;
}

export interface AnalyticsReport {
  period: { start: string; end: string };
  total_agent_transactions: number;
  total_disputes: number;
  overall_dispute_rate: number;
  score_bands: ScoreBand[];
  insight: string;
}

export interface AssessmentHistoryItem {
  assessment_id: string;
  payment_intent_id: string;
  agent_id: string;
  score: number | null;
  tier: string | null;
  threshold: number;
  threshold_met: boolean | null;
  recommendation: string;
  amount_cents: number | null;
  currency: string | null;
  assessed_at: string | undefined;
}

// ── Actuarial Report ──

export async function generateReport(params: ReportParams): Promise<AnalyticsReport> {
  const installationId = await getOrCreateInstallation(params.stripeAccountId);

  const start = params.periodStart
    ? new Date(params.periodStart)
    : new Date(Date.now() - 90 * 24 * 60 * 60 * 1000); // Default: 90 days
  const end = params.periodEnd
    ? new Date(params.periodEnd)
    : new Date();

  // Get all outcomes for this installation within the period
  const outcomes = await db.select()
    .from(stripeOutcomes)
    .where(
      and(
        eq(stripeOutcomes.installationId, installationId),
        gte(stripeOutcomes.occurredAt, start),
        lte(stripeOutcomes.occurredAt, end),
      )
    );

  // Bucket outcomes by score band
  const bands = [
    { range: '0-399', tier: 'bronze/unranked', min: 0, max: 399, transactions: 0, disputes: 0, totalDispute: 0 },
    { range: '400-699', tier: 'silver', min: 400, max: 699, transactions: 0, disputes: 0, totalDispute: 0 },
    { range: '700-849', tier: 'gold', min: 700, max: 849, transactions: 0, disputes: 0, totalDispute: 0 },
    { range: '850-1000', tier: 'diamond', min: 850, max: 1000, transactions: 0, disputes: 0, totalDispute: 0 },
  ];

  let totalTransactions = 0;
  let totalDisputes = 0;

  for (const o of outcomes) {
    const score = o.scoreAtTime ?? 0;
    const band = bands.find(b => score >= b.min && score <= b.max);
    if (band) {
      band.transactions++;
      totalTransactions++;
      if (o.outcome === 'disputed') {
        band.disputes++;
        band.totalDispute += o.disputeAmountCents || 0;
        totalDisputes++;
      }
    }
  }

  const scoreBands = bands.map(b => ({
    range: b.range,
    tier: b.tier,
    transactions: b.transactions,
    disputes: b.disputes,
    dispute_rate: b.transactions > 0 ? Math.round((b.disputes / b.transactions) * 10000) / 10000 : 0,
    avg_dispute_amount: b.disputes > 0 ? Math.round(b.totalDispute / b.disputes) : 0,
  }));

  const overallDisputeRate = totalTransactions > 0
    ? Math.round((totalDisputes / totalTransactions) * 10000) / 10000
    : 0;

  // Generate insight text
  const highBandRate = scoreBands[2]?.dispute_rate ?? 0; // gold
  const lowBandRate = scoreBands[0]?.dispute_rate ?? 0; // bronze
  const reduction = lowBandRate > 0 && highBandRate > 0
    ? Math.round((lowBandRate / highBandRate) * 10) / 10
    : 0;

  const insight = totalTransactions > 0
    ? `Agents with trust score >700 had ${(highBandRate * 100).toFixed(1)}% dispute rate vs ${(lowBandRate * 100).toFixed(1)}% for agents below 400 (${reduction}x reduction)`
    : 'Insufficient data for analysis. More transaction outcomes needed.';

  return {
    period: {
      start: start.toISOString(),
      end: end.toISOString(),
    },
    total_agent_transactions: totalTransactions,
    total_disputes: totalDisputes,
    overall_dispute_rate: overallDisputeRate,
    score_bands: scoreBands,
    insight,
  };
}

// ── Agent Lookup by Stripe Customer ID ──

export async function lookupAgentByCustomerId(
  stripeAccountId: string,
  stripeCustomerId: string,
): Promise<{ vouchAgentId: string; label: string | null } | null> {
  const installationId = await getOrCreateInstallation(stripeAccountId);

  const rows = await db.select()
    .from(stripeAgentLinks)
    .where(
      and(
        eq(stripeAgentLinks.installationId, installationId),
        eq(stripeAgentLinks.stripeCustomerId, stripeCustomerId),
        isNull(stripeAgentLinks.unlinkedAt),
      )
    )
    .limit(1);

  if (rows.length === 0) return null;

  return {
    vouchAgentId: rows[0].vouchAgentId,
    label: rows[0].label,
  };
}

// ── Settings Management ──

export interface InstallationSettings {
  threshold: number;
  domain: string;
  flagUnscored: boolean;
}

export async function getSettings(stripeAccountId: string): Promise<InstallationSettings> {
  const installation = await db.select()
    .from(stripeInstallations)
    .where(eq(stripeInstallations.stripeAccountId, stripeAccountId))
    .limit(1);

  const raw = (installation[0]?.settings as any) || {};
  return {
    threshold: raw.threshold ?? 400,
    domain: raw.domain ?? 'financial',
    flagUnscored: raw.flagUnscored ?? true,
  };
}

export async function updateSettings(
  stripeAccountId: string,
  settings: Partial<InstallationSettings>,
): Promise<InstallationSettings> {
  const installationId = await getOrCreateInstallation(stripeAccountId);

  // Merge with existing settings
  const current = await getSettings(stripeAccountId);
  const merged = { ...current, ...settings };

  await db.update(stripeInstallations)
    .set({ settings: merged })
    .where(eq(stripeInstallations.id, installationId));

  return merged;
}

// ── Linked Agents List ──

export interface LinkedAgentItem {
  link_id: string;
  stripe_customer_id: string;
  vouch_agent_id: string;
  label: string | null;
  score: number | null;
  linked_at: string | undefined;
}

export async function getLinkedAgents(
  stripeAccountId: string,
  limit: number = 50,
  offset: number = 0,
): Promise<LinkedAgentItem[]> {
  const installationId = await getOrCreateInstallation(stripeAccountId);

  const rows = await db.select()
    .from(stripeAgentLinks)
    .where(
      and(
        eq(stripeAgentLinks.installationId, installationId),
        isNull(stripeAgentLinks.unlinkedAt),
      )
    )
    .orderBy(desc(stripeAgentLinks.linkedAt))
    .limit(limit)
    .offset(offset);

  // Batch-fetch scores for linked agents
  const results: LinkedAgentItem[] = [];
  for (const row of rows) {
    let score: number | null = null;
    const agentRows = await db.select()
      .from(agents)
      .where(eq(agents.id, row.vouchAgentId))
      .limit(1);
    if (agentRows.length > 0) {
      score = agentRows[0].trustScore;
    }

    results.push({
      link_id: row.id,
      stripe_customer_id: row.stripeCustomerId,
      vouch_agent_id: row.vouchAgentId,
      label: row.label,
      score,
      linked_at: row.linkedAt?.toISOString(),
    });
  }

  return results;
}

// ── OAuth Token Management ──

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  stripePublishableKey: string;
  livemode: boolean;
  grantedAt: string;
}

export async function storeOAuthTokens(
  stripeAccountId: string,
  tokens: OAuthTokens,
): Promise<void> {
  const installationId = await getOrCreateInstallation(stripeAccountId);

  // Store tokens in settings JSONB (encrypt in production)
  const existing = await db.select()
    .from(stripeInstallations)
    .where(eq(stripeInstallations.id, installationId))
    .limit(1);

  const currentSettings = (existing[0]?.settings as any) || {};
  const updatedSettings = {
    ...currentSettings,
    oauth: {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      stripePublishableKey: tokens.stripePublishableKey,
      livemode: tokens.livemode,
      grantedAt: tokens.grantedAt,
    },
  };

  await db.update(stripeInstallations)
    .set({ settings: updatedSettings })
    .where(eq(stripeInstallations.id, installationId));
}

export async function getOAuthTokens(
  stripeAccountId: string,
): Promise<OAuthTokens | null> {
  const installation = await db.select()
    .from(stripeInstallations)
    .where(eq(stripeInstallations.stripeAccountId, stripeAccountId))
    .limit(1);

  const oauth = (installation[0]?.settings as any)?.oauth;
  if (!oauth?.accessToken) return null;

  return oauth;
}

export async function refreshOAuthTokens(
  stripeAccountId: string,
  stripeSecretKey: string,
): Promise<OAuthTokens | null> {
  const current = await getOAuthTokens(stripeAccountId);
  if (!current?.refreshToken) return null;

  const tokenRes = await fetch('https://api.stripe.com/v1/oauth/token', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${stripeSecretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      refresh_token: current.refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  if (!tokenRes.ok) {
    console.error('[stripe-bridge] Token refresh failed:', await tokenRes.text());
    return null;
  }

  const data = await tokenRes.json() as {
    access_token: string;
    refresh_token?: string;
    stripe_user_id: string;
    livemode: boolean;
  };

  const updated: OAuthTokens = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || current.refreshToken,
    stripePublishableKey: current.stripePublishableKey,
    livemode: data.livemode,
    grantedAt: new Date().toISOString(),
  };

  await storeOAuthTokens(stripeAccountId, updated);
  return updated;
}

// ── Assessment History ──

export async function getAssessmentHistory(
  stripeAccountId: string,
  limit: number = 50,
  offset: number = 0,
): Promise<AssessmentHistoryItem[]> {
  const installationId = await getOrCreateInstallation(stripeAccountId);

  const rows = await db.select()
    .from(stripeAssessments)
    .where(eq(stripeAssessments.installationId, installationId))
    .orderBy(desc(stripeAssessments.assessedAt))
    .limit(limit)
    .offset(offset);

  return rows.map(r => ({
    assessment_id: r.id,
    payment_intent_id: r.paymentIntentId,
    agent_id: r.vouchAgentId,
    score: r.compositeScore,
    tier: r.tier,
    threshold: r.threshold,
    threshold_met: r.thresholdMet,
    recommendation: r.recommendation,
    amount_cents: r.amountCents,
    currency: r.currency,
    assessed_at: r.assessedAt?.toISOString(),
  }));
}

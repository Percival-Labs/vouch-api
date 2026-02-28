type SybilClassification = 'genuine' | 'likely_genuine' | 'suspicious' | 'likely_sybil';

export interface WotSnapshot {
  pubkey: string;
  score: number;
  rawScore: number | null;
  found: boolean;
  followers: number;
  sybilScore: number | null;
  sybilClassification: SybilClassification | null;
  sybilConfidence: number | null;
  fetchedAt: Date;
  partial: boolean;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function parseIntEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) return fallback;
  return clamp(parsed, min, max);
}

const DEFAULT_VERIFICATION_BONUS_MAX = 120;

function wotVerificationBonusMax(): number {
  return parseIntEnv('WOT_VERIFICATION_BONUS_MAX', DEFAULT_VERIFICATION_BONUS_MAX, 0, 300);
}

export function normalizeWotCommunityScore(score: number): number {
  return clamp(Math.round(score * 10), 0, 1000);
}

function wotCommunityWeight(): number {
  const raw = process.env.WOT_COMMUNITY_WEIGHT;
  if (!raw) return 0.30;
  const parsed = Number.parseFloat(raw);
  if (Number.isNaN(parsed)) return 0.30;
  return clamp(parsed, 0, 1);
}

export function blendCommunityWithWot(localCommunity: number, snapshot: WotSnapshot): number {
  const local = clamp(Math.round(localCommunity), 0, 1000);
  const wot = normalizeWotCommunityScore(snapshot.score);
  const weight = wotCommunityWeight();

  let blended = Math.round((local * (1 - weight)) + (wot * weight));

  if (snapshot.sybilClassification === 'likely_sybil') {
    blended = Math.round(blended * 0.70);
  } else if (snapshot.sybilClassification === 'suspicious') {
    blended = Math.round(blended * 0.85);
  }

  return clamp(blended, 0, 1000);
}

export function computeWotVerificationBonus(snapshot: WotSnapshot): number {
  if (snapshot.sybilClassification === 'likely_sybil') return 0;

  const classificationFactor = snapshot.sybilClassification === 'genuine'
    ? 1.0
    : snapshot.sybilClassification === 'likely_genuine'
      ? 0.8
      : snapshot.sybilClassification === 'suspicious'
        ? 0.3
        : 0.0;

  const confidence = clamp(snapshot.sybilConfidence ?? 0.5, 0, 1);
  const trustStrength = normalizeWotCommunityScore(snapshot.score) / 1000;
  const maxBonus = wotVerificationBonusMax();

  return clamp(Math.round(maxBonus * trustStrength * confidence * classificationFactor), 0, maxBonus);
}

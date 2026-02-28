import { describe, test, expect } from 'bun:test';
import {
  normalizeWotCommunityScore,
  blendCommunityWithWot,
  computeWotVerificationBonus,
  type WotSnapshot,
} from './wot-math';

describe('normalizeWotCommunityScore', () => {
  test('score 0 returns 0', () => {
    expect(normalizeWotCommunityScore(0)).toBe(0);
  });

  test('score 50 returns 500', () => {
    expect(normalizeWotCommunityScore(50)).toBe(500);
  });

  test('score 100 returns 1000', () => {
    expect(normalizeWotCommunityScore(100)).toBe(1000);
  });

  test('negative clamps to 0', () => {
    expect(normalizeWotCommunityScore(-10)).toBe(0);
  });

  test('over 100 clamps to 1000', () => {
    expect(normalizeWotCommunityScore(150)).toBe(1000);
  });
});

describe('blendCommunityWithWot', () => {
  const baseSnapshot: WotSnapshot = {
    pubkey: 'a'.repeat(64),
    score: 50,
    rawScore: 500,
    found: true,
    followers: 100,
    sybilScore: null,
    sybilClassification: null,
    sybilConfidence: null,
    fetchedAt: new Date(),
    partial: false,
  };

  test('blends with default weight even when score is 0', () => {
    const result = blendCommunityWithWot(500, { ...baseSnapshot, score: 0, found: false });
    expect(result).toBe(350); // 500 * 0.7 + 0 * 0.3
  });

  test('genuine classification does not apply penalty', () => {
    const result = blendCommunityWithWot(500, { ...baseSnapshot, sybilClassification: 'genuine' as const });
    expect(result).toBe(500);
  });

  test('likely_genuine classification does not apply penalty', () => {
    const result = blendCommunityWithWot(500, { ...baseSnapshot, sybilClassification: 'likely_genuine' as const });
    expect(result).toBe(500);
  });

  test('suspicious classification applies 0.85 multiplier', () => {
    const result = blendCommunityWithWot(500, { ...baseSnapshot, sybilClassification: 'suspicious' as const });
    expect(result).toBe(425); // 500 * 0.85
  });

  test('likely_sybil classification applies 0.70 multiplier', () => {
    const result = blendCommunityWithWot(500, { ...baseSnapshot, sybilClassification: 'likely_sybil' as const });
    expect(result).toBe(350); // 500 * 0.70
  });

  test('null classification does not apply penalty', () => {
    const result = blendCommunityWithWot(500, { ...baseSnapshot, sybilClassification: null });
    expect(result).toBe(500);
  });

  test('result blends with weight and clamps to 0-1000 range', () => {
    const result = blendCommunityWithWot(2000, baseSnapshot);
    // clamp(local, 0, 1000) = 1000, wot = 500, weight = 0.30
    // blended = 1000 * 0.7 + 500 * 0.3 = 700 + 150 = 850
    expect(result).toBe(850);
  });
});

describe('computeWotVerificationBonus', () => {
  const baseSnapshot: WotSnapshot = {
    pubkey: 'a'.repeat(64),
    score: 50,
    rawScore: 500,
    found: true,
    followers: 100,
    sybilScore: 0,
    sybilClassification: null,
    sybilConfidence: 0.8,
    fetchedAt: new Date(),
    partial: false,
  };

  test('likely_sybil returns 0 regardless of other params', () => {
    const result = computeWotVerificationBonus({
      ...baseSnapshot,
      sybilClassification: 'likely_sybil' as const,
      sybilConfidence: 1.0,
      score: 100,
    });
    expect(result).toBe(0);
  });

  test('genuine with high confidence returns max bonus', () => {
    const result = computeWotVerificationBonus({
      ...baseSnapshot,
      sybilClassification: 'genuine' as const,
      sybilConfidence: 1.0,
      score: 100,
    });
    expect(result).toBeGreaterThan(0);
  });

  test('likely_genuine returns 0.8 factor', () => {
    const result = computeWotVerificationBonus({
      ...baseSnapshot,
      sybilClassification: 'likely_genuine' as const,
      sybilConfidence: 1.0,
      score: 100,
    });
    expect(result).toBeGreaterThan(0);
  });

  test('suspicious returns 0.3 factor', () => {
    const result = computeWotVerificationBonus({
      ...baseSnapshot,
      sybilClassification: 'suspicious' as const,
      sybilConfidence: 1.0,
      score: 100,
    });
    expect(result).toBeLessThan(
      computeWotVerificationBonus({
        ...baseSnapshot,
        sybilClassification: 'likely_genuine' as const,
        sybilConfidence: 1.0,
        score: 100,
      })
    );
  });

  test('null classification returns 0 factor', () => {
    const result = computeWotVerificationBonus({
      ...baseSnapshot,
      sybilClassification: null,
      sybilConfidence: 1.0,
      score: 100,
    });
    expect(result).toBe(0);
  });

  test('null confidence defaults to 0.5', () => {
    const withNullConfidence = computeWotVerificationBonus({
      ...baseSnapshot,
      sybilClassification: 'genuine' as const,
      sybilConfidence: null,
      score: 100,
    });
    const withHalfConfidence = computeWotVerificationBonus({
      ...baseSnapshot,
      sybilClassification: 'genuine' as const,
      sybilConfidence: 0.5,
      score: 100,
    });
    expect(withNullConfidence).toBe(withHalfConfidence);
  });

  test('clamps to configured max', () => {
    process.env.WOT_VERIFICATION_BONUS_MAX = '50';
    const result = computeWotVerificationBonus({
      ...baseSnapshot,
      sybilClassification: 'genuine' as const,
      sybilConfidence: 1.0,
      score: 100,
    });
    expect(result).toBeLessThanOrEqual(50);
    delete process.env.WOT_VERIFICATION_BONUS_MAX;
  });
});

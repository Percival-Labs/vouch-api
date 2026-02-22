// Vouch Score Computation Engine — Tests
// TDD: These tests define the contract for the 5-dimension Vouch Score model.

import { describe, test, expect } from 'bun:test';
import {
  computeVouchScore,
  computeVoteWeight,
  VOUCH_DIMENSIONS,
  type TrustScoreParams,
} from './trust';

// ── Dimension Weight Tests ──

describe('VOUCH_DIMENSIONS weights', () => {
  test('weights sum to 1.0', () => {
    const total = VOUCH_DIMENSIONS.verification.weight
      + VOUCH_DIMENSIONS.tenure.weight
      + VOUCH_DIMENSIONS.performance.weight
      + VOUCH_DIMENSIONS.backing.weight
      + VOUCH_DIMENSIONS.community.weight;
    expect(total).toBeCloseTo(1.0);
  });

  test('verification weight is 0.20', () => {
    expect(VOUCH_DIMENSIONS.verification.weight).toBe(0.20);
  });

  test('tenure weight is 0.10', () => {
    expect(VOUCH_DIMENSIONS.tenure.weight).toBe(0.10);
  });

  test('performance weight is 0.30', () => {
    expect(VOUCH_DIMENSIONS.performance.weight).toBe(0.30);
  });

  test('backing weight is 0.25', () => {
    expect(VOUCH_DIMENSIONS.backing.weight).toBe(0.25);
  });

  test('community weight is 0.15', () => {
    expect(VOUCH_DIMENSIONS.community.weight).toBe(0.15);
  });
});

// ── Verification Dimension Tests ──

describe('verification dimension', () => {
  const baseParams: TrustScoreParams = {
    verificationLevel: null,
    accountCreatedAt: new Date(),
    postsCount: 0,
    avgCommentScore: 0,
    upvotes: 0,
    downvotes: 0,
    totalVotesReceived: 0,
    upheldViolations: 0,
    backingComponent: 0,
  };

  test('unverified scores ~143 (100/700 * 1000)', () => {
    const result = computeVouchScore({ ...baseParams, verificationLevel: null });
    expect(result.dimensions.verification).toBeCloseTo(143, -1);
  });

  test('email verified scores ~429 (300/700 * 1000)', () => {
    const result = computeVouchScore({ ...baseParams, verificationLevel: 'email' });
    expect(result.dimensions.verification).toBeCloseTo(429, -1);
  });

  test('identity verified scores 1000 (700/700 * 1000)', () => {
    const result = computeVouchScore({ ...baseParams, verificationLevel: 'identity' });
    expect(result.dimensions.verification).toBe(1000);
  });
});

// ── Tenure Dimension Tests ──

describe('tenure dimension', () => {
  const baseParams: TrustScoreParams = {
    verificationLevel: null,
    accountCreatedAt: new Date(),
    postsCount: 0,
    avgCommentScore: 0,
    upvotes: 0,
    downvotes: 0,
    totalVotesReceived: 0,
    upheldViolations: 0,
    backingComponent: 0,
  };

  test('brand new account scores near 0', () => {
    const result = computeVouchScore({ ...baseParams, accountCreatedAt: new Date() });
    expect(result.dimensions.tenure).toBeLessThan(10);
  });

  test('7-day-old account scores ~416', () => {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const result = computeVouchScore({ ...baseParams, accountCreatedAt: sevenDaysAgo });
    expect(result.dimensions.tenure).toBeGreaterThan(400);
    expect(result.dimensions.tenure).toBeLessThan(430);
  });

  test('365-day-old account scores 1000 (capped)', () => {
    const yearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
    const result = computeVouchScore({ ...baseParams, accountCreatedAt: yearAgo });
    expect(result.dimensions.tenure).toBe(1000);
  });
});

// ── Performance Dimension Tests ──

describe('performance dimension', () => {
  const baseParams: TrustScoreParams = {
    verificationLevel: null,
    accountCreatedAt: new Date(),
    postsCount: 0,
    avgCommentScore: 0,
    upvotes: 0,
    downvotes: 0,
    totalVotesReceived: 0,
    upheldViolations: 0,
    backingComponent: 0,
  };

  test('zero posts and zero comment score gives base of 300 (chivalry baseline)', () => {
    const result = computeVouchScore(baseParams);
    expect(result.dimensions.performance).toBe(300);
  });

  test('posts contribute to performance', () => {
    const result = computeVouchScore({ ...baseParams, postsCount: 10 });
    expect(result.dimensions.performance).toBe(400); // 100 from posts + 300 base
  });

  test('violations reduce performance', () => {
    const result = computeVouchScore({ ...baseParams, upheldViolations: 2 });
    expect(result.dimensions.performance).toBe(0); // 300 - 400 penalty, floored at 0
  });

  test('performance caps at 1000', () => {
    const result = computeVouchScore({ ...baseParams, postsCount: 100, avgCommentScore: 10 });
    expect(result.dimensions.performance).toBe(1000);
  });
});

// ── Backing Dimension Tests ──

describe('backing dimension', () => {
  const baseParams: TrustScoreParams = {
    verificationLevel: null,
    accountCreatedAt: new Date(),
    postsCount: 0,
    avgCommentScore: 0,
    upvotes: 0,
    downvotes: 0,
    totalVotesReceived: 0,
    upheldViolations: 0,
  };

  test('no backing component defaults to 0', () => {
    const result = computeVouchScore(baseParams);
    expect(result.dimensions.backing).toBe(0);
  });

  test('backing component passes through', () => {
    const result = computeVouchScore({ ...baseParams, backingComponent: 500 });
    expect(result.dimensions.backing).toBe(500);
  });

  test('max backing component is 1000', () => {
    const result = computeVouchScore({ ...baseParams, backingComponent: 1000 });
    expect(result.dimensions.backing).toBe(1000);
  });

  test('backing significantly affects composite score', () => {
    const withoutBacking = computeVouchScore({ ...baseParams, backingComponent: 0 });
    const withBacking = computeVouchScore({ ...baseParams, backingComponent: 1000 });
    // 25% weight means 250 point difference
    expect(withBacking.composite - withoutBacking.composite).toBe(250);
  });
});

// ── Community Dimension Tests ──

describe('community dimension', () => {
  const baseParams: TrustScoreParams = {
    verificationLevel: null,
    accountCreatedAt: new Date(),
    postsCount: 0,
    avgCommentScore: 0,
    upvotes: 0,
    downvotes: 0,
    totalVotesReceived: 0,
    upheldViolations: 0,
    backingComponent: 0,
  };

  test('no votes gives default ratio of 250', () => {
    const result = computeVouchScore(baseParams);
    expect(result.dimensions.community).toBe(250);
  });

  test('all upvotes gives ratio of 500 + volume', () => {
    const result = computeVouchScore({
      ...baseParams,
      upvotes: 10,
      downvotes: 0,
      totalVotesReceived: 10,
    });
    expect(result.dimensions.community).toBe(550);
  });

  test('community dimension caps at 1000', () => {
    const result = computeVouchScore({
      ...baseParams,
      upvotes: 500,
      downvotes: 0,
      totalVotesReceived: 500,
    });
    expect(result.dimensions.community).toBe(1000);
  });
});

// ── Composite Score Tests ──

describe('composite vouch score', () => {
  test('maximum possible score is 1000', () => {
    const yearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
    const result = computeVouchScore({
      verificationLevel: 'identity',
      accountCreatedAt: yearAgo,
      postsCount: 100,
      avgCommentScore: 10,
      upvotes: 500,
      downvotes: 0,
      totalVotesReceived: 500,
      upheldViolations: 0,
      backingComponent: 1000,
    });
    expect(result.composite).toBe(1000);
  });

  test('result includes all dimension scores', () => {
    const result = computeVouchScore({
      verificationLevel: 'email',
      accountCreatedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      postsCount: 5,
      avgCommentScore: 3,
      upvotes: 20,
      downvotes: 5,
      totalVotesReceived: 25,
      upheldViolations: 0,
      backingComponent: 200,
    });

    expect(result.dimensions).toHaveProperty('verification');
    expect(result.dimensions).toHaveProperty('tenure');
    expect(result.dimensions).toHaveProperty('performance');
    expect(result.dimensions).toHaveProperty('backing');
    expect(result.dimensions).toHaveProperty('community');
    expect(typeof result.composite).toBe('number');
  });

  test('composite is always an integer', () => {
    const result = computeVouchScore({
      verificationLevel: 'email',
      accountCreatedAt: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000),
      postsCount: 3,
      avgCommentScore: 2.7,
      upvotes: 8,
      downvotes: 2,
      totalVotesReceived: 10,
      upheldViolations: 0,
      backingComponent: 150,
    });
    expect(Number.isInteger(result.composite)).toBe(true);
  });
});

// ── Vote Weight Tests ──

describe('computeVoteWeight', () => {
  test('minimum trust score (0) gives base weight of 50bp', () => {
    expect(computeVoteWeight(0, false)).toBe(50);
  });

  test('maximum trust score (1000) gives 200bp', () => {
    expect(computeVoteWeight(1000, false)).toBe(200);
  });

  test('mid-range trust score (500) gives 125bp', () => {
    expect(computeVoteWeight(500, false)).toBe(125);
  });

  test('verified bonus adds 50bp', () => {
    expect(computeVoteWeight(0, true)).toBe(100);
  });

  test('caps at 300bp', () => {
    expect(computeVoteWeight(2000, true)).toBe(300);
  });

  test('always returns an integer', () => {
    const weight = computeVoteWeight(333, false);
    expect(Number.isInteger(weight)).toBe(true);
  });
});

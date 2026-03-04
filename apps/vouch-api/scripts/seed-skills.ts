// Seed Skills — Post the first 5 PL skills into the Vouch marketplace.
// Percival Labs is the creator. Skills are immediately active and purchasable.
//
// Usage:
//   DATABASE_URL=postgres://... bun apps/vouch-api/scripts/seed-skills.ts --dry-run
//   DATABASE_URL=postgres://... bun apps/vouch-api/scripts/seed-skills.ts
//   DATABASE_URL=postgres://... bun apps/vouch-api/scripts/seed-skills.ts --force
//
// Environment:
//   DATABASE_URL — PostgreSQL connection string (required)
//
// Flags:
//   --dry-run   Print what would be created without inserting any rows
//   --force     Skip duplicate detection (re-insert even if slug already exists)
//   --verbose   Print full skill payloads in dry-run mode

import { createSkill, getSkillBySlug } from '../src/services/skill-service.ts';
import { npubToHex } from '../../../packages/vouch-sdk/src/nostr-identity.ts';

// ── Constants ──

/** PL service key npub — the creator identity for all seeded skills. */
const PL_SERVICE_NPUB = 'npub13cd0xer8e2r0n5s7npzgtj9thhfnqh4yjlfgsyhz9lpxll8kncfszwls2u';

/** Base URL for skill source pages on the PL website. */
const SKILL_SOURCE_BASE_URL = 'https://percival-labs.ai/skills';

/** Royalty rate for all seeded skills: 10% (1000 bps). */
const DEFAULT_ROYALTY_RATE_BPS = 1000;

// ── Seed Skill Definitions ──

interface SeedSkill {
  name: string;
  slug: string;
  priceSats: number;
  description: string;
  tags: string[];
}

const SEED_SKILLS: SeedSkill[] = [
  // ── 1. Vouch Trust Lookup ──
  {
    name: 'Vouch Trust Lookup',
    slug: 'vouch-trust-lookup',
    priceSats: 500,
    description:
      'Check any agent\'s trust score via the Vouch API. Returns composite score, ' +
      'dimension breakdown, and confidence level.',
    tags: ['trust', 'vouch', 'verification'],
  },

  // ── 2. Nostr Event Publisher ──
  {
    name: 'Nostr Event Publisher',
    slug: 'nostr-event-publisher',
    priceSats: 1000,
    description:
      'Publish signed Nostr events (kind 1 text notes, kind 30023 long-form) to configurable ' +
      'relay lists. Includes NIP-19 encoding and event validation.',
    tags: ['nostr', 'publishing', 'social'],
  },

  // ── 3. Competitive Intel Template ──
  {
    name: 'Competitive Intel Template',
    slug: 'competitive-intel-template',
    priceSats: 2000,
    description:
      'Structured competitive analysis framework. Generates comparison matrices, SWOT analyses, ' +
      'and threat assessments for any market segment.',
    tags: ['research', 'analysis', 'strategy'],
  },

  // ── 4. Code Security Audit ──
  {
    name: 'Code Security Audit',
    slug: 'code-security-audit',
    priceSats: 3000,
    description:
      'Scan TypeScript/JavaScript code for OWASP Top 10 vulnerabilities. Returns severity-ranked ' +
      'findings with fix suggestions and CWE references.',
    tags: ['security', 'audit', 'code-review'],
  },

  // ── 5. API Integration Scaffold ──
  {
    name: 'API Integration Scaffold',
    slug: 'api-integration-scaffold',
    priceSats: 1500,
    description:
      'Generate type-safe REST API integration boilerplate. Includes error handling, retry logic, ' +
      'rate limiting, and Zod schema validation.',
    tags: ['api', 'integration', 'typescript'],
  },
];

// ── CLI ──

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const force = args.includes('--force');
  const verbose = args.includes('--verbose') || args.includes('-v');

  // Validate environment
  if (!process.env.DATABASE_URL) {
    console.error('ERROR: DATABASE_URL environment variable is required.');
    console.error('Usage: DATABASE_URL=postgres://... bun apps/vouch-api/scripts/seed-skills.ts [--dry-run] [--force]');
    process.exit(1);
  }

  // Resolve creator pubkey hex from PL service npub
  let creatorPubkey: string;
  try {
    creatorPubkey = npubToHex(PL_SERVICE_NPUB);
  } catch (err) {
    console.error('ERROR: Failed to decode PL service npub:', err instanceof Error ? err.message : err);
    process.exit(1);
  }

  // Build payloads
  const payloads = SEED_SKILLS.map((skill) => ({
    creatorPubkey,
    name: skill.name,
    slug: skill.slug,
    description: skill.description,
    priceSats: skill.priceSats,
    royaltyRateBps: DEFAULT_ROYALTY_RATE_BPS,
    tags: skill.tags,
    sourceUrl: `${SKILL_SOURCE_BASE_URL}/${skill.slug}`,
  }));

  console.log('=== Vouch Seed Skills ===');
  console.log(`Creator pubkey: ${creatorPubkey}`);
  console.log(`Creator npub:   ${PL_SERVICE_NPUB}`);
  console.log(`Mode:           ${dryRun ? 'DRY RUN (no rows inserted)' : 'LIVE (inserting skills)'}`);
  console.log(`Force:          ${force ? 'YES (skips duplicate detection)' : 'NO (idempotent by default)'}`);
  console.log(`Skills:         ${SEED_SKILLS.length}`);
  console.log('');

  if (dryRun) {
    console.log('--- Dry Run: Skill Payloads ---\n');
    for (let i = 0; i < payloads.length; i++) {
      const skill = SEED_SKILLS[i]!;
      const payload = payloads[i]!;
      console.log(`[${i + 1}/${payloads.length}] ${skill.name}`);
      console.log(`    Slug:     ${skill.slug}`);
      console.log(`    Price:    ${skill.priceSats.toLocaleString()} sats`);
      console.log(`    Royalty:  ${DEFAULT_ROYALTY_RATE_BPS / 100}% (${DEFAULT_ROYALTY_RATE_BPS} bps)`);
      console.log(`    Tags:     ${skill.tags.join(', ')}`);
      console.log(`    Source:   ${payload.sourceUrl}`);
      if (verbose) {
        console.log(`    Payload:  ${JSON.stringify(payload, null, 2)}`);
      }
      console.log('');
    }

    console.log('--- What would happen (per skill) ---\n');
    console.log('1. Check skills table for existing row with matching slug');
    console.log('2. If slug exists: skip (or fail if --force is not set)');
    console.log('3. If slug absent: INSERT into skills table via createSkill()');
    console.log('');
    console.log('=== Dry run complete. Remove --dry-run to insert skills. ===');
    return;
  }

  // Insert skills
  console.log('--- Inserting Skills ---\n');
  const results: Array<{ name: string; skillId: string; slug: string }> = [];
  const skipped: Array<{ name: string; slug: string; reason: string }> = [];
  const errors: Array<{ name: string; error: string }> = [];

  for (let i = 0; i < payloads.length; i++) {
    const skill = SEED_SKILLS[i]!;
    const payload = payloads[i]!;

    process.stdout.write(`[${i + 1}/${payloads.length}] ${skill.name} (${skill.priceSats.toLocaleString()} sats)... `);

    try {
      // Duplicate detection — skip if slug already exists (unless --force)
      if (!force) {
        const existing = await getSkillBySlug(skill.slug);
        if (existing) {
          console.log(`SKIPPED (slug "${skill.slug}" already exists, id=${existing.id})`);
          skipped.push({ name: skill.name, slug: skill.slug, reason: `slug already exists (id=${existing.id})` });
          continue;
        }
      }

      const created = await createSkill(payload);
      results.push({ name: skill.name, skillId: created.id, slug: created.slug });
      console.log(`OK (id=${created.id})`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ name: skill.name, error: message });
      console.log(`FAILED: ${message}`);
    }

    // Brief pause between inserts to avoid connection saturation
    if (i < payloads.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  // Summary
  console.log('\n=== Summary ===\n');
  console.log(`Inserted: ${results.length}/${payloads.length}`);
  console.log(`Skipped:  ${skipped.length}/${payloads.length}`);
  console.log(`Failed:   ${errors.length}/${payloads.length}`);

  if (results.length > 0) {
    console.log('\nCreated skills:');
    for (const r of results) {
      console.log(`  - ${r.skillId}: ${r.name} (slug: ${r.slug})`);
    }
  }

  if (skipped.length > 0) {
    console.log('\nSkipped skills (already exist):');
    for (const s of skipped) {
      console.log(`  - ${s.name}: ${s.reason}`);
    }
  }

  if (errors.length > 0) {
    console.log('\nFailed skills:');
    for (const e of errors) {
      console.log(`  - ${e.name}: ${e.error}`);
    }
    process.exit(1);
  }

  if (results.length === 0 && skipped.length === payloads.length) {
    console.log('\nAll skills already exist. Run with --force to re-insert.');
    return;
  }

  console.log('\nAll seed skills inserted successfully.');
  console.log('Next steps:');
  console.log('  1. Verify in DB: SELECT id, name, slug, price_sats FROM skills ORDER BY created_at;');
  console.log('  2. Test public listing: GET /v1/public/skills');
  console.log('  3. Wire skill detail pages on percival-labs.ai/skills/:slug');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

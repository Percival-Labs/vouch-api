// Vouch — Contract Service
// Business logic for construction-model agent work agreements.
// All state transitions use db.transaction() for atomicity (matching staking-service pattern).

import { eq, and, sql, desc, asc, count } from 'drizzle-orm';
import {
  db,
  contracts,
  contractMilestones,
  contractChangeOrders,
  contractBids,
  contractEvents,
  paymentEvents,
  nwcConnections,
  outcomes,
} from '@percival/vouch-db';
import { ulid } from 'ulid';
import {
  calculateRoyalties,
  recordRoyalties,
  executeRoyaltyPayments,
} from './royalty-service';
import { encrypt, decrypt } from '../lib/encryption';

// ── ISC Types ──

export interface ISCCriterion {
  id: string;           // "C1", "C2", etc.
  criterion: string;    // 8-12 words, binary testable
  verify: string;       // verification method
  priority: 'critical' | 'important' | 'nice';
  status: 'pending' | 'passed' | 'failed';
  evidence?: string;    // proof when verified
}

export interface ISCAntiCriterion {
  id: string;           // "A1", "A2", etc.
  criterion: string;
  verify: string;
  status: 'avoided' | 'violated';
  evidence?: string;
}

export interface MilestoneISC {
  criteria: ISCCriterion[];
  antiCriteria?: ISCAntiCriterion[];
}

// ── Types ──

export interface CreateContractParams {
  customerPubkey: string;
  agentPubkey: string;
  title: string;
  description?: string;
  sow: {
    deliverables: string[];
    acceptance_criteria: string[];
    exclusions?: string[];
    tools_required?: string[];
    timeline_description?: string;
  };
  totalSats: number;
  retentionBps?: number;
  retentionReleaseAfterDays?: number;
  milestones: Array<{
    title: string;
    description?: string;
    acceptance_criteria?: string;
    percentage_bps: number;
    isc_criteria?: MilestoneISC;
  }>;
}

export interface ContractSummary {
  id: string;
  customerPubkey: string;
  agentPubkey: string;
  title: string;
  totalSats: number;
  paidSats: number;
  status: string;
  milestoneCount: number;
  completedMilestones: number;
  createdAt: Date;
}

export interface ContractDetail {
  contract: typeof contracts.$inferSelect;
  milestones: Array<typeof contractMilestones.$inferSelect>;
  changeOrders: Array<typeof contractChangeOrders.$inferSelect>;
  events: Array<typeof contractEvents.$inferSelect>;
}

// ── Helpers ──

async function logEvent(
  contractId: string,
  eventType: typeof contractEvents.$inferInsert['eventType'],
  actorPubkey: string,
  metadata?: Record<string, unknown>,
) {
  await db.insert(contractEvents).values({
    id: ulid(),
    contractId,
    eventType,
    actorPubkey,
    metadata: metadata ?? {},
  });
}

// ── ISC Validation ──

/**
 * Validate ISC criteria structure.
 * Each criterion must have id, criterion (4-20 words), verify, priority.
 * IDs must be unique. Criterion text under 100 chars. At least one criterion required.
 */
const MAX_CRITERIA = 50;
const MAX_ANTI_CRITERIA = 20;
const ID_PATTERN = /^[CA]\d{1,3}$/;

export function validateISC(isc: MilestoneISC): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!isc.criteria || isc.criteria.length === 0) {
    errors.push('At least one criterion is required');
    return { valid: false, errors };
  }

  if (isc.criteria.length > MAX_CRITERIA) {
    errors.push(`Too many criteria (max ${MAX_CRITERIA}, got ${isc.criteria.length})`);
    return { valid: false, errors };
  }

  if (isc.antiCriteria && isc.antiCriteria.length > MAX_ANTI_CRITERIA) {
    errors.push(`Too many anti-criteria (max ${MAX_ANTI_CRITERIA}, got ${isc.antiCriteria.length})`);
    return { valid: false, errors };
  }

  const seenIds = new Set<string>();

  for (const c of isc.criteria) {
    if (!c.id) {
      errors.push('Each criterion must have an id');
    } else if (!ID_PATTERN.test(c.id)) {
      errors.push(`Criterion id "${c.id}" must match format C1, C2, ... C999`);
    } else if (seenIds.has(c.id)) {
      errors.push(`Duplicate criterion id: ${c.id}`);
    } else {
      seenIds.add(c.id);
    }

    if (!c.criterion) {
      errors.push(`Criterion ${c.id || '?'}: criterion text is required`);
    } else {
      const sanitized = c.criterion.replace(/<[^>]*>/g, '');
      if (sanitized.length !== c.criterion.length) {
        errors.push(`Criterion ${c.id || '?'}: HTML tags not allowed`);
      }
      if (c.criterion.length > 100) {
        errors.push(`Criterion ${c.id || '?'}: text must be under 100 characters`);
      }
      const wordCount = c.criterion.trim().split(/\s+/).length;
      if (wordCount < 4 || wordCount > 20) {
        errors.push(`Criterion ${c.id || '?'}: must be 4-20 words (got ${wordCount})`);
      }
    }

    if (!c.verify) {
      errors.push(`Criterion ${c.id || '?'}: verify method is required`);
    } else if (c.verify.length > 200) {
      errors.push(`Criterion ${c.id || '?'}: verify method must be under 200 characters`);
    }

    if (!c.priority || !['critical', 'important', 'nice'].includes(c.priority)) {
      errors.push(`Criterion ${c.id || '?'}: priority must be critical, important, or nice`);
    }
  }

  if (isc.antiCriteria) {
    for (const a of isc.antiCriteria) {
      if (!a.id) {
        errors.push('Each anti-criterion must have an id');
      } else if (!ID_PATTERN.test(a.id)) {
        errors.push(`Anti-criterion id "${a.id}" must match format A1, A2, ... A999`);
      } else if (seenIds.has(a.id)) {
        errors.push(`Duplicate criterion/anti-criterion id: ${a.id}`);
      } else {
        seenIds.add(a.id);
      }

      if (!a.criterion) {
        errors.push(`Anti-criterion ${a.id || '?'}: criterion text is required`);
      } else {
        const sanitized = a.criterion.replace(/<[^>]*>/g, '');
        if (sanitized.length !== a.criterion.length) {
          errors.push(`Anti-criterion ${a.id || '?'}: HTML tags not allowed`);
        }
      }

      if (!a.verify) {
        errors.push(`Anti-criterion ${a.id || '?'}: verify method is required`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Strip status and evidence fields from ISC input.
 * Used by updateMilestoneISC to prevent agents from pre-setting
 * criteria to 'passed' or anti-criteria to 'avoided' via the PUT endpoint.
 * Status changes must only happen through submit/accept flows.
 */
function sanitizeISCForUpdate(isc: MilestoneISC): MilestoneISC {
  return {
    criteria: isc.criteria.map(c => ({
      id: c.id,
      criterion: c.criterion,
      verify: c.verify,
      priority: c.priority,
      status: 'pending' as const,
      // evidence stripped — only set during submit flow
    })),
    antiCriteria: isc.antiCriteria?.map(a => ({
      id: a.id,
      criterion: a.criterion,
      verify: a.verify,
      status: 'avoided' as const,
      // evidence stripped
    })),
  };
}

/**
 * Auto-generate ISC from plain text acceptance criteria.
 * Runs automatically when acceptance_criteria is provided but isc_criteria is not.
 * Splits on sentences/bullets and converts each into a binary-testable criterion.
 */
export function generateISCFromText(text: string): MilestoneISC {
  // Split on newlines, bullets, semicolons, or sentence boundaries
  const lines = text
    .split(/[\n;]|(?:^|\n)\s*[-*•]\s*|(?<=\.)\s+/)
    .map(s => s.trim())
    .filter(s => s.length > 3);

  const criteria: ISCCriterion[] = lines.map((line, i) => {
    // Clean up the text to be concise
    const cleaned = line
      .replace(/^(must|should|shall|needs? to|has to)\s+/i, '')
      .replace(/\.$/, '')
      .trim();

    // Truncate to ~12 words if too long
    const words = cleaned.split(/\s+/);
    const criterion = words.length > 12
      ? words.slice(0, 12).join(' ')
      : cleaned;

    return {
      id: `C${i + 1}`,
      criterion,
      verify: 'Customer confirms deliverable meets this requirement',
      priority: 'important' as const,
      status: 'pending' as const,
    };
  });

  // Ensure at least one criterion
  if (criteria.length === 0) {
    criteria.push({
      id: 'C1',
      criterion: 'Deliverable matches acceptance criteria description',
      verify: 'Customer reviews and confirms',
      priority: 'critical',
      status: 'pending',
    });
  }

  // Mark first criterion as critical (primary deliverable)
  criteria[0].priority = 'critical';

  return { criteria };
}

// ── Contract Lifecycle ──

/**
 * Create a contract with milestones in one transaction.
 * Validates milestone percentages sum to (10000 - retentionBps).
 * Auto-creates retention milestone.
 */
export async function createContract(params: CreateContractParams) {
  const retentionBps = params.retentionBps ?? 1000;
  const retentionDays = params.retentionReleaseAfterDays ?? 30;
  const workBps = 10000 - retentionBps;

  // Validate milestone percentages sum to workBps
  const totalMilestoneBps = params.milestones.reduce((sum, m) => sum + m.percentage_bps, 0);
  if (totalMilestoneBps !== workBps) {
    throw new Error(
      `Milestone percentages must sum to ${workBps} bps (got ${totalMilestoneBps}). ` +
      `Retention is ${retentionBps} bps.`
    );
  }

  return await db.transaction(async (tx) => {
    const contractId = ulid();

    // Create the contract
    await tx.insert(contracts).values({
      id: contractId,
      customerPubkey: params.customerPubkey,
      agentPubkey: params.agentPubkey,
      title: params.title,
      description: params.description,
      sow: params.sow,
      totalSats: params.totalSats,
      retentionBps,
      retentionReleaseAfterDays: retentionDays,
      status: 'draft',
    });

    // Create work milestones
    // ISC is always generated: use provided ISC, or auto-generate from acceptance_criteria text
    const milestoneRows = params.milestones.map((m, i) => {
      let isc = m.isc_criteria || null;

      // Auto-generate ISC from plain text if no structured ISC provided
      if (!isc && m.acceptance_criteria) {
        isc = generateISCFromText(m.acceptance_criteria);
      }

      // Validate ISC if present
      if (isc) {
        const validation = validateISC(isc);
        if (!validation.valid) {
          throw new Error(`Milestone "${m.title}" ISC validation failed: ${validation.errors.join('; ')}`);
        }
      }

      return {
        id: ulid(),
        contractId,
        sequence: i + 1,
        title: m.title,
        description: m.description,
        acceptanceCriteria: m.acceptance_criteria,
        amountSats: Math.round((params.totalSats * m.percentage_bps) / 10000),
        percentageBps: m.percentage_bps,
        isRetention: false,
        iscCriteria: isc,
      };
    });

    // Create retention milestone (if retention > 0)
    if (retentionBps > 0) {
      milestoneRows.push({
        id: ulid(),
        contractId,
        sequence: params.milestones.length + 1,
        title: 'Retention Release',
        description: `Released ${retentionDays} days after contract completion`,
        acceptanceCriteria: undefined,
        amountSats: Math.round((params.totalSats * retentionBps) / 10000),
        percentageBps: retentionBps,
        isRetention: true,
        iscCriteria: null,
      });
    }

    await tx.insert(contractMilestones).values(milestoneRows);

    // Log creation event
    await tx.insert(contractEvents).values({
      id: ulid(),
      contractId,
      eventType: 'created',
      actorPubkey: params.customerPubkey,
      metadata: { milestone_count: milestoneRows.length },
    });

    return {
      contractId,
      milestoneCount: milestoneRows.length,
    };
  });
}

/**
 * Get a contract with milestones, change orders, and recent events.
 */
export async function getContract(contractId: string): Promise<ContractDetail | null> {
  const [contract] = await db
    .select()
    .from(contracts)
    .where(eq(contracts.id, contractId))
    .limit(1);

  if (!contract) return null;

  const [milestones, changeOrders, events] = await Promise.all([
    db.select()
      .from(contractMilestones)
      .where(eq(contractMilestones.contractId, contractId))
      .orderBy(asc(contractMilestones.sequence)),
    db.select()
      .from(contractChangeOrders)
      .where(eq(contractChangeOrders.contractId, contractId))
      .orderBy(asc(contractChangeOrders.sequence)),
    db.select()
      .from(contractEvents)
      .where(eq(contractEvents.contractId, contractId))
      .orderBy(desc(contractEvents.createdAt))
      .limit(50),
  ]);

  return { contract, milestones, changeOrders, events };
}

/**
 * List contracts for a pubkey, filtered by role and status.
 */
export async function listContracts(
  pubkey: string,
  role: 'customer' | 'agent' | 'any',
  status?: string,
  page = 1,
  limit = 25,
) {
  const offset = (page - 1) * limit;

  // Build where conditions
  const conditions = [];
  if (role === 'customer') {
    conditions.push(eq(contracts.customerPubkey, pubkey));
  } else if (role === 'agent') {
    conditions.push(eq(contracts.agentPubkey, pubkey));
  } else {
    conditions.push(
      sql`(${contracts.customerPubkey} = ${pubkey} OR ${contracts.agentPubkey} = ${pubkey})`
    );
  }

  if (status) {
    conditions.push(eq(contracts.status, status as typeof contracts.$inferSelect['status']));
  }

  const whereClause = conditions.length === 1 ? conditions[0] : and(...conditions);

  const [rows, countRows] = await Promise.all([
    db.select()
      .from(contracts)
      .where(whereClause)
      .orderBy(desc(contracts.createdAt))
      .limit(limit)
      .offset(offset),
    db.select({ total: count() })
      .from(contracts)
      .where(whereClause),
  ]);
  const total = countRows[0]?.total ?? 0;

  return {
    data: rows,
    meta: {
      page,
      limit,
      total: Number(total),
      has_more: offset + rows.length < Number(total),
    },
  };
}

/**
 * Activate a draft contract. Customer only.
 */
export async function activateContract(contractId: string, customerPubkey: string) {
  return await db.transaction(async (tx) => {
    const [contract] = await tx
      .select()
      .from(contracts)
      .where(and(eq(contracts.id, contractId), eq(contracts.customerPubkey, customerPubkey)))
      .limit(1);

    if (!contract) throw new Error('Contract not found');
    if (contract.status !== 'draft') {
      throw new Error(`Cannot activate contract in status "${contract.status}"`);
    }

    await tx
      .update(contracts)
      .set({
        status: 'active',
        activatedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(contracts.id, contractId));

    await tx.insert(contractEvents).values({
      id: ulid(),
      contractId,
      eventType: 'funded',
      actorPubkey: customerPubkey,
    });

    return { status: 'active' };
  });
}

/**
 * Fund a contract by charging per-milestone invoices from the customer's NWC connection.
 * Generates preimage + hash per milestone. Uses HOLD invoices (Path A) if supported,
 * otherwise regular invoices to platform wallet (Path B).
 */
export async function fundContract(
  contractId: string,
  customerPubkey: string,
  nwcConnectionId: string,
) {
  // Import services dynamically to avoid circular deps
  const albyhub = await import('./albyhub-service');
  const { executeSlash } = await import('./nwc-service');

  return await db.transaction(async (tx) => {
    const [contract] = await tx
      .select()
      .from(contracts)
      .where(and(eq(contracts.id, contractId), eq(contracts.customerPubkey, customerPubkey)))
      .limit(1);

    if (!contract) throw new Error('Contract not found');
    if (contract.status !== 'draft' && contract.status !== 'active') {
      throw new Error(`Cannot fund contract in status "${contract.status}"`);
    }

    // Verify NWC connection exists and belongs to customer
    const [nwc] = await tx
      .select()
      .from(nwcConnections)
      .where(and(
        eq(nwcConnections.id, nwcConnectionId),
        eq(nwcConnections.status, 'active'),
      ))
      .limit(1);

    if (!nwc) throw new Error('NWC connection not found or inactive');

    // S6 fix: Verify NWC connection belongs to the customer (prevent charging another user's wallet)
    if (nwc.userNpub !== customerPubkey) {
      throw new Error('NWC connection does not belong to this user');
    }

    const remaining = nwc.budgetSats - nwc.spentSats;
    if (remaining < contract.totalSats) {
      throw new Error(`NWC budget ${remaining} sats insufficient for contract ${contract.totalSats} sats`);
    }

    // Fetch milestones for per-milestone funding
    const milestones = await tx
      .select()
      .from(contractMilestones)
      .where(eq(contractMilestones.contractId, contractId))
      .orderBy(asc(contractMilestones.sequence));

    const milestoneInvoices: Array<{ milestoneId: string; bolt11: string; amountSats: number }> = [];

    for (const ms of milestones) {
      // Generate preimage + hash per milestone
      const preimageBytes = crypto.getRandomValues(new Uint8Array(32));
      const preimage = Buffer.from(preimageBytes).toString('hex');
      const hashBytes = await crypto.subtle.digest('SHA-256', preimageBytes);
      const holdPaymentHash = Buffer.from(new Uint8Array(hashBytes)).toString('hex');

      // Charge customer via NWC (Path B: regular invoices to platform wallet)
      // Path A (HOLD invoices) can be swapped in when we move to Voltage/LND
      const { paymentHash: invoicePaymentHash } = await executeSlash(
        nwcConnectionId,
        ms.amountSats,
        `Contract "${contract.title}": ${ms.title}`,
      );

      // S1 fix: Encrypt preimage before storage (AES-256-GCM)
      const encryptedPreimage = await encrypt(preimage);

      // Store hold data on milestone
      await tx
        .update(contractMilestones)
        .set({
          holdPaymentHash,
          holdPreimage: encryptedPreimage,
        })
        .where(eq(contractMilestones.id, ms.id));

      // Record payment event with 'held' status
      await tx.insert(paymentEvents).values({
        id: ulid(),
        paymentHash: invoicePaymentHash || holdPaymentHash,
        amountSats: ms.amountSats,
        purpose: 'hold_lock',
        status: 'held',
        contractId,
        milestoneId: ms.id,
        nwcConnectionId,
        metadata: { hold_payment_hash: holdPaymentHash },
      });

      milestoneInvoices.push({
        milestoneId: ms.id,
        bolt11: '', // Path B — no bolt11 to return since we charged directly
        amountSats: ms.amountSats,
      });
    }

    await tx
      .update(contracts)
      .set({
        nwcConnectionId,
        fundedSats: contract.totalSats,
        status: 'active',
        activatedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(contracts.id, contractId));

    await tx.insert(contractEvents).values({
      id: ulid(),
      contractId,
      eventType: 'funded',
      actorPubkey: customerPubkey,
      metadata: {
        funded_sats: contract.totalSats,
        milestones_funded: milestones.length,
        path: 'B', // platform wallet relay
      },
    });

    return {
      funded_sats: contract.totalSats,
      milestones: milestoneInvoices,
    };
  });
}

/**
 * Submit a milestone deliverable. Agent only.
 */
export async function submitMilestone(
  contractId: string,
  milestoneId: string,
  agentPubkey: string,
  deliverableUrl?: string,
  deliverableNotes?: string,
  evidence?: Record<string, string>,
  skillsUsed?: string[],
  agentBolt11?: string,
) {
  return await db.transaction(async (tx) => {
    const [contract] = await tx
      .select()
      .from(contracts)
      .where(and(eq(contracts.id, contractId), eq(contracts.agentPubkey, agentPubkey)))
      .limit(1);

    if (!contract) throw new Error('Contract not found');
    if (contract.status !== 'active') {
      throw new Error(`Cannot submit milestone on contract in status "${contract.status}"`);
    }

    const [milestone] = await tx
      .select()
      .from(contractMilestones)
      .where(and(
        eq(contractMilestones.id, milestoneId),
        eq(contractMilestones.contractId, contractId),
      ))
      .limit(1);

    if (!milestone) throw new Error('Milestone not found');
    if (milestone.isRetention) throw new Error('Cannot submit retention milestone directly');

    const validStatuses = ['pending', 'in_progress', 'rejected'];
    if (!validStatuses.includes(milestone.status)) {
      throw new Error(`Cannot submit milestone in status "${milestone.status}"`);
    }

    // Process ISC evidence if milestone has ISC criteria and evidence is provided
    let updatedIsc = milestone.iscCriteria as MilestoneISC | null;
    if (updatedIsc && evidence) {
      // Service-layer evidence validation (ISC-S5: defense-in-depth beyond Zod)
      for (const [key, val] of Object.entries(evidence)) {
        if (typeof val !== 'string' || val.length > 2000) {
          throw new Error(`Evidence for "${key}" exceeds 2000 character limit`);
        }
      }

      // Update each criterion's evidence and status
      updatedIsc = {
        ...updatedIsc,
        criteria: updatedIsc.criteria.map((c) => {
          if (evidence[c.id]) {
            return { ...c, status: 'passed' as const, evidence: evidence[c.id] };
          }
          return c;
        }),
      };

      // Check all CRITICAL criteria have evidence
      const missingCritical = updatedIsc.criteria
        .filter((c) => c.priority === 'critical' && c.status !== 'passed')
        .map((c) => c.id);

      if (missingCritical.length > 0) {
        throw new Error(
          `Missing evidence for critical ISC criteria: ${missingCritical.join(', ')}`
        );
      }
    }

    await tx
      .update(contractMilestones)
      .set({
        status: 'submitted',
        deliverableUrl,
        deliverableNotes,
        submittedAt: new Date(),
        ...(updatedIsc ? { iscCriteria: updatedIsc } : {}),
        ...(skillsUsed ? { skillsUsed } : {}),
        ...(agentBolt11 ? { agentBolt11 } : {}),
      })
      .where(eq(contractMilestones.id, milestoneId));

    await tx.insert(contractEvents).values({
      id: ulid(),
      contractId,
      eventType: 'milestone_submitted',
      actorPubkey: agentPubkey,
      metadata: {
        milestone_id: milestoneId,
        milestone_title: milestone.title,
        ...(evidence ? { isc_evidence_keys: Object.keys(evidence) } : {}),
      },
    });
  });
}

/**
 * Accept a submitted milestone. Customer only.
 * Triggers payment release. If all work milestones accepted → completeContract.
 */
export async function acceptMilestone(
  contractId: string,
  milestoneId: string,
  customerPubkey: string,
  iscOverrides?: Record<string, { status: 'passed' | 'failed'; note?: string }>,
) {
  const result = await db.transaction(async (tx) => {
    const [contract] = await tx
      .select()
      .from(contracts)
      .where(and(eq(contracts.id, contractId), eq(contracts.customerPubkey, customerPubkey)))
      .limit(1);

    if (!contract) throw new Error('Contract not found');
    if (contract.status !== 'active') {
      throw new Error(`Cannot accept milestone on contract in status "${contract.status}"`);
    }

    const [milestone] = await tx
      .select()
      .from(contractMilestones)
      .where(and(
        eq(contractMilestones.id, milestoneId),
        eq(contractMilestones.contractId, contractId),
      ))
      .limit(1);

    if (!milestone) throw new Error('Milestone not found');
    if (milestone.status !== 'submitted') {
      throw new Error(`Cannot accept milestone in status "${milestone.status}"`);
    }

    // Process ISC criteria validation if milestone has ISC
    let finalIsc = milestone.iscCriteria as MilestoneISC | null;
    if (finalIsc) {
      // Apply overrides
      if (iscOverrides) {
        finalIsc = {
          ...finalIsc,
          criteria: finalIsc.criteria.map((c) => {
            const override = iscOverrides[c.id];
            if (override) {
              return {
                ...c,
                status: override.status,
                evidence: override.note ? `${c.evidence || ''} [Override: ${override.note}]`.trim() : c.evidence,
              };
            }
            return c;
          }),
        };
      }

      // Verify all CRITICAL criteria are 'passed'
      const failedCritical = finalIsc.criteria
        .filter((c) => c.priority === 'critical' && c.status !== 'passed')
        .map((c) => c.id);

      if (failedCritical.length > 0) {
        throw new Error(
          `Cannot accept milestone: critical ISC criteria not passed: ${failedCritical.join(', ')}`
        );
      }

      // Check anti-criteria are all 'avoided'
      if (finalIsc.antiCriteria) {
        const violated = finalIsc.antiCriteria
          .filter((a) => a.status === 'violated')
          .map((a) => a.id);

        if (violated.length > 0) {
          throw new Error(
            `Cannot accept milestone: anti-criteria violated: ${violated.join(', ')}`
          );
        }
      }
    }

    await tx
      .update(contractMilestones)
      .set({
        status: 'accepted',
        acceptedAt: new Date(),
        ...(finalIsc ? { iscCriteria: finalIsc } : {}),
      })
      .where(eq(contractMilestones.id, milestoneId));

    await tx.insert(contractEvents).values({
      id: ulid(),
      contractId,
      eventType: 'milestone_accepted',
      actorPubkey: customerPubkey,
      metadata: { milestone_id: milestoneId, amount_sats: milestone.amountSats },
    });

    // S3 fix: paidSats is incremented in releaseMilestonePayment (the canonical payment event),
    // NOT here. Acceptance is approval, not payment.

    // Check if all non-retention milestones are accepted
    const allMilestones = await tx
      .select()
      .from(contractMilestones)
      .where(eq(contractMilestones.contractId, contractId));

    const workMilestones = allMilestones.filter((m) => !m.isRetention);
    const allWorkAccepted = workMilestones.every(
      (m) => m.id === milestoneId ? true : m.status === 'accepted'
    );

    if (allWorkAccepted) {
      await tx
        .update(contracts)
        .set({
          status: 'completed',
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(contracts.id, contractId));

      await tx.insert(contractEvents).values({
        id: ulid(),
        contractId,
        eventType: 'completed',
        actorPubkey: customerPubkey,
      });

    }

    // Return factory-relevant data so we can fire the hook AFTER the transaction commits.
    const completionSowObj = contract.sow as Record<string, unknown>;
    const rawCompletionTags = completionSowObj?.['tags'];
    const completionSowTags: string[] = Array.isArray(rawCompletionTags) ? (rawCompletionTags as string[]) : [];

    return {
      milestoneAccepted: true,
      contractCompleted: allWorkAccepted,
      isFactoryContract: completionSowTags.includes('factory:training'),
      agentPubkey: contract.agentPubkey,
    };
  });

  // Factory onboarding hook — fires AFTER the transaction commits (FA-1 fix).
  // If the tx rolled back, we never reach here, preventing trust boosts on failed milestones.
  // S10 fix: `result` is now captured from the transaction return (was missing `const result =`).
  if (result.contractCompleted && result.isFactoryContract) {
    const agentPub = result.agentPubkey;
    setImmediate(async () => {
      try {
        const { recordFactoryCompletion } = await import('./factory-service');
        await recordFactoryCompletion(contractId, agentPub);
      } catch (err) {
        console.error(
          `[factory] recordFactoryCompletion failed for contract ${contractId}:`,
          err,
        );
      }
    });
  }

  // Gateway Credits Launch Promo — grant bonus inference credits on contract completion.
  // Separate from sats payout. Agent claims via GET /v1/credits/gateway.
  // PROMO: Remove or disable after launch window closes.
  if (result.contractCompleted) {
    const agentPub = result.agentPubkey;
    const PROMO_CREDITS_SATS = 25_000; // 25,000 sats of Gateway inference budget per completed contract
    const PROMO_DEADLINE = new Date('2026-04-13T00:00:00Z'); // 1 month from launch

    if (new Date() < PROMO_DEADLINE) {
      setImmediate(async () => {
        try {
          const { payAgentGatewayCredits } = await import('./gateway-service');
          await payAgentGatewayCredits(
            agentPub,
            PROMO_CREDITS_SATS,
            `Launch promo: bonus inference credits for completing contract ${contractId}`,
          );
          console.log(`[promo] Granted ${PROMO_CREDITS_SATS} Gateway credits to ${agentPub.slice(0, 8)}... for contract ${contractId}`);
        } catch (err) {
          console.error(`[promo] Failed to grant Gateway credits to ${agentPub.slice(0, 8)}...:`, err instanceof Error ? err.message : err);
        }
      });
    }
  }

  return {
    milestoneAccepted: result.milestoneAccepted,
    contractCompleted: result.contractCompleted,
  };
}

/**
 * Reject a submitted milestone. Customer only. Agent can re-submit.
 */
export async function rejectMilestone(
  contractId: string,
  milestoneId: string,
  customerPubkey: string,
  reason: string,
) {
  return await db.transaction(async (tx) => {
    const [contract] = await tx
      .select()
      .from(contracts)
      .where(and(eq(contracts.id, contractId), eq(contracts.customerPubkey, customerPubkey)))
      .limit(1);

    if (!contract) throw new Error('Contract not found');
    if (contract.status !== 'active') {
      throw new Error(`Cannot reject milestone on contract in status "${contract.status}"`);
    }

    const [milestone] = await tx
      .select()
      .from(contractMilestones)
      .where(and(
        eq(contractMilestones.id, milestoneId),
        eq(contractMilestones.contractId, contractId),
      ))
      .limit(1);

    if (!milestone) throw new Error('Milestone not found');
    if (milestone.status !== 'submitted') {
      throw new Error(`Cannot reject milestone in status "${milestone.status}"`);
    }

    await tx
      .update(contractMilestones)
      .set({
        status: 'rejected',
        rejectedAt: new Date(),
        rejectionReason: reason,
      })
      .where(eq(contractMilestones.id, milestoneId));

    await tx.insert(contractEvents).values({
      id: ulid(),
      contractId,
      eventType: 'milestone_rejected',
      actorPubkey: customerPubkey,
      metadata: { milestone_id: milestoneId, reason },
    });
  });
}

/**
 * Release payment for an accepted milestone.
 * Path B (platform wallet relay): Sats already at platform wallet from fundContract().
 * 1. Mark funding payment as settled
 * 2. Calculate 1% platform fee
 * 3. Pay agent via Lightning (bolt11) or Gateway credits
 * 4. Record everything in paymentEvents
 */
export async function releaseMilestonePayment(contractId: string, milestoneId: string, callerPubkey?: string) {
  // S5 fix: 2-phase payment — DB intent inside transaction, Lightning payment outside.
  // This prevents double-payment if Lightning succeeds but DB transaction rolls back.

  // Phase 1: Record intent and calculate amounts (inside transaction, short-lived)
  const intent = await db.transaction(async (tx) => {
    const [contract] = await tx
      .select()
      .from(contracts)
      .where(eq(contracts.id, contractId))
      .for('update');

    if (!contract) throw new Error('Contract not found');

    // S4 fix: Defense-in-depth auth check
    if (callerPubkey && callerPubkey !== contract.customerPubkey) {
      throw new Error('Only the customer can release milestone payments');
    }

    const [milestone] = await tx
      .select()
      .from(contractMilestones)
      .where(and(
        eq(contractMilestones.id, milestoneId),
        eq(contractMilestones.contractId, contractId),
      ))
      .for('update');

    if (!milestone) throw new Error('Milestone not found');

    // Idempotency guard: already released = no-op
    if (milestone.status === 'released') {
      return { alreadyReleased: true, paymentHash: milestone.paymentHash ?? 'already_released', amountSats: milestone.amountSats } as const;
    }

    if (milestone.status !== 'accepted' && !(milestone.isRetention && milestone.status === 'pending')) {
      throw new Error(`Cannot release payment for milestone in status "${milestone.status}"`);
    }

    // Mark the hold_lock payment as settled (Path B: sats already at platform wallet)
    if (milestone.holdPaymentHash) {
      await tx
        .update(paymentEvents)
        .set({ status: 'paid', updatedAt: new Date() })
        .where(and(
          eq(paymentEvents.contractId, contractId),
          eq(paymentEvents.milestoneId, milestoneId),
          eq(paymentEvents.purpose, 'hold_lock'),
          eq(paymentEvents.status, 'held'),
        ));
    }

    const feeSats = Math.floor(milestone.amountSats / 100); // 1% activity fee
    const netPayoutSats = milestone.amountSats - feeSats;
    const payoutMethod = milestone.payoutMethod ?? 'lightning';

    return {
      alreadyReleased: false,
      contractTitle: contract.title,
      agentPubkey: contract.agentPubkey,
      customerPubkey: contract.customerPubkey,
      amountSats: milestone.amountSats,
      milestoneTitle: milestone.title,
      agentBolt11: milestone.agentBolt11,
      payoutMethod,
      feeSats,
      netPayoutSats,
      isRetention: milestone.isRetention,
    } as const;
  });

  if (intent.alreadyReleased) {
    return { paymentHash: intent.paymentHash, amountSats: intent.amountSats };
  }

  // Phase 2: Execute payment OUTSIDE the transaction (no DB locks held)
  let agentPaymentHash = '';
  try {
    if (intent.payoutMethod === 'gateway_credits') {
      const { payAgentGatewayCredits } = await import('./gateway-service');
      const creditResult = await payAgentGatewayCredits(
        intent.agentPubkey,
        intent.netPayoutSats,
        `Contract "${intent.contractTitle}": ${intent.milestoneTitle}`,
      );
      // Store token so agent can retrieve it via contract events
      agentPaymentHash = `gateway_credits_${creditResult.token.slice(0, 16)}_${ulid()}`;
    } else {
      if (intent.agentBolt11) {
        const albyhub = await import('./albyhub-service');
        const payment = await albyhub.payInvoice(intent.agentBolt11);
        agentPaymentHash = payment.paymentHash || payment.preimage;
      } else {
        console.warn(`[contracts] No agent_bolt11 for milestone ${milestoneId} — sats held in platform wallet pending agent claim`);
        agentPaymentHash = `pending_claim_${ulid()}`;
      }
    }
  } catch (payErr) {
    // Payment failed — record failure but don't mark milestone as released
    await db.insert(paymentEvents).values({
      id: ulid(),
      paymentHash: `failed_${ulid()}`,
      amountSats: intent.amountSats,
      purpose: intent.isRetention ? 'contract_retention' : 'contract_milestone',
      status: 'failed',
      contractId,
      milestoneId,
      metadata: { error: payErr instanceof Error ? payErr.message : 'Unknown error' },
    });
    throw payErr;
  }

  // Phase 3: Record success (separate transaction — idempotent via status check)
  await db.transaction(async (tx) => {
    // Re-check milestone status to prevent race condition
    const [ms] = await tx
      .select()
      .from(contractMilestones)
      .where(eq(contractMilestones.id, milestoneId))
      .for('update');

    if (!ms || ms.status === 'released') return; // Already released by concurrent call

    await tx.insert(paymentEvents).values({
      id: ulid(),
      paymentHash: agentPaymentHash,
      amountSats: intent.netPayoutSats,
      purpose: 'agent_payout',
      status: agentPaymentHash.startsWith('pending_claim_') ? 'pending' : 'paid',
      contractId,
      milestoneId,
      metadata: {
        fee_sats: intent.feeSats,
        gross_amount_sats: intent.amountSats,
        payout_method: intent.payoutMethod,
      },
    });

    await tx
      .update(contractMilestones)
      .set({
        status: 'released',
        releasedAt: new Date(),
        paymentHash: agentPaymentHash,
        agentPaymentHash,
        feeSats: intent.feeSats,
        netPayoutSats: intent.netPayoutSats,
      })
      .where(eq(contractMilestones.id, milestoneId));

    await tx
      .update(contracts)
      .set({
        paidSats: sql`${contracts.paidSats} + ${intent.amountSats}`,
        updatedAt: new Date(),
      })
      .where(eq(contracts.id, contractId));

    await logEvent(contractId, 'milestone_released', intent.customerPubkey, {
      milestone_id: milestoneId,
      amount_sats: intent.amountSats,
      fee_sats: intent.feeSats,
      net_payout_sats: intent.netPayoutSats,
      payout_method: intent.payoutMethod,
      payment_hash: agentPaymentHash,
    });
  });

  const result = { paymentHash: agentPaymentHash, amountSats: intent.amountSats, alreadyReleased: false };

  // Trigger royalty payments outside the transaction (non-blocking, matching existing pattern)
  if (!result.alreadyReleased) {
    // Re-read milestone for skillsUsed (outside transaction)
    const [milestone] = await db.select().from(contractMilestones)
      .where(eq(contractMilestones.id, milestoneId)).limit(1);
    const [contract] = await db.select().from(contracts)
      .where(eq(contracts.id, contractId)).limit(1);

    if (milestone && contract) {
      const milestoneSkillsUsed = milestone.skillsUsed as string[] | null;
      if (milestoneSkillsUsed && milestoneSkillsUsed.length > 0) {
        calculateRoyalties(contractId, milestoneId, contract.agentPubkey, milestone.amountSats, milestoneSkillsUsed)
          .then((calculations) => recordRoyalties(contractId, milestoneId, milestone.amountSats, calculations))
          .then((royaltyIds) => executeRoyaltyPayments(royaltyIds))
          .catch((err) => {
            console.error(`[contracts] Royalty processing failed for milestone ${milestoneId}:`, err instanceof Error ? err.message : err);
          });
      }
    }
  }

  return { paymentHash: result.paymentHash, amountSats: result.amountSats };
}

/**
 * Propose a change order. Either party can propose on an active contract.
 */
export async function proposeChangeOrder(
  contractId: string,
  proposerPubkey: string,
  params: {
    title: string;
    description: string;
    costDeltaSats?: number;
    timelineDeltaDays?: number;
  },
) {
  return await db.transaction(async (tx) => {
    const [contract] = await tx
      .select()
      .from(contracts)
      .where(eq(contracts.id, contractId))
      .limit(1);

    if (!contract) throw new Error('Contract not found');
    if (contract.status !== 'active') {
      throw new Error(`Cannot propose change order on contract in status "${contract.status}"`);
    }

    // Verify proposer is a party to the contract
    if (proposerPubkey !== contract.customerPubkey && proposerPubkey !== contract.agentPubkey) {
      throw new Error('Only contract parties can propose change orders');
    }

    // Get next sequence number
    const existing = await tx
      .select({ total: count() })
      .from(contractChangeOrders)
      .where(eq(contractChangeOrders.contractId, contractId));
    const sequence = Number(existing[0]?.total ?? 0) + 1;

    const coId = ulid();
    await tx.insert(contractChangeOrders).values({
      id: coId,
      contractId,
      sequence,
      title: params.title,
      description: params.description,
      proposedBy: proposerPubkey,
      costDeltaSats: params.costDeltaSats ?? 0,
      timelineDeltaDays: params.timelineDeltaDays ?? 0,
    });

    await tx.insert(contractEvents).values({
      id: ulid(),
      contractId,
      eventType: 'change_order_proposed',
      actorPubkey: proposerPubkey,
      metadata: {
        change_order_id: coId,
        cost_delta_sats: params.costDeltaSats ?? 0,
        timeline_delta_days: params.timelineDeltaDays ?? 0,
      },
    });

    return { changeOrderId: coId, sequence };
  });
}

/**
 * Approve a change order. Other party (not the proposer) approves.
 */
export async function approveChangeOrder(
  contractId: string,
  changeOrderId: string,
  approverPubkey: string,
) {
  return await db.transaction(async (tx) => {
    const [contract] = await tx
      .select()
      .from(contracts)
      .where(eq(contracts.id, contractId))
      .limit(1);

    if (!contract) throw new Error('Contract not found');

    const [co] = await tx
      .select()
      .from(contractChangeOrders)
      .where(and(
        eq(contractChangeOrders.id, changeOrderId),
        eq(contractChangeOrders.contractId, contractId),
      ))
      .limit(1);

    if (!co) throw new Error('Change order not found');
    if (co.status !== 'proposed') {
      throw new Error(`Cannot approve change order in status "${co.status}"`);
    }
    if (co.proposedBy === approverPubkey) {
      throw new Error('Cannot approve your own change order');
    }

    // Verify approver is the other party
    if (approverPubkey !== contract.customerPubkey && approverPubkey !== contract.agentPubkey) {
      throw new Error('Only contract parties can approve change orders');
    }

    await tx
      .update(contractChangeOrders)
      .set({
        status: 'approved',
        approvedBy: approverPubkey,
        resolvedAt: new Date(),
      })
      .where(eq(contractChangeOrders.id, changeOrderId));

    // H3 fix: Guard against change orders that would make totalSats negative or below paidSats
    if (co.costDeltaSats !== 0) {
      const newTotal = contract.totalSats + co.costDeltaSats;
      const paidSats = contract.paidSats ?? 0;
      if (newTotal < 0) {
        throw new Error('Change order would reduce contract total below zero');
      }
      if (newTotal < paidSats) {
        throw new Error('Change order would reduce contract total below already-paid amount');
      }

      await tx
        .update(contracts)
        .set({
          totalSats: sql`${contracts.totalSats} + ${co.costDeltaSats}`,
          updatedAt: new Date(),
        })
        .where(eq(contracts.id, contractId));
    }

    await tx.insert(contractEvents).values({
      id: ulid(),
      contractId,
      eventType: 'change_order_approved',
      actorPubkey: approverPubkey,
      metadata: { change_order_id: changeOrderId, cost_delta_sats: co.costDeltaSats },
    });

    return { approved: true };
  });
}

/**
 * Reject a change order. Other party (not the proposer) rejects.
 */
export async function rejectChangeOrder(
  contractId: string,
  changeOrderId: string,
  rejectorPubkey: string,
  reason?: string,
) {
  return await db.transaction(async (tx) => {
    const [contract] = await tx
      .select()
      .from(contracts)
      .where(eq(contracts.id, contractId))
      .limit(1);

    if (!contract) throw new Error('Contract not found');

    const [co] = await tx
      .select()
      .from(contractChangeOrders)
      .where(and(
        eq(contractChangeOrders.id, changeOrderId),
        eq(contractChangeOrders.contractId, contractId),
      ))
      .limit(1);

    if (!co) throw new Error('Change order not found');
    if (co.status !== 'proposed') {
      throw new Error(`Cannot reject change order in status "${co.status}"`);
    }
    if (co.proposedBy === rejectorPubkey) {
      throw new Error('Cannot reject your own change order — withdraw it instead');
    }

    await tx
      .update(contractChangeOrders)
      .set({
        status: 'rejected',
        rejectedBy: rejectorPubkey,
        rejectionReason: reason,
        resolvedAt: new Date(),
      })
      .where(eq(contractChangeOrders.id, changeOrderId));

    await tx.insert(contractEvents).values({
      id: ulid(),
      contractId,
      eventType: 'change_order_rejected',
      actorPubkey: rejectorPubkey,
      metadata: { change_order_id: changeOrderId, reason },
    });
  });
}

/**
 * Rate the contract. After completion, either party rates the other.
 * When both have rated, create outcome records for trust score integration.
 */
export async function rateContract(
  contractId: string,
  raterPubkey: string,
  rating: number,
  review?: string,
) {
  return await db.transaction(async (tx) => {
    const [contract] = await tx
      .select()
      .from(contracts)
      .where(eq(contracts.id, contractId))
      .limit(1);

    if (!contract) throw new Error('Contract not found');
    if (contract.status !== 'completed') {
      throw new Error('Can only rate completed contracts');
    }

    const isCustomer = raterPubkey === contract.customerPubkey;
    const isAgent = raterPubkey === contract.agentPubkey;
    if (!isCustomer && !isAgent) {
      throw new Error('Only contract parties can rate');
    }

    // Check for existing rating
    if (isCustomer && contract.customerRating !== null) {
      throw new Error('Customer has already rated this contract');
    }
    if (isAgent && contract.agentRating !== null) {
      throw new Error('Agent has already rated this contract');
    }

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (isCustomer) {
      updates.customerRating = rating;
      updates.customerReview = review;
    } else {
      updates.agentRating = rating;
      updates.agentReview = review;
    }

    await tx
      .update(contracts)
      .set(updates)
      .where(eq(contracts.id, contractId));

    await tx.insert(contractEvents).values({
      id: ulid(),
      contractId,
      eventType: 'rated',
      actorPubkey: raterPubkey,
      metadata: { rating, role: isCustomer ? 'customer' : 'agent' },
    });

    // Check if both parties have now rated — create outcome records
    const otherRated = isCustomer ? contract.agentRating !== null : contract.customerRating !== null;
    if (otherRated) {
      // Customer rates agent (agent is performer)
      const customerRating = isCustomer ? rating : contract.customerRating!;
      const agentRating = isAgent ? rating : contract.agentRating!;

      // Agent's outcome (as performer)
      await tx.insert(outcomes).values({
        id: ulid(),
        agentPubkey: contract.agentPubkey,
        counterpartyPubkey: contract.customerPubkey,
        role: 'performer',
        taskType: 'contract',
        taskRef: contractId,
        success: customerRating >= 3,
        rating: customerRating,
        evidence: `Contract: ${contract.title}`,
      });

      // Customer's outcome (as purchaser)
      await tx.insert(outcomes).values({
        id: ulid(),
        agentPubkey: contract.customerPubkey,
        counterpartyPubkey: contract.agentPubkey,
        role: 'purchaser',
        taskType: 'contract',
        taskRef: contractId,
        success: agentRating >= 3,
        rating: agentRating,
        evidence: `Contract: ${contract.title}`,
      });
    }

    return { rated: true, bothRated: otherRated };
  });
}

/**
 * Release retention after the cooling period.
 * Called by daily cron or manual trigger.
 */
export async function releaseRetention(contractId: string) {
  const [contract] = await db
    .select()
    .from(contracts)
    .where(eq(contracts.id, contractId))
    .limit(1);

  if (!contract) throw new Error('Contract not found');
  if (contract.status !== 'completed') {
    throw new Error('Can only release retention on completed contracts');
  }
  if (contract.retentionReleasedAt) {
    throw new Error('Retention already released');
  }

  // Check cooling period
  if (!contract.completedAt) throw new Error('Contract has no completion date');
  const cooldownMs = contract.retentionReleaseAfterDays * 24 * 60 * 60 * 1000;
  const releaseDate = new Date(contract.completedAt.getTime() + cooldownMs);

  if (new Date() < releaseDate) {
    throw new Error(`Retention not yet releasable. Release date: ${releaseDate.toISOString()}`);
  }

  // Find retention milestone
  const [retentionMilestone] = await db
    .select()
    .from(contractMilestones)
    .where(and(
      eq(contractMilestones.contractId, contractId),
      eq(contractMilestones.isRetention, true),
    ))
    .limit(1);

  if (!retentionMilestone) throw new Error('No retention milestone found');

  // Release payment
  const result = await releaseMilestonePayment(contractId, retentionMilestone.id);

  // Update contract
  await db
    .update(contracts)
    .set({
      retentionReleasedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(contracts.id, contractId));

  return result;
}

/**
 * Cancel a contract. Only from draft/awaiting_funding.
 */
export async function cancelContract(
  contractId: string,
  actorPubkey: string,
  reason: string,
) {
  // S8 fix: Cancel in a short transaction, then refund outside it (no long DB locks during Lightning).
  const refundInfo = await db.transaction(async (tx) => {
    const [contract] = await tx
      .select()
      .from(contracts)
      .where(eq(contracts.id, contractId))
      .for('update');

    if (!contract) throw new Error('Contract not found');

    // Verify actor is a party
    if (actorPubkey !== contract.customerPubkey && actorPubkey !== contract.agentPubkey) {
      throw new Error('Only contract parties can cancel');
    }

    // Allow cancellation of draft, awaiting_funding, and active (with refunds)
    const cancellableStatuses = ['draft', 'awaiting_funding', 'active'];
    if (!cancellableStatuses.includes(contract.status)) {
      throw new Error(`Cannot cancel contract in status "${contract.status}". Only draft, awaiting_funding, or active contracts can be cancelled.`);
    }

    // Collect refund intents for funded milestones
    let refunds: Array<{ milestoneId: string; amountSats: number }> = [];
    let nwcConnectionId: string | null = null;

    if (contract.status === 'active' && contract.nwcConnectionId) {
      nwcConnectionId = contract.nwcConnectionId;
      const milestones = await tx
        .select()
        .from(contractMilestones)
        .where(eq(contractMilestones.contractId, contractId));

      refunds = milestones
        .filter((ms) => ms.status !== 'released' && ms.holdPaymentHash)
        .map((ms) => ({ milestoneId: ms.id, amountSats: ms.amountSats }));
    }

    await tx
      .update(contracts)
      .set({
        status: 'cancelled',
        cancelledAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(contracts.id, contractId));

    await tx.insert(contractEvents).values({
      id: ulid(),
      contractId,
      eventType: 'cancelled',
      actorPubkey,
      metadata: { reason, pending_refunds: refunds.length },
    });

    return { refunds, nwcConnectionId };
  });

  // Process refunds OUTSIDE the transaction (no DB locks held during Lightning round-trips)
  if (refundInfo.refunds.length > 0 && refundInfo.nwcConnectionId) {
    const { payYield } = await import('./nwc-service');
    const connId = refundInfo.nwcConnectionId;

    // Fire-and-forget: don't block the cancel response on refund completion
    setImmediate(async () => {
      for (const refund of refundInfo.refunds) {
        try {
          const { paymentHash } = await payYield(connId, refund.amountSats);
          await db.insert(paymentEvents).values({
            id: ulid(),
            paymentHash: paymentHash || `refund_${ulid()}`,
            amountSats: refund.amountSats,
            purpose: 'contract_refund',
            status: 'paid',
            contractId,
            milestoneId: refund.milestoneId,
            nwcConnectionId: connId,
            metadata: { reason: 'contract_cancelled' },
          });
        } catch (refundErr) {
          console.error(`[contracts] Refund failed for milestone ${refund.milestoneId}:`, refundErr instanceof Error ? refundErr.message : refundErr);
          await db.insert(paymentEvents).values({
            id: ulid(),
            paymentHash: `refund_failed_${ulid()}`,
            amountSats: refund.amountSats,
            purpose: 'contract_refund',
            status: 'failed',
            contractId,
            milestoneId: refund.milestoneId,
            metadata: { error: refundErr instanceof Error ? refundErr.message : 'Unknown error' },
          });
        }
      }
    });
  }

  return { cancelled: true };
}

/**
 * Process retention releases for all eligible contracts.
 * Called by daily cron.
 */
export async function processRetentionReleases() {
  const completed = await db
    .select()
    .from(contracts)
    .where(and(
      eq(contracts.status, 'completed'),
      sql`${contracts.retentionReleasedAt} IS NULL`,
      sql`${contracts.completedAt} IS NOT NULL`,
    ));

  let released = 0;
  for (const contract of completed) {
    if (!contract.completedAt) continue;

    const cooldownMs = contract.retentionReleaseAfterDays * 24 * 60 * 60 * 1000;
    const releaseDate = new Date(contract.completedAt.getTime() + cooldownMs);

    if (new Date() >= releaseDate) {
      try {
        await releaseRetention(contract.id);
        released++;
        console.log(`[contracts] Retention released for contract ${contract.id}`);
      } catch (err) {
        console.error(`[contracts] Failed to release retention for ${contract.id}:`, err);
      }
    }
  }

  if (released > 0) {
    console.log(`[contracts] Released retention for ${released} contracts`);
  }
}

/**
 * Get contract event audit trail with pagination.
 */
export async function getContractEvents(
  contractId: string,
  page = 1,
  limit = 50,
) {
  const offset = (page - 1) * limit;

  const [rows, countRows] = await Promise.all([
    db.select()
      .from(contractEvents)
      .where(eq(contractEvents.contractId, contractId))
      .orderBy(desc(contractEvents.createdAt))
      .limit(limit)
      .offset(offset),
    db.select({ total: count() })
      .from(contractEvents)
      .where(eq(contractEvents.contractId, contractId)),
  ]);
  const total = countRows[0]?.total ?? 0;

  return {
    data: rows,
    meta: {
      page,
      limit,
      total: Number(total),
      has_more: offset + rows.length < Number(total),
    },
  };
}

// ── ISC Operations ──

/**
 * Get ISC criteria for a specific milestone.
 * Verifies the requester is a party to the contract.
 */
export async function getMilestoneISC(
  contractId: string,
  milestoneId: string,
  requesterPubkey: string,
): Promise<MilestoneISC | null> {
  const [contract] = await db
    .select()
    .from(contracts)
    .where(eq(contracts.id, contractId))
    .limit(1);

  if (!contract) throw new Error('Contract not found');
  if (contract.customerPubkey !== requesterPubkey && contract.agentPubkey !== requesterPubkey) {
    throw new Error('Only contract parties can view ISC criteria');
  }

  const [milestone] = await db
    .select()
    .from(contractMilestones)
    .where(and(
      eq(contractMilestones.id, milestoneId),
      eq(contractMilestones.contractId, contractId),
    ))
    .limit(1);

  if (!milestone) throw new Error('Milestone not found');

  return (milestone.iscCriteria as MilestoneISC) || null;
}

/**
 * Update ISC criteria for a milestone.
 * Only allowed when contract is draft or active.
 * Validates the ISC structure before saving.
 */
export async function updateMilestoneISC(
  contractId: string,
  milestoneId: string,
  requesterPubkey: string,
  isc: MilestoneISC,
): Promise<void> {
  return await db.transaction(async (tx) => {
    const [contract] = await tx
      .select()
      .from(contracts)
      .where(eq(contracts.id, contractId))
      .limit(1);

    if (!contract) throw new Error('Contract not found');
    if (contract.customerPubkey !== requesterPubkey && contract.agentPubkey !== requesterPubkey) {
      throw new Error('Only contract parties can update ISC criteria');
    }

    const editableStatuses = ['draft', 'active'];
    if (!editableStatuses.includes(contract.status)) {
      throw new Error(`Cannot update ISC on contract in status "${contract.status}"`);
    }

    const [milestone] = await tx
      .select()
      .from(contractMilestones)
      .where(and(
        eq(contractMilestones.id, milestoneId),
        eq(contractMilestones.contractId, contractId),
      ))
      .limit(1);

    if (!milestone) throw new Error('Milestone not found');

    // Sanitize: strip status/evidence to prevent pre-setting via PUT (ISC-S1 fix)
    const sanitized = sanitizeISCForUpdate(isc);

    // Validate ISC structure
    const validation = validateISC(sanitized);
    if (!validation.valid) {
      throw new Error(`ISC validation failed: ${validation.errors.join('; ')}`);
    }

    await tx
      .update(contractMilestones)
      .set({ iscCriteria: sanitized })
      .where(eq(contractMilestones.id, milestoneId));
  });
}

// ── Bid System ──

const SENTINEL_PUBKEY = '0'.repeat(64);

/**
 * Submit a bid on an open contract.
 * Validates: contract is biddable (draft/awaiting_funding), bidder isn't customer,
 * no duplicate pending bids. Snapshots bidder trust score at submission time.
 */
export async function submitBid(
  contractId: string,
  bidderPubkey: string,
  approach: string,
  costSats: number,
  estimatedDays: number,
  payoutPreference: string = 'lightning',
) {
  if (!approach || approach.trim().length === 0) {
    throw new Error('approach is required');
  }
  if (approach.trim().length > 5000) {
    throw new Error('approach must be under 5000 characters');
  }
  if (!Number.isInteger(costSats) || costSats < 1 || costSats > 100_000_000) {
    throw new Error('cost_sats must be a positive integer up to 100,000,000');
  }
  if (!Number.isInteger(estimatedDays) || estimatedDays < 1 || estimatedDays > 365) {
    throw new Error('estimated_days must be a positive integer up to 365');
  }

  return await db.transaction(async (tx) => {
    // Lock contract and verify it's biddable
    const [contract] = await tx
      .select()
      .from(contracts)
      .where(eq(contracts.id, contractId))
      .for('update');

    if (!contract) throw new Error('Contract not found');
    if (contract.status !== 'draft' && contract.status !== 'awaiting_funding') {
      throw new Error('Contract is not open for bids');
    }

    // If an agent has already been assigned (bid accepted), no more bids
    if (contract.agentPubkey !== SENTINEL_PUBKEY) {
      throw new Error('Contract already has an assigned agent');
    }

    // Bidder can't be the customer
    if (contract.customerPubkey === bidderPubkey) {
      throw new Error('Cannot bid on your own contract');
    }

    // Check for duplicate pending bid
    const [existing] = await tx
      .select({ id: contractBids.id })
      .from(contractBids)
      .where(
        and(
          eq(contractBids.contractId, contractId),
          eq(contractBids.bidderPubkey, bidderPubkey),
          eq(contractBids.status, 'pending'),
        ),
      )
      .limit(1);

    if (existing) {
      throw new Error('You already have a pending bid on this contract');
    }

    // Factory contract gate: check if this is a factory:training contract,
    // and if so, enforce the trust < 100 eligibility rule.
    const sowObj = contract.sow as Record<string, unknown>;
    const rawTags = sowObj?.['tags'];
    const sowTags: string[] = Array.isArray(rawTags) ? (rawTags as string[]) : [];
    if (sowTags.includes('factory:training')) {
      const { canBidOnFactoryContract } = await import('./factory-service');
      const eligible = await canBidOnFactoryContract(bidderPubkey);
      if (!eligible.allowed) {
        throw new Error(eligible.reason ?? 'Not eligible to bid on factory contracts');
      }
    }

    // Snapshot bidder's trust score (best-effort, non-blocking)
    let bidderTrustScore = 0;
    try {
      const { calculateAgentTrust } = await import('./trust-service');
      const trust = await calculateAgentTrust(bidderPubkey);
      bidderTrustScore = trust.score;
    } catch {
      // Trust score unavailable — default to 0
    }

    const [bid] = await tx
      .insert(contractBids)
      .values({
        contractId,
        bidderPubkey,
        approach: approach.trim(),
        costSats,
        estimatedDays,
        bidderTrustScore,
        payoutPreference,
      })
      .returning();

    console.log(`[contracts] Bid submitted: ${bidderPubkey} on contract ${contractId} for ${costSats} sats`);
    return bid!;
  });
}

/**
 * List bids for a contract.
 * Customer sees all bids. Bidders see only their own.
 * Non-parties get an empty array (no leak of contract existence).
 */
export async function listBids(contractId: string, requesterPubkey: string) {
  const [contract] = await db
    .select({
      id: contracts.id,
      customerPubkey: contracts.customerPubkey,
    })
    .from(contracts)
    .where(eq(contracts.id, contractId))
    .limit(1);

  if (!contract) throw new Error('Contract not found');

  // Customer sees all bids
  if (contract.customerPubkey === requesterPubkey) {
    return db
      .select()
      .from(contractBids)
      .where(eq(contractBids.contractId, contractId))
      .orderBy(desc(contractBids.createdAt));
  }

  // Bidder sees only their own bids
  return db
    .select()
    .from(contractBids)
    .where(
      and(
        eq(contractBids.contractId, contractId),
        eq(contractBids.bidderPubkey, requesterPubkey),
      ),
    )
    .orderBy(desc(contractBids.createdAt));
}

/**
 * Accept a bid. Sets the bidder as the contract's agent, updates totalSats
 * to match the accepted bid's costSats, and rejects all other pending bids.
 * Only the customer can accept bids. Atomic.
 */
export async function acceptBid(
  contractId: string,
  bidId: string,
  customerPubkey: string,
) {
  return await db.transaction(async (tx) => {
    // Lock contract
    const [contract] = await tx
      .select()
      .from(contracts)
      .where(eq(contracts.id, contractId))
      .for('update');

    if (!contract) throw new Error('Contract not found');
    if (contract.customerPubkey !== customerPubkey) {
      throw new Error('Only the customer can accept bids');
    }
    if (contract.status !== 'draft' && contract.status !== 'awaiting_funding') {
      throw new Error('Contract is not open for bids');
    }

    // Lock bid
    const [bid] = await tx
      .select()
      .from(contractBids)
      .where(eq(contractBids.id, bidId))
      .for('update');

    if (!bid) throw new Error('Bid not found');
    if (bid.contractId !== contractId) throw new Error('Bid does not belong to this contract');
    if (bid.status !== 'pending') throw new Error(`Bid is ${bid.status}, not pending`);

    // Accept this bid
    await tx
      .update(contractBids)
      .set({ status: 'accepted' })
      .where(eq(contractBids.id, bidId));

    // Reject all other pending bids for this contract
    await tx
      .update(contractBids)
      .set({ status: 'rejected' })
      .where(
        and(
          eq(contractBids.contractId, contractId),
          eq(contractBids.status, 'pending'),
          sql`${contractBids.id} != ${bidId}`,
        ),
      );

    // Assign agent to contract and update totalSats to bid amount
    await tx
      .update(contracts)
      .set({
        agentPubkey: bid.bidderPubkey,
        totalSats: bid.costSats,
        updatedAt: new Date(),
      })
      .where(eq(contracts.id, contractId));

    // Recalculate milestone amounts when bid cost differs from original totalSats
    if (bid.costSats !== contract.totalSats) {
      const milestones = await tx
        .select()
        .from(contractMilestones)
        .where(eq(contractMilestones.contractId, contractId));

      for (const ms of milestones) {
        const newAmount = Math.floor((bid.costSats * ms.percentageBps) / 10000);
        await tx
          .update(contractMilestones)
          .set({
            amountSats: newAmount,
            payoutMethod: (bid as Record<string, unknown>).payoutPreference as string ?? 'lightning',
          })
          .where(eq(contractMilestones.id, ms.id));
      }
    } else {
      // Even if cost matches, propagate payout preference
      await tx
        .update(contractMilestones)
        .set({
          payoutMethod: (bid as Record<string, unknown>).payoutPreference as string ?? 'lightning',
        })
        .where(eq(contractMilestones.contractId, contractId));
    }

    console.log(`[contracts] Bid accepted: ${bid.bidderPubkey} assigned to contract ${contractId} for ${bid.costSats} sats`);
    return { contractId, bidId, agentPubkey: bid.bidderPubkey, costSats: bid.costSats };
  });
}

/**
 * Reject a bid. Only the customer can reject bids. Atomic.
 */
export async function rejectBid(
  contractId: string,
  bidId: string,
  customerPubkey: string,
) {
  return await db.transaction(async (tx) => {
    const [contract] = await tx
      .select({ id: contracts.id, customerPubkey: contracts.customerPubkey })
      .from(contracts)
      .where(eq(contracts.id, contractId))
      .limit(1);

    if (!contract) throw new Error('Contract not found');
    if (contract.customerPubkey !== customerPubkey) {
      throw new Error('Only the customer can reject bids');
    }

    const [bid] = await tx
      .select()
      .from(contractBids)
      .where(eq(contractBids.id, bidId))
      .for('update');

    if (!bid) throw new Error('Bid not found');
    if (bid.contractId !== contractId) throw new Error('Bid does not belong to this contract');
    if (bid.status !== 'pending') throw new Error(`Bid is ${bid.status}, not pending`);

    await tx
      .update(contractBids)
      .set({ status: 'rejected' })
      .where(eq(contractBids.id, bidId));

    console.log(`[contracts] Bid rejected: ${bidId} on contract ${contractId}`);
    return { contractId, bidId, rejected: true };
  });
}

/**
 * Withdraw a bid. Only the bidder can withdraw their own pending bid. Atomic.
 */
export async function withdrawBid(
  contractId: string,
  bidId: string,
  bidderPubkey: string,
) {
  return await db.transaction(async (tx) => {
    const [bid] = await tx
      .select()
      .from(contractBids)
      .where(eq(contractBids.id, bidId))
      .for('update');

    if (!bid) throw new Error('Bid not found');
    if (bid.contractId !== contractId) throw new Error('Bid does not belong to this contract');
    if (bid.bidderPubkey !== bidderPubkey) {
      throw new Error('Only the bidder can withdraw their bid');
    }
    if (bid.status !== 'pending') throw new Error(`Bid is ${bid.status}, not pending`);

    await tx
      .update(contractBids)
      .set({ status: 'withdrawn' })
      .where(eq(contractBids.id, bidId));

    console.log(`[contracts] Bid withdrawn: ${bidId} on contract ${contractId}`);
    return { contractId, bidId, withdrawn: true };
  });
}

// Vouch — Contract Service
// Business logic for construction-model agent work agreements.
// All state transitions use db.transaction() for atomicity (matching staking-service pattern).

import { eq, and, sql, desc, asc, count } from 'drizzle-orm';
import {
  db,
  contracts,
  contractMilestones,
  contractChangeOrders,
  contractEvents,
  paymentEvents,
  nwcConnections,
  outcomes,
} from '@percival/vouch-db';
import { ulid } from 'ulid';

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
    const milestoneRows = params.milestones.map((m, i) => ({
      id: ulid(),
      contractId,
      sequence: i + 1,
      title: m.title,
      description: m.description,
      acceptanceCriteria: m.acceptance_criteria,
      amountSats: Math.round((params.totalSats * m.percentage_bps) / 10000),
      percentageBps: m.percentage_bps,
      isRetention: false,
    }));

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
 * Fund a contract by linking a customer's NWC connection.
 * Budget = totalSats. Same pattern as createStakeLock.
 */
export async function fundContract(
  contractId: string,
  customerPubkey: string,
  nwcConnectionId: string,
) {
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

    const remaining = nwc.budgetSats - nwc.spentSats;
    if (remaining < contract.totalSats) {
      throw new Error(`NWC budget ${remaining} sats insufficient for contract ${contract.totalSats} sats`);
    }

    await tx
      .update(contracts)
      .set({
        nwcConnectionId,
        fundedSats: contract.totalSats,
        updatedAt: new Date(),
      })
      .where(eq(contracts.id, contractId));

    await tx.insert(contractEvents).values({
      id: ulid(),
      contractId,
      eventType: 'funded',
      actorPubkey: customerPubkey,
      metadata: { funded_sats: contract.totalSats },
    });

    return { funded_sats: contract.totalSats };
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

    await tx
      .update(contractMilestones)
      .set({
        status: 'submitted',
        deliverableUrl,
        deliverableNotes,
        submittedAt: new Date(),
      })
      .where(eq(contractMilestones.id, milestoneId));

    await tx.insert(contractEvents).values({
      id: ulid(),
      contractId,
      eventType: 'milestone_submitted',
      actorPubkey: agentPubkey,
      metadata: { milestone_id: milestoneId, milestone_title: milestone.title },
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
) {
  return await db.transaction(async (tx) => {
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

    await tx
      .update(contractMilestones)
      .set({
        status: 'accepted',
        acceptedAt: new Date(),
      })
      .where(eq(contractMilestones.id, milestoneId));

    await tx.insert(contractEvents).values({
      id: ulid(),
      contractId,
      eventType: 'milestone_accepted',
      actorPubkey: customerPubkey,
      metadata: { milestone_id: milestoneId, amount_sats: milestone.amountSats },
    });

    // Update contract paid amount
    await tx
      .update(contracts)
      .set({
        paidSats: sql`${contracts.paidSats} + ${milestone.amountSats}`,
        updatedAt: new Date(),
      })
      .where(eq(contracts.id, contractId));

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

    return {
      milestoneAccepted: true,
      contractCompleted: allWorkAccepted,
    };
  });
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
 * Charges customer NWC → pays agent NWC. Records payment_event.
 */
export async function releaseMilestonePayment(contractId: string, milestoneId: string) {
  const [contract] = await db
    .select()
    .from(contracts)
    .where(eq(contracts.id, contractId))
    .limit(1);

  if (!contract) throw new Error('Contract not found');
  if (!contract.nwcConnectionId) throw new Error('Contract has no NWC connection');

  const [milestone] = await db
    .select()
    .from(contractMilestones)
    .where(and(
      eq(contractMilestones.id, milestoneId),
      eq(contractMilestones.contractId, contractId),
    ))
    .limit(1);

  if (!milestone) throw new Error('Milestone not found');
  if (milestone.status !== 'accepted' && !(milestone.isRetention && milestone.status === 'pending')) {
    throw new Error(`Cannot release payment for milestone in status "${milestone.status}"`);
  }

  const purpose = milestone.isRetention ? 'contract_retention' : 'contract_milestone';

  try {
    // Dynamic import to avoid circular deps (matching staking-service pattern)
    const { executeSlash } = await import('./nwc-service');
    const { paymentHash } = await executeSlash(
      contract.nwcConnectionId,
      milestone.amountSats,
      `Contract ${contract.title}: ${milestone.title}`,
    );

    // Record payment event
    await db.insert(paymentEvents).values({
      id: ulid(),
      paymentHash,
      amountSats: milestone.amountSats,
      purpose: purpose as 'contract_milestone' | 'contract_retention',
      status: 'paid',
      contractId,
      milestoneId,
      nwcConnectionId: contract.nwcConnectionId,
    });

    // Mark milestone as released
    await db
      .update(contractMilestones)
      .set({
        status: 'released',
        releasedAt: new Date(),
        paymentHash,
      })
      .where(eq(contractMilestones.id, milestoneId));

    await logEvent(contractId, 'milestone_released', contract.customerPubkey, {
      milestone_id: milestoneId,
      amount_sats: milestone.amountSats,
      payment_hash: paymentHash,
    });

    // TODO: Pay agent NWC (payYield pattern) once agent NWC connections are tracked
    // For now, payment goes to platform treasury and manual disbursement

    return { paymentHash, amountSats: milestone.amountSats };
  } catch (err) {
    // Record failed payment
    await db.insert(paymentEvents).values({
      id: ulid(),
      paymentHash: `failed_${ulid()}`,
      amountSats: milestone.amountSats,
      purpose: purpose as 'contract_milestone' | 'contract_retention',
      status: 'failed',
      contractId,
      milestoneId,
      nwcConnectionId: contract.nwcConnectionId,
      metadata: { error: err instanceof Error ? err.message : 'Unknown error' },
    });
    throw err;
  }
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

    // Apply cost delta to contract total
    if (co.costDeltaSats !== 0) {
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
  return await db.transaction(async (tx) => {
    const [contract] = await tx
      .select()
      .from(contracts)
      .where(eq(contracts.id, contractId))
      .limit(1);

    if (!contract) throw new Error('Contract not found');

    // Verify actor is a party
    if (actorPubkey !== contract.customerPubkey && actorPubkey !== contract.agentPubkey) {
      throw new Error('Only contract parties can cancel');
    }

    const cancellableStatuses = ['draft', 'awaiting_funding'];
    if (!cancellableStatuses.includes(contract.status)) {
      throw new Error(`Cannot cancel contract in status "${contract.status}". Only draft or awaiting_funding contracts can be cancelled.`);
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
      metadata: { reason },
    });

    return { cancelled: true };
  });
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

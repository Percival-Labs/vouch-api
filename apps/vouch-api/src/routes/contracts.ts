// Contract Routes — Vouch Agent Work Agreements
// NIP-98 auth for all routes (both agents and customers use Nostr identity).

import { Hono } from 'hono';
import { success, paginated, error } from '../lib/response';
import {
  validate,
  CreateContractSchema,
  UpdateContractSchema,
  SubmitMilestoneSchema,
  RejectMilestoneSchema,
  ProposeChangeOrderSchema,
  RejectChangeOrderSchema,
  RateContractSchema,
  CancelContractSchema,
  PaginationSchema,
  UpdateISCSchema,
  SubmitBidSchema,
} from '../lib/schemas';
import type { NostrAuthEnv } from '../middleware/nostr-auth';
import {
  createContract,
  getContract,
  listContracts,
  activateContract,
  fundContract,
  submitMilestone,
  acceptMilestone,
  rejectMilestone,
  releaseMilestonePayment,
  proposeChangeOrder,
  approveChangeOrder,
  rejectChangeOrder,
  rateContract,
  releaseRetention,
  cancelContract,
  getContractEvents,
  getMilestoneISC,
  updateMilestoneISC,
  submitBid,
  listBids,
  acceptBid,
  rejectBid,
  withdrawBid,
  type MilestoneISC,
} from '../services/contract-service';

const app = new Hono<NostrAuthEnv>();

// ── Helper: get authenticated pubkey ──
function getPubkey(c: { get: (key: string) => string | undefined }) {
  const pubkey = c.get('nostrPubkey');
  if (!pubkey) return null;
  return pubkey;
}

// ── POST / — Create contract (draft) ──
app.post('/', async (c) => {
  const pubkey = getPubkey(c);
  if (!pubkey) return error(c, 401, 'AUTH_REQUIRED', 'Authentication required');

  try {
    const body = await c.req.json();
    const v = validate(CreateContractSchema, body);
    if (!v.success) return error(c, 400, v.error.code, v.error.message, v.error.details);

    const result = await createContract({
      customerPubkey: pubkey,
      agentPubkey: v.data.agent_pubkey,
      title: v.data.title,
      description: v.data.description,
      sow: v.data.sow,
      totalSats: v.data.total_sats,
      retentionBps: v.data.retention_bps,
      retentionReleaseAfterDays: v.data.retention_release_after_days,
      milestones: v.data.milestones,
    });

    return success(c, result, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[contracts] POST / error:', message);
    if (message.includes('Milestone percentages')) {
      return error(c, 400, 'VALIDATION_ERROR', message);
    }
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to create contract');
  }
});

// ── GET / — List contracts ──
app.get('/', async (c) => {
  const pubkey = getPubkey(c);
  if (!pubkey) return error(c, 401, 'AUTH_REQUIRED', 'Authentication required');

  try {
    const status = c.req.query('status');
    const role = (c.req.query('role') || 'any') as 'customer' | 'agent' | 'any';
    const page = parseInt(c.req.query('page') || '1', 10);
    const limit = parseInt(c.req.query('limit') || '25', 10);

    const result = await listContracts(pubkey, role, status, page, limit);
    return paginated(c, result.data, result.meta);
  } catch (err) {
    console.error('[contracts] GET / error:', err);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to list contracts');
  }
});

// ── GET /:id — Contract detail ──
app.get('/:id', async (c) => {
  const pubkey = getPubkey(c);
  if (!pubkey) return error(c, 401, 'AUTH_REQUIRED', 'Authentication required');

  try {
    const contractId = c.req.param('id');
    const result = await getContract(contractId);
    if (!result) return error(c, 404, 'NOT_FOUND', 'Contract not found');

    // Only contract parties can view
    const { contract } = result;
    if (contract.customerPubkey !== pubkey && contract.agentPubkey !== pubkey) {
      return error(c, 403, 'FORBIDDEN', 'Not a party to this contract');
    }

    return success(c, result);
  } catch (err) {
    console.error('[contracts] GET /:id error:', err);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to get contract');
  }
});

// ── POST /:id/activate — Activate contract (customer) ──
app.post('/:id/activate', async (c) => {
  const pubkey = getPubkey(c);
  if (!pubkey) return error(c, 401, 'AUTH_REQUIRED', 'Authentication required');

  try {
    const contractId = c.req.param('id');
    const result = await activateContract(contractId, pubkey);
    return success(c, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[contracts] POST /:id/activate error:', message);
    if (message.includes('not found')) return error(c, 404, 'NOT_FOUND', message);
    if (message.includes('Cannot activate')) return error(c, 409, 'INVALID_STATE', message);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to activate contract');
  }
});

// ── POST /:id/fund — Connect NWC wallet (customer) ──
app.post('/:id/fund', async (c) => {
  const pubkey = getPubkey(c);
  if (!pubkey) return error(c, 401, 'AUTH_REQUIRED', 'Authentication required');

  try {
    const contractId = c.req.param('id');
    const body = await c.req.json<{ nwc_connection_id: string }>();
    if (!body.nwc_connection_id) {
      return error(c, 400, 'VALIDATION_ERROR', 'nwc_connection_id is required');
    }

    const result = await fundContract(contractId, pubkey, body.nwc_connection_id);
    return success(c, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[contracts] POST /:id/fund error:', message);
    if (message.includes('not found')) return error(c, 404, 'NOT_FOUND', message);
    if (message.includes('Cannot fund')) return error(c, 409, 'INVALID_STATE', message);
    if (message.includes('insufficient')) return error(c, 400, 'INSUFFICIENT_BUDGET', message);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to fund contract');
  }
});

// ── POST /:id/cancel — Cancel contract ──
app.post('/:id/cancel', async (c) => {
  const pubkey = getPubkey(c);
  if (!pubkey) return error(c, 401, 'AUTH_REQUIRED', 'Authentication required');

  try {
    const contractId = c.req.param('id');
    const body = await c.req.json();
    const v = validate(CancelContractSchema, body);
    if (!v.success) return error(c, 400, v.error.code, v.error.message, v.error.details);

    const result = await cancelContract(contractId, pubkey, v.data.reason);
    return success(c, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[contracts] POST /:id/cancel error:', message);
    if (message.includes('not found')) return error(c, 404, 'NOT_FOUND', message);
    if (message.includes('Cannot cancel')) return error(c, 409, 'INVALID_STATE', message);
    if (message.includes('Only contract parties')) return error(c, 403, 'FORBIDDEN', message);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to cancel contract');
  }
});

// ── POST /:id/milestones/:mid/submit — Submit deliverable (agent) ──
app.post('/:id/milestones/:mid/submit', async (c) => {
  const pubkey = getPubkey(c);
  if (!pubkey) return error(c, 401, 'AUTH_REQUIRED', 'Authentication required');

  try {
    const contractId = c.req.param('id');
    const milestoneId = c.req.param('mid');
    const body = await c.req.json();
    const v = validate(SubmitMilestoneSchema, body);
    if (!v.success) return error(c, 400, v.error.code, v.error.message, v.error.details);

    await submitMilestone(
      contractId,
      milestoneId,
      pubkey,
      v.data.deliverable_url,
      v.data.deliverable_notes,
      v.data.isc_evidence,
      v.data.skills_used,
    );
    return success(c, { submitted: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[contracts] POST milestones/submit error:', message);
    if (message.includes('not found')) return error(c, 404, 'NOT_FOUND', message);
    if (message.includes('Cannot submit')) return error(c, 409, 'INVALID_STATE', message);
    if (message.includes('retention')) return error(c, 400, 'VALIDATION_ERROR', message);
    if (message.includes('Missing evidence for critical ISC')) return error(c, 400, 'ISC_EVIDENCE_MISSING', message);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to submit milestone');
  }
});

// ── POST /:id/milestones/:mid/accept — Accept milestone (customer) ──
app.post('/:id/milestones/:mid/accept', async (c) => {
  const pubkey = getPubkey(c);
  if (!pubkey) return error(c, 401, 'AUTH_REQUIRED', 'Authentication required');

  try {
    const contractId = c.req.param('id');
    const milestoneId = c.req.param('mid');
    const body = await c.req.json().catch(() => ({}));
    const iscOverrides = (body as { isc_overrides?: Record<string, { status: 'passed' | 'failed'; note?: string }> }).isc_overrides;
    const result = await acceptMilestone(contractId, milestoneId, pubkey, iscOverrides);

    // Trigger payment release (non-blocking, matching staking-service pattern)
    releaseMilestonePayment(contractId, milestoneId).catch((err) => {
      console.error(`[contracts] Payment release failed for milestone ${milestoneId}:`, err);
    });

    return success(c, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[contracts] POST milestones/accept error:', message);
    if (message.includes('not found')) return error(c, 404, 'NOT_FOUND', message);
    if (message.includes('Cannot accept')) return error(c, 409, 'INVALID_STATE', message);
    if (message.includes('critical ISC criteria')) return error(c, 400, 'ISC_CRITERIA_NOT_MET', message);
    if (message.includes('anti-criteria violated')) return error(c, 400, 'ISC_ANTI_CRITERIA_VIOLATED', message);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to accept milestone');
  }
});

// ── POST /:id/milestones/:mid/reject — Reject milestone (customer) ──
app.post('/:id/milestones/:mid/reject', async (c) => {
  const pubkey = getPubkey(c);
  if (!pubkey) return error(c, 401, 'AUTH_REQUIRED', 'Authentication required');

  try {
    const contractId = c.req.param('id');
    const milestoneId = c.req.param('mid');
    const body = await c.req.json();
    const v = validate(RejectMilestoneSchema, body);
    if (!v.success) return error(c, 400, v.error.code, v.error.message, v.error.details);

    await rejectMilestone(contractId, milestoneId, pubkey, v.data.reason);
    return success(c, { rejected: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[contracts] POST milestones/reject error:', message);
    if (message.includes('not found')) return error(c, 404, 'NOT_FOUND', message);
    if (message.includes('Cannot reject')) return error(c, 409, 'INVALID_STATE', message);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to reject milestone');
  }
});

// ── POST /:id/change-orders — Propose change order (either party) ──
app.post('/:id/change-orders', async (c) => {
  const pubkey = getPubkey(c);
  if (!pubkey) return error(c, 401, 'AUTH_REQUIRED', 'Authentication required');

  try {
    const contractId = c.req.param('id');
    const body = await c.req.json();
    const v = validate(ProposeChangeOrderSchema, body);
    if (!v.success) return error(c, 400, v.error.code, v.error.message, v.error.details);

    const result = await proposeChangeOrder(contractId, pubkey, {
      title: v.data.title,
      description: v.data.description,
      costDeltaSats: v.data.cost_delta_sats,
      timelineDeltaDays: v.data.timeline_delta_days,
    });
    return success(c, result, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[contracts] POST change-orders error:', message);
    if (message.includes('not found')) return error(c, 404, 'NOT_FOUND', message);
    if (message.includes('Cannot propose')) return error(c, 409, 'INVALID_STATE', message);
    if (message.includes('Only contract parties')) return error(c, 403, 'FORBIDDEN', message);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to propose change order');
  }
});

// ── POST /:id/change-orders/:coId/approve — Approve change order ──
app.post('/:id/change-orders/:coId/approve', async (c) => {
  const pubkey = getPubkey(c);
  if (!pubkey) return error(c, 401, 'AUTH_REQUIRED', 'Authentication required');

  try {
    const contractId = c.req.param('id');
    const coId = c.req.param('coId');
    const result = await approveChangeOrder(contractId, coId, pubkey);
    return success(c, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[contracts] POST change-orders/approve error:', message);
    if (message.includes('not found')) return error(c, 404, 'NOT_FOUND', message);
    if (message.includes('Cannot approve')) return error(c, 409, 'INVALID_STATE', message);
    if (message.includes('your own')) return error(c, 403, 'FORBIDDEN', message);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to approve change order');
  }
});

// ── POST /:id/change-orders/:coId/reject — Reject change order ──
app.post('/:id/change-orders/:coId/reject', async (c) => {
  const pubkey = getPubkey(c);
  if (!pubkey) return error(c, 401, 'AUTH_REQUIRED', 'Authentication required');

  try {
    const contractId = c.req.param('id');
    const coId = c.req.param('coId');
    const body = await c.req.json().catch(() => ({}));
    const v = validate(RejectChangeOrderSchema, body);
    if (!v.success) return error(c, 400, v.error.code, v.error.message, v.error.details);

    await rejectChangeOrder(contractId, coId, pubkey, v.data.reason);
    return success(c, { rejected: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[contracts] POST change-orders/reject error:', message);
    if (message.includes('not found')) return error(c, 404, 'NOT_FOUND', message);
    if (message.includes('Cannot reject')) return error(c, 409, 'INVALID_STATE', message);
    if (message.includes('your own')) return error(c, 403, 'FORBIDDEN', message);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to reject change order');
  }
});

// ── POST /:id/rate — Rate other party ──
app.post('/:id/rate', async (c) => {
  const pubkey = getPubkey(c);
  if (!pubkey) return error(c, 401, 'AUTH_REQUIRED', 'Authentication required');

  try {
    const contractId = c.req.param('id');
    const body = await c.req.json();
    const v = validate(RateContractSchema, body);
    if (!v.success) return error(c, 400, v.error.code, v.error.message, v.error.details);

    const result = await rateContract(contractId, pubkey, v.data.rating, v.data.review);
    return success(c, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[contracts] POST /:id/rate error:', message);
    if (message.includes('not found')) return error(c, 404, 'NOT_FOUND', message);
    if (message.includes('only rate')) return error(c, 409, 'INVALID_STATE', message);
    if (message.includes('already rated')) return error(c, 409, 'ALREADY_RATED', message);
    if (message.includes('Only contract parties')) return error(c, 403, 'FORBIDDEN', message);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to rate contract');
  }
});

// ── POST /:id/release-retention — Release retention (after cooldown) ──
app.post('/:id/release-retention', async (c) => {
  const pubkey = getPubkey(c);
  if (!pubkey) return error(c, 401, 'AUTH_REQUIRED', 'Authentication required');

  try {
    const contractId = c.req.param('id');

    // Authorization: only contract parties can release retention
    const detail = await getContract(contractId);
    if (!detail) return error(c, 404, 'NOT_FOUND', 'Contract not found');
    if (detail.contract.customerPubkey !== pubkey && detail.contract.agentPubkey !== pubkey) {
      return error(c, 403, 'FORBIDDEN', 'Only contract parties can release retention');
    }

    const result = await releaseRetention(contractId);
    return success(c, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[contracts] POST /:id/release-retention error:', message);
    if (message.includes('not found')) return error(c, 404, 'NOT_FOUND', message);
    if (message.includes('already released')) return error(c, 409, 'ALREADY_RELEASED', message);
    if (message.includes('not yet releasable')) return error(c, 409, 'TOO_EARLY', message);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to release retention');
  }
});

// ── GET /:id/milestones/:mid/isc — Get ISC criteria ──
app.get('/:id/milestones/:mid/isc', async (c) => {
  const pubkey = getPubkey(c);
  if (!pubkey) return error(c, 401, 'AUTH_REQUIRED', 'Authentication required');

  try {
    const contractId = c.req.param('id');
    const milestoneId = c.req.param('mid');
    const isc = await getMilestoneISC(contractId, milestoneId, pubkey);
    return success(c, { isc });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[contracts] GET milestones/isc error:', message);
    if (message.includes('not found')) return error(c, 404, 'NOT_FOUND', message);
    if (message.includes('Only contract parties')) return error(c, 403, 'FORBIDDEN', message);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to get ISC criteria');
  }
});

// ── PUT /:id/milestones/:mid/isc — Update ISC criteria ──
app.put('/:id/milestones/:mid/isc', async (c) => {
  const pubkey = getPubkey(c);
  if (!pubkey) return error(c, 401, 'AUTH_REQUIRED', 'Authentication required');

  try {
    const contractId = c.req.param('id');
    const milestoneId = c.req.param('mid');
    const body = await c.req.json();

    // Validate through Zod schema (ISC-S4 fix: no raw cast)
    const v = validate(UpdateISCSchema, body);
    if (!v.success) return error(c, 400, v.error.code, v.error.message, v.error.details);

    await updateMilestoneISC(contractId, milestoneId, pubkey, v.data as MilestoneISC);
    return success(c, { updated: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[contracts] PUT milestones/isc error:', message);
    if (message.includes('not found')) return error(c, 404, 'NOT_FOUND', message);
    if (message.includes('Only contract parties')) return error(c, 403, 'FORBIDDEN', message);
    if (message.includes('Cannot update ISC')) return error(c, 409, 'INVALID_STATE', message);
    if (message.includes('ISC validation failed')) return error(c, 400, 'VALIDATION_ERROR', message);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to update ISC criteria');
  }
});

// ── GET /:id/events — Audit trail ──
app.get('/:id/events', async (c) => {
  const pubkey = getPubkey(c);
  if (!pubkey) return error(c, 401, 'AUTH_REQUIRED', 'Authentication required');

  try {
    const contractId = c.req.param('id');

    // Verify access — must be a party to the contract
    const detail = await getContract(contractId);
    if (!detail) return error(c, 404, 'NOT_FOUND', 'Contract not found');
    if (detail.contract.customerPubkey !== pubkey && detail.contract.agentPubkey !== pubkey) {
      return error(c, 403, 'FORBIDDEN', 'Not a party to this contract');
    }

    const page = parseInt(c.req.query('page') || '1', 10);
    const limit = parseInt(c.req.query('limit') || '50', 10);
    const result = await getContractEvents(contractId, page, limit);
    return paginated(c, result.data, result.meta);
  } catch (err) {
    console.error('[contracts] GET /:id/events error:', err);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to get events');
  }
});

// ── POST /:id/bids — Submit bid (agent) ──
app.post('/:id/bids', async (c) => {
  const pubkey = getPubkey(c);
  if (!pubkey) return error(c, 401, 'AUTH_REQUIRED', 'Authentication required');

  try {
    const contractId = c.req.param('id');
    const body = await c.req.json();
    const v = validate(SubmitBidSchema, body);
    if (!v.success) return error(c, 400, v.error.code, v.error.message, v.error.details);

    const result = await submitBid(contractId, pubkey, v.data.approach, v.data.cost_sats, v.data.estimated_days);
    return success(c, result, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[contracts] POST /:id/bids error:', message);
    if (message.includes('not found')) return error(c, 404, 'NOT_FOUND', message);
    if (message.includes('not open')) return error(c, 409, 'INVALID_STATE', message);
    if (message.includes('your own')) return error(c, 403, 'FORBIDDEN', message);
    if (message.includes('already have')) return error(c, 409, 'DUPLICATE_BID', message);
    if (message.includes('cost_sats') || message.includes('estimated_days') || message.includes('approach')) {
      return error(c, 400, 'VALIDATION_ERROR', message);
    }
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to submit bid');
  }
});

// ── GET /:id/bids — List bids (customer sees all, bidder sees own) ──
app.get('/:id/bids', async (c) => {
  const pubkey = getPubkey(c);
  if (!pubkey) return error(c, 401, 'AUTH_REQUIRED', 'Authentication required');

  try {
    const contractId = c.req.param('id');
    const bids = await listBids(contractId, pubkey);
    return success(c, bids);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[contracts] GET /:id/bids error:', message);
    if (message.includes('not found')) return error(c, 404, 'NOT_FOUND', message);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to list bids');
  }
});

// ── POST /:id/bids/:bidId/accept — Accept bid (customer) ──
app.post('/:id/bids/:bidId/accept', async (c) => {
  const pubkey = getPubkey(c);
  if (!pubkey) return error(c, 401, 'AUTH_REQUIRED', 'Authentication required');

  try {
    const contractId = c.req.param('id');
    const bidId = c.req.param('bidId');
    const result = await acceptBid(contractId, bidId, pubkey);
    return success(c, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[contracts] POST /:id/bids/:bidId/accept error:', message);
    if (message.includes('not found')) return error(c, 404, 'NOT_FOUND', message);
    if (message.includes('Only the customer')) return error(c, 403, 'FORBIDDEN', message);
    if (message.includes('not open') || message.includes('not pending')) return error(c, 409, 'INVALID_STATE', message);
    if (message.includes('does not belong')) return error(c, 400, 'VALIDATION_ERROR', message);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to accept bid');
  }
});

// ── POST /:id/bids/:bidId/reject — Reject bid (customer) ──
app.post('/:id/bids/:bidId/reject', async (c) => {
  const pubkey = getPubkey(c);
  if (!pubkey) return error(c, 401, 'AUTH_REQUIRED', 'Authentication required');

  try {
    const contractId = c.req.param('id');
    const bidId = c.req.param('bidId');
    const result = await rejectBid(contractId, bidId, pubkey);
    return success(c, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[contracts] POST /:id/bids/:bidId/reject error:', message);
    if (message.includes('not found')) return error(c, 404, 'NOT_FOUND', message);
    if (message.includes('Only the customer')) return error(c, 403, 'FORBIDDEN', message);
    if (message.includes('not pending')) return error(c, 409, 'INVALID_STATE', message);
    if (message.includes('does not belong')) return error(c, 400, 'VALIDATION_ERROR', message);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to reject bid');
  }
});

// ── POST /:id/bids/:bidId/withdraw — Withdraw bid (bidder) ──
app.post('/:id/bids/:bidId/withdraw', async (c) => {
  const pubkey = getPubkey(c);
  if (!pubkey) return error(c, 401, 'AUTH_REQUIRED', 'Authentication required');

  try {
    const contractId = c.req.param('id');
    const bidId = c.req.param('bidId');
    const result = await withdrawBid(contractId, bidId, pubkey);
    return success(c, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[contracts] POST /:id/bids/:bidId/withdraw error:', message);
    if (message.includes('not found')) return error(c, 404, 'NOT_FOUND', message);
    if (message.includes('Only the bidder')) return error(c, 403, 'FORBIDDEN', message);
    if (message.includes('not pending')) return error(c, 409, 'INVALID_STATE', message);
    if (message.includes('does not belong')) return error(c, 400, 'VALIDATION_ERROR', message);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to withdraw bid');
  }
});

export default app;

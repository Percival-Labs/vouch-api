// Trust score routes — view and refresh trust breakdowns

import { Hono } from 'hono';
import { success, error } from '../lib/response';
import type { AppEnv } from '../middleware/verify-signature';
import {
  calculateUserTrust,
  calculateAgentTrust,
  refreshTrustScore,
} from '../services/trust-service';

const app = new Hono<AppEnv>();

// ── GET /users/:id — Trust score breakdown for a user ──
app.get('/users/:id', async (c) => {
  const userId = c.req.param('id');

  try {
    const breakdown = await calculateUserTrust(userId);
    if (!breakdown) {
      return error(c, 404, 'NOT_FOUND', 'User not found');
    }

    return success(c, breakdown);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[api] GET /v1/trust/users/${userId} error:`, message);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to compute trust score');
  }
});

// ── GET /agents/:id — Trust score breakdown for an agent ──
app.get('/agents/:id', async (c) => {
  const agentId = c.req.param('id');

  try {
    const breakdown = await calculateAgentTrust(agentId);
    if (!breakdown) {
      return error(c, 404, 'NOT_FOUND', 'Agent not found');
    }

    return success(c, breakdown);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[api] GET /v1/trust/agents/${agentId} error:`, message);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to compute trust score');
  }
});

// ── POST /refresh/:id — Recalculate and persist trust score (self only) ──
app.post('/refresh/:id', async (c) => {
  const subjectId = c.req.param('id');
  const callerId = c.get('verifiedAgentId');

  if (callerId !== subjectId) {
    return error(c, 403, 'FORBIDDEN', 'Agents can only refresh their own trust score');
  }

  try {
    const body = await c.req.json<{ subject_type: 'user' | 'agent' }>();

    if (!body.subject_type || (body.subject_type !== 'user' && body.subject_type !== 'agent')) {
      return error(c, 400, 'VALIDATION_ERROR', 'subject_type must be "user" or "agent"', [
        { field: 'subject_type', issue: 'must be "user" or "agent"' },
      ]);
    }

    const breakdown = await refreshTrustScore(subjectId, body.subject_type);
    if (!breakdown) {
      return error(c, 404, 'NOT_FOUND', `${body.subject_type === 'user' ? 'User' : 'Agent'} not found`);
    }

    return success(c, breakdown);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[api] POST /v1/trust/refresh/${subjectId} error:`, message);
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to refresh trust score');
  }
});

export default app;

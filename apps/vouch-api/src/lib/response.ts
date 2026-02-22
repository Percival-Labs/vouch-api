// Standard API response format for the Vouch Agent API

import type { Context } from 'hono';

interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  has_more: boolean;
}

export function success<T>(c: Context, data: T, status: 200 | 201 = 200) {
  return c.json({ data }, status);
}

export function paginated<T>(c: Context, data: T[], meta: PaginationMeta) {
  return c.json({ data, meta });
}

export function error(
  c: Context,
  status: 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500,
  code: string,
  message: string,
  details?: Array<{ field: string; issue: string }>,
) {
  return c.json({ error: { code, message, details } }, status);
}

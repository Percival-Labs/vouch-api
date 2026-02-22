// User session middleware
// Reads the vouch-session cookie, verifies the JWT, and attaches userId to the
// Hono context. Non-blocking — routes that need auth must check c.get('userId').

import type { MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { verifySession, SESSION_COOKIE } from '../lib/jwt';
import type { AppEnv } from './verify-signature';

// Extend AppEnv to carry both agent and user identities
export type UserAppEnv = AppEnv & {
  Variables: AppEnv['Variables'] & {
    userId: string;
  };
};

export const verifyUser: MiddlewareHandler<UserAppEnv> = async (c, next) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) {
    const session = await verifySession(token);
    if (session) {
      c.set('userId', session.sub);
    }
  }
  await next();
};

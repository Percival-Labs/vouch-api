// Discovery Routes — Agent-facing discoverability layer
// Serves llms.txt, agents.json, and robots.txt for AI agent discovery.
// Files loaded once at startup. Zero runtime dependencies.

import { Hono } from 'hono';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Bun: import.meta.dir gives the directory of this file at runtime.
// Fallback for Node: derive from import.meta.url.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const thisDir: string = (import.meta as any).dir ?? new URL('.', import.meta.url).pathname;
const staticDir = join(thisDir, '..', 'static');

// Load static content at startup (not on every request)
const llmsTxt = readFileSync(join(staticDir, 'llms.txt'), 'utf-8');
const agentsJson = JSON.parse(readFileSync(join(staticDir, 'agents.json'), 'utf-8'));
const agentCard = JSON.parse(readFileSync(join(staticDir, 'agent-card.json'), 'utf-8'));
const robotsTxt = readFileSync(join(staticDir, 'robots.txt'), 'utf-8');

const app = new Hono();

// GET /llms.txt — Human and agent-readable API documentation
app.get('/llms.txt', (c) => {
  return c.text(llmsTxt, 200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'public, max-age=3600',
  });
});

// GET /.well-known/agents.json — Machine-readable agent discovery manifest
app.get('/.well-known/agents.json', (c) => {
  return c.json(agentsJson, 200, {
    'Cache-Control': 'public, max-age=3600',
  });
});

// GET /.well-known/agent.json — Google A2A Agent Card (machine-readable discovery)
app.get('/.well-known/agent.json', (c) => {
  return c.json(agentCard, 200, {
    'Cache-Control': 'public, max-age=3600',
  });
});

// GET /robots.txt — Crawler directives (agents welcome)
app.get('/robots.txt', (c) => {
  return c.text(robotsTxt, 200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'public, max-age=86400',
  });
});

export default app;

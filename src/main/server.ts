import express from 'express';
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { app } from 'electron';
import { PINGLY_DIR, PORT_FILE, PORT_RANGE } from '../shared/paths';
import { AGENT_IDS, SESSION_STATES, type PinglyEvent } from '../shared/types';
import { sessions } from './sessions';
import { handleJump } from './overlay';

const CAP = 200;

function clamp(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, CAP) : undefined;
}

/** Returns a valid event or undefined. Malformed input is dropped, never patched into something plausible. */
function validate(body: unknown): PinglyEvent | undefined {
  if (!body || typeof body !== 'object') return;
  const b = body as Record<string, unknown>;
  if (!AGENT_IDS.includes(b.agent as never)) return;
  if (!SESSION_STATES.includes(b.state as never)) return;
  if (typeof b.cwd !== 'string' || !b.cwd.trim()) return;

  return {
    agent: b.agent as PinglyEvent['agent'],
    state: b.state as PinglyEvent['state'],
    cwd: b.cwd.trim(),
    project: clamp(b.project) || basename(b.cwd.trim()) || b.cwd.trim(),
    sessionId: clamp(b.sessionId),
    message: clamp(b.message),
    detail: clamp(b.detail),
    shimPid: typeof b.shimPid === 'number' ? b.shimPid : 0,
    ts: typeof b.ts === 'number' ? b.ts : Date.now(),
    ...(clamp(b.status) ? { status: clamp(b.status) } : {})
  } as PinglyEvent;
}

export async function startServer(): Promise<number> {
  const api = express();
  api.use(express.json({ limit: '32kb' }));

  // Only local processes should ever reach us; a browser always sends Origin.
  api.use((req, res, next) => {
    if (req.headers.origin) return void res.status(403).end();
    next();
  });

  api.post('/event', (req, res) => {
    const event = validate(req.body);
    if (!event) return void res.status(400).json({});
    console.log('[pingly] event', event);
    sessions.ingest(event);
    res.json({});
  });

  api.get('/health', (_req, res) => res.json({ version: app.getVersion() }));
  // debugging + selftest seam
  api.get('/sessions', (_req, res) => res.json(sessions.visible()));
  api.post('/dismiss', (req, res) => {
    sessions.dismiss(String(req.body?.cwd ?? ''));
    res.json({});
  });
  api.post('/jump', async (req, res) => res.json({ result: await handleJump(String(req.body?.cwd ?? '')) }));

  for (let p = PORT_RANGE[0]; p <= PORT_RANGE[1]; p++) {
    const ok = await new Promise<boolean>((resolve) => {
      const server = api.listen(p, '127.0.0.1', () => resolve(true));
      server.once('error', () => resolve(false));
    });
    if (!ok) continue;
    mkdirSync(PINGLY_DIR, { recursive: true });
    writeFileSync(PORT_FILE, String(p), 'utf8');
    console.log(`[pingly] listening on 127.0.0.1:${p}`);
    return p;
  }
  throw new Error(`no free port in ${PORT_RANGE[0]}-${PORT_RANGE[1]}`);
}

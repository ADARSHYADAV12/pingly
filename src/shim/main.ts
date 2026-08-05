/**
 * pingly-shim — runs on every agent turn. Reads the hook payload, POSTs it to the
 * local Pingly server, exits 0 no matter what. It must never block or fail an agent.
 */
import { request } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

// Duplicated from shared/paths.ts on purpose: the shim must bundle to a single
// standalone file, and sharing the module makes rollup emit a chunk alongside it.
const PINGLY_DIR = join(process.env.LOCALAPPDATA || '', 'Pingly');
const PORT_FILE = join(PINGLY_DIR, 'port');
const CODEX_CHAIN_FILE = join(PINGLY_DIR, 'codex-chain.json');
const DEFAULT_PORT = 47821;

const HARD_DEADLINE_MS = 700;
const POST_TIMEOUT_MS = 300;
const STDIN_TIMEOUT_MS = 150;

// Nothing below is allowed to keep the process alive past this.
const bail = setTimeout(() => process.exit(0), HARD_DEADLINE_MS);
bail.unref();

function flags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    out[key] = next && !next.startsWith('--') ? (i++, next) : 'true';
  }
  return out;
}

/** Codex hands the payload over as a single JSON argv instead of stdin. */
function argvJson(argv: string[]): Record<string, unknown> {
  for (const a of argv) {
    if (a.startsWith('{')) {
      try {
        return JSON.parse(a);
      } catch {
        /* not ours */
      }
    }
  }
  return {};
}

function readStdin(): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve({});
    let buf = '';
    const done = (): void => {
      clearTimeout(timer);
      process.stdin.pause();
      // trim also strips the UTF-8 BOM some shells prepend — JSON.parse would throw on it
      const text = buf.trim();
      try {
        resolve(text.startsWith('{') ? JSON.parse(text) : {});
      } catch {
        resolve({});
      }
    };
    const timer = setTimeout(done, STDIN_TIMEOUT_MS);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (buf += c));
    process.stdin.on('end', done);
    process.stdin.on('error', done);
  });
}

function port(): number {
  try {
    const n = parseInt(readFileSync(PORT_FILE, 'utf8').trim(), 10);
    if (n >= 1 && n <= 65535) return n;
  } catch {
    /* not running, or never launched */
  }
  return DEFAULT_PORT;
}

function post(body: string): Promise<void> {
  return new Promise((resolve) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: port(),
        path: '/event',
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
        timeout: POST_TIMEOUT_MS
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve());
      }
    );
    req.on('timeout', () => (req.destroy(), resolve()));
    req.on('error', () => resolve());
    req.end(body);
  });
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/** Set PINGLY_DEBUG=1 to trace a misbehaving hook on stderr; silent otherwise. */
const debug = (...m: unknown[]): void => {
  if (process.env.PINGLY_DEBUG) console.error('[shim]', ...m);
};

/** Standard CommandLineToArgvW quoting, so the callee reassembles the exact argument. */
function winQuote(a: string): string {
  if (a && !/[\s"]/.test(a)) return a;
  return '"' + a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1') + '"';
}

/**
 * Codex allows only one `notify` program, so wiring Pingly displaces whatever was there.
 * Re-run it with the identical payload, detached, so nothing the user already had breaks.
 */
function runDisplacedNotify(rawPayload: string): Promise<void> {
  return new Promise((resolve) => {
    let child;
    try {
      const saved = JSON.parse(readFileSync(CODEX_CHAIN_FILE, 'utf8'));
      const argv = Array.isArray(saved) ? saved : saved?.argv;
      if (!Array.isArray(argv) || !argv.length) return resolve();

      const full = [...argv, rawPayload];
      const opts = { detached: true, stdio: 'ignore' as const, windowsHide: true };

      // Windows cannot exec a .cmd/.bat directly — it has to go through the interpreter,
      // and cmd /s only strips the outermost quote pair, so the line is built by hand.
      // ponytail: a literal % in the payload would still be expanded by cmd. JSON rarely
      // has one; escape it here if that ever bites.
      debug('chain argv', JSON.stringify(full));
      if (/\.(cmd|bat)$/i.test(argv[0])) {
        const line = full.map(winQuote).join(' ');
        debug('chain via cmd:', `/d /s /c "${line}"`);
        child = spawn(process.env.COMSPEC || 'cmd.exe', [`/d /s /c "${line}"`], {
          ...opts,
          windowsVerbatimArguments: true
        });
      } else {
        child = spawn(full[0], full.slice(1), opts);
      }
    } catch (e) {
      debug('chain skipped:', (e as Error).message); // nothing displaced, or record unreadable
      return resolve();
    }

    // The child must be fully spawned before this process exits, or exiting kills it.
    child.once('spawn', () => {
      debug('chain spawned pid', child.pid);
      child.unref();
      resolve();
    });
    child.once('error', (e) => {
      debug('chain error:', e.message);
      resolve();
    });
    setTimeout(() => {
      debug('chain timed out waiting for spawn');
      resolve();
    }, 300).unref();
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const f = flags(argv);
  const payload = { ...argvJson(argv), ...(await readStdin()) } as Record<string, unknown>;
  debug('argv', JSON.stringify(argv), 'payload', JSON.stringify(payload));

  const chained =
    f.agent === 'codex' ? runDisplacedNotify(argv.find((a) => a.startsWith('{')) ?? '{}') : Promise.resolve();

  // Antigravity reports the folder as workspacePaths[] and uses camelCase throughout.
  const workspace = Array.isArray(payload.workspacePaths) ? str(payload.workspacePaths[0]) : undefined;
  // CLI flags win for agent/state; the payload wins for message and cwd.
  const cwd = str(payload.cwd) || workspace || str(payload.workspace_root) || process.cwd();
  // Cursor's stop hook reports how the turn ended; 'aborted' is dropped by the session store.
  const status = str(payload.status);
  const event = {
    agent: f.agent || 'generic',
    state: status === 'error' ? 'error' : f.state || 'done',
    project: basename(cwd) || cwd,
    cwd,
    sessionId: str(payload.session_id) || str(payload.conversation_id) || str(payload.conversationId),
    // Codex's only signal is the assistant's closing message; 80 chars is a dock line
    message:
      str(payload['last-assistant-message'])?.slice(0, 80) || str(payload.message) || str(f.message),
    detail: str(f.detail) || str(payload.command),
    shimPid: process.pid,
    ts: Date.now(),
    status
  };

  await Promise.all([post(JSON.stringify(event)), chained]);
}

main()
  .catch(() => {})
  .finally(() => {
    // Cursor treats a hook with no stdout as a crash. Claude Code does the opposite:
    // UserPromptSubmit stdout is injected into the prompt, so stay silent there.
    if (process.argv.includes('cursor')) process.stdout.write('{}');
    process.exit(0);
  });

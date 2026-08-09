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

const HARD_DEADLINE_MS = 1500;
const POST_TIMEOUT_MS = 300;
// Cursor v1 hooks on Windows launch the command first, then PowerShell begins piping
// the JSON temp file. On real machines the first byte can arrive well after 150 ms.
const STDIN_TIMEOUT_MS = 1000;

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
    let settled = false;
    const done = (waitForCompleteJson = false): void => {
      if (settled) return;
      const text = buf.trim();
      if (waitForCompleteJson && text.startsWith('{')) {
        try {
          const value = JSON.parse(text);
          settled = true;
          clearTimeout(timer);
          process.stdin.pause();
          resolve(value);
          return;
        } catch {
          return;
        }
      }
      settled = true;
      clearTimeout(timer);
      process.stdin.pause();
      // trim also strips the UTF-8 BOM some shells prepend — JSON.parse would throw on it
      try {
        resolve(text.startsWith('{') ? JSON.parse(text) : {});
      } catch {
        resolve({});
      }
    };
    const timer = setTimeout(done, STDIN_TIMEOUT_MS);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => {
      buf += c;
      done(true);
    });
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

function firstStr(v: unknown): string | undefined {
  return Array.isArray(v) ? v.map(str).find(Boolean) : undefined;
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
  // Cursor imports ~/.claude hooks and marks every hook process with this private
  // project environment variable. Drop that compatible copy before waiting for stdin;
  // otherwise a slow/empty pipe can masquerade as a real Claude Code session.
  if (f.agent === 'claude-code' && process.env.CURSOR_PROJECT_DIR !== undefined) {
    debug('skipping Claude-compatible hook launched by Cursor environment');
    return;
  }
  const argPayload = argvJson(argv);
  // Codex already supplies a complete argv payload; do not make it wait for an
  // inherited stdin stream that may remain open.
  const stdinPayload = Object.keys(argPayload).length ? {} : await readStdin();
  const payload = { ...argPayload, ...stdinPayload } as Record<string, unknown>;
  debug('argv', JSON.stringify(argv), 'payload', JSON.stringify(payload));

  const chained =
    f.agent === 'codex' ? runDisplacedNotify(argv.find((a) => a.startsWith('{')) ?? '{}') : Promise.resolve();

  // Cursor deliberately imports compatible hooks from ~/.claude/settings.json as well
  // as running ~/.cursor/hooks.json. Both receive Cursor's generation metadata, so drop
  // the translated Claude copy and let the native Cursor event represent the turn.
  const cursorGeneration = str(payload.generation_id) || str(payload.generationId);
  const cursorCompatPayload =
    !!cursorGeneration &&
    (Array.isArray(payload.workspace_roots) || Array.isArray(payload.workspaceRoots) || str(payload.composer_mode));
  if (f.agent === 'claude-code' && cursorCompatPayload) {
    debug('skipping Claude-compatible hook duplicated by Cursor', cursorGeneration);
    await chained;
    return;
  }

  // CLI flags win for agent/state; the payload wins for message and cwd.
  const conversationId = str(payload.conversation_id) || str(payload.conversationId);
  const workspace =
    str(payload.cwd) ||
    str(payload.workspace_root) ||
    firstStr(payload.workspace_roots) ||
    firstStr(payload.workspaceRoots);
  // Cursor's home Agent intentionally reports workspace_roots: []. Use its
  // conversation as a stable logical destination instead of ~/.cursor.
  const cursorHome = f.agent === 'cursor' && !!cursorGeneration && !workspace && !!conversationId;
  const cwd = cursorHome ? `cursor-agent://${conversationId}` : workspace || process.cwd();
  // Cursor's stop hook reports how the turn ended; 'aborted' is dropped by the session store.
  const status = str(payload.status);
  // AskUserQuestion arrives as a PreToolUse call whose input holds the question itself
  const toolInput = payload.tool_input as Record<string, unknown> | undefined;
  const question = Array.isArray(toolInput?.questions)
    ? (toolInput.questions[0] as Record<string, unknown> | undefined)
    : undefined;
  const event = {
    agent: f.agent || 'generic',
    state: status === 'error' ? 'error' : f.state || 'done',
    project: cursorHome ? 'Cursor Agent' : basename(cwd) || cwd,
    cwd,
    sessionId: str(payload.session_id) || conversationId,
    turnId: str(payload.turn_id) || str(payload['turn-id']) || cursorGeneration,
    // Codex includes the assistant's closing message; 80 chars is a dock line.
    message:
      str(payload['last-assistant-message'])?.slice(0, 80) ||
      str(payload.last_assistant_message)?.slice(0, 80) ||
      str(question?.question) || // show the actual question, not just "you are needed"
      str(payload.message) ||
      str(f.message),
    // the command awaiting approval, or the question's own short header
    detail: str(f.detail) || str(payload.command) || str(toolInput?.command) || str(question?.header),
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
    // Cursor requires JSON output, and Codex Stop requires valid JSON on a successful
    // hook. Codex's legacy notify callback ignores stdout, so this is safe there too.
    if (process.argv.includes('cursor') || process.argv.includes('codex')) process.stdout.write('{}');
    process.exit(0);
  });

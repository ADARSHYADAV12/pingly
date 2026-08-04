import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parse } from 'smol-toml';
import { CODEX_CHAIN_FILE, PINGLY_DIR } from '../../shared/paths';
import { type Adapter, isCurrent, isOurs, readText, shimArgv, writeText } from './types';
import { mkdirSync } from 'node:fs';

const DIR = join(homedir(), '.codex');
const FILE = join(DIR, 'config.toml');

/**
 * Index of the first `[table]` header. TOML root keys must appear above every table,
 * so this is where `notify` has to go — get it wrong and the whole file fails to parse.
 * Bracket depth is tracked so a multi-line array value is not mistaken for a header.
 */
function firstTableLine(lines: string[]): number {
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    if (depth === 0 && /^\s*\[/.test(lines[i])) return i;
    for (const ch of lines[i]) {
      if (ch === '[') depth++;
      else if (ch === ']') depth--;
    }
    if (depth < 0) depth = 0;
  }
  return lines.length;
}

/** Line span of a root-level `key = ...`, following a multi-line array to its close. */
function rootKeyRange(lines: string[], key: string): [number, number] | null {
  const limit = firstTableLine(lines);
  const re = new RegExp(`^\\s*${key}\\s*=`);
  for (let i = 0; i < limit; i++) {
    if (!re.test(lines[i])) continue;
    let depth = 0;
    for (let j = i; j < lines.length; j++) {
      for (const ch of lines[j]) {
        if (ch === '[') depth++;
        else if (ch === ']') depth--;
      }
      if (depth <= 0) return [i, j];
    }
    return [i, lines.length - 1];
  }
  return null;
}

/** The exact source text of the root `notify` assignment, so it can be put back verbatim. */
function notifyLineText(text: string): string | null {
  const lines = text.split('\n');
  const r = rootKeyRange(lines, 'notify');
  return r ? lines.slice(r[0], r[1] + 1).join('\n') : null;
}

/**
 * Rewrites only the `notify` assignment and leaves the rest of the file byte-identical —
 * re-serialising the document would churn comments, quoting style and key order.
 * A new key is inserted above the first table, because TOML root keys must precede tables.
 * The result is re-parsed before it is written; a malformed edit throws instead.
 */
function setNotify(text: string, newLine: string | null, expect: string[] | null): string {
  const lines = text.split('\n');
  const range = rootKeyRange(lines, 'notify');
  const replacement = newLine ? newLine.split('\n') : [];

  if (range) lines.splice(range[0], range[1] - range[0] + 1, ...replacement);
  else if (newLine) lines.splice(firstTableLine(lines), 0, ...replacement);

  const out = lines.join('\n');
  const got = JSON.stringify((parse(out) as Record<string, unknown>).notify ?? null);
  if (got !== JSON.stringify(expect)) throw new Error(`codex notify edit failed: got ${got}`);
  return out;
}

function currentNotify(text: string): string[] | null {
  try {
    const n = (parse(text) as Record<string, unknown>).notify;
    return Array.isArray(n) && n.every((x) => typeof x === 'string') ? (n as string[]) : null;
  } catch {
    return null;
  }
}

/** What Pingly displaced: the argv the shim must re-run, and the source line to restore. */
interface Chain {
  argv: string[];
  line: string | null;
}

function readChain(): Chain | null {
  try {
    const v = JSON.parse(readText(CODEX_CHAIN_FILE));
    if (Array.isArray(v)) return v.length ? { argv: v, line: null } : null;
    return Array.isArray(v?.argv) && v.argv.length ? v : null;
  } catch {
    return null;
  }
}

export const codex: Adapter = {
  id: 'codex',
  displayName: 'Codex CLI',
  configPath: FILE,
  description: 'Tells you when a turn completes. Any notify program you already use keeps working.',

  async isInstalled() {
    return existsSync(DIR);
  },

  async isWired() {
    const n = currentNotify(readText(FILE));
    return !!n && isCurrent(n.join(' '));
  },

  async wire() {
    const text = readText(FILE);
    const existing = currentNotify(text);

    // Codex allows exactly one notify program. Anything already there is preserved and
    // re-run by the shim, so wiring Pingly never silently disables another integration.
    if (existing && !isOurs(existing.join(' '))) {
      const chain: Chain = { argv: existing, line: notifyLineText(text) };
      mkdirSync(PINGLY_DIR, { recursive: true });
      writeFileSync(CODEX_CHAIN_FILE, JSON.stringify(chain), 'utf8');
    }

    const argv = shimArgv('codex', 'done');
    writeText(FILE, setNotify(text, `notify = ${JSON.stringify(argv)}`, argv));
  },

  async unwire() {
    const text = readText(FILE);
    if (!currentNotify(text)) return;
    // hand the slot back to whoever had it, in their original formatting
    const chain = readChain();
    const line = chain ? (chain.line ?? `notify = ${JSON.stringify(chain.argv)}`) : null;
    writeText(FILE, setNotify(text, line, chain ? chain.argv : null));
    rmSync(CODEX_CHAIN_FILE, { force: true });
  }
};

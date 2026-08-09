import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CODEX_CHAIN_FILE, LEGACY_DIR, PINGLY_DIR } from '../../shared/paths';
import type { AgentId } from '../../shared/types';
import { settings } from '../settings';
import { isOurs, nodeInfo, readJson, readText, writeJson, type Adapter } from './types';
import { claudeCode } from './claudecode';
import { cursor } from './cursor';
import { codex } from './codex';

export const adapters: Adapter[] = [claudeCode, cursor, codex];

export interface Runtime {
  /** Hooks shell out to node; without it nothing Pingly wires can ever fire. */
  nodeFound: boolean;
  nodePath: string;
}

export const runtime = (): Runtime => {
  const n = nodeInfo();
  return { nodeFound: n.found, nodePath: n.path };
};

export interface AdapterStatus {
  id: AgentId;
  displayName: string;
  configPath: string;
  description: string;
  installed: boolean;
  wired: boolean;
  /** Cursor reloads hooks.json on save; Claude Code needs a fresh session. */
  needsRestart: boolean;
  /** Codex will skip newly written lifecycle hooks until the user trusts them in /hooks. */
  needsTrustApproval: boolean;
}

export async function listAdapters(): Promise<AdapterStatus[]> {
  return Promise.all(
    adapters.map(async (a) => ({
      id: a.id,
      displayName: a.displayName,
      configPath: a.configPath,
      description: a.description,
      installed: await a.isInstalled(),
      wired: await a.isWired(),
      needsRestart: a.id !== 'cursor',
      needsTrustApproval: a.id === 'codex' && (await a.isWired()) && !settings.get('codexHooksTrusted')
    }))
  );
}

function remember(): void {
  Promise.all(adapters.map(async (a) => ((await a.isWired()) ? a.id : null))).then((ids) =>
    settings.set('wiredAdapters', ids.filter(Boolean) as AgentId[])
  );
}

export async function setWired(id: AgentId, on: boolean): Promise<void> {
  const a = adapters.find((x) => x.id === id);
  if (!a) throw new Error(`unknown adapter ${id}`);
  await (on ? a.wire() : a.unwire());
  // Reconnecting can change the trusted hook definition, so guide the user through
  // Codex's review again instead of claiming setup is complete prematurely.
  if (id === 'codex') settings.set('codexHooksTrusted', false);
  remember();
}

export function confirmCodexHookTrust(): void {
  settings.set('codexHooksTrusted', true);
}

/**
 * The Antigravity adapter is gone: its hook runner hands the command to cmd with the
 * outer quotes still attached, so `"C:\Program Files\nodejs\node.exe"` was never a
 * program it could find and every hook we wrote there failed silently.
 *
 * Dropping the adapter is not enough on its own — without this, anyone who wired it in
 * an earlier build keeps dead entries in ~/.gemini/config/hooks.json forever, because
 * only the adapter knew how to remove them. Same trap the pre-rename `nudge` group fell
 * into, which is why that key goes too.
 */
function dropAntigravityHooks(): void {
  const file = join(homedir(), '.gemini', 'config', 'hooks.json');
  if (!existsSync(file)) return;
  const cfg = readJson(file);
  const stale = ['pingly', 'nudge'].filter((k) => k in cfg);
  if (!stale.length) return;
  for (const k of stale) delete cfg[k];
  writeJson(file, cfg);
  console.log(`[pingly] removed stale Antigravity hooks (${stale.join(', ')})`);
}

/**
 * One-time carry-over from the pre-rename build. Hooks written by Nudge point at a shim
 * path that no longer exists, so they would fail silently; re-wiring rewrites them in
 * place. The Codex chain record moves first — without it, unwire could not give Codex's
 * `notify` slot back to whatever program Nudge displaced.
 */
export async function migrateFromLegacy(): Promise<void> {
  dropAntigravityHooks();

  if (existsSync(LEGACY_DIR) && !existsSync(CODEX_CHAIN_FILE)) {
    const old = join(LEGACY_DIR, 'codex-chain.json');
    if (existsSync(old)) {
      mkdirSync(PINGLY_DIR, { recursive: true });
      copyFileSync(old, CODEX_CHAIN_FILE);
      console.log('[pingly] carried over the Codex chain record');
    }
  }

  for (const a of adapters) {
    const stale = isOurs(readText(a.configPath)) && !(await a.isWired());
    if (!stale) continue;
    await a.wire();
    if (a.id === 'codex') settings.set('codexHooksTrusted', false);
    console.log(`[pingly] re-wired ${a.displayName} to the new shim path`);
  }
  remember();
}

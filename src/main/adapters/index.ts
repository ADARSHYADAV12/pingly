import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { CODEX_CHAIN_FILE, LEGACY_DIR, PINGLY_DIR } from '../../shared/paths';
import type { AgentId } from '../../shared/types';
import { settings } from '../settings';
import { isOurs, nodeInfo, readText, type Adapter } from './types';
import { claudeCode } from './claudecode';
import { cursor } from './cursor';
import { codex } from './codex';
import { antigravity } from './antigravity';

export const adapters: Adapter[] = [claudeCode, cursor, codex, antigravity];

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
      needsRestart: a.id !== 'cursor'
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
  remember();
}

/**
 * One-time carry-over from the pre-rename build. Hooks written by Nudge point at a shim
 * path that no longer exists, so they would fail silently; re-wiring rewrites them in
 * place. The Codex chain record moves first — without it, unwire could not give Codex's
 * `notify` slot back to whatever program Nudge displaced.
 */
export async function migrateFromLegacy(): Promise<void> {
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
    console.log(`[pingly] re-wired ${a.displayName} to the new shim path`);
  }
  remember();
}

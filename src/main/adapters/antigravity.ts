import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { type Adapter, isCurrent, isOurs, readJson, shimCommand, writeJson } from './types';

// Antigravity keeps its global customizations under ~/.gemini; workspace-level hooks
// live in .agents/hooks.json, which we deliberately leave to the user.
const GEMINI = join(homedir(), '.gemini');
const FILE = join(GEMINI, 'config', 'hooks.json');

/**
 * Hook groups are keyed by name, so everything we add lives under one key and unwire is
 * a single delete — it can never touch a group the user wrote.
 */
const GROUP = 'pingly';

interface HookGroup {
  enabled?: boolean;
  [event: string]: unknown;
}

const entry = (state: 'done' | 'needs-input' | 'working', matcher?: string): unknown => ({
  ...(matcher ? { matcher } : {}),
  hooks: [{ type: 'command', command: shimCommand('antigravity', state) }]
});

const OURS: HookGroup = {
  // Stop fires when the agent's execution loop terminates
  Stop: [entry('done')],
  // PreToolUse fires before every tool call and carries no "waiting on the user" signal,
  // so it only refreshes activity rather than raising an approval alert.
  PreToolUse: [entry('working', 'run_command')]
};

export const antigravity: Adapter = {
  id: 'antigravity',
  displayName: 'Antigravity',
  configPath: FILE,
  description: 'Tells you when the agent stops. Antigravity gives no approval signal, so there is no approval alert.',

  async isInstalled() {
    return existsSync(join(GEMINI, 'antigravity')) || existsSync(join(homedir(), '.antigravity'));
  },

  async isWired() {
    const group = readJson(FILE)[GROUP] as HookGroup | undefined;
    return !!group && isCurrent(JSON.stringify(group));
  },

  async wire() {
    const cfg = readJson(FILE);
    cfg[GROUP] = OURS;
    writeJson(FILE, cfg);
  },

  async unwire() {
    const cfg = readJson(FILE);
    if (!(GROUP in cfg)) return;
    delete cfg[GROUP];
    writeJson(FILE, cfg);
  }
};

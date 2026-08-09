import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { type Adapter, isCurrent, isOurs, readJson, shimCommand, writeJson } from './types';

const DIR = join(homedir(), '.cursor');
const FILE = join(DIR, 'hooks.json');

interface Entry {
  command?: string;
}

const OURS: Record<string, Entry> = {
  // Per-turn signal: unlike sessionStart, this fires every time the user submits a prompt.
  beforeSubmitPrompt: { command: shimCommand('cursor', 'working') },
  stop: { command: shimCommand('cursor', 'done') },
  // Cursor has no "the user was actually asked" event: beforeShellExecution fires before
  // every shell command. Treating it as needs-input popped a card on each one, so it only
  // refreshes the session's activity instead.
  beforeShellExecution: { command: shimCommand('cursor', 'working') }
};

function hooksOf(cfg: Record<string, unknown>): Record<string, Entry[]> {
  const h = cfg.hooks;
  return h && typeof h === 'object' ? (h as Record<string, Entry[]>) : {};
}

export const cursor: Adapter = {
  id: 'cursor',
  displayName: 'Cursor',
  configPath: FILE,
  description: 'Shows a live timer and tells you when a task finishes. Cursor gives no permission-prompt signal.',

  async isInstalled() {
    return existsSync(DIR);
  },

  async isWired() {
    const hooks = hooksOf(readJson(FILE));
    return Object.keys(OURS).every((event) => (hooks[event] ?? []).some((e) => isCurrent(e.command)));
  },

  async wire() {
    const cfg = readJson(FILE);
    const hooks = hooksOf(cfg);
    // Remove every older Pingly entry first. Cursor 1.x rejects the newer `sessionStart`
    // event as unknown, invalidating the whole file; `beforeSubmitPrompt` is supported and
    // is the correct per-turn signal anyway.
    for (const event of Object.keys(hooks)) {
      const kept = (hooks[event] ?? []).filter((entry) => !isOurs(entry.command));
      if (kept.length) hooks[event] = kept;
      else delete hooks[event];
    }
    for (const [event, entry] of Object.entries(OURS)) {
      hooks[event] = [...(hooks[event] ?? []), entry];
    }
    cfg.version = 1;
    cfg.hooks = hooks;
    writeJson(FILE, cfg);
  },

  async unwire() {
    const cfg = readJson(FILE);
    const hooks = hooksOf(cfg);
    for (const event of Object.keys(hooks)) {
      const kept = (hooks[event] ?? []).filter((e) => !isOurs(e.command));
      if (kept.length) hooks[event] = kept;
      else delete hooks[event];
    }
    cfg.hooks = hooks;
    writeJson(FILE, cfg);
  }
};

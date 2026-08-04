import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { type Adapter, isCurrent, isOurs, readJson, shimCommand, writeJson } from './types';

const DIR = join(homedir(), '.claude');
const FILE = join(DIR, 'settings.json');

interface HookEntry {
  type?: string;
  command?: string;
}
interface HookGroup {
  matcher?: string;
  hooks?: HookEntry[];
}

const cmd = (state: 'done' | 'needs-input' | 'working'): HookGroup => ({
  hooks: [{ type: 'command', command: shimCommand('claude-code', state) }]
});

/** Stop fires on task completion but not on Esc — a task you cancelled needs no notification. */
const OURS: Record<string, HookGroup[]> = {
  Stop: [cmd('done')],
  Notification: [
    { matcher: 'permission_prompt', ...cmd('needs-input') },
    { matcher: 'idle_prompt', ...cmd('needs-input') }
  ],
  // without this the dock never learns a task started, so it can show no elapsed time
  UserPromptSubmit: [cmd('working')]
};

function hooksOf(cfg: Record<string, unknown>): Record<string, HookGroup[]> {
  const h = cfg.hooks;
  return h && typeof h === 'object' ? (h as Record<string, HookGroup[]>) : {};
}

export const claudeCode: Adapter = {
  id: 'claude-code',
  displayName: 'Claude Code',
  configPath: FILE,
  description: 'Tells you when a task finishes, and when it asks for permission or goes idle.',

  async isInstalled() {
    return existsSync(DIR);
  },

  async isWired() {
    const hooks = hooksOf(readJson(FILE));
    return Object.keys(OURS).every((event) =>
      (hooks[event] ?? []).some((g) => (g.hooks ?? []).some((h) => isCurrent(h.command)))
    );
  },

  async wire() {
    const cfg = readJson(FILE);
    const hooks = hooksOf(cfg);
    for (const [event, groups] of Object.entries(OURS)) {
      const existing = (hooks[event] ?? []).filter((g) => !(g.hooks ?? []).some((h) => isOurs(h.command)));
      hooks[event] = [...existing, ...groups];
    }
    cfg.hooks = hooks;
    writeJson(FILE, cfg);
  },

  async unwire() {
    const cfg = readJson(FILE);
    const hooks = hooksOf(cfg);
    for (const event of Object.keys(hooks)) {
      // strip our commands, then drop groups and events left empty — but never a
      // group that still holds one of the user's own hooks
      const kept = (hooks[event] ?? [])
        .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isOurs(h.command)) }))
        .filter((g) => g.hooks.length > 0);
      if (kept.length) hooks[event] = kept;
      else delete hooks[event];
    }
    if (Object.keys(hooks).length) cfg.hooks = hooks;
    else delete cfg.hooks;
    writeJson(FILE, cfg);
  }
};

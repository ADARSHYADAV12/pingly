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

/**
 * Every Notification type that means "blocked, waiting on the human". `agent_needs_input`
 * is the one AskUserQuestion raises — the whole point of the app — and leaving it out meant
 * the dock sat on `working` through the entire question. `elicitation_dialog` is the MCP
 * equivalent. The two types that are *not* here, `auth_success` and `agent_completed`, do
 * not need you.
 */
const BLOCKED_ON_USER = ['agent_needs_input', 'permission_prompt', 'idle_prompt', 'elicitation_dialog'];

/**
 * Tools that stop and wait for a human answer. This is the reliable signal: PreToolUse
 * matches on tool name, and the question dialog *is* a tool call. The Notification types
 * above never fired in practice, so they are kept only as a belt-and-braces fallback.
 */
const BLOCKING_TOOLS = 'AskUserQuestion|ExitPlanMode';

/** Stop fires on task completion but not on Esc — a task you cancelled needs no notification. */
const OURS: Record<string, HookGroup[]> = {
  Stop: [cmd('done')],
  Notification: BLOCKED_ON_USER.map((matcher) => ({ matcher, ...cmd('needs-input') })),
  // the agent is about to block on a question
  PreToolUse: [{ matcher: BLOCKING_TOOLS, ...cmd('needs-input') }],
  // answered — it is thinking again
  PostToolUse: [{ matcher: BLOCKING_TOOLS, ...cmd('working') }],
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

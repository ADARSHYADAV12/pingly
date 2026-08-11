/**
 * Verifies wire/unwire never damages a config we do not own.
 * Run it against a throwaway home:
 *   $env:USERPROFILE = "$env:TEMP\pingly-adapter-test"; node out/main/adaptertest.js
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { claudeCode } from '../src/main/adapters/claudecode';
import { cursor } from '../src/main/adapters/cursor';
import { codex } from '../src/main/adapters/codex';
import { SessionStore } from '../src/main/sessions';
import { consumeCodexJournal, type CodexJournalState } from '../src/main/codex-session-watcher';
import {
  CURSOR_TAIL_POLL_MS,
  consumeCursorHookLog,
  type CursorHookLogState
} from '../src/main/cursor-session-watcher';
import { launchCodexHookReview } from '../src/main/codex-hook-review';
import { CODEX_CHAIN_FILE, PORT_FILE } from '../src/shared/paths';
import type { PinglyEvent } from '../src/shared/types';
import { shouldExpandForSessions, workingSetChanged } from '../src/shared/dock-state';

const home = homedir();
assert.ok(home.includes('pingly-adapter-test'), `refusing to run against a real home: ${home}`);
// the codex chain file hangs off LOCALAPPDATA, not the home dir — it must be redirected
// too, or a test run would delete the record needed to restore a real notify program
assert.ok(
  CODEX_CHAIN_FILE.includes('pingly-adapter-test'),
  `refusing to run against a real LOCALAPPDATA: ${CODEX_CHAIN_FILE}`
);

const read = (f: string): any => JSON.parse(readFileSync(f, 'utf8'));
const has = (o: unknown): boolean => JSON.stringify(o).includes('pingly-shim');

async function main(): Promise<void> {
rmSync(home, { recursive: true, force: true });

/* ---------------- working dock always starts collapsed ---------------- */
{
  const working = (cwd: string, turnId: string): any => ({ agent: 'cursor', cwd, turnId, state: 'working' });
  assert.equal(workingSetChanged([], [working('cursor-agent://pending', 'watch-1')]), true);
  assert.equal(
    workingSetChanged([working('cursor-agent://pending', 'watch-1')], [working('cursor-agent://pending', 'watch-1')]),
    false,
    'a heartbeat must not repeatedly disturb hover state'
  );
  assert.equal(
    workingSetChanged([{ ...working('cursor-agent://one', 'turn-1'), state: 'done' }], [working('cursor-agent://one', 'turn-2')]),
    true,
    'a later Cursor turn must reset an old expanded completion card to the timer pill'
  );
  assert.equal(
    workingSetChanged(
      [working('cursor-agent://pending', 'cursor-watch-1')],
      [working('cursor-agent://conversation-1', 'cursor-turn-1')]
    ),
    false,
    'the delayed Cursor identity handoff must preserve an intentional hover expansion'
  );
}

/* ---------------- completed dock waits for explicit user action ---------------- */
{
  assert.equal(shouldExpandForSessions([{ state: 'working' }]), false, 'working starts as the timer pill');
  assert.equal(shouldExpandForSessions([{ state: 'done' }]), true, 'a completed card must remain expanded');
  assert.equal(shouldExpandForSessions([{ state: 'needs-input' }]), true, 'an input request must remain expanded');
  assert.equal(shouldExpandForSessions([{ state: 'error' }]), true, 'an error must remain expanded');
  assert.equal(shouldExpandForSessions([]), false, 'closing the last card hides the dock');
}

/* ---------------- immediate Cursor lifecycle watcher ---------------- */
{
  assert.ok(CURSOR_TAIL_POLL_MS <= 100, 'Cursor lifecycle fallback must react in at most 100 ms');
  const state: CursorHookLogState = { buffer: '' };
  assert.deepEqual(consumeCursorHookLog(state, '[2026-08-09T00:00:00.000Z] Hook step reques'), []);
  assert.equal(
    consumeCursorHookLog(state, 'ted: beforeSubmitPrompt\n')[0]?.project,
    'Cursor Agent',
    'Cursor log must start the working pill before its slow Windows hook returns'
  );
  assert.deepEqual(
    consumeCursorHookLog(state, '[2026-08-09T00:00:01.000Z] Hook step requested: stop\n'),
    [],
    'the watcher must leave completion to the authoritative stop hook'
  );
}

/* ---------------- Cursor payload and Claude-compat dedupe ---------------- */
{
  const received: PinglyEvent[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      received.push(JSON.parse(body) as PinglyEvent);
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  mkdirSync(join(process.env.LOCALAPPDATA!, 'Pingly'), { recursive: true });
  writeFileSync(PORT_FILE, String(address.port));

  const runShim = (agent: 'claude-code' | 'cursor', payload: string, cursorEnvironment = false): Promise<void> =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [join(process.cwd(), 'out', 'main', 'shim.js'), '--agent', agent, '--state', 'working'], {
        stdio: ['pipe', 'ignore', 'inherit'],
        env: cursorEnvironment ? { ...process.env, CURSOR_PROJECT_DIR: 'C:\\Users\\test\\.cursor' } : process.env
      });
      child.once('error', reject);
      child.once('close', () => resolve());
      // Cursor v1 hooks on Windows start the downstream process, then pipe a temp
      // file through PowerShell. Reproduce the delayed first byte seen in practice.
      if (cursorEnvironment) child.stdin.end(payload);
      else setTimeout(() => child.stdin.end(payload), 300);
    });

  await runShim('claude-code', '{}', true);
  assert.equal(received.length, 0, 'Cursor must never create a fallback Claude Code dock');

  // Cursor intentionally imports compatible Claude Code hooks. Pingly must keep only
  // Cursor's native event and use the real workspace rather than ~/.claude or ~/.cursor.
  const workspacePayload = JSON.stringify({
    conversation_id: 'cursor-conversation',
    generation_id: 'cursor-generation',
    workspace_roots: ['C:\\work\\real-project'],
    composer_mode: 'agent'
  });
  await runShim('claude-code', workspacePayload);
  await runShim('cursor', workspacePayload);
  assert.equal(received.length, 1, 'one Cursor turn must produce one Pingly session');
  assert.equal(received[0]?.agent, 'cursor');
  assert.equal(received[0]?.cwd, 'C:\\work\\real-project');
  assert.equal(received[0]?.turnId, 'cursor-generation');

  // Cursor's home Agent has no open workspace. It still needs one stable dock and a
  // usable Cursor destination rather than two fake ~/.cursor + ~/.claude projects.
  received.length = 0;
  const homeAgentPayload = JSON.stringify({
    conversation_id: 'cursor-home-conversation',
    generation_id: 'cursor-home-generation',
    workspace_roots: [],
    composer_mode: 'agent'
  });
  await runShim('claude-code', homeAgentPayload);
  await runShim('cursor', homeAgentPayload);
  server.close();
  assert.equal(received.length, 1, 'Cursor home Agent must also produce one session');
  assert.equal(received[0]?.agent, 'cursor');
  assert.equal(received[0]?.cwd, 'cursor-agent://cursor-home-conversation');
  assert.equal(received[0]?.project, 'Cursor Agent');
}

/* ---------------- Codex hook-review handoff ---------------- */
{
  let copied = '';
  let launched: { command: string; args: readonly string[]; options: Record<string, unknown> } | undefined;
  let unrefed = false;
  const result = launchCodexHookReview({
    copyText: (text) => (copied = text),
    command: 'C:\\Windows\\System32\\cmd.exe',
    spawnProcess: (command, args, options) => {
      launched = { command, args, options };
      return { unref: () => (unrefed = true) };
    }
  });

  assert.equal(copied, '/hooks', 'the exact review command must be copied');
  assert.deepEqual(launched?.args, ['/d', '/k', 'codex'], 'Codex must open interactively, not bypass trust');
  assert.equal(launched?.options.windowsHide, false, 'the approval terminal must be visible');
  assert.equal(launched?.options.detached, true, 'the terminal must outlive the setup window');
  assert.equal(unrefed, true);
  assert.equal(result.opened, true);

  const fallback = launchCodexHookReview({
    copyText: () => {},
    spawnProcess: () => {
      throw new Error('not found');
    }
  });
  assert.equal(fallback.opened, false, 'launch failure must fall back to the copied command');
  assert.equal(fallback.copied, true);
}

/* ---------------- Codex IDE journal lifecycle ---------------- */
{
  const state: CodexJournalState = { buffer: '' };
  const meta = JSON.stringify({ type: 'session_meta', payload: { id: 'session-1', cwd: 'C:\\work\\journal' } });
  const turn1 = JSON.stringify({ type: 'turn_context', payload: { turn_id: 'turn-1', cwd: 'C:\\work\\journal' } });
  const privateMessage = JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: 'private' } });

  assert.deepEqual(consumeCodexJournal(state, meta.slice(0, 20)), [], 'partial records wait for the next chunk');
  const first = consumeCodexJournal(state, `${meta.slice(20)}\n${privateMessage}\n${turn1}\n`);
  assert.deepEqual(first, [
    { cwd: 'C:\\work\\journal', project: 'journal', sessionId: 'session-1', turnId: 'turn-1' }
  ]);
  assert.deepEqual(consumeCodexJournal(state, `${turn1}\n`), [], 'compaction must not restart the same turn');

  const turn2 = JSON.stringify({ type: 'turn_context', payload: { turn_id: 'turn-2', cwd: 'C:\\work\\journal' } });
  assert.equal(consumeCodexJournal(state, `${turn2}\n`)[0]?.turnId, 'turn-2', 'a later prompt starts a new timer');
}

/* ---------------- session event ordering ---------------- */
{
  const store = new SessionStore();
  const event = (state: PinglyEvent['state'], turnId: string, ts: number): PinglyEvent => ({
    agent: 'codex',
    state,
    cwd: 'C:\\work\\same-turn',
    project: 'same-turn',
    turnId,
    shimPid: 1,
    ts
  });

  store.ingest(event('working', 'turn-1', 100));
  store.ingest(event('done', 'turn-1', 200));
  let notifications = 0;
  store.on('notify', () => notifications++);
  store.ingest(event('done', 'turn-1', 210));
  assert.equal(notifications, 0, 'duplicate completion signals must not chime twice');
  store.ingest(event('working', 'turn-1', 150));
  assert.equal(store.get('C:\\work\\same-turn')?.state, 'done', 'late same-turn heartbeat must not reopen done');

  store.ingest(event('working', 'turn-2', 300));
  assert.equal(store.get('C:\\work\\same-turn')?.state, 'working', 'a new turn must reopen the session');

  const cursorStore = new SessionStore();
  cursorStore.ingest({
    agent: 'cursor', state: 'working', cwd: 'cursor-agent://pending', project: 'Cursor Agent',
    turnId: 'cursor-watch-1', shimPid: 0, ts: 400
  });
  cursorStore.ingest({
    agent: 'cursor', state: 'done', cwd: 'cursor-agent://conversation-1', project: 'Cursor Agent',
    turnId: 'cursor-turn-1', shimPid: 1, ts: 500
  });
  assert.equal(cursorStore.all().length, 1, 'the real Cursor hook must replace, not duplicate, its immediate dock');
  assert.equal(cursorStore.all()[0]?.startedAt, 400, 'Cursor completion must retain the immediate watcher start time');
}

/* ---------------- Claude Code ---------------- */
{
  const f = claudeCode.configPath;
  mkdirSync(join(home, '.claude'), { recursive: true });
  const original = {
    model: 'opus',
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: 'echo user-stop' }] }],
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo user-pretool' }] }]
    }
  };
  writeFileSync(f, JSON.stringify(original, null, 2));

  assert.equal(await claudeCode.isInstalled(), true);
  assert.equal(await claudeCode.isWired(), false, 'clean config must not read as wired');

  await claudeCode.wire();
  const wired = read(f);
  assert.equal(wired.model, 'opus', 'unrelated top-level keys must survive');
  assert.equal(wired.hooks.Stop.length, 2, "user's Stop hook must survive alongside ours");
  assert.equal(wired.hooks.Stop[0].hooks[0].command, 'echo user-stop');
  assert.ok(has(wired.hooks.Stop[1]));
  assert.deepEqual(
    wired.hooks.Notification.map((g: any) => g.matcher),
    ['agent_needs_input', 'permission_prompt', 'idle_prompt', 'elicitation_dialog'],
    'every blocked-on-user notification type must be wired, agent_needs_input above all'
  );
  assert.equal(wired.hooks.UserPromptSubmit.length, 1);
  assert.deepEqual(
    wired.hooks.PreToolUse[0],
    original.hooks.PreToolUse[0],
    "the user's own PreToolUse hook must survive untouched"
  );
  assert.equal(wired.hooks.PreToolUse.length, 2, 'ours is appended, theirs is kept');
  assert.equal(wired.hooks.PreToolUse[1].matcher, 'AskUserQuestion|ExitPlanMode');
  assert.equal(wired.hooks.PermissionRequest.length, 1, 'dedicated approval requests must notify');
  assert.equal(wired.hooks.PostToolUse[0].matcher, undefined, 'every completed tool can resume the working timer');
  assert.equal(await claudeCode.isWired(), true);

  assert.ok(existsSync(`${f}.pingly-backup`), 'original must be backed up before the first write');
  assert.deepEqual(read(`${f}.pingly-backup`), original);

  await claudeCode.wire();
  assert.equal(read(f).hooks.Stop.length, 2, 'wire must be idempotent, not additive');

  await claudeCode.unwire();
  const clean = read(f);
  assert.equal(has(clean), false, 'no trace of us may remain');
  assert.equal(clean.model, 'opus');
  assert.deepEqual(clean.hooks.Stop, original.hooks.Stop, "user's hooks must be byte-identical after unwire");
  assert.deepEqual(clean.hooks.PreToolUse, original.hooks.PreToolUse, 'ours removed, theirs intact');
  assert.equal('PostToolUse' in clean.hooks, false, 'events we created are removed entirely');
  assert.equal('Notification' in clean.hooks, false, 'events we created must be removed entirely');
  assert.equal(await claudeCode.isWired(), false);
}

/* ---------------- Cursor ---------------- */
{
  const f = cursor.configPath;
  mkdirSync(join(home, '.cursor'), { recursive: true });
  const original = {
    version: 1,
    hooks: {
      stop: [{ command: 'echo mine' }],
      afterFileEdit: [{ command: 'echo fmt' }],
      sessionStart: [{ command: 'node C:\\old\\pingly-shim.js --agent cursor --state working' }]
    }
  };
  writeFileSync(f, JSON.stringify(original, null, 2));

  assert.equal(await cursor.isWired(), false);
  await cursor.wire();
  const wired = read(f);
  assert.equal(wired.version, 1);
  assert.equal(wired.hooks.stop.length, 2);
  assert.equal(wired.hooks.stop[0].command, 'echo mine');
  assert.deepEqual(wired.hooks.afterFileEdit, original.hooks.afterFileEdit);
  assert.equal('sessionStart' in wired.hooks, false, 'obsolete Pingly sessionStart hook must be removed');
  assert.ok(has(wired.hooks.beforeShellExecution));
  assert.ok(has(wired.hooks.beforeSubmitPrompt), 'every submitted prompt must start the timer');
  assert.equal(await cursor.isWired(), true);

  await cursor.wire();
  assert.equal(read(f).hooks.stop.length, 2, 'wire must be idempotent');

  await cursor.unwire();
  const clean = read(f);
  assert.equal(has(clean), false);
  assert.deepEqual(clean.hooks.stop, original.hooks.stop);
  assert.deepEqual(clean.hooks.afterFileEdit, original.hooks.afterFileEdit);
  assert.equal(await cursor.isWired(), false);
}

/* ---------------- no config at all ---------------- */
{
  rmSync(claudeCode.configPath, { force: true });
  assert.equal(await claudeCode.isWired(), false);
  await claudeCode.wire();
  assert.equal(await claudeCode.isWired(), true, 'must create the file when none exists');
  await claudeCode.unwire();
  assert.equal(has(read(claudeCode.configPath)), false);
}

/* -------- carry-over from the pre-rename build --------
   Hooks written by Nudge point at a shim path that no longer exists. They must read as
   "not connected", and wiring must replace them rather than pile a second entry on top. */
{
  const f = claudeCode.configPath;
  const legacyCmd = '"C:\\node.exe" "C:\\Users\\me\\AppData\\Local\\Nudge\\bin\\nudge-shim.js" --agent claude-code --state done';
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(
    f,
    JSON.stringify({
      hooks: {
        Stop: [
          { hooks: [{ type: 'command', command: 'echo user-stop' }] },
          { hooks: [{ type: 'command', command: legacyCmd }] }
        ]
      }
    })
  );

  assert.equal(await claudeCode.isWired(), false, 'a stale Nudge hook must not read as connected');

  await claudeCode.wire();
  const wired = read(f);
  const cmds = wired.hooks.Stop.flatMap((g: any) => g.hooks.map((h: any) => h.command));
  assert.equal(cmds.filter((c: string) => c.includes('nudge-shim')).length, 0, 'stale hook must be gone');
  assert.equal(cmds.filter((c: string) => c.includes('pingly-shim')).length, 1, 'exactly one live hook');
  assert.ok(cmds.includes('echo user-stop'), "the user's own hook still survives a migration");
  assert.equal(await claudeCode.isWired(), true);

  await claudeCode.unwire();
  assert.equal(JSON.stringify(read(f)).includes('shim'), false, 'unwire clears both old and new');
}

/* ---------------- Codex: TOML root-key ordering ---------------- */
{
  const f = codex.configPath;
  const hooksFile = join(home, '.codex', 'hooks.json');
  mkdirSync(join(home, '.codex'), { recursive: true });
  rmSync(CODEX_CHAIN_FILE, { force: true });
  const originalHooks = {
    description: 'my hooks',
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo user-pretool' }] }],
      PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo user-posttool' }] }]
    }
  };
  writeFileSync(hooksFile, JSON.stringify(originalHooks, null, 2));

  // the shape that actually breaks: a root key must never land below a [table]
  const original =
    'model = "gpt-5.6-sol"\n' +
    'model_reasoning_effort = "medium"\n' +
    '\n' +
    '[marketplaces.openai-bundled]\n' +
    'source_type = "local"\n' +
    "source = '\\\\?\\C:\\Users\\me\\.codex'\n" +
    '\n' +
    '[features]\n' +
    'js_repl = false\n';
  writeFileSync(f, original);

  assert.equal(await codex.isWired(), false);
  await codex.wire();

  const text = readFileSync(f, 'utf8');
  const lines = text.split('\n');
  const notifyAt = lines.findIndex((l) => l.startsWith('notify ='));
  const firstTable = lines.findIndex((l) => l.startsWith('['));
  assert.ok(notifyAt >= 0, 'notify must be written');
  assert.ok(notifyAt < firstTable, `notify at ${notifyAt} must precede the first table at ${firstTable}`);

  const toml: any = parse(text); // the real proof: it still parses
  assert.equal(toml.model, 'gpt-5.6-sol');
  assert.equal(toml.features.js_repl, false);
  assert.equal(toml.marketplaces['openai-bundled'].source, '\\\\?\\C:\\Users\\me\\.codex');
  assert.ok(has(toml.notify));
  assert.equal(await codex.isWired(), true);
  assert.ok(existsSync(`${f}.pingly-backup`));

  const wiredHooks = read(hooksFile);
  assert.equal(wiredHooks.description, 'my hooks', 'unrelated hooks.json metadata must survive');
  assert.deepEqual(wiredHooks.hooks.PreToolUse, originalHooks.hooks.PreToolUse, "the user's hook must survive untouched");
  assert.equal(wiredHooks.hooks.UserPromptSubmit.length, 1, 'prompt submission must start the timer');
  assert.equal(wiredHooks.hooks.PermissionRequest.length, 1, 'approval requests must notify');
  assert.equal(wiredHooks.hooks.PostToolUse.length, 2, "ours must be appended alongside the user's hook");
  assert.equal(wiredHooks.hooks.Stop.length, 1, 'turn completion must replace the working state');
  assert.ok(has(wiredHooks.hooks.UserPromptSubmit));
  assert.ok(existsSync(`${hooksFile}.pingly-backup`), 'the original hooks file must be backed up');

  await codex.wire();
  assert.equal(readFileSync(f, 'utf8').split('\n').filter((l) => l.startsWith('notify =')).length, 1, 'idempotent');
  assert.equal(read(hooksFile).hooks.UserPromptSubmit.length, 1, 'lifecycle wiring must be idempotent');

  await codex.unwire();
  assert.equal(readFileSync(f, 'utf8'), original, 'unwire must restore the file byte-for-byte');
  assert.deepEqual(read(hooksFile), originalHooks, "unwire must restore the user's hooks without Pingly entries");
  assert.equal(await codex.isWired(), false);
}

/* ---------------- Codex: an existing notify must survive ---------------- */
{
  const f = codex.configPath;
  const theirs = ['C:\\tools\\their-notify.exe', 'turn-ended'];
  const original = `notify = ${JSON.stringify(theirs)}\nmodel = "gpt-5.6-sol"\n\n[features]\njs_repl = false\n`;
  writeFileSync(f, original);
  rmSync(CODEX_CHAIN_FILE, { force: true });

  await codex.wire();
  const wired: any = parse(readFileSync(f, 'utf8'));
  assert.ok(has(wired.notify), 'our notify replaces theirs in the single slot');
  assert.deepEqual(JSON.parse(readFileSync(CODEX_CHAIN_FILE, 'utf8')).argv, theirs, 'theirs is saved so the shim re-runs it');
  assert.equal(wired.model, 'gpt-5.6-sol');

  await codex.wire();
  assert.deepEqual(JSON.parse(readFileSync(CODEX_CHAIN_FILE, 'utf8')).argv, theirs, 'rewiring must not chain to ourselves');

  await codex.unwire();
  assert.deepEqual((parse(readFileSync(f, 'utf8')) as any).notify, theirs, 'their notify must come back');
  assert.equal(existsSync(CODEX_CHAIN_FILE), false, 'chain file cleaned up');
}

/* -------- optional: run against a copy of a real config.toml --------
   PINGLY_REAL_TOML=<path> npm run test:adapters
   Proves the edit survives a genuine file (many tables, literal strings, an
   occupied notify) without ever touching the original.                      */
if (process.env.PINGLY_REAL_TOML) {
  const src = process.env.PINGLY_REAL_TOML;
  const f = codex.configPath;
  const original = readFileSync(src, 'utf8');
  writeFileSync(f, original);
  rmSync(`${f}.pingly-backup`, { force: true });
  rmSync(CODEX_CHAIN_FILE, { force: true });

  const before: any = parse(original);
  await codex.wire();
  const after: any = parse(readFileSync(f, 'utf8'));

  for (const k of Object.keys(before)) {
    if (k === 'notify') continue;
    assert.deepEqual(after[k], before[k], `real config key '${k}' changed`);
  }
  assert.ok(has(after.notify), 'notify is ours after wiring');
  if (before.notify) {
    assert.deepEqual(JSON.parse(readFileSync(CODEX_CHAIN_FILE, 'utf8')).argv, before.notify, 'real notify preserved');
  }

  await codex.unwire();
  assert.equal(readFileSync(f, 'utf8'), original, 'real config restored byte-for-byte');
  console.log(`real-config check OK (${Object.keys(before).length} root keys, notify=${!!before.notify})`);
}

console.log('adapter-test OK');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

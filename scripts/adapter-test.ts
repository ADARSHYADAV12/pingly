/**
 * Verifies wire/unwire never damages a config we do not own.
 * Run it against a throwaway home:
 *   $env:USERPROFILE = "$env:TEMP\pingly-adapter-test"; node out/main/adaptertest.js
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { claudeCode } from '../src/main/adapters/claudecode';
import { cursor } from '../src/main/adapters/cursor';
import { codex } from '../src/main/adapters/codex';
import { antigravity } from '../src/main/adapters/antigravity';
import { CODEX_CHAIN_FILE } from '../src/shared/paths';

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
  assert.deepEqual(wired.hooks.PreToolUse, original.hooks.PreToolUse, 'untouched events must be byte-identical');
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
  assert.deepEqual(clean.hooks.PreToolUse, original.hooks.PreToolUse);
  assert.equal('Notification' in clean.hooks, false, 'events we created must be removed entirely');
  assert.equal(await claudeCode.isWired(), false);
}

/* ---------------- Cursor ---------------- */
{
  const f = cursor.configPath;
  mkdirSync(join(home, '.cursor'), { recursive: true });
  const original = { version: 1, hooks: { stop: [{ command: 'echo mine' }], afterFileEdit: [{ command: 'echo fmt' }] } };
  writeFileSync(f, JSON.stringify(original, null, 2));

  assert.equal(await cursor.isWired(), false);
  await cursor.wire();
  const wired = read(f);
  assert.equal(wired.version, 1);
  assert.equal(wired.hooks.stop.length, 2);
  assert.equal(wired.hooks.stop[0].command, 'echo mine');
  assert.deepEqual(wired.hooks.afterFileEdit, original.hooks.afterFileEdit);
  assert.ok(has(wired.hooks.sessionStart) && has(wired.hooks.beforeShellExecution));
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
  mkdirSync(join(home, '.codex'), { recursive: true });
  rmSync(CODEX_CHAIN_FILE, { force: true });

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

  await codex.wire();
  assert.equal(readFileSync(f, 'utf8').split('\n').filter((l) => l.startsWith('notify =')).length, 1, 'idempotent');

  await codex.unwire();
  assert.equal(readFileSync(f, 'utf8'), original, 'unwire must restore the file byte-for-byte');
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

/* ---------------- Antigravity ---------------- */
{
  const f = antigravity.configPath;
  mkdirSync(join(home, '.gemini', 'config'), { recursive: true });
  const original = {
    'my-linter-hook': { PostToolUse: [{ matcher: 'run_command', hooks: [{ command: './scripts/lint.sh' }] }] }
  };
  writeFileSync(f, JSON.stringify(original, null, 2));

  assert.equal(await antigravity.isWired(), false);
  await antigravity.wire();
  const wired = read(f);
  assert.deepEqual(wired['my-linter-hook'], original['my-linter-hook'], "user's hook group untouched");
  assert.ok(has(wired.pingly.Stop));
  assert.equal(wired.pingly.PreToolUse[0].matcher, 'run_command');
  assert.equal(await antigravity.isWired(), true);

  await antigravity.wire();
  assert.equal(Object.keys(read(f)).length, 2, 'idempotent');

  await antigravity.unwire();
  assert.deepEqual(read(f), original, 'unwire removes exactly our group');
  assert.equal(await antigravity.isWired(), false);
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

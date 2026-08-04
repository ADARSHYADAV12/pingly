// End-to-end check of the event validator + session state machine against a running Pingly.
// Usage: node scripts/selftest.mjs   (start the app first)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let port = 47821;
try {
  port = parseInt(readFileSync(join(process.env.LOCALAPPDATA, 'Pingly', 'port'), 'utf8').trim(), 10);
} catch {}
const base = `http://127.0.0.1:${port}`;

const post = (path, body) =>
  fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });

const send = (over) =>
  post('/event', {
    agent: 'claude-code',
    state: 'working',
    cwd: 'C:\\nudge-selftest\\selftest',
    project: 'selftest',
    shimPid: 1,
    ts: Date.now(),
    ...over
  });

const find = async (cwd = 'C:\\nudge-selftest\\selftest') =>
  (await (await fetch(base + '/sessions')).json()).find((s) => s.cwd === cwd);

// --- validation ---------------------------------------------------------
assert.equal((await post('/event', { agent: 'nope', state: 'done', cwd: 'x' })).status, 400, 'bad agent rejected');
assert.equal((await post('/event', { agent: 'cursor', state: 'nope', cwd: 'x' })).status, 400, 'bad state rejected');
assert.equal((await post('/event', { agent: 'cursor', state: 'done', cwd: '  ' })).status, 400, 'empty cwd rejected');
assert.equal(
  (await fetch(base + '/event', { method: 'POST', headers: { origin: 'http://evil.test' } })).status,
  403,
  'Origin header rejected'
);

// --- transitions --------------------------------------------------------
await send({ state: 'working' });
const first = await find();
assert.equal(first.state, 'working');

await new Promise((r) => setTimeout(r, 30));
await send({ state: 'working' });
assert.equal((await find()).startedAt, first.startedAt, 'working->working must not reset startedAt');

await send({ state: 'done', message: 'x'.repeat(500) });
const done = await find();
assert.equal(done.state, 'done');
assert.equal(done.startedAt, first.startedAt, 'done keeps the working startedAt for elapsed time');
assert.equal(done.message.length, 200, 'message capped at 200 chars');
assert.equal(done.dismissed, false);

await post('/dismiss', { cwd: 'C:\\nudge-selftest\\selftest' });
assert.equal(await find(), undefined, 'dismissed sessions drop out of visible()');

await send({ state: 'needs-input', message: 'Allow Bash?' });
assert.ok(await find(), 'a new event un-dismisses the session');

// --- sort order ---------------------------------------------------------
await send({ cwd: 'C:\\nudge-selftest\\a', project: 'a', state: 'done' });
await send({ cwd: 'C:\\nudge-selftest\\b', project: 'b', state: 'working' });
await send({ cwd: 'C:\\nudge-selftest\\c', project: 'c', state: 'error' });
const order = (await (await fetch(base + '/sessions')).json())
  .filter((s) => s.cwd.startsWith('C:\\nudge-selftest\\'))
  .map((s) => s.state);
assert.deepEqual(order, ['needs-input', 'error', 'done', 'working'], `sort order wrong: ${order}`);

// cleanup
for (const cwd of ['C:\\nudge-selftest\\selftest', 'C:\\nudge-selftest\\a', 'C:\\nudge-selftest\\b', 'C:\\nudge-selftest\\c']) await post('/dismiss', { cwd });

console.log('selftest OK');

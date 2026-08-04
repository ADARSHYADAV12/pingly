// POST an arbitrary event to a running Pingly. Usage:
//   node scripts/fake-event.mjs [state] [project] [message] [detail]
//   node scripts/fake-event.mjs needs-input octiq "Allow Bash?" "npm run db:migrate"
import { readFileSync } from 'node:fs';
import { join, basename } from 'node:path';

const [state = 'done', project = basename(process.cwd()), message = 'Finished editing 4 files', detail] =
  process.argv.slice(2);

let port = 47821;
try {
  port = parseInt(readFileSync(join(process.env.LOCALAPPDATA, 'Pingly', 'port'), 'utf8').trim(), 10);
} catch {}

const body = {
  agent: process.env.AGENT || 'claude-code',
  state,
  project,
  cwd: `C:\\dev\\${project}`,
  message,
  detail,
  shimPid: process.pid,
  ts: Date.now()
};

const res = await fetch(`http://127.0.0.1:${port}/event`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body)
});
console.log(res.status, await res.text());

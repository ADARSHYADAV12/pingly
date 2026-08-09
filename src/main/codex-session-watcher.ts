import { existsSync, openSync, closeSync, readSync, readdirSync, statSync, watch, type FSWatcher } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';

export interface CodexTurnStart {
  cwd: string;
  project: string;
  sessionId?: string;
  turnId: string;
}

export interface CodexJournalState {
  buffer: string;
  cwd?: string;
  sessionId?: string;
  lastTurnId?: string;
}

interface JournalFileState extends CodexJournalState {
  offset: number;
}

/**
 * Consume only lifecycle metadata from a Codex rollout journal. Prompt and response
 * bodies are deliberately ignored: Pingly needs to know that a turn began, not what
 * the user or agent said.
 */
export function consumeCodexJournal(state: CodexJournalState, chunk: string): CodexTurnStart[] {
  const records = `${state.buffer}${chunk}`.split(/\r?\n/);
  state.buffer = records.pop() ?? '';
  const starts: CodexTurnStart[] = [];

  for (const record of records) {
    if (!record.trim()) continue;
    let entry: { type?: string; payload?: Record<string, unknown> };
    try {
      entry = JSON.parse(record) as typeof entry;
    } catch {
      continue;
    }

    const payload = entry.payload ?? {};
    if (entry.type === 'session_meta') {
      if (typeof payload.cwd === 'string') state.cwd = payload.cwd;
      const id = payload.id ?? payload.session_id;
      if (typeof id === 'string') state.sessionId = id;
      continue;
    }

    if (entry.type !== 'turn_context') continue;
    const turnId = payload.turn_id;
    const cwd = typeof payload.cwd === 'string' ? payload.cwd : state.cwd;
    if (typeof turnId !== 'string' || !cwd || turnId === state.lastTurnId) continue;

    state.lastTurnId = turnId;
    state.cwd = cwd;
    starts.push({ cwd, project: basename(cwd) || cwd, sessionId: state.sessionId, turnId });
  }

  return starts;
}

function journalFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(path);
    }
  };
  visit(root);
  return files;
}

/**
 * The Codex desktop/IDE surface currently writes turn lifecycle records but does not
 * consistently run UserPromptSubmit hooks. Tail those records as a fallback so the
 * working pill begins on the first task. Existing journal contents are never replayed.
 */
export function startCodexSessionWatcher(
  onTurnStart: (start: CodexTurnStart) => void,
  root = join(homedir(), '.codex', 'sessions')
): () => void {
  if (!existsSync(root)) {
    console.log('[pingly] Codex session watcher idle: sessions folder not found');
    return () => {};
  }

  const states = new Map<string, JournalFileState>();
  const pending = new Map<string, NodeJS.Timeout>();
  let watcher: FSWatcher | undefined;

  // Seed at EOF so launching Pingly never resurrects old or already-finished turns.
  for (const file of journalFiles(root)) {
    try {
      states.set(file, { offset: statSync(file).size, buffer: '' });
    } catch {
      /* the journal can rotate between listing and stat */
    }
  }

  const drain = (file: string): void => {
    let size: number;
    try {
      size = statSync(file).size;
    } catch {
      return;
    }

    let state = states.get(file);
    if (!state) {
      state = { offset: 0, buffer: '' };
      states.set(file, state);
    }
    if (size < state.offset) {
      state.offset = 0;
      state.buffer = '';
    }
    if (size === state.offset) return;

    const length = size - state.offset;
    const bytes = Buffer.alloc(length);
    let fd: number | undefined;
    try {
      fd = openSync(file, 'r');
      const read = readSync(fd, bytes, 0, length, state.offset);
      state.offset += read;
      for (const start of consumeCodexJournal(state, bytes.subarray(0, read).toString('utf8'))) onTurnStart(start);
    } catch (error) {
      console.warn('[pingly] could not read Codex session journal:', error);
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  };

  const schedule = (file: string): void => {
    if (!file.endsWith('.jsonl') || pending.has(file)) return;
    pending.set(
      file,
      setTimeout(() => {
        pending.delete(file);
        drain(file);
      }, 40)
    );
  };

  try {
    watcher = watch(root, { recursive: true }, (_event, filename) => {
      if (filename) schedule(resolve(root, filename.toString()));
    });
    watcher.on('error', (error) => console.warn('[pingly] Codex session watcher error:', error));
    console.log('[pingly] watching Codex IDE sessions for turn starts');
  } catch (error) {
    console.warn('[pingly] could not start Codex session watcher:', error);
  }

  // A slow reconciliation covers journal rotations and the rare dropped filesystem event.
  const reconcile = setInterval(() => {
    for (const file of journalFiles(root)) drain(file);
  }, 10_000);
  reconcile.unref();

  return () => {
    watcher?.close();
    clearInterval(reconcile);
    for (const timer of pending.values()) clearTimeout(timer);
    pending.clear();
  };
}

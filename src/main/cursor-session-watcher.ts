import { closeSync, existsSync, openSync, readSync, readdirSync, statSync, watch, type FSWatcher } from 'node:fs';
import { join, resolve } from 'node:path';

export const CURSOR_PENDING_CWD = 'cursor-agent://pending';
export const CURSOR_TAIL_POLL_MS = 100;

export interface CursorTurnStart {
  cwd: string;
  project: 'Cursor Agent';
  turnId: string;
}

export interface CursorHookLogState {
  buffer: string;
}

interface HookFileState extends CursorHookLogState {
  offset: number;
}

/**
 * Cursor writes this lifecycle line before launching its Windows hooks, which currently
 * take roughly five seconds to return. Read only that marker: prompt and response bodies
 * in the same diagnostic log are never parsed or retained by Pingly.
 */
export function consumeCursorHookLog(state: CursorHookLogState, chunk: string): CursorTurnStart[] {
  const lines = `${state.buffer}${chunk}`.split(/\r?\n/);
  state.buffer = lines.pop() ?? '';
  const starts: CursorTurnStart[] = [];
  for (const line of lines) {
    if (!/Hook step requested:\s*beforeSubmitPrompt\s*$/.test(line)) continue;
    starts.push({
      cwd: CURSOR_PENDING_CWD,
      project: 'Cursor Agent',
      turnId: `cursor-watch-${Date.now()}`
    });
  }
  return starts;
}

function hookLogs(root: string): string[] {
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
      else if (entry.isFile() && /^cursor\.hooks.*\.log$/i.test(entry.name)) files.push(path);
    }
  };
  visit(root);
  return files;
}

/** Starts Cursor's working pill immediately; the normal hook still supplies identity and completion. */
export function startCursorSessionWatcher(
  onTurnStart: (start: CursorTurnStart) => void,
  root = join(process.env.APPDATA || '', 'Cursor', 'logs')
): () => void {
  if (!existsSync(root)) {
    console.log('[pingly] Cursor session watcher idle: logs folder not found');
    return () => {};
  }

  const states = new Map<string, HookFileState>();
  const pending = new Map<string, NodeJS.Timeout>();
  let watcher: FSWatcher | undefined;

  // Never replay prompts from before Pingly launched.
  for (const file of hookLogs(root)) {
    try {
      states.set(file, { offset: statSync(file).size, buffer: '' });
    } catch {
      /* log rotation race */
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
    if (size < state.offset) Object.assign(state, { offset: 0, buffer: '' });
    if (size === state.offset) return;

    const bytes = Buffer.alloc(size - state.offset);
    let fd: number | undefined;
    try {
      fd = openSync(file, 'r');
      const read = readSync(fd, bytes, 0, bytes.length, state.offset);
      state.offset += read;
      for (const start of consumeCursorHookLog(state, bytes.subarray(0, read).toString('utf8'))) onTurnStart(start);
    } catch (error) {
      console.warn('[pingly] could not read Cursor lifecycle log:', error);
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  };

  const schedule = (file: string): void => {
    if (!/^cursor\.hooks.*\.log$/i.test(file.split(/[\\/]/).pop() || '') || pending.has(file)) return;
    pending.set(
      file,
      setTimeout(() => {
        pending.delete(file);
        drain(file);
      }, 20)
    );
  };

  try {
    watcher = watch(root, { recursive: true }, (_event, filename) => {
      if (filename) schedule(resolve(root, filename.toString()));
    });
    watcher.on('error', (error) => console.warn('[pingly] Cursor session watcher error:', error));
    console.log('[pingly] watching Cursor sessions for immediate turn starts');
  } catch (error) {
    console.warn('[pingly] could not start Cursor session watcher:', error);
  }

  // Windows can miss recursive fs.watch writes inside Cursor's freshly-created log
  // directories. Stat only the already-known hook logs at a tight interval; this is a
  // handful of tiny metadata calls and keeps prompt-to-pill latency under 100 ms.
  const tail = setInterval(() => {
    for (const file of states.keys()) drain(file);
  }, CURSOR_TAIL_POLL_MS);
  tail.unref();

  // Discover log files created for new Cursor windows without recursively walking the
  // whole tree on every 100 ms tail tick.
  const discover = setInterval(() => {
    for (const file of hookLogs(root)) if (!states.has(file)) drain(file);
  }, 2_000);
  discover.unref();

  return () => {
    watcher?.close();
    clearInterval(tail);
    clearInterval(discover);
    for (const timer of pending.values()) clearTimeout(timer);
    pending.clear();
  };
}

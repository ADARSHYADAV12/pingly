import { appendFileSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PINGLY_DIR } from '../shared/paths';

export const LOG_FILE = join(PINGLY_DIR, 'pingly.log');
const MAX_BYTES = 512 * 1024;

/**
 * Mirrors the console to a file. A packaged tray app has nowhere to print, so without
 * this there is no way for anyone to tell you *why* it did not fire.
 */
export function initLog(): void {
  try {
    mkdirSync(PINGLY_DIR, { recursive: true });
    if (statSync(LOG_FILE).size > MAX_BYTES) rmSync(LOG_FILE, { force: true });
  } catch {
    /* no log yet */
  }

  for (const level of ['log', 'warn', 'error'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]): void => {
      original(...args);
      try {
        const line = args
          .map((a) => (typeof a === 'string' ? a : a instanceof Error ? a.stack : JSON.stringify(a)))
          .join(' ');
        appendFileSync(LOG_FILE, `${new Date().toISOString()} ${level.toUpperCase()} ${line}\n`);
      } catch {
        /* logging must never take the app down */
      }
    };
  }
}

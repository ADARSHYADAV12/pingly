import { spawn, type SpawnOptions } from 'node:child_process';
import { homedir } from 'node:os';

interface DetachedProcess {
  unref(): void;
}

type SpawnProcess = (command: string, args: readonly string[], options: SpawnOptions) => DetachedProcess;

export interface CodexHookReviewResult {
  copied: boolean;
  opened: boolean;
  error?: string;
}

export interface CodexHookReviewDeps {
  copyText(text: string): void;
  command?: string;
  spawnProcess?: SpawnProcess;
}

/** Hand the user into Codex's trust UI without touching its private trust state. */
export function launchCodexHookReview(deps: CodexHookReviewDeps): CodexHookReviewResult {
  let copied = false;
  try {
    deps.copyText('/hooks');
    copied = true;
  } catch (error) {
    console.warn('[pingly] could not copy /hooks:', error);
  }

  try {
    const command = deps.command ?? process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe';
    const spawnProcess = deps.spawnProcess ?? spawn;
    const child = spawnProcess(command, ['/d', '/k', 'codex'], {
      cwd: homedir(),
      detached: true,
      stdio: 'ignore',
      windowsHide: false
    });
    child.unref();
    return { copied, opened: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[pingly] could not open Codex hook review:', message);
    return { copied, opened: false, error: message };
  }
}

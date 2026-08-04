import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { LEGACY_SHIM_MARKER, SHIM_MARKER, SHIM_PATH } from '../../shared/paths';
import type { AgentId, SessionState } from '../../shared/types';

export interface Adapter {
  id: AgentId;
  displayName: string;
  /** Shown in the setup window — developers do not trust apps that silently edit dotfiles. */
  configPath: string;
  /** One line explaining exactly what wiring this agent will do. */
  description: string;
  isInstalled(): Promise<boolean>;
  isWired(): Promise<boolean>;
  wire(): Promise<void>;
  unwire(): Promise<void>;
}

let cachedNode: { path: string; found: boolean } | null = null;

/**
 * Absolute path to node. Hooks run in the agent's environment, which may not have the
 * same PATH we do, so the command embeds the full path rather than bare `node`.
 * `found` is false when node is not installed at all — hooks would then be dead on
 * arrival, so the setup window says so instead of wiring something that cannot fire.
 */
export function nodeInfo(): { path: string; found: boolean } {
  if (cachedNode) return cachedNode;
  try {
    const p = execFileSync('where.exe', ['node'], { encoding: 'utf8' }).split(/\r?\n/)[0].trim();
    cachedNode = p ? { path: p, found: true } : { path: 'node', found: false };
  } catch {
    cachedNode = { path: 'node', found: false };
  }
  return cachedNode;
}

const nodePath = (): string => nodeInfo().path;

export function shimCommand(agent: AgentId, state: SessionState): string {
  return `"${nodePath()}" "${SHIM_PATH}" --agent ${agent} --state ${state}`;
}

/** Same invocation as an argv array — Codex's `notify` takes a list, not a shell string. */
export function shimArgv(agent: AgentId, state: SessionState): string[] {
  return [nodePath(), SHIM_PATH, '--agent', agent, '--state', state];
}

/**
 * Every entry we write invokes the shim — that string is how unwire identifies ours.
 * The pre-rename name still counts, so wiring replaces a stale Nudge entry instead of
 * leaving a dead hook behind, and unwire cleans one up.
 */
export const isOurs = (command: unknown): boolean =>
  typeof command === 'string' &&
  [SHIM_MARKER, LEGACY_SHIM_MARKER].some((m) => command.toLowerCase().includes(m));

/** Wired to *this* build, as opposed to a leftover entry from the old name. */
export const isCurrent = (command: unknown): boolean =>
  typeof command === 'string' && command.toLowerCase().includes(SHIM_MARKER);

export function readJson(file: string): Record<string, unknown> {
  try {
    const text = readFileSync(file, 'utf8').trim();
    const parsed = text ? JSON.parse(text) : {};
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function readText(file: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Backs the original up once, then writes. Never clobbers what we did not put there.
 * A pre-rename `.nudge-backup` counts as the backup: it holds the genuine original,
 * whereas taking a fresh one now would snapshot an already-wired file.
 */
export function writeText(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const backup = `${file}.pingly-backup`;
  const legacyBackup = `${file}.nudge-backup`;
  if (existsSync(file) && !existsSync(backup) && !existsSync(legacyBackup)) copyFileSync(file, backup);
  writeFileSync(file, text, 'utf8');
}

export function writeJson(file: string, data: unknown): void {
  writeText(file, JSON.stringify(data, null, 2) + '\n');
}

import { EventEmitter } from 'node:events';
import type { PinglyEvent, Session, SessionState } from '../shared/types';

const DONE_TTL_MS = 5 * 60 * 1000;
const WORKING_TTL_MS = 6 * 60 * 60 * 1000;
const SWEEP_MS = 30 * 1000;

const TIER: Record<SessionState, number> = { 'needs-input': 0, error: 1, done: 2, working: 3 };

/**
 * Windows paths are case-insensitive, but agents echo back whatever the user typed —
 * Codex reported `D:\Adarsh\...` while Claude Code reported `d:\Adarsh\...`, which
 * split one project into two sessions and left a stale card on screen. The original
 * casing is kept on the session for display and window matching; only the key is folded.
 */
const key = (cwd: string): string => cwd.trim().replace(/[\\/]+$/, '').toLowerCase();
const CURSOR_PENDING_KEY = key('cursor-agent://pending');

export class SessionStore extends EventEmitter {
  private map = new Map<string, Session>();

  constructor() {
    super();
    setInterval(() => this.sweep(), SWEEP_MS).unref();
  }

  ingest(event: PinglyEvent): Session | undefined {
    // Cursor reports user-cancelled turns as aborted — never notify for those.
    if ((event as { status?: string }).status === 'aborted') return;

    const eventKey = key(event.cwd);
    let prev = this.map.get(eventKey);

    if (event.agent === 'cursor' && event.state === 'working' && eventKey === CURSOR_PENDING_KEY) {
      // The watcher sees the prompt before Cursor's hook has supplied its destination.
      // A new prompt supersedes any prior Cursor result so only one dock is visible.
      for (const [cwd, session] of this.map) if (session.agent === 'cursor') this.map.delete(cwd);
      prev = undefined;
    } else if (event.agent === 'cursor' && eventKey !== CURSOR_PENDING_KEY) {
      // Replace the provisional watcher session once the authoritative hook arrives,
      // preserving the true start time instead of creating a second dock five seconds in.
      const pending = this.map.get(CURSOR_PENDING_KEY);
      if (pending) {
        this.map.delete(CURSOR_PENDING_KEY);
        if (!prev || pending.changedAt >= prev.changedAt) prev = pending;
      }
    }

    // Hook commands are separate short-lived processes, so their HTTP requests can land
    // out of order. Once Stop has completed a turn, a late PostToolUse from that same
    // turn must not put the card back into "working".
    if (
      event.state === 'working' &&
      (prev?.state === 'done' || prev?.state === 'error') &&
      event.turnId &&
      event.turnId === prev.turnId
    ) {
      return prev;
    }

    // Codex can report completion through both the modern Stop hook and the legacy
    // notify callback. They describe the same turn; keep one card and one chime.
    if (
      (event.state === 'done' || event.state === 'error') &&
      prev?.state === event.state &&
      event.turnId &&
      event.turnId === prev.turnId
    ) {
      return prev;
    }

    const next: Session = {
      cwd: event.cwd,
      project: event.project,
      agent: event.agent,
      turnId: event.turnId,
      state: event.state,
      message: event.message ?? (prev?.state === event.state ? prev.message : undefined),
      detail: event.detail ?? (prev?.state === event.state ? prev.detail : undefined),
      shimPid: event.shimPid,
      startedAt: prev && !(prev.state !== 'working' && event.state === 'working') ? prev.startedAt : event.ts,
      changedAt: event.ts,
      windowHandle: prev?.windowHandle,
      dismissed: false
    };

    this.map.set(eventKey, next);

    // working → working is a heartbeat, not news.
    const notify = !(event.state === 'working' && prev?.state === 'working');
    this.emit('changed');
    if (notify) this.emit('notify', next);
    return next;
  }

  dismiss(cwd: string): void {
    const s = this.map.get(key(cwd));
    if (!s) return;
    s.dismissed = true;
    this.emit('changed');
  }

  dismissAll(): void {
    for (const s of this.map.values()) s.dismissed = true;
    this.emit('changed');
  }

  get(cwd: string): Session | undefined {
    return this.map.get(key(cwd));
  }

  /** Non-dismissed sessions, most urgent first. */
  visible(): Session[] {
    return [...this.map.values()]
      .filter((s) => !s.dismissed)
      .sort((a, b) => TIER[a.state] - TIER[b.state] || b.changedAt - a.changedAt);
  }

  all(): Session[] {
    return [...this.map.values()].sort((a, b) => TIER[a.state] - TIER[b.state] || b.changedAt - a.changedAt);
  }

  private sweep(): void {
    const now = Date.now();
    let dropped = false;
    for (const [cwd, s] of this.map) {
      const ttl = s.state === 'working' ? WORKING_TTL_MS : s.state === 'done' ? DONE_TTL_MS : Infinity;
      if (now - s.changedAt > ttl) {
        this.map.delete(cwd);
        dropped = true;
      }
    }
    if (dropped) this.emit('changed');
  }
}

export const sessions = new SessionStore();

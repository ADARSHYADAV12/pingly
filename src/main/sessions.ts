import { EventEmitter } from 'node:events';
import type { PinglyEvent, Session, SessionState } from '../shared/types';

const DONE_TTL_MS = 5 * 60 * 1000;
const WORKING_TTL_MS = 6 * 60 * 60 * 1000;
const SWEEP_MS = 30 * 1000;

const TIER: Record<SessionState, number> = { 'needs-input': 0, error: 1, done: 2, working: 3 };

class SessionStore extends EventEmitter {
  private map = new Map<string, Session>();

  constructor() {
    super();
    setInterval(() => this.sweep(), SWEEP_MS).unref();
  }

  ingest(event: PinglyEvent): Session | undefined {
    // Cursor reports user-cancelled turns as aborted — never notify for those.
    if ((event as { status?: string }).status === 'aborted') return;

    const prev = this.map.get(event.cwd);
    const next: Session = {
      cwd: event.cwd,
      project: event.project,
      agent: event.agent,
      state: event.state,
      message: event.message ?? (prev?.state === event.state ? prev.message : undefined),
      detail: event.detail ?? (prev?.state === event.state ? prev.detail : undefined),
      shimPid: event.shimPid,
      startedAt: prev && !(prev.state !== 'working' && event.state === 'working') ? prev.startedAt : event.ts,
      changedAt: event.ts,
      windowHandle: prev?.windowHandle,
      dismissed: false
    };

    this.map.set(event.cwd, next);

    // working → working is a heartbeat, not news.
    const notify = !(event.state === 'working' && prev?.state === 'working');
    this.emit('changed');
    if (notify) this.emit('notify', next);
    return next;
  }

  dismiss(cwd: string): void {
    const s = this.map.get(cwd);
    if (!s) return;
    s.dismissed = true;
    this.emit('changed');
  }

  dismissAll(): void {
    for (const s of this.map.values()) s.dismissed = true;
    this.emit('changed');
  }

  get(cwd: string): Session | undefined {
    return this.map.get(cwd);
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

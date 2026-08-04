export type AgentId = 'claude-code' | 'cursor' | 'codex' | 'antigravity' | 'generic';
export type SessionState = 'working' | 'needs-input' | 'done' | 'error';

export const AGENT_IDS: AgentId[] = ['claude-code', 'cursor', 'codex', 'antigravity', 'generic'];
export const SESSION_STATES: SessionState[] = ['working', 'needs-input', 'done', 'error'];

export interface PinglyEvent {
  agent: AgentId;
  state: SessionState;
  project: string;
  cwd: string;
  sessionId?: string;
  message?: string;
  detail?: string;
  shimPid: number;
  ts: number;
}

export interface Session {
  cwd: string;
  project: string;
  agent: AgentId;
  state: SessionState;
  message?: string;
  detail?: string;
  shimPid: number;
  startedAt: number;
  changedAt: number;
  windowHandle?: number;
  dismissed: boolean;
}

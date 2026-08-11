export type AgentId = 'claude-code' | 'cursor' | 'codex' | 'generic';
export type SessionState = 'working' | 'needs-input' | 'done' | 'error';

export const AGENT_IDS: AgentId[] = ['claude-code', 'cursor', 'codex', 'generic'];
export const SESSION_STATES: SessionState[] = ['working', 'needs-input', 'done', 'error'];

export interface PinglyEvent {
  agent: AgentId;
  state: SessionState;
  project: string;
  cwd: string;
  sessionId?: string;
  turnId?: string;
  message?: string;
  detail?: string;
  shimPid: number;
  ts: number;
}

export interface Session {
  cwd: string;
  project: string;
  agent: AgentId;
  turnId?: string;
  state: SessionState;
  message?: string;
  detail?: string;
  shimPid: number;
  startedAt: number;
  changedAt: number;
  windowHandle?: number;
  dismissed: boolean;
}

export interface UpdateInfo {
  version: string;
  currentVersion: string;
  downloadUrl: string;
  releaseUrl: string;
  notes?: string;
  foundAt: number;
  dismissed: boolean;
}

import type { Session } from './types';

type DockSession = Pick<Session, 'agent' | 'cwd' | 'state' | 'turnId'>;

function workingIds(sessions: readonly DockSession[]): string[] {
  return sessions
    .filter((session) => session.state === 'working')
    .map((session) => `${session.agent}:${session.turnId || session.cwd.toLowerCase()}`)
    .sort();
}

/** True only when a working lifecycle appears, disappears, or changes identity. */
export function workingSetChanged(previous: readonly DockSession[], next: readonly DockSession[]): boolean {
  const beforeWorking = previous.filter((session) => session.state === 'working');
  const afterWorking = next.filter((session) => session.state === 'working');
  if (
    beforeWorking.length === 1 &&
    afterWorking.length === 1 &&
    beforeWorking[0].agent === 'cursor' &&
    afterWorking[0].agent === 'cursor' &&
    beforeWorking[0].cwd.toLowerCase() === 'cursor-agent://pending'
  ) {
    return false;
  }
  const before = workingIds(previous);
  const after = workingIds(next);
  return before.length !== after.length || before.some((id, index) => id !== after[index]);
}

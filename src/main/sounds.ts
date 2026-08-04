import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import type { SessionState } from '../shared/types';
import { settings } from './settings';

const DEDUPE_MS = 2000;
const QUIET_POLL_MS = 60_000;

let lastPlayedAt = 0;
let quietHours = false;

function resourcesDir(): string {
  return app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources');
}

/**
 * Playback happens in the overlay renderer (main has no audio API), so the wavs
 * are handed over as data URLs — works identically in dev and packaged.
 */
export function soundDataUrls(): { done: string; attention: string } {
  const read = (n: string): string =>
    'data:audio/wav;base64,' + readFileSync(join(resourcesDir(), 'sounds', `${n}.wav`)).toString('base64');
  return { done: read('done'), attention: read('attention') };
}

/**
 * Windows Focus Assist state. Electron exposes no API for it, so this reads the
 * CloudStore blob Windows writes it to.
 * ponytail: byte 0x08 of an undocumented blob, polled on a timer and failing open
 * (sound plays) on any error. Swap for a real WNF/QUERY_USER_NOTIFICATION_STATE
 * native call if it ever misreports.
 */
function pollQuietHours(): void {
  const ps =
    "$k='HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\CloudStore\\Store\\DefaultAccount\\Current\\" +
    "$$windows.data.notifications.quiethoursstate\\Current';" +
    "(Get-ItemProperty -Path $k -Name Data -ErrorAction Stop).Data[8]";
  execFile(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', ps],
    { windowsHide: true, timeout: 5000 },
    (err, stdout) => {
      quietHours = err ? false : parseInt(stdout.trim(), 10) > 0;
    }
  );
}

if (process.platform === 'win32') {
  pollQuietHours();
  setInterval(pollQuietHours, QUIET_POLL_MS).unref();
}

export function maybePlay(state: SessionState, play: (name: 'done' | 'attention') => void): void {
  if (state === 'working') return;
  if (settings.get('muted') || quietHours) return;
  // Three events in one second are one interruption, not three.
  const now = Date.now();
  if (now - lastPlayedAt < DEDUPE_MS) return;
  lastPlayedAt = now;
  play(state === 'done' ? 'done' : 'attention');
}

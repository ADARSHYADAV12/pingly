import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BIN_DIR } from '../shared/paths';

/**
 * Compiles a small C# helper with the in-box compiler and caches it by source hash.
 * Used instead of an npm native module: no build toolchain for the user, nothing extra
 * in the installer, and a `WindowsApplication` helper never flashes a console window.
 */
const inFlight = new Map<string, Promise<string | null>>();

export function compileHelper(
  name: string,
  source: string,
  type: 'ConsoleApplication' | 'WindowsApplication'
): Promise<string | null> {
  const tag = createHash('sha1').update(source).digest('hex').slice(0, 8);
  const exe = join(BIN_DIR, `${name}-${tag}.exe`);
  if (existsSync(exe)) return Promise.resolve(exe);

  const pending = inFlight.get(exe);
  if (pending) return pending;

  const build = new Promise<string | null>((resolve) => {
    const cs = join(BIN_DIR, `${name}-${tag}.cs`);
    mkdirSync(BIN_DIR, { recursive: true });
    writeFileSync(cs, source, 'utf8');
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        `Add-Type -TypeDefinition (Get-Content -Raw '${cs}') -OutputAssembly '${exe}' -OutputType ${type}`
      ],
      { windowsHide: true, timeout: 60000 },
      (err) => {
        if (err) console.error(`[pingly] ${name} helper build failed:`, err.message);
        resolve(existsSync(exe) ? exe : null);
      }
    );
  });

  inFlight.set(exe, build);
  return build;
}

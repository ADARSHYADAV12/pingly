import { join } from 'node:path';

const LOCAL_APP_DATA =
  process.env.LOCALAPPDATA || join(process.env.USERPROFILE || '.', 'AppData', 'Local');

// %LOCALAPPDATA%\Pingly — shared between the app and the shim, so it lives outside main/.
export const PINGLY_DIR = join(LOCAL_APP_DATA, 'Pingly');
export const BIN_DIR = join(PINGLY_DIR, 'bin');
export const SHIM_PATH = join(BIN_DIR, 'pingly-shim.js');
export const PORT_FILE = join(PINGLY_DIR, 'port');
/** The notify program Pingly displaced in Codex's config, so the shim can still run it. */
export const CODEX_CHAIN_FILE = join(PINGLY_DIR, 'codex-chain.json');

/** Pre-rename data directory. Only referenced by the one-time startup migration. */
export const LEGACY_DIR = join(LOCAL_APP_DATA, 'Nudge');
export const LEGACY_SHIM_MARKER = 'nudge-shim';
export const SHIM_MARKER = 'pingly-shim';

export const DEFAULT_PORT = 47821;
export const PORT_RANGE = [47821, 47830] as const;

/**
 * Read-only: what Pingly sees on this machine. Writes nothing.
 *   npm run status
 */
import { claudeCode } from '../src/main/adapters/claudecode';
import { cursor } from '../src/main/adapters/cursor';
import { codex } from '../src/main/adapters/codex';

async function main(): Promise<void> {
  for (const a of [claudeCode, cursor, codex]) {
    const installed = await a.isInstalled();
    const wired = await a.isWired();
    const status = !installed ? 'not installed' : wired ? 'CONNECTED' : 'not connected';
    console.log(`${a.displayName.padEnd(14)} ${status.padEnd(14)} ${a.configPath}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

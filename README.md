# Pingly

**AI done. You know.**

A Windows desktop companion that watches your AI coding agents and taps you on the shoulder
when one finishes a task or needs your approval.

You start an agent, switch to another window, and forget about it. It finishes — or worse,
stops twenty seconds in to ask permission — and sits idle for forty minutes. Pingly makes
that impossible to miss without being annoying.

---

## What it looks like

While an agent is working, Pingly is a dot and a clock at the top of your screen. When the
agent finishes or needs you, a card slides down: what happened, how long it took, and one
button to jump back. Hover to see everything; it shrinks itself again when you move away.

## Supported agents

| Agent | Config it edits | What you get |
|---|---|---|
| Claude Code | `~/.claude/settings.json` | Finished, permission prompts, idle prompts |
| Cursor | `~/.cursor/hooks.json` | Finished |
| Codex CLI | `~/.codex/config.toml` | Turn complete |

Cursor exposes no "the user was actually asked" event, so it only reports completion.
Codex only emits one event by design.

These are wired into each tool's own global config, not into an editor, so it makes no
difference how you launch them. The Claude Code and Codex extensions running inside
VS Code, Cursor, or Antigravity read the same files and fire the same hooks.

Antigravity's *own* agent is not supported. Its hook runner passes the command to `cmd`
with the outer quotes still attached, so `"C:\Program Files\nodejs\node.exe"` is not a
program it can find and every hook fails — reporting the error only for `PreToolUse`,
and silently for `Stop`.

## Install

Download `Pingly-x.y.z-setup.exe` from Releases and run it. The setup window opens on first
launch — connect the agents you use, restart them, and you're done.

There's also a portable `.exe` if you'd rather not install.

**Requires [Node.js](https://nodejs.org).** Pingly's hooks shell out to it. The setup window
tells you if it isn't found.

> Pingly isn't code signed yet, so Windows SmartScreen will warn on first run.
> *More info → Run anyway.*

## What it does to your machine

Pingly is deliberately boring about this, because it edits files you care about:

- **Nothing leaves your PC.** No accounts, no telemetry, no network calls beyond
  `127.0.0.1`. The local server refuses any request carrying an `Origin` header.
- **Your configs are merged, never overwritten.** The original is copied to
  `<file>.pingly-backup` before the first write.
- **Disconnect removes only Pingly's own entries**, and leaves your own hooks byte-for-byte
  intact. There are tests for exactly this.
- **Codex's single `notify` slot is shared, not stolen.** If you already use one, Pingly
  records it and re-runs it on every turn, then hands the slot back on disconnect.
- **Uninstalling unwires everything first**, so you're never left with agents calling a
  shim that no longer exists.
- It never takes focus. The overlay window is `focusable: false` on purpose.

Files live in `%LOCALAPPDATA%\Pingly` (shim, log, Codex chain record) and
`%APPDATA%\pingly` (settings).

## Troubleshooting

**Nothing appears when my agent finishes.**
Hooks load when a session *starts* — restart the agent after connecting. Check
tray → *Open log file*. Confirm Node is installed.

**I see a card for every shell command.**
That was Cursor behaviour in an earlier build; it now only reports completion.

**"Jump to it" flashes the taskbar instead of switching.**
Windows blocks background apps from stealing focus. Pingly flashes the target instead of
failing silently. It only switches outright when the window is minimized.

## Development

```bash
npm install
npm run dev            # electron-vite dev
npm run build          # compile to out/
npm run dist           # NSIS installer + portable exe into dist/

npm run status         # read-only: which agents are detected and connected
npm run test:adapters  # wire/unwire safety against a throwaway home
npm run test:live      # event pipeline against a running app (start it first)
```

`npm run test:adapters` refuses to run unless both `USERPROFILE` and `LOCALAPPDATA` point at
a temp directory, so it can never touch a real config. Point `PINGLY_REAL_TOML` at a *copy*
of your `config.toml` to exercise the Codex adapter against a genuine file.

### Layout

```
src/main/        app lifecycle, tray, local server, session store, overlay, window focus
src/main/adapters/  one file per agent — all merge-and-restore, never overwrite
src/preload/     contextBridge API
src/renderer/    the dock and the setup window (plain TS, no framework)
src/shim/        the tiny script every agent hook calls
```

The shim is what agents invoke on every turn. It reads the hook payload, POSTs it to the
local server, and exits 0 no matter what — if Pingly isn't running, it silently does
nothing. It must never block or fail an agent.

## Known limits

- Windows only.
- Not code signed; expect a SmartScreen warning and possible antivirus false positives.
- "Jump to it" matches windows by title, so it can pick the wrong one when two open
  projects share a folder name.
- Only tested on Windows 11 at 125% scaling so far.

## License

MIT — see [LICENSE](LICENSE).

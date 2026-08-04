# Nudge — build spec

A Windows desktop app that watches AI coding agents (Claude Code, Cursor, Codex CLI, Antigravity) and surfaces a notch-style dock at the top-center of the screen when an agent finishes a task or needs input.

---

## How to use this document

Paste this whole file into Claude Code and start with:

> Read NUDGE_BUILD_SPEC.md. Build Phase 1 only. Do not start Phase 2 until I confirm Phase 1 works. Ask me before installing any dependency not listed in the stack section.

Build phases are at the bottom. Do not build them out of order.

---

## 1. The problem

A developer starts an agent task in Claude Code or Cursor, switches to another window while it runs, and forgets about it. The agent finishes — or worse, stops 20 seconds in to ask for permission — and sits there idle for 40 minutes.

Nudge makes that impossible to miss without being annoying.

---

## 2. Non-goals

Do not build these. They are explicitly out of scope for v1.

- macOS or Linux support (Windows 10/11 only)
- Any cloud backend, account system, telemetry, or analytics
- Reading agent transcripts or conversation content
- Inline reply (answering the agent from the dock) — planned for v2, do not scaffold for it
- Auto-update
- A settings UI beyond a minimal tray menu

---

## 3. Stack

- Electron 33+ (main + preload + renderer, contextIsolation on, nodeIntegration off)
- TypeScript throughout
- electron-vite for the build
- Renderer: plain HTML/CSS/TS. No React, no Tailwind, no component library. The UI is three small states — a framework is pure overhead here.
- `express` for the local event server
- `node-window-manager` for Win32 window focus
- `electron-store` for settings persistence
- `smol-toml` for reading/writing Codex's config.toml

Do not add anything else without asking.

---

## 4. Repo structure

```
nudge/
├── src/
│   ├── main/
│   │   ├── index.ts              app lifecycle, tray, single-instance lock
│   │   ├── server.ts             express listener on 127.0.0.1
│   │   ├── sessions.ts           session store + state machine
│   │   ├── overlay.ts            the notch BrowserWindow
│   │   ├── focus.ts              Win32 jump-to-window
│   │   ├── sounds.ts             audio playback
│   │   ├── settings.ts           electron-store wrapper
│   │   └── adapters/
│   │       ├── types.ts          Adapter interface
│   │       ├── claudecode.ts
│   │       ├── cursor.ts
│   │       ├── codex.ts
│   │       ├── antigravity.ts
│   │       └── index.ts          registry + install/uninstall all
│   ├── preload/
│   │   └── index.ts              contextBridge API
│   ├── renderer/
│   │   ├── index.html
│   │   ├── dock.ts               state rendering + hover logic
│   │   └── dock.css
│   └── shim/
│       └── main.ts               tiny CLI compiled to nudge-shim.exe
├── resources/
│   ├── sounds/{done.wav,attention.wav}
│   └── icons/{tray.ico,agents/*.png}
└── electron.vite.config.ts
```

---

## 5. The core event schema

Everything in the app flows through this one object. Every adapter normalizes into it.

```ts
type AgentId = 'claude-code' | 'cursor' | 'codex' | 'antigravity' | 'generic';
type SessionState = 'working' | 'needs-input' | 'done' | 'error';

interface NudgeEvent {
  agent: AgentId;
  state: SessionState;
  project: string;          // basename of cwd, e.g. "octiq"
  cwd: string;              // absolute path, used as the session key
  sessionId?: string;       // agent's own id if it gives one
  message?: string;         // "Finished editing 4 files" / "Allow Bash?"
  detail?: string;          // monospace secondary line, e.g. "npm run db:migrate"
  shimPid: number;          // PID of the shim process — used for window resolution
  ts: number;               // Date.now()
}
```

`cwd` is the session key, not `sessionId`. Agents restart sessions constantly; the project folder is what the user actually thinks in.

---

## 6. The shim

A tiny standalone executable that every agent's hook calls. It does exactly one thing: read the event, POST it to the local server, exit fast.

```
nudge-shim.exe --agent <id> --state <state> [--message "..."]
```

Behaviour:

1. Read JSON from stdin if available (Claude Code, Cursor, Antigravity all pipe JSON on stdin). If `argv[2]` is a JSON string instead, parse that (Codex passes it as a single argv).
2. Merge stdin/argv data with the CLI flags. CLI flags win for `agent`; the payload wins for `message` and `cwd`.
3. Resolve `cwd` — prefer the payload's field, fall back to `process.cwd()`.
4. POST to `http://127.0.0.1:47821/event` with a 300ms timeout.
5. Always `process.exit(0)`, even on failure. **A failed POST must never block or slow the agent.** If Nudge isn't running, the shim silently no-ops.

Compile with `pkg` or `esbuild` + `node --experimental-sea-config`. Target size under 15MB, startup under 80ms. Startup time matters — this runs on every agent turn.

Ship it to `%LOCALAPPDATA%\Nudge\bin\nudge-shim.exe` on first launch and reference that absolute path in every hook config.

---

## 7. Adapters

Each adapter implements:

```ts
interface Adapter {
  id: AgentId;
  displayName: string;
  isInstalled(): Promise<boolean>;    // is the agent itself present on this machine?
  isWired(): Promise<boolean>;        // are our hooks already in its config?
  wire(): Promise<void>;              // merge our hooks in
  unwire(): Promise<void>;            // remove only our entries
}
```

**Critical rule for all adapters:** never overwrite the user's config file. Read it, parse it, merge our entries in, write it back. Before the first write, copy the original to `<file>.nudge-backup`. Every entry we add must be identifiable so `unwire` can remove exactly ours and nothing else — tag our commands by the fact that they invoke our shim path.

### 7.1 Claude Code

File: `%USERPROFILE%\.claude\settings.json`

```json
{
  "hooks": {
    "Stop": [
      { "hooks": [{ "type": "command", "command": "\"C:\\...\\nudge-shim.exe\" --agent claude-code --state done" }] }
    ],
    "Notification": [
      { "matcher": "permission_prompt", "hooks": [{ "type": "command", "command": "\"C:\\...\\nudge-shim.exe\" --agent claude-code --state needs-input" }] },
      { "matcher": "idle_prompt", "hooks": [{ "type": "command", "command": "\"C:\\...\\nudge-shim.exe\" --agent claude-code --state needs-input" }] }
    ],
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "\"C:\\...\\nudge-shim.exe\" --agent claude-code --state working" }] }
    ]
  }
}
```

Notes:
- `Stop` does not fire when the user interrupts with Esc. That's correct behaviour — no notification for a task you cancelled yourself.
- `UserPromptSubmit` is what puts a session into `working`. Without it the dock has no idea a task started.
- stdin JSON gives you `session_id`, `cwd`, `transcript_path`, `hook_event_name`.
- Reference: https://docs.claude.com/en/docs/claude-code/hooks

### 7.2 Cursor

File: `%USERPROFILE%\.cursor\hooks.json`

```json
{
  "version": 1,
  "hooks": {
    "sessionStart": [{ "command": "\"C:\\...\\nudge-shim.exe\" --agent cursor --state working" }],
    "stop": [{ "command": "\"C:\\...\\nudge-shim.exe\" --agent cursor --state done" }],
    "beforeShellExecution": [{ "command": "\"C:\\...\\nudge-shim.exe\" --agent cursor --state needs-input" }]
  }
}
```

Notes:
- The `stop` hook receives `{ conversation_id, status: "completed" | "aborted" | "error", loop_count }` on stdin. Map `aborted` → suppress entirely, `error` → `state: 'error'`.
- `afterFileEdit` gives `workspace_roots` — useful if `cwd` resolution fails.
- The shim must print `{}` to stdout and exit 0, or Cursor may treat it as a crashed hook.
- Cursor hooks work in the IDE. CLI support has historically lagged — detect and warn if only the CLI is present.
- Reference: https://cursor.com/docs/hooks

### 7.3 Codex CLI

File: `%USERPROFILE%\.codex\config.toml`

```toml
notify = ["C:\\...\\nudge-shim.exe", "--agent", "codex", "--state", "done"]
```

Notes:
- **TOML root keys must appear before any `[table]`.** When merging, insert `notify` above the first table header or the file will fail to parse. This is the single most likely bug in this adapter — write a test for it.
- Only one event exists: `agent-turn-complete`. Codex gives you no needs-input signal, so Codex sessions only ever produce `done`. Do not fake it.
- The payload arrives as a single JSON argv string: `{"type":"agent-turn-complete","last-assistant-message":"..."}`. Use `last-assistant-message` (truncated to 80 chars) as the dock message.
- Reference: https://developers.openai.com/codex/config-advanced

### 7.4 Antigravity

Antigravity 2.0 added hooks that run local shell scripts at agent lifecycle stages, including before/after tool execution and at agent-loop stopping conditions.

Wire the stopping-condition hook to `--state done` and the before-tool-execution hook to `--state needs-input`.

**Before implementing, fetch the current hook config format from https://antigravity.google/docs — do not guess the file path or schema.** If the docs are unclear or the format has changed, stub `isInstalled()` to return false and move on. This adapter is Phase 4; it must not block anything earlier.

---

## 8. Local server

`src/main/server.ts`, express, bound to `127.0.0.1:47821` only — never `0.0.0.0`.

- `POST /event` → validate against the `NudgeEvent` shape, drop anything malformed, hand to the session store, `200 {}`.
- `GET /health` → `200 { version }`. The shim doesn't use this; it's for debugging.
- Reject any request whose `Origin` header is present (a browser trying to hit our port).
- Cap message and detail at 200 chars before storing.
- If the port is taken, try 47822–47830 and write the chosen port to `%LOCALAPPDATA%\Nudge\port`. The shim reads that file, falling back to 47821.

---

## 9. Session store

`Map<cwd, Session>` in memory. No persistence — sessions are meaningless across restarts.

```ts
interface Session {
  cwd: string;
  project: string;
  agent: AgentId;
  state: SessionState;
  message?: string;
  detail?: string;
  shimPid: number;
  startedAt: number;     // when it entered 'working'
  changedAt: number;     // last state transition
  windowHandle?: number; // resolved lazily, cached
  dismissed: boolean;
}
```

Transition rules:

- `working` → `working`: refresh `changedAt`, do not re-notify, do not reset `startedAt`.
- `* → done` or `* → needs-input` or `* → error`: reset `dismissed` to false, fire a notification.
- Any new event on a dismissed session un-dismisses it.
- A session in `done` for over 5 minutes is deleted.
- A session in `working` with no events for 6 hours is deleted (stale, probably a crashed agent).

Sort order for display: `needs-input` → `error` → `done` → `working`. Within a tier, most recent `changedAt` first.

---

## 10. Overlay window

`src/main/overlay.ts`

```ts
const overlay = new BrowserWindow({
  width: 1000,
  height: 420,
  x: Math.round((screenWidth - 1000) / 2),
  y: 0,
  frame: false,
  transparent: true,
  resizable: false,
  movable: false,
  minimizable: false,
  maximizable: false,
  skipTaskbar: true,
  hasShadow: false,
  focusable: false,
  show: false,
  webPreferences: { preload, contextIsolation: true, nodeIntegration: false }
});

overlay.setAlwaysOnTop(true, 'screen-saver');
overlay.setIgnoreMouseEvents(true, { forward: true });
overlay.setVisibleOnAllWorkspaces(true);
```

**Non-negotiable rules:**

1. **Never resize or move the window to animate.** The window is a fixed 1000×420 transparent rectangle. All expansion and collapse is CSS inside the renderer. Resizing the window produces visible flicker and tearing on Windows.

2. **Mouse passthrough must be correct or the app is unusable.** `forward: true` means the renderer still receives `mousemove` while clicks pass through to whatever's underneath. In the renderer, attach `mouseenter`/`mouseleave` to the visible card element and IPC to main:
   - `mouseenter` → `overlay.setIgnoreMouseEvents(false)`
   - `mouseleave` → `overlay.setIgnoreMouseEvents(true, { forward: true })`
   
   Test explicitly: with the dock idle, the user must be able to click a browser tab directly underneath the invisible window area. If they can't, the bug is here.

3. **Never call `overlay.focus()` or `show()` with focus.** `focusable: false` handles this, but a stray `focus()` will steal keystrokes mid-typing and it is the fastest way to get uninstalled.

4. Hide the window entirely (`overlay.hide()`) when there are zero non-dismissed sessions. A transparent always-on-top window with nothing in it still costs compositor work.

5. Handle `screen` display changes — recompute `x` on `display-metrics-changed` and `display-added`. Multi-monitor users are the target audience.

---

## 11. Renderer UI

### Layout

Content is anchored to the top edge of the window and horizontally centered. The card has **no top border and no top corner radius** — it must read as growing out of the screen edge, not floating below it.

```css
border-radius: 0 0 16px 16px;
border: 0.5px solid var(--border);
border-top: none;
```

### Tokens (dark only for v1)

```css
--surface:        #17171A;
--surface-inset:  #1F1F23;
--border:         rgba(255,255,255,0.10);
--text-primary:   #ECECEE;
--text-secondary: #9A9AA2;
--text-muted:     #6B6B73;
--accent-done:    #1D9E75;
--accent-input:   #EF9F27;
--accent-error:   #E24B4A;
--font-sans:      "Segoe UI Variable", "Segoe UI", system-ui, sans-serif;
--font-mono:      "Cascadia Code", "Consolas", ui-monospace, monospace;
```

Follow the system theme in a later phase. Dark only for now.

### The three states

**Collapsed (working).** A pill, width fits content, padding `7px 14px`. Contents: a 6px status dot, the project name in mono 12px `--text-secondary`, elapsed time `M:SS` in 12px `--text-muted`. No sound. Fully click-through.

**Done.** Card width 360px, padding `12px 16px 14px`.
- Header row: 6px dot in `--accent-done`, `agent · project` in mono 12px `--text-secondary`, right-aligned `done in M:SS` in 12px `--text-muted`.
- Message line: 14px `--text-primary`, single line, ellipsis on overflow.
- Buttons: `Jump to it` (flex 1) and a 36px icon-only dismiss.
- Auto-collapses back to the pill after 10s. If all sessions are `done`, hides entirely.

**Needs input.** Card width 360px, same structure.
- Dot in `--accent-input`, right-aligned `waiting M:SS` which keeps counting up.
- Message line: the question, 14px.
- Optional detail line: mono 12px on `--surface-inset`, `border-radius: 8px`, `padding: 6px 10px`. Use this for the command being approved.
- Single button: `Jump to it`.
- **Never auto-dismisses.** Persists until the state changes or the user dismisses it.

**Error.** Same as done, dot in `--accent-error`, does not auto-collapse.

### Stacking

More than one active session: collapsed shows `3 agents · 1 waiting` with three dots colored by state. On hover, expand into a vertical list of up to 4 cards, 8px gap, most urgent on top. Beyond 4, show `+N more` and open the tray window on click.

### Motion

`180ms cubic-bezier(0.32, 0.72, 0, 1)` on `height` and `opacity` only. Never animate `filter`, `blur`, or `box-shadow` — they force repaints on a transparent window and stutter.

Respect `prefers-reduced-motion`: skip the height transition, keep opacity.

### Sound

- `done` → a soft single chime, 400ms, low volume.
- `needs-input` and `error` → a sharper two-tone, more present.
- **Never queue.** If three events land within 2 seconds, play one sound only. Deduplicate on a 2s window.
- Respect a `muted` setting and Windows Focus Assist — check `SystemParametersInfo` / quiet hours and stay silent during a presentation.

---

## 12. Jump to window

This is the hardest part of the app. Budget real time for it.

**Resolving the target window:**

The hooks give you `cwd`, not a window handle. Resolve it by walking up the process tree from `shimPid`:

1. Query the parent chain with `Get-CimInstance Win32_Process` (or a native call — avoid spawning PowerShell per event, cache aggressively).
2. Walk up until you hit a process whose name matches a known host (`Cursor.exe`, `WindowsTerminal.exe`, `Code.exe`, `Antigravity.exe`, `powershell.exe`, `pwsh.exe`, `cmd.exe`, `alacritty.exe`, `WezTerm.exe`) **and** which owns a visible top-level window.
3. Cache the resulting handle on the session. Invalidate if the handle is no longer valid.

Fallback if the walk fails: enumerate windows via `node-window-manager` and match a title containing the project folder name. This is a heuristic and will occasionally pick the wrong window — that's acceptable as a fallback, not as the primary path.

**Actually focusing it:**

Windows blocks `SetForegroundWindow` from background processes. `node-window-manager`'s `bringToTop()` handles most cases. When it fails silently, the standard workaround is to attach the calling thread's input queue to the foreground window's thread (`AttachThreadInput`), call `SetForegroundWindow`, then detach.

If the window is minimized, `ShowWindow(SW_RESTORE)` first.

If focus fails entirely, fall back to flashing the taskbar entry (`FlashWindowEx`) and keep the dock card visible. Never fail silently with no feedback.

---

## 13. Tray

Icon in the system tray, always present. Right-click menu:

- Active sessions (read-only list, click to jump)
- Mute sounds (checkbox)
- Start at login (checkbox, via `app.setLoginItemSettings`)
- Agent setup… (opens the setup window)
- Quit

Left-click toggles the dock's expanded state.

---

## 14. Setup window

A single small window (520×600, normal chrome) listing every adapter:

| Agent | Detected | Status | Action |
|---|---|---|---|
| Claude Code | yes | Connected | Disconnect |
| Cursor | yes | Not connected | Connect |
| Codex CLI | no | Not installed | — |
| Antigravity | no | Not installed | — |

Connect calls `wire()`, Disconnect calls `unwire()`. Show the exact file path being modified under each row — developers do not trust apps that silently edit their dotfiles.

After wiring, show: "Restart Claude Code for hooks to load." Cursor reloads `hooks.json` on save; Claude Code and Codex need a fresh session.

---

## 15. Settings

`electron-store`, at `%APPDATA%\Nudge\config.json`:

```ts
{
  muted: boolean;              // default false
  startAtLogin: boolean;       // default true
  autoCollapseMs: number;      // default 10000
  position: 'top-center';      // only value for v1
  wiredAdapters: AgentId[];
}
```

---

## 16. Build phases

Do not proceed to the next phase until the current one is verified working.

### Phase 1 — the spine
Electron app boots, tray icon appears, express server listens on 47821, session store handles transitions, shim compiles and POSTs successfully.

**Done when:** running `nudge-shim.exe --agent claude-code --state done` from any folder logs a correctly-shaped `NudgeEvent` in the main process console.

### Phase 2 — the dock
Overlay window, all three visual states, stacking, motion, sounds, mouse passthrough.

**Done when:** POSTing a fake event renders the correct card, and with the dock idle you can click a link in a browser window positioned directly beneath the overlay's invisible area.

### Phase 3 — Claude Code + Cursor
Both adapters, the setup window, `wire`/`unwire` with backups.

**Done when:** a real Claude Code task finishing produces a real dock card, and a real permission prompt produces a needs-input card that persists.

### Phase 4 — jump to window
Process-tree walk, handle caching, `AttachThreadInput` focus, taskbar-flash fallback.

**Done when:** clicking `Jump to it` reliably focuses the correct terminal or IDE window from a fullscreen browser, including when that window is minimized.

### Phase 5 — Codex + Antigravity
Both remaining adapters. TOML root-key ordering test for Codex.

### Phase 6 — packaging
`electron-builder`, NSIS installer, code signing if a cert is available, portable exe as a secondary artifact.

---

## 17. Testing notes

- Write a `scripts/fake-event.ts` that POSTs arbitrary events. You'll use it constantly.
- Test with three concurrent sessions in three different folders.
- Test on a 4K display at 150% scaling — the notch centering will break at non-100% DPI if you use raw pixel math instead of `screen.getPrimaryDisplay().workArea`.
- Test with two monitors, primary on the right.
- Test what happens when Nudge isn't running and a hook fires. It must be invisible to the agent.
- Test `unwire` on a `settings.json` that has the user's own unrelated hooks in it. Their hooks must survive untouched.

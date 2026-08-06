# Pingly — test checklist

Everything worth checking before you hand a build to someone else. Tick top to bottom;
the automated parts take a minute, the real-agent parts are the ones that actually matter.

Two things are true of nearly every "it didn't work" report:

- **Pingly must be running.** No tray icon = no cards. Check first, always.
- **Hooks load when an agent session starts.** Change wiring → restart that agent.

---

## 0. Automated (1 minute)

```powershell
npm run build
npm run test:adapters          # wire/unwire safety, throwaway home, touches nothing real
npm run status                 # read-only: what's detected and connected
```

Then start Pingly and:

```powershell
npm run test:live              # event pipeline against the running app
```

- [ ] `adapter-test OK`
- [ ] `selftest OK`
- [ ] `npm run status` lists every agent you actually use as `CONNECTED`

Optional, highest-value safety check — run the adapter suite against a **copy** of your
real Codex config:

```powershell
Copy-Item "$env:USERPROFILE\.codex\config.toml" "$env:TEMP\codex-copy.toml"
$env:PINGLY_REAL_TOML = "$env:TEMP\codex-copy.toml"; npm run test:adapters
```

- [ ] `real-config check OK` — every key survives, restored byte-for-byte

---

## 1. Startup and tray

- [ ] Tray icon appears (Win11 hides it under the `^` overflow by default)
- [ ] `http://127.0.0.1:47821/health` returns a version
- [ ] Right-click tray shows: sessions · Dismiss all · Mute sounds · Start at login ·
      Agent setup… · Open Pingly folder · Open log file · Quit
- [ ] **Left-click** tray toggles the dock open/closed (pins it expanded)
- [ ] *Open log file* opens `%LOCALAPPDATA%\Pingly\pingly.log` and it has recent lines
- [ ] Launching Pingly a second time opens the setup window instead of doing nothing

---

## 2. First run

```powershell
# simulate a brand-new machine
Remove-Item "$env:APPDATA\pingly\config.json" -Force
```

- [ ] Setup window opens **by itself** on next launch
- [ ] It does **not** reopen on the launch after that
- [ ] Hero, plain-English explainer, and the 3 numbered steps all read correctly
- [ ] Summary line is accurate (`4 of 4 connected` / `2 detected · none connected yet`)
- [ ] Each row states what connecting will do, and shows the exact file path
- [ ] **Show me a sample** fires a real notification
- [ ] Connect → the note tells you to restart that agent
- [ ] Disconnect → the note says your own settings were left alone

---

## 3. The dock, by state

Fire these without touching your agents:

```powershell
node scripts/fake-event.mjs working     myproj
node scripts/fake-event.mjs done        myproj "Refactored the onboarding flow"
node scripts/fake-event.mjs needs-input myproj "Allow this?" "npm run db:migrate"
node scripts/fake-event.mjs error       myproj "Build failed: tsc exited 2"
```

Move your mouse away from the top of the screen first, or hover will hold it open.

- [ ] **working** → tiny pill only: a dot and a live `M:SS`. No card.
- [ ] **done** → full card, green check, `Finished in …`, `Resume Coding →`
- [ ] done card collapses on its own after ~10s, then disappears entirely
- [ ] **needs-input** → amber card, the question as the message, mono chip for the command
- [ ] needs-input collapses to the pill after ~30s but **the amber pill stays**, counting how
      long it's been waiting — it must not vanish
- [ ] **error** → red card, `Take me there →`
- [ ] Hovering the pill expands it back to full cards; moving away re-collapses

### Stacking

```powershell
node scripts/fake-event.mjs working     alpha
node scripts/fake-event.mjs needs-input beta  "Approve?"
node scripts/fake-event.mjs error       gamma "It broke"
node scripts/fake-event.mjs done        delta "All good"
node scripts/fake-event.mjs working     epsilon
```

- [ ] Order is needs-input → error → done → working
- [ ] Max 4 cards, then `+N more`
- [ ] Top card is flush with the screen edge; the rest are rounded
- [ ] Collapsed multi-session pill shows dots + a count

---

## 4. Clicks, keyboard, passthrough

- [ ] `×` closes the card (appears only on hover — that's deliberate)
- [ ] The action button works and the arrow nudges right on hover
- [ ] Button turns amber **only** on hover
- [ ] Clicking anywhere else on the card also opens the session
- [ ] **Passthrough:** with only the tiny pill showing, click a link in a browser directly
      below the invisible window area — the click must reach the browser
- [ ] Hovering onto the card makes it clickable again (try several times in a row)
- [ ] Typing in your editor while a card is on screen never loses a keystroke

---

## 5. Jump to window

- [ ] `Jump to it` on a **minimized** target restores and focuses it
- [ ] On a visible-but-background target it flashes the taskbar button orange
- [ ] When it can't focus, the card shows the amber explanation — never silent
- [ ] No matching window → `No matching window found`

Scriptable:

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:47821/jump `
  -ContentType application/json -Body '{"cwd":"C:\\dev\\myproj"}'
```

Expect `focused`, `flashed`, or `not-found`. **`flashed` is normal** — Windows blocks
background apps from stealing focus.

---

## 6. Sound

- [ ] `done` plays a soft single chime
- [ ] `needs-input` / `error` play a sharper two-tone
- [ ] Three events inside 2s play **one** sound, not three
- [ ] Tray → *Mute sounds* silences it
- [ ] Windows Focus Assist / Do not disturb silences it

---

## 7. Multi-monitor and DPI

- [ ] Card appears centred at the top of the screen **your cursor is on**
- [ ] Still centred after moving the mouse to the other monitor and firing a new event
- [ ] Unplug/replug or change resolution → it repositions, doesn't end up off-screen
- [ ] Check at a scaling other than yours (125% here) — 100% and 150% especially

---

## 8. Per-agent (the ones that count)

Restart the agent first. These can only be verified by real use.

### Claude Code
- [ ] Send a prompt → tiny pill with a live timer
- [ ] It finishes → `Response ready` card + sound
- [ ] It asks a **question** (`AskUserQuestion`) → `Waiting for your input` showing the
      actual question text
- [ ] Answer it → card clears, back to the working pill
- [ ] A permission prompt shows the command in the mono chip
- [ ] Press Esc to interrupt → **no** notification (cancelling yourself isn't news)

### Cursor
- [ ] Task finishes → card
- [ ] No card on every shell command (deliberate — Cursor has no approval signal)
- [ ] Cancelling a turn produces nothing

### Codex CLI
- [ ] Turn completes → card with the closing message, truncated to 80 chars
- [ ] **Computer-use still works.** Pingly took Codex's single `notify` slot and re-runs
      your original program; if that broke, this is where you'd see it.

### Extensions inside an editor
Hooks live in each tool's global config, not in the editor, so the host should not matter.
- [ ] Claude Code extension in **VS Code** → card on finish
- [ ] Claude Code or Codex extension in **Antigravity IDE** → card on finish
- [ ] `Resume Coding` focuses the editor window, not a stray terminal

---

## 9. Config safety

- [ ] `<config>.pingly-backup` exists next to each wired file
- [ ] Disconnect leaves your own hooks byte-for-byte intact
- [ ] Disconnect Codex → your original `notify` line returns **exactly** as it was
- [ ] Reconnecting twice doesn't create duplicate entries

---

## 10. Failure modes

- [ ] **Pingly not running** + agent finishes → agent is completely unaffected, no error,
      no delay. The single most important one.
- [ ] Rename the shim away and run a hook → agent still fine
- [ ] Rename `node` off PATH → setup window shows the red Node warning and Connect is
      disabled
- [ ] Port 47821 occupied → Pingly takes the next free port and
      `%LOCALAPPDATA%\Pingly\port` reflects it
- [ ] A stale `needs-input` you never answer can be cleared via `×` or tray → Dismiss all

---

## 11. Install / uninstall

- [ ] `Pingly-0.1.0-setup.exe` installs without admin rights
- [ ] Setup window opens after install finishes
- [ ] SmartScreen warns (expected — unsigned; *More info → Run anyway*)
- [ ] Start at login works after a reboot
- [ ] **Uninstall unwires every agent first** — check `npm run status` afterwards; all
      should read `not connected`, and Codex's original `notify` must be back
- [ ] `Pingly-0.1.0-portable.exe` runs with no install

---

## Known limits — don't chase these

- `Jump to it` usually **flashes** rather than switches. Windows blocks foreground steals
  from background processes; it only switches outright when the target is minimized.
- Window matching is by **title**, so it can pick the wrong window when two open projects
  share a folder name.
- Cursor gives **no approval alerts** — it exposes no "the user was asked" event.
  Completion only.
- Antigravity's own agent is **not supported**: its hook runner leaves the outer quotes on
  the command, so `"C:\Program Files\nodejs\node.exe"` never resolves. The Claude Code and
  Codex extensions running inside Antigravity are unaffected.
- Codex only ever reports `done`. It has one event.
- Unsigned, so SmartScreen and possibly antivirus will complain.
- Windows only.

---

## When something doesn't fire

```powershell
Get-Content "$env:LOCALAPPDATA\Pingly\pingly.log" -Tail 30
```

- an `event {…}` line → the hook fired; the problem is downstream in the dock
- nothing → the hook never fired; check Pingly is running, then that the agent was
  restarted after wiring

To see exactly what an agent sends, run the hook by hand:

```powershell
$env:PINGLY_DEBUG = "1"
'{"cwd":"C:\\dev\\myproj","tool_name":"AskUserQuestion"}' | `
  node "$env:LOCALAPPDATA\Pingly\bin\pingly-shim.js" --agent claude-code --state needs-input
```

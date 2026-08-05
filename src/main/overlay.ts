import { BrowserWindow, ipcMain, screen } from 'electron';
import { join } from 'node:path';
import { sessions } from './sessions';
import { settings } from './settings';
import { soundDataUrls, maybePlay } from './sounds';
import { jumpTo, type JumpResult } from './focus';

const W = 1000;
// Tall enough for four stacked cards, capped to the work area so it never runs off
// screen. The window is a fixed transparent rectangle and is hidden when empty.
const MAX_H = 960;
const HOVER_POLL_MS = 50;

let overlay: BrowserWindow | null = null;
/** Bounds of the visible card/pill, in window-relative DIP. Reported by the renderer. */
let contentRect = { x: 0, y: 0, width: 0, height: 0 };
let interactive = false;
let poll: NodeJS.Timeout | null = null;

/**
 * Placed on the display the pointer is on, not the primary one — on a multi-monitor desk
 * a notification pinned to monitor 1 is invisible while you work on monitor 2. Recomputed
 * only as the dock appears, so it never hops mid-read.
 */
function frame(): { x: number; y: number; width: number; height: number } {
  // workArea is in DIP, so this stays centered at any display scaling.
  const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  return {
    x: Math.round(wa.x + (wa.width - W) / 2),
    y: wa.y,
    width: W,
    height: Math.min(MAX_H, wa.height)
  };
}

function setInteractive(on: boolean): void {
  if (!overlay || on === interactive) return;
  interactive = on;
  if (on) overlay.setIgnoreMouseEvents(false);
  else overlay.setIgnoreMouseEvents(true);
  overlay.webContents.send('hover', on);
}

/**
 * Hit-testing lives in main and polls the cursor rather than listening for renderer
 * mousemove: `setIgnoreMouseEvents(true, {forward:true})` only forwards moves from the
 * window that happened to be under the cursor when it was armed, so the renderer stops
 * hearing about hovers after the first pass-through cycle and the dock goes dead.
 */
function pollCursor(): void {
  if (!overlay?.isVisible() || contentRect.width === 0) return void setInteractive(false);
  const p = screen.getCursorScreenPoint();
  const b = overlay.getBounds();
  const x = p.x - b.x - contentRect.x;
  const y = p.y - b.y - contentRect.y;
  setInteractive(x >= 0 && x <= contentRect.width && y >= 0 && y <= contentRect.height);
}

function push(): void {
  overlay?.webContents.send('sessions', {
    sessions: sessions.visible(),
    autoCollapseMs: settings.get('autoCollapseMs')
  });
}

export function createOverlay(preload: string, rendererUrl: string | null, rendererFile: string): BrowserWindow {
  overlay = new BrowserWindow({
    ...frame(),
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    hasShadow: false,
    // Focusable, but never focused on our initiative: it is only ever shown with
    // showInactive() and focus() is never called. A non-focusable window on Windows
    // refuses activation, and Chromium then swallows clicks — hover worked, buttons
    // did nothing. This is also what makes the card keyboard-reachable once clicked.
    focusable: true,
    show: false,
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false // the dock keeps ticking elapsed time while hidden
    }
  });

  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setIgnoreMouseEvents(true);
  overlay.setVisibleOnAllWorkspaces(true);

  if (rendererUrl) overlay.loadURL(rendererUrl);
  else overlay.loadFile(rendererFile);

  overlay.webContents.on('console-message', (_e, _lvl, msg) => console.log('[dock]', msg));

  overlay.webContents.on('did-finish-load', () => {
    overlay?.webContents.send('sounds', soundDataUrls());
    push();
  });

  ipcMain.on('dock:rect', (_e, r: typeof contentRect) => (contentRect = r));

  ipcMain.on('dock:visible', (_e, visible: boolean) => {
    if (!overlay) return;
    if (visible && !overlay.isVisible()) {
      overlay.setBounds(frame()); // follow whichever screen is being used right now
      // Never show with focus — a stray focus steals keystrokes mid-typing.
      overlay.showInactive();
      poll ??= setInterval(pollCursor, HOVER_POLL_MS);
    } else if (!visible && overlay.isVisible()) {
      overlay.hide();
      setInteractive(false);
      if (poll) clearInterval(poll), (poll = null);
    }
  });

  ipcMain.on('dock:dismiss', (_e, cwd: string) => {
    console.log('[pingly] dismiss', cwd);
    sessions.dismiss(cwd);
  });

  ipcMain.on('dock:jump', (_e, cwd: string) => {
    console.log('[pingly] jump', cwd);
    void handleJump(cwd);
  });

  sessions.on('changed', push);
  sessions.on('notify', (s) => maybePlay(s.state, (name) => overlay?.webContents.send('sound', name)));

  const reposition = (): void => overlay?.setBounds(frame());
  screen.on('display-metrics-changed', reposition);
  screen.on('display-added', reposition);
  screen.on('display-removed', reposition);

  return overlay;
}

export async function handleJump(cwd: string): Promise<JumpResult | 'no-session'> {
  const s = sessions.get(cwd);
  if (!s) return 'no-session';
  const result = await jumpTo(s);
  // Always report back — "never fail silently with no feedback".
  overlay?.webContents.send('jump:result', { cwd, result });
  if (result === 'focused') sessions.dismiss(cwd);
  return result;
}

export function toggleDock(): void {
  overlay?.webContents.send('dock:toggle');
}

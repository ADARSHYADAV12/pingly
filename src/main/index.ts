import { app, BrowserWindow, clipboard, ipcMain, Menu, Tray, shell } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BIN_DIR, PINGLY_DIR, SHIM_PATH } from '../shared/paths';
import type { AgentId } from '../shared/types';
import { sessions } from './sessions';
import { settings } from './settings';
import { startServer } from './server';
import { createOverlay, toggleDock } from './overlay';
import { adapters, confirmCodexHookTrust, listAdapters, migrateFromLegacy, runtime, setWired } from './adapters';
import { codex } from './adapters/codex';
import { cursor } from './adapters/cursor';
import { ensureHelper } from './focus';
import { initLog, LOG_FILE } from './log';
import { startCodexSessionWatcher } from './codex-session-watcher';
import { startCursorSessionWatcher } from './cursor-session-watcher';
import { launchCodexHookReview } from './codex-hook-review';
import { updater } from './updater';

const resourcesDir = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources');
const preloadPath = join(__dirname, '../preload/index.js');

let tray: Tray | null = null;
let setupWindow: BrowserWindow | null = null;

function openSetup(): void {
  if (setupWindow) return void setupWindow.focus();
  setupWindow = new BrowserWindow({
    width: 560,
    height: 830,
    title: 'Pingly — Agent setup',
    backgroundColor: '#141417',
    icon: join(resourcesDir, 'icons', 'tray.ico'),
    webPreferences: { preload: preloadPath, contextIsolation: true, nodeIntegration: false }
  });
  setupWindow.setMenuBarVisibility(false);
  setupWindow.on('closed', () => (setupWindow = null));

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) setupWindow.loadURL(`${devUrl}/setup.html`);
  else setupWindow.loadFile(join(__dirname, '../renderer/setup.html'));

  // Dev aid: renders this window to a PNG and exits, so the UI can be reviewed without
  // photographing the desktop. PINGLY_CAPTURE=<path>, never set in normal use.
  if (process.env.PINGLY_CAPTURE) {
    setupWindow.webContents.once('did-finish-load', () =>
      setTimeout(async () => {
        setupWindow!.show();
        const img = await setupWindow!.webContents.capturePage();
        writeFileSync(process.env.PINGLY_CAPTURE!, img.toPNG());
        app.quit();
      }, 2500)
    );
  }
}

/** Copy the bundled shim to a stable absolute path that hook configs can reference. */
function installShim(): void {
  mkdirSync(BIN_DIR, { recursive: true });
  // read+write rather than copyFileSync: once packaged the source lives inside app.asar
  writeFileSync(SHIM_PATH, readFileSync(join(__dirname, 'shim.js')));
}

function buildTrayMenu(): void {
  if (!tray) return;
  const active = sessions.all();
  tray.setContextMenu(
    Menu.buildFromTemplate([
      ...(active.length
        ? active.map((s) => ({ label: `${s.project} — ${s.state}`, enabled: false }))
        : [{ label: 'No active sessions', enabled: false }]),
      { type: 'separator' },
      ...(updater.info()
        ? [
            { label: `Update available — v${updater.info()!.version}`, click: () => void updater.download() },
            { label: 'Check for updates', click: () => void updater.check() },
            { type: 'separator' as const }
          ]
        : [{ label: 'Check for updates', click: () => void updater.check() }, { type: 'separator' as const }]),
      // escape hatch: clears the dock even if the overlay itself is unreachable
      { label: 'Dismiss all', enabled: active.length > 0, click: () => sessions.dismissAll() },
      {
        label: 'Mute sounds',
        type: 'checkbox',
        checked: settings.get('muted'),
        click: (i) => settings.set('muted', i.checked)
      },
      {
        label: 'Start at login',
        type: 'checkbox',
        checked: settings.get('startAtLogin'),
        click: (i) => {
          settings.set('startAtLogin', i.checked);
          app.setLoginItemSettings({ openAtLogin: i.checked });
        }
      },
      { type: 'separator' },
      { label: 'Agent setup…', click: openSetup },
      { label: 'Open Pingly folder', click: () => shell.openPath(PINGLY_DIR) },
      { label: 'Open log file', click: () => shell.openPath(LOG_FILE) },
      { label: 'Quit', click: () => app.quit() }
    ])
  );
  tray.setToolTip(active.length ? `Pingly — ${active.length} session(s)` : 'Pingly');
}

initLog();

/**
 * Run by the uninstaller before the files are deleted. Without this, every wired agent is
 * left calling a shim that no longer exists — a hard error on every turn, forever, from an
 * app the user has removed. Deliberately ahead of the single-instance lock so it still
 * runs when Pingly happens to be open.
 */
const bulk = process.argv.includes('--unwire-all') ? 'unwire' : process.argv.includes('--wire-all') ? 'wire' : null;

if (bulk) {
  app.whenReady().then(async () => {
    for (const a of adapters) {
      try {
        if (bulk === 'wire' && !(await a.isInstalled())) continue;
        await (bulk === 'wire' ? a.wire() : a.unwire());
        console.log(`[pingly] ${bulk}d ${a.displayName}`);
      } catch (e) {
        console.error(`[pingly] could not ${bulk} ${a.displayName}:`, e);
      }
    }
    app.exit(0);
  });
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.whenReady().then(async () => {
    installShim();
    app.setLoginItemSettings({ openAtLogin: settings.get('startAtLogin') });
    void ensureHelper(); // build in the background so the first Jump click is fast
    await migrateFromLegacy();

    ipcMain.handle('adapters:list', () => listAdapters());
    ipcMain.handle('adapters:runtime', () => runtime());
    ipcMain.handle('adapters:setWired', (_e, id: AgentId, on: boolean) => setWired(id, on));
    ipcMain.handle('adapters:confirmCodexTrust', () => confirmCodexHookTrust());
    ipcMain.handle('adapters:openCodexHookReview', () =>
      launchCodexHookReview({ copyText: (text) => clipboard.writeText(text) })
    );
    // lets someone see what a notification looks like before wiring anything up
    ipcMain.handle('demo:notify', () =>
      sessions.ingest({
        agent: 'claude-code',
        state: 'done',
        project: 'your-project',
        cwd: 'pingly://demo',
        message: 'This is what Pingly looks like when an agent finishes.',
        shimPid: 0,
        ts: Date.now()
      })
    );

    createOverlay(
      preloadPath,
      process.env.ELECTRON_RENDERER_URL ? `${process.env.ELECTRON_RENDERER_URL}/index.html` : null,
      join(__dirname, '../renderer/index.html')
    );

    tray = new Tray(join(resourcesDir, 'icons', 'tray.ico'));
    buildTrayMenu();
    tray.on('click', toggleDock);
    sessions.on('changed', buildTrayMenu);
    updater.on('changed', buildTrayMenu);
    updater.start();

    await startServer();
    startCodexSessionWatcher((turn) => {
      // The journal is Codex-owned rather than part of its hook config, so explicitly
      // respect Pingly's Connect/Disconnect switch before surfacing the fallback event.
      void codex.isWired().then((wired) => {
        if (!wired) return;
        sessions.ingest({
          agent: 'codex',
          state: 'working',
          ...turn,
          shimPid: 0,
          ts: Date.now()
        });
      });
    });
    startCursorSessionWatcher((turn) => {
      // Cursor's Windows hook runner is slow to launch. Its own diagnostic lifecycle
      // marker appears immediately and contains no prompt text in the data we consume.
      void cursor.isWired().then((wired) => {
        if (!wired) return;
        sessions.ingest({
          agent: 'cursor',
          state: 'working',
          ...turn,
          shimPid: 0,
          ts: Date.now()
        });
      });
    });
    console.log('[pingly] shim installed at', SHIM_PATH);

    // First launch explains the setup before Pingly disappears into the tray. A new or
    // changed Codex hook also brings this window back until its one-time trust review is
    // confirmed, so upgrades cannot silently leave lifecycle tracking disabled.
    const approvalNeeded = (await listAdapters()).some((a) => a.needsTrustApproval);
    if (process.argv.includes('--setup') || !settings.get('onboarded') || approvalNeeded) {
      settings.set('onboarded', true);
      openSetup();
    }
  });

  // Relaunching a tray app should do something visible rather than silently exit.
  app.on('second-instance', openSetup);

  // Tray app: never quit just because a window closed.
  app.on('window-all-closed', () => {});
}

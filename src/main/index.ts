import { app, BrowserWindow, ipcMain, Menu, Tray, shell } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BIN_DIR, PINGLY_DIR, SHIM_PATH } from '../shared/paths';
import type { AgentId } from '../shared/types';
import { sessions } from './sessions';
import { settings } from './settings';
import { startServer } from './server';
import { createOverlay, toggleDock } from './overlay';
import { adapters, listAdapters, migrateFromLegacy, runtime, setWired } from './adapters';
import { ensureHelper } from './focus';
import { initLog, LOG_FILE } from './log';

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

    await startServer();
    console.log('[pingly] shim installed at', SHIM_PATH);

    // first launch after install: explain what this is before it sits silently in the tray
    if (process.argv.includes('--setup') || !settings.get('onboarded')) {
      settings.set('onboarded', true);
      openSetup();
    }
  });

  // Relaunching a tray app should do something visible rather than silently exit.
  app.on('second-instance', openSetup);

  // Tray app: never quit just because a window closed.
  app.on('window-all-closed', () => {});
}

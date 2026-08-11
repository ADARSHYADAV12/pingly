import { contextBridge, ipcRenderer } from 'electron';
import type { Session, UpdateInfo } from '../shared/types';

export interface DockPayload {
  sessions: Session[];
  autoCollapseMs: number;
  update: UpdateInfo | null;
}

contextBridge.exposeInMainWorld('pingly', {
  onSessions: (cb: (p: DockPayload) => void) => ipcRenderer.on('sessions', (_e, p) => cb(p)),
  onSounds: (cb: (s: { done: string; attention: string }) => void) => ipcRenderer.on('sounds', (_e, s) => cb(s)),
  onSound: (cb: (name: 'done' | 'attention') => void) => ipcRenderer.on('sound', (_e, n) => cb(n)),
  onToggle: (cb: () => void) => ipcRenderer.on('dock:toggle', () => cb()),
  onHover: (cb: (on: boolean) => void) => ipcRenderer.on('hover', (_e, on) => cb(on)),
  onJumpResult: (cb: (r: { cwd: string; result: string }) => void) =>
    ipcRenderer.on('jump:result', (_e, r) => cb(r)),
  setRect: (r: { x: number; y: number; width: number; height: number }) => ipcRenderer.send('dock:rect', r),
  setVisible: (on: boolean) => ipcRenderer.send('dock:visible', on),
  dismiss: (cwd: string) => ipcRenderer.send('dock:dismiss', cwd),
  jump: (cwd: string) => ipcRenderer.send('dock:jump', cwd),
  dismissUpdate: () => ipcRenderer.send('update:dismiss'),
  downloadUpdate: () => ipcRenderer.send('update:download')
});

// used by the setup window
contextBridge.exposeInMainWorld('pinglySetup', {
  list: () => ipcRenderer.invoke('adapters:list'),
  runtime: () => ipcRenderer.invoke('adapters:runtime'),
  setWired: (id: string, on: boolean) => ipcRenderer.invoke('adapters:setWired', id, on),
  openCodexHookReview: () => ipcRenderer.invoke('adapters:openCodexHookReview'),
  confirmCodexTrust: () => ipcRenderer.invoke('adapters:confirmCodexTrust'),
  demo: () => ipcRenderer.invoke('demo:notify')
});

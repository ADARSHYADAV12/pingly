import Store from 'electron-store';
import type { AgentId } from '../shared/types';

interface Schema {
  muted: boolean;
  startAtLogin: boolean;
  autoCollapseMs: number;
  position: 'top-center';
  wiredAdapters: AgentId[];
  /** false until the setup window has been shown once */
  onboarded: boolean;
}

export const settings = new Store<Schema>({
  name: 'config',
  defaults: {
    muted: false,
    startAtLogin: true,
    autoCollapseMs: 10000,
    position: 'top-center',
    wiredAdapters: [],
    onboarded: false
  }
});

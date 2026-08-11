import { app, net, shell } from 'electron';
import { EventEmitter } from 'node:events';
import type { UpdateInfo } from '../shared/types';

const LATEST_RELEASE_API = 'https://api.github.com/repos/ADARSHYADAV12/pingly/releases/latest';
const RELEASES_PAGE = 'https://github.com/ADARSHYADAV12/pingly/releases/latest';
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

type GithubRelease = {
  tag_name?: string;
  html_url?: string;
  body?: string;
  draft?: boolean;
  prerelease?: boolean;
  assets?: Array<{ name?: string; browser_download_url?: string }>;
};

function parts(version: string): number[] | null {
  const match = version.trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  return match ? match.slice(1).map(Number) : null;
}

export function isNewerVersion(candidate: string, current: string): boolean {
  const next = parts(candidate);
  const installed = parts(current);
  if (!next || !installed) return false;
  for (let i = 0; i < 3; i += 1) {
    if (next[i] !== installed[i]) return next[i] > installed[i];
  }
  return false;
}

class UpdateChecker extends EventEmitter {
  private available: UpdateInfo | null = null;
  private checking = false;
  private dismissed = false;

  info(): UpdateInfo | null {
    return this.available ? { ...this.available, dismissed: this.dismissed } : null;
  }

  async check(): Promise<UpdateInfo | null> {
    if (this.checking) return this.info();
    this.checking = true;
    try {
      const response = await net.fetch(LATEST_RELEASE_API, {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': `Pingly/${app.getVersion()}`,
          'X-GitHub-Api-Version': '2022-11-28'
        }
      });
      if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
      const release = (await response.json()) as GithubRelease;
      if (release.draft || release.prerelease || !release.tag_name) return null;
      if (!isNewerVersion(release.tag_name, app.getVersion())) {
        if (this.available) {
          this.available = null;
          this.emit('changed');
        }
        return null;
      }

      const installer = release.assets?.find((asset) => asset.name === 'Pingly-Setup.exe');
      const version = release.tag_name.replace(/^v/i, '');
      const isDifferent = this.available?.version !== version;
      this.available = {
        version,
        currentVersion: app.getVersion(),
        downloadUrl: installer?.browser_download_url || release.html_url || RELEASES_PAGE,
        releaseUrl: release.html_url || RELEASES_PAGE,
        notes: release.body?.trim().slice(0, 240),
        foundAt: isDifferent ? Date.now() : this.available?.foundAt || Date.now(),
        dismissed: false
      };
      if (isDifferent) this.dismissed = false;
      this.emit('changed');
      return this.info();
    } catch (error) {
      console.warn('[pingly] update check failed:', error);
      return this.info();
    } finally {
      this.checking = false;
    }
  }

  dismiss(): void {
    if (!this.available || this.dismissed) return;
    this.dismissed = true;
    this.emit('changed');
  }

  async download(): Promise<void> {
    await shell.openExternal(this.available?.downloadUrl || RELEASES_PAGE);
  }

  start(): void {
    setTimeout(() => void this.check(), 3_000).unref();
    setInterval(() => void this.check(), CHECK_EVERY_MS).unref();
  }
}

export const updater = new UpdateChecker();

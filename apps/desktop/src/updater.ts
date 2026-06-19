// @z-assistant/app-desktop — Auto Update
//
// Uses electron-updater to check for updates and apply them.
// Configured with a static update server URL that can be replaced
// at build time.

import { autoUpdater, type UpdateInfo } from 'electron-updater';
import { BrowserWindow, dialog } from 'electron';

export const UPDATE_SERVER = 'https://update.z-assistant.app';

export interface UpdateState {
  checking: boolean;
  available: boolean;
  downloading: boolean;
  info: UpdateInfo | null;
  error: string | null;
}

export type UpdateListener = (state: UpdateState) => void;

export class Updater {
  private listeners = new Set<UpdateListener>();
  private state: UpdateState = {
    checking: false,
    available: false,
    downloading: false,
    info: null,
    error: null,
  };

  constructor(private readonly win: BrowserWindow | null = null) {
    autoUpdater.setFeedURL({
      provider: 'generic',
      url: UPDATE_SERVER,
    });

    autoUpdater.on('update-available', (info) => {
      this.state = { ...this.state, checking: false, available: true, info, error: null };
      this.notify();
      // Show dialog if we have a window reference
      if (this.win && !this.win.isDestroyed()) {
        dialog.showMessageBox(this.win, {
          type: 'info',
          title: 'Update Available',
          message: `Version ${info.version} is available.`,
          detail: 'The update will be downloaded in the background.',
          buttons: ['OK'],
        }).catch(() => { /* ignore */ });
      }
    });

    autoUpdater.on('update-not-available', () => {
      this.state = { ...this.state, checking: false, error: null };
      this.notify();
    });

    autoUpdater.on('download-progress', () => {
      this.state = { ...this.state, downloading: true };
      this.notify();
    });

    autoUpdater.on('update-downloaded', (info) => {
      this.state = { ...this.state, downloading: false, available: true, info, error: null };
      this.notify();
      // Prompt to install
      if (this.win && !this.win.isDestroyed()) {
        dialog.showMessageBox(this.win, {
          type: 'question',
          title: 'Update Ready',
          message: `Version ${info.version} has been downloaded.`,
          detail: 'Restart now to apply the update?',
          buttons: ['Restart', 'Later'],
          defaultId: 0,
          cancelId: 1,
        }).then(({ response }) => {
          if (response === 0) autoUpdater.quitAndInstall();
        }).catch(() => { /* ignore */ });
      }
    });

    autoUpdater.on('error', (err) => {
      this.state = { ...this.state, checking: false, error: err.message ?? String(err) };
      this.notify();
    });
  }

  get state_snapshot(): UpdateState {
    return { ...this.state };
  }

  /** Check for updates from the update server. */
  check(): void {
    this.state = { ...this.state, checking: true, error: null };
    this.notify();
    autoUpdater.checkForUpdates().catch(() => {
      this.state = { ...this.state, checking: false, error: 'Failed to check for updates.' };
      this.notify();
    });
  }

  /** Download an available update. */
  download(): void {
    if (!this.state.available) return;
    this.state = { ...this.state, downloading: true };
    this.notify();
    autoUpdater.downloadUpdate().catch(() => {
      this.state = { ...this.state, downloading: false, error: 'Download failed.' };
      this.notify();
    });
  }

  /** Subscribe to update state changes. */
  onStateChange(fn: UpdateListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    for (const fn of this.listeners) fn(this.state);
  }
}

// @z-assistant/app-desktop — Agent Viewport (Marvis-like floating window)
//
// A dedicated floating Electron window that shows what the AI is doing:
//   - CDP screencast when the browser is active (real-time ~10fps)
//   - Agent activity feed when doing other tasks (research, coding, etc.)
//
// The window is always-on-top, compact, and can be toggled via tray/hotkey.
//
// ─────────────────────────────────────────────────────────────────────
//  ⚠ TEMPORARILY DISABLED — 2026-06-25
// ─────────────────────────────────────────────────────────────────────
//  The viewport currently shows a browser window during/after a task but
//  provides no real-time streaming of the AI's actions. Users see a
//  window open with no activity until the task completes, which is
//  confusing. Until we wire CDP screencast into every Browser-agent
//  invocation AND show a live To-do list panel, the viewport stays off.
//  See main.ts for the commented-out wiring; this file is preserved
//  intact so the work can be resumed.
// ─────────────────────────────────────────────────────────────────────

import { BrowserWindow, ipcMain } from 'electron';
import * as path from 'path';
import { IPC_CHANNELS, APP_NAME } from './constants';

export type ScreencastStarter = (opts: {
  onFrame: (jpegBase64: string) => void;
  quality?: number;
  maxWidth?: number;
  maxHeight?: number;
}) => Promise<void>;

export type ScreencastStopper = () => Promise<void>;

export class AgentViewport {
  private win: BrowserWindow | null = null;
  private _isVisible = false;
  private startScreencastFn: ScreencastStarter | null = null;
  private stopScreencastFn: ScreencastStopper | null = null;
  private screencastActive = false;

  get isVisible(): boolean {
    return this._isVisible;
  }

  setScreencastFns(start: ScreencastStarter, stop: ScreencastStopper): void {
    this.startScreencastFn = start;
    this.stopScreencastFn = stop;
  }

  /** Show or create the viewport window. */
  show(): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.show();
      this.win.focus();
      this._isVisible = true;
      return;
    }

    this.win = new BrowserWindow({
      width: 560,
      height: 460,
      minWidth: 320,
      minHeight: 240,
      title: `${APP_NAME} — Viewport`,
      show: false,
      resizable: true,
      alwaysOnTop: true,
      frame: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });

    this.win.loadURL(`file://${path.join(__dirname, 'renderer', 'agent-viewport.html')}`);

    this.win.once('ready-to-show', () => {
      this.win?.show();
      this._isVisible = true;
    });

    this.win.on('closed', () => {
      this.win = null;
      this._isVisible = false;
      this.stopScreencast();
    });
  }

  /** Hide the viewport window. */
  hide(): void {
    this._isVisible = false;
    if (this.win && !this.win.isDestroyed()) {
      this.win.hide();
    }
  }

  /** Toggle visibility. */
  toggle(): void {
    if (this._isVisible) {
      this.hide();
    } else {
      this.show();
    }
  }

  /** Start CDP screencast (browser active). */
  async startScreencast(): Promise<void> {
    if (this.screencastActive || !this.startScreencastFn) return;
    this.screencastActive = true;

    try {
      await this.startScreencastFn({
        onFrame: (jpegBase64: string) => {
          if (this.win && !this.win.isDestroyed()) {
            this.win.webContents.send(IPC_CHANNELS.ON_BROWSER_PREVIEW, jpegBase64);
          }
        },
        quality: 30,
        maxWidth: 480,
        maxHeight: 360,
      });
      // Switch to screencast mode
      if (this.win && !this.win.isDestroyed()) {
        this.win.webContents.send('z:viewport-mode', 'screencast');
      }
    } catch {
      this.screencastActive = false;
    }
  }

  /** Stop CDP screencast. */
  async stopScreencast(): Promise<void> {
    if (!this.screencastActive) return;
    this.screencastActive = false;
    if (this.stopScreencastFn) {
      try { await this.stopScreencastFn(); } catch { /* ignore */ }
    }
  }

  /** Send an agent activity event to the viewport. */
  sendActivity(agent: string, icon: string, message: string, detail?: string): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.webContents.send(IPC_CHANNELS.ON_AGENT_ACTIVITY, { agent, icon, message, detail });
    }
  }

  /** Clean up on app quit. */
  async destroy(): Promise<void> {
    await this.stopScreencast();
    if (this.win && !this.win.isDestroyed()) {
      this.win.close();
    }
    this.win = null;
    this._isVisible = false;
  }
}

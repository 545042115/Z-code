// @z-assistant/app-desktop — electron-updater type declarations

declare module 'electron-updater' {
  import { EventEmitter } from 'events';

  export interface UpdateInfo {
    version: string;
    releaseDate?: string;
    releaseNotes?: string;
    path?: string;
    sha512?: string;
    stagingPercentage?: number;
    files?: Array<{ url: string; sha512: string; size: number }>;
  }

  export interface ProgressInfo {
    total: number;
    delta: number;
    transferred: number;
    percent: number;
    bytesPerSecond: number;
  }

  export interface UpdateCheckResult {
    updateInfo: UpdateInfo;
    downloadPromise?: Promise<string>;
    cancellationToken?: unknown;
  }

  export class AutoUpdater extends EventEmitter {
    setFeedURL(options: { provider: string; url: string }): void;
    checkForUpdates(): Promise<UpdateCheckResult | null>;
    checkForUpdatesAndNotify(): Promise<UpdateCheckResult | null>;
    downloadUpdate(cancellationToken?: unknown): Promise<string>;
    quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;

    on(event: 'checking-for-update', listener: () => void): this;
    on(event: 'update-available', listener: (info: UpdateInfo) => void): this;
    on(event: 'update-not-available', listener: (info: UpdateInfo) => void): this;
    on(event: 'error', listener: (error: Error) => void): this;
    on(event: 'download-progress', listener: (progress: ProgressInfo) => void): this;
    on(event: 'update-downloaded', listener: (info: UpdateInfo) => void): this;
  }

  export const autoUpdater: AutoUpdater;
}

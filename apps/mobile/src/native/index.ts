// Native Capabilities — mobile system features via Capacitor
//
// Phase 8: Mobile system capabilities.
//
// Wraps Capacitor plugins with a clean interface and provides
// graceful fallbacks when running in a web/browser context.

import { Capacitor } from '@capacitor/core';

export interface NativeNotification {
  id: number;
  title: string;
  body: string;
  largeBody?: string;
  summaryText?: string;
}

export interface ShareOptions {
  title?: string;
  text?: string;
  url?: string;
  dialogTitle?: string;
}

export interface HapticOptions {
  style?: 'light' | 'medium' | 'heavy';
}

export interface WriteFileOptions {
  path: string;
  data: string;
  directory?: 'Data' | 'Documents' | 'Cache' | 'External' | 'ExternalStorage';
  recursive?: boolean;
}

export interface ReadFileResult {
  data: string;
}

export interface NativeCapabilities {
  readonly platform: 'android' | 'ios' | 'web';
  readonly isNative: boolean;

  // Notifications
  requestNotificationPermission(): Promise<boolean>;
  scheduleNotification(notification: NativeNotification): Promise<number>;
  cancelNotification(id: number): Promise<void>;

  // Share
  share(options: ShareOptions): Promise<boolean>;

  // Clipboard
  copyToClipboard(text: string): Promise<void>;
  readFromClipboard(): Promise<string>;

  // Haptics / Vibration
  vibrate(options?: HapticOptions): Promise<void>;
  vibrateSuccess(): Promise<void>;
  vibrateWarning(): Promise<void>;
  vibrateError(): Promise<void>;

  // File system
  writeFile(options: WriteFileOptions): Promise<string>;
  readFile(path: string, directory?: WriteFileOptions['directory']): Promise<string | null>;
  deleteFile(path: string, directory?: WriteFileOptions['directory']): Promise<boolean>;
}

// ── Capacitor-based implementation ────────────────────────────────────

class CapacitorNativeCapabilities implements NativeCapabilities {
  readonly platform: 'android' | 'ios' | 'web';
  readonly isNative: boolean;

  constructor() {
    const platform = Capacitor.getPlatform();
    if (platform === 'android') {
      this.platform = 'android';
    } else if (platform === 'ios') {
      this.platform = 'ios';
    } else {
      this.platform = 'web';
    }
    this.isNative = this.platform !== 'web';
  }

  // ── Notifications ────────────────────────────────────────────────

  async requestNotificationPermission(): Promise<boolean> {
    if (!this.isNative) {
      if ('Notification' in window) {
        const result = await Notification.requestPermission();
        return result === 'granted';
      }
      return false;
    }
    try {
      const { LocalNotifications } = await import('@capacitor/local-notifications');
      const result = await LocalNotifications.requestPermissions();
      return result.display === 'granted';
    } catch {
      return false;
    }
  }

  async scheduleNotification(notification: NativeNotification): Promise<number> {
    if (!this.isNative) {
      if ('Notification' in window && Notification.permission === 'granted') {
        new Notification(notification.title, { body: notification.body });
      }
      return notification.id;
    }
    try {
      const { LocalNotifications } = await import('@capacitor/local-notifications');
      await LocalNotifications.schedule({
        notifications: [
          {
            id: notification.id,
            title: notification.title,
            body: notification.body,
            largeBody: notification.largeBody,
            summaryText: notification.summaryText,
          },
        ],
      });
      return notification.id;
    } catch {
      return notification.id;
    }
  }

  async cancelNotification(id: number): Promise<void> {
    if (!this.isNative) return;
    try {
      const { LocalNotifications } = await import('@capacitor/local-notifications');
      await LocalNotifications.cancel({ notifications: [{ id }] });
    } catch {
      // ignore
    }
  }

  // ── Share ────────────────────────────────────────────────────────

  async share(options: ShareOptions): Promise<boolean> {
    if (!this.isNative) {
      if (navigator.share) {
        try {
          await navigator.share({
            title: options.title,
            text: options.text,
            url: options.url,
          });
          return true;
        } catch {
          return false;
        }
      }
      // Fallback: copy to clipboard
      if (options.text) {
        await this.copyToClipboard(options.text);
        return true;
      }
      return false;
    }
    try {
      const { Share } = await import('@capacitor/share');
      await Share.share({
        title: options.title,
        text: options.text,
        url: options.url,
        dialogTitle: options.dialogTitle,
      });
      return true;
    } catch {
      return false;
    }
  }

  // ── Clipboard ────────────────────────────────────────────────────

  async copyToClipboard(text: string): Promise<void> {
    if (!this.isNative) {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(text);
        return;
      }
    }
    try {
      const { Clipboard } = await import('@capacitor/clipboard');
      await Clipboard.write({ string: text });
    } catch {
      // Fallback for web
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(text);
      }
    }
  }

  async readFromClipboard(): Promise<string> {
    if (!this.isNative) {
      if (navigator.clipboard) {
        return await navigator.clipboard.readText();
      }
      return '';
    }
    try {
      const { Clipboard } = await import('@capacitor/clipboard');
      const result = await Clipboard.read();
      return result.value || '';
    } catch {
      return '';
    }
  }

  // ── Haptics ──────────────────────────────────────────────────────

  async vibrate(options?: HapticOptions): Promise<void> {
    if (!this.isNative) {
      if (navigator.vibrate) {
        navigator.vibrate(options?.style === 'heavy' ? 50 : 20);
      }
      return;
    }
    try {
      const { Haptics, ImpactStyle, NotificationType } = await import('@capacitor/haptics');
      if (options?.style) {
        const styleMap: Record<string, any> = {
          light: ImpactStyle.Light,
          medium: ImpactStyle.Medium,
          heavy: ImpactStyle.Heavy,
        };
        await Haptics.impact({ style: styleMap[options.style] ?? ImpactStyle.Medium });
      } else {
        await Haptics.vibrate();
      }
    } catch {
      // ignore
    }
  }

  async vibrateSuccess(): Promise<void> {
    if (!this.isNative) {
      if (navigator.vibrate) navigator.vibrate([30, 50, 30]);
      return;
    }
    try {
      const { Haptics, NotificationType } = await import('@capacitor/haptics');
      await Haptics.notification({ type: NotificationType.Success });
    } catch {
      // ignore
    }
  }

  async vibrateWarning(): Promise<void> {
    if (!this.isNative) {
      if (navigator.vibrate) navigator.vibrate([50, 30, 50]);
      return;
    }
    try {
      const { Haptics, NotificationType } = await import('@capacitor/haptics');
      await Haptics.notification({ type: NotificationType.Warning });
    } catch {
      // ignore
    }
  }

  async vibrateError(): Promise<void> {
    if (!this.isNative) {
      if (navigator.vibrate) navigator.vibrate([80, 40, 80, 40, 80]);
      return;
    }
    try {
      const { Haptics, NotificationType } = await import('@capacitor/haptics');
      await Haptics.notification({ type: NotificationType.Error });
    } catch {
      // ignore
    }
  }

  // ── File System ──────────────────────────────────────────────────

  async writeFile(options: WriteFileOptions): Promise<string> {
    if (!this.isNative) {
      // Web fallback: localStorage
      const key = `file:${options.directory || 'Data'}:${options.path}`;
      localStorage.setItem(key, options.data);
      return options.path;
    }
    try {
      const { Filesystem, Directory } = await import('@capacitor/filesystem');
      const dirMap: Record<string, any> = {
        Data: Directory.Data,
        Documents: Directory.Documents,
        Cache: Directory.Cache,
        External: Directory.External,
        ExternalStorage: Directory.ExternalStorage,
      };
      await Filesystem.writeFile({
        path: options.path,
        data: options.data,
        directory: dirMap[options.directory || 'Data'],
        recursive: options.recursive,
      });
      return options.path;
    } catch (e) {
      throw new Error(e instanceof Error ? e.message : 'Failed to write file');
    }
  }

  async readFile(path: string, directory?: WriteFileOptions['directory']): Promise<string | null> {
    if (!this.isNative) {
      const key = `file:${directory || 'Data'}:${path}`;
      return localStorage.getItem(key);
    }
    try {
      const { Filesystem, Directory } = await import('@capacitor/filesystem');
      const dirMap: Record<string, any> = {
        Data: Directory.Data,
        Documents: Directory.Documents,
        Cache: Directory.Cache,
        External: Directory.External,
        ExternalStorage: Directory.ExternalStorage,
      };
      const result = await Filesystem.readFile({
        path,
        directory: dirMap[directory || 'Data'],
      });
      return result.data as string;
    } catch {
      return null;
    }
  }

  async deleteFile(path: string, directory?: WriteFileOptions['directory']): Promise<boolean> {
    if (!this.isNative) {
      const key = `file:${directory || 'Data'}:${path}`;
      localStorage.removeItem(key);
      return true;
    }
    try {
      const { Filesystem, Directory } = await import('@capacitor/filesystem');
      const dirMap: Record<string, any> = {
        Data: Directory.Data,
        Documents: Directory.Documents,
        Cache: Directory.Cache,
        External: Directory.External,
        ExternalStorage: Directory.ExternalStorage,
      };
      await Filesystem.deleteFile({
        path,
        directory: dirMap[directory || 'Data'],
      });
      return true;
    } catch {
      return false;
    }
  }
}

// ── Singleton instance ────────────────────────────────────────────────

let instance: NativeCapabilities | null = null;

export function getNativeCapabilities(): NativeCapabilities {
  if (!instance) {
    instance = new CapacitorNativeCapabilities();
  }
  return instance;
}

// WebPlatformCapabilities — IPlatformCapabilities implementation for Mobile/Web.
//
// Provides mobile-native capabilities via Capacitor plugins.
// File system is limited to the app's Documents directory.
// No process execution or Docker support.

import type { IPlatformCapabilities } from '@ziner/runtime-core';

export class WebPlatformCapabilities implements IPlatformCapabilities {
  async readFile(path: string): Promise<string> {
    // Uses Capacitor Filesystem plugin (injected at runtime)
    const Filesystem = (window as unknown as { Capacitor?: { Filesystem?: { readFile: (opts: { path: string; directory?: string; encoding?: string }) => Promise<{ data: string }> } } }).Capacitor?.Filesystem;
    if (!Filesystem) throw new Error('Filesystem plugin not available');
    const result = await Filesystem.readFile({ path, encoding: 'utf8' });
    return result.data;
  }

  async writeFile(path: string, content: string): Promise<void> {
    const Filesystem = (window as unknown as { Capacitor?: { Filesystem?: { writeFile: (opts: { path: string; data: string; directory?: string; encoding?: string; recursive?: boolean }) => Promise<void> } } }).Capacitor?.Filesystem;
    if (!Filesystem) throw new Error('Filesystem plugin not available');
    await Filesystem.writeFile({ path, data: content, encoding: 'utf8', recursive: true });
  }

  async notify(title: string, body: string): Promise<void> {
    // Uses Capacitor Local Notifications (injected at runtime)
    const Notifications = (window as unknown as { Capacitor?: { Notifications?: { requestPermission: () => Promise<{ display: string }>; schedule: (opts: { notifications: Array<{ id: number; title: string; body: string; schedule: { at: Date } }> }) => Promise<void> } } }).Capacitor?.Notifications;
    if (Notifications) {
      await Notifications.requestPermission();
      await Notifications.schedule({
        notifications: [{
          id: Date.now(),
          title,
          body,
          schedule: { at: new Date(Date.now() + 100) },
        }],
      });
    } else if ('Notification' in window) {
      // Fallback to Web Notifications
      if (Notification.permission === 'granted') {
        new Notification(title, { body });
      } else if (Notification.permission !== 'denied') {
        const perm = await Notification.requestPermission();
        if (perm === 'granted') new Notification(title, { body });
      }
    }
  }

  async vibrate(pattern: number | number[]): Promise<void> {
    const Haptics = (window as unknown as { Capacitor?: { Haptics?: { vibrate: (opts: { duration: number }) => Promise<void> } } }).Capacitor?.Haptics;
    if (Haptics) {
      const duration = typeof pattern === 'number' ? pattern : pattern[0] ?? 200;
      await Haptics.vibrate({ duration });
    } else if ('vibrate' in navigator) {
      navigator.vibrate(pattern);
    }
  }

  async share(text: string, title?: string): Promise<void> {
    const Share = (window as unknown as { Capacitor?: { Share?: { share: (opts: { title?: string; text: string }) => Promise<void> } } }).Capacitor?.Share;
    if (Share) {
      await Share.share({ title, text });
    } else if ('share' in navigator) {
      await navigator.share({ title, text });
    }
  }

  async copyToClipboard(text: string): Promise<void> {
    if ('clipboard' in navigator) {
      await navigator.clipboard.writeText(text);
    } else {
      // Fallback
      const textarea = document.createElement('textarea');
      textarea.value = text;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
    }
  }
}

/**
 * Factory function to get the platform capabilities implementation.
 * Returns a WebPlatformCapabilities instance for the mobile/web platform.
 */
export function getPlatformCapabilities(): IPlatformCapabilities {
  return new WebPlatformCapabilities();
}

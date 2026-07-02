// @ziner/app-desktop — global hotkey

import { globalShortcut, BrowserWindow } from 'electron';

export const DEFAULT_HOTKEY = 'CommandOrControl+Shift+Z';

export function registerGlobalHotkey(accelerator = DEFAULT_HOTKEY, onTrigger: () => void): boolean {
  if (globalShortcut.isRegistered(accelerator)) return true;
  return globalShortcut.register(accelerator, onTrigger);
}

export function unregisterGlobalHotkey(accelerator = DEFAULT_HOTKEY): void {
  globalShortcut.unregister(accelerator);
}

export function unregisterAllGlobalHotkeys(): void {
  globalShortcut.unregisterAll();
}

/** Toggle window visibility: hide if focused and visible, otherwise show & focus. */
export function toggleWindow(win: BrowserWindow | null): void {
  if (!win) return;
  if (win.isVisible() && win.isFocused()) {
    win.hide();
  } else {
    win.show();
    win.focus();
  }
}

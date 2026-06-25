// @z-assistant/app-desktop — system tray

import { Tray, Menu, nativeImage } from 'electron';
import * as path from 'path';
import { APP_NAME } from './constants';

export type TrayLanguage = 'zh-CN' | 'en';

export interface TrayOptions {
  onShowMain: () => void;
  onShowChat: () => void;
  onShowTrace: () => void;
  onShowSettings: () => void;
  onShowViewport: () => void;
  onQuit: () => void;
  language?: TrayLanguage;
}

const TRAY_LABELS: Record<TrayLanguage, { main: string; chat: string; trace: string; settings: string; viewport: string; quit: string }> = {
  'zh-CN': { main: '主页', chat: '对话', trace: '追踪', settings: '设置', viewport: '视窗', quit: '退出' },
  en: { main: 'Main', chat: 'Chat', trace: 'Trace', settings: 'Settings', viewport: 'Viewport', quit: 'Quit' },
};

let tray: Tray | null = null;
let currentOpts: TrayOptions | null = null;

function buildContextMenu(opts: TrayOptions): Electron.Menu {
  const labels = TRAY_LABELS[opts.language ?? 'en'];
  return Menu.buildFromTemplate([
    { label: labels.main, click: opts.onShowMain },
    { label: labels.chat, click: opts.onShowChat },
    { label: labels.trace, click: opts.onShowTrace },
    { label: labels.settings, click: opts.onShowSettings },
    // { label: labels.viewport, click: opts.onShowViewport },  // TEMP DISABLED
    { type: 'separator' },
    { label: labels.quit, click: opts.onQuit },
  ]);
}

export function createTray(opts: TrayOptions): Tray {
  currentOpts = opts;
  // Use a 16x16 template icon if available; otherwise an empty image.
  const iconPath = path.join(__dirname, 'assets', 'tray-icon.png');
  const icon = nativeImage.createFromPath(iconPath);
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon.resize({ width: 16, height: 16 }));
  tray.setToolTip(APP_NAME);
  tray.setContextMenu(buildContextMenu(opts));
  tray.on('double-click', opts.onShowMain);
  return tray;
}

/** Update the tray context menu when the application language changes. */
export function updateTrayLanguage(language: TrayLanguage): void {
  if (!tray || !currentOpts) return;
  currentOpts = { ...currentOpts, language };
  tray.setContextMenu(buildContextMenu(currentOpts));
}

export function destroyTray(): void {
  tray?.destroy();
  tray = null;
  currentOpts = null;
}

export function getTray(): Tray | null {
  return tray;
}

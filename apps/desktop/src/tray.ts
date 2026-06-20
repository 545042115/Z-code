// @z-assistant/app-desktop — system tray

import { Tray, Menu, nativeImage } from 'electron';
import * as path from 'path';
import { APP_NAME } from './constants';

export interface TrayOptions {
  onShowMain: () => void;
  onShowChat: () => void;
  onShowTrace: () => void;
  onShowSettings: () => void;
  onQuit: () => void;
}

let tray: Tray | null = null;

export function createTray(opts: TrayOptions): Tray {
  // Use a 16x16 template icon if available; otherwise an empty image.
  const iconPath = path.join(__dirname, 'assets', 'tray-icon.png');
  const icon = nativeImage.createFromPath(iconPath);
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon.resize({ width: 16, height: 16 }));
  tray.setToolTip(APP_NAME);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Main', click: opts.onShowMain },
    { label: 'Chat', click: opts.onShowChat },
    { label: 'Trace', click: opts.onShowTrace },
    { label: 'Settings', click: opts.onShowSettings },
    { type: 'separator' },
    { label: 'Quit', click: opts.onQuit },
  ]));
  tray.on('double-click', opts.onShowMain);
  return tray;
}

export function destroyTray(): void {
  tray?.destroy();
  tray = null;
}

export function getTray(): Tray | null {
  return tray;
}

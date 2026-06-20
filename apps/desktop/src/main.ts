// @z-assistant/app-desktop — main process

import * as path from 'path';
import * as fs from 'fs';
import { app, BrowserWindow, ipcMain, shell, dialog, Menu } from 'electron';
import { IPC_CHANNELS, WINDOW_SIZES, APP_NAME } from './constants';
import { RuntimeBridge } from './runtime-bridge';
import { createTray, destroyTray } from './tray';
import { registerGlobalHotkey, unregisterAllGlobalHotkeys, toggleWindow, DEFAULT_HOTKEY } from './hotkey';
import type { DesktopSettings } from './runtime-bridge';
import type { ChatMessage } from './session-manager';

// Crash logging
const logFile = path.join(app.getPath('userData'), 'desktop-debug.log');
function debugLog(msg: string): void {
  try {
    fs.appendFileSync(logFile, `${new Date().toISOString()} ${msg}\n`);
  } catch { /* ignore */ }
}
debugLog('=== START ===');

process.on('uncaughtException', (e) => {
  debugLog(`CRASH: ${e.message}\n${e.stack ?? ''}`);
});
process.on('unhandledRejection', (e: any) => {
  debugLog(`UNHANDLED REJECTION: ${e?.message ?? String(e)}`);
});

const bridge = new RuntimeBridge();

// ── Single-instance lock ─────────────────────────────────────────────
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  debugLog('Another instance is already running, quitting.');
  app.quit();
}

let mainWindow: BrowserWindow | null = null;
let chatWindow: BrowserWindow | null = null;
let traceWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
let isQuitting = false;

function getRendererUrl(file: string): string {
  const url = `file://${path.join(__dirname, 'renderer', file)}`;
  debugLog(`Renderer URL: ${url}`);
  return url;
}

function createMainWindow(): BrowserWindow {
  debugLog('createMainWindow');
  const win = new BrowserWindow({
    width: WINDOW_SIZES.main.width,
    height: WINDOW_SIZES.main.height,
    title: APP_NAME,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.loadURL(getRendererUrl('index.html?view=main'));
  win.once('ready-to-show', () => {
    debugLog('ready-to-show fired');
    win.show();
  });
  win.webContents.on('did-finish-load', () => debugLog('window did-finish-load'));
  win.webContents.on('did-fail-load', (_e, ec, ed) => debugLog(`did-fail-load: ${ec} ${ed}`));
  win.webContents.on('console-message', (_e, level, msg) => debugLog(`[renderer] ${msg}`));
  win.on('closed', () => { mainWindow = null; });
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // ── Close to tray (minimize instead of quit) ─────────────────
  win.on('close', (event) => {
    // On Windows/Linux, minimize to tray instead of quitting
    if (process.platform !== 'darwin' && !isQuitting) {
      event.preventDefault();
      win.hide();
    }
  });

  return win;
}

function createChatWindow(): BrowserWindow {
  if (chatWindow) {
    chatWindow.focus();
    return chatWindow;
  }
  const win = new BrowserWindow({
    width: WINDOW_SIZES.chat.width,
    height: WINDOW_SIZES.chat.height,
    title: `${APP_NAME} — Chat`,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadURL(getRendererUrl('index.html?view=chat'));
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { chatWindow = null; });
  return win;
}

function createTraceWindow(): BrowserWindow {
  if (traceWindow) {
    traceWindow.focus();
    return traceWindow;
  }
  const win = new BrowserWindow({
    width: WINDOW_SIZES.trace.width,
    height: WINDOW_SIZES.trace.height,
    title: `${APP_NAME} — Trace`,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadURL(getRendererUrl('index.html?view=trace'));
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { traceWindow = null; });
  return win;
}

function createSettingsWindow(): BrowserWindow {
  if (settingsWindow) {
    settingsWindow.focus();
    return settingsWindow;
  }
  const win = new BrowserWindow({
    width: WINDOW_SIZES.settings.width,
    height: WINDOW_SIZES.settings.height,
    title: `${APP_NAME} — Settings`,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadURL(getRendererUrl('index.html?view=settings'));
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { settingsWindow = null; });
  return win;
}

function showChat(): void {
  chatWindow = createChatWindow();
}

function showTrace(): void {
  traceWindow = createTraceWindow();
}

function showSettings(): void {
  settingsWindow = createSettingsWindow();
}

function registerIpcHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.RUN_TASK, async (_event, task: string, sessionId?: string) => {
    await bridge.start();
    return bridge.runTask(task, sessionId);
  });
  ipcMain.handle(IPC_CHANNELS.LIST_RUNS, async (_event, limit?: number, sessionId?: string) => {
    await bridge.start();
    return bridge.listRuns(limit, sessionId);
  });
  ipcMain.handle(IPC_CHANNELS.GET_RUN, async (_event, runId: string) => {
    await bridge.start();
    return bridge.getRun(runId);
  });
  ipcMain.handle(IPC_CHANNELS.GET_SPANS, async (_event, runId: string) => {
    await bridge.start();
    return bridge.getSpans(runId);
  });
  ipcMain.handle(IPC_CHANNELS.GET_SETTINGS, () => bridge.getSettings());
  ipcMain.handle(IPC_CHANNELS.SET_SETTINGS, (_event, patch) => bridge.updateSettings(patch));
  ipcMain.handle(IPC_CHANNELS.RECALL_MEMORY, async (_event, query: string, limit?: number) => {
    await bridge.start();
    return bridge.recallMemory(query, limit);
  });
  ipcMain.handle(IPC_CHANNELS.SELECT_DIRECTORY, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory'] });
    return result.canceled ? null : result.filePaths[0];
  });

  // ── Session IPC handlers ─────────────────────────────────────────
  ipcMain.handle(IPC_CHANNELS.LIST_SESSIONS, () => bridge.sessions.list());
  ipcMain.handle(IPC_CHANNELS.GET_SESSION, (_event, id: string) => bridge.sessions.get(id));
  ipcMain.handle(IPC_CHANNELS.CREATE_SESSION, (_event, title?: string) => bridge.sessions.create(title));
  ipcMain.handle(IPC_CHANNELS.APPEND_MESSAGE, (_event, sessionId: string, msg: ChatMessage) => {
    return bridge.sessions.appendMessage(sessionId, msg);
  });
  ipcMain.handle(IPC_CHANNELS.DELETE_SESSION, (_event, id: string) => bridge.sessions.delete(id));

  // ── WeChat Hook IPC handlers ────────────────────────────────
  ipcMain.handle(IPC_CHANNELS.START_WECHAT_HOOK, async (_event, config) => {
    await bridge.start();
    await bridge.startWeChatHook(config);
    return bridge.getWeChatHookStatus();
  });
  ipcMain.handle(IPC_CHANNELS.STOP_WECHAT_HOOK, async () => {
    await bridge.stopWeChatHook();
    return bridge.getWeChatHookStatus();
  });
  ipcMain.handle(IPC_CHANNELS.GET_WECHAT_HOOK_STATUS, () => bridge.getWeChatHookStatus());

  // ── QQ Bot IPC handlers ──────────────────────────────────────
  ipcMain.handle(IPC_CHANNELS.START_QQ, async (_event, config) => {
    await bridge.start();
    await bridge.startQQ(config);
    return bridge.getQQStatus();
  });
  ipcMain.handle(IPC_CHANNELS.STOP_QQ, async () => {
    await bridge.stopQQ();
    return bridge.getQQStatus();
  });
  ipcMain.handle(IPC_CHANNELS.GET_QQ_STATUS, () => bridge.getQQStatus());

  // ── Profile IPC handlers ─────────────────────────────────────────
  ipcMain.handle(IPC_CHANNELS.GET_PROFILE, () => bridge.getProfile());
  ipcMain.handle(IPC_CHANNELS.REBUILD_PROFILE, () => bridge.rebuildProfile());
  ipcMain.handle(IPC_CHANNELS.SET_PROFILE_ENABLED, (_event, enabled: boolean) => bridge.setProfileEnabled(enabled));
  ipcMain.handle(IPC_CHANNELS.CLEAR_CHAT_PROFILE, () => bridge.clearProfile());
}

function forwardEventsToFocusedWindow(): void {
  bridge.onEvent((e) => {
    const target = chatWindow ?? mainWindow;
    target?.webContents.send(IPC_CHANNELS.ON_RUN_EVENT, e);
    if ((e as { type: string }).type === 'progress') {
      target?.webContents.send(IPC_CHANNELS.ON_PROGRESS, e);
    }
  });
  bridge.onWeChatHookStatus((s) => {
    BrowserWindow.getAllWindows().forEach(w => w.webContents.send(IPC_CHANNELS.ON_WECHAT_HOOK_STATUS, s));
  });
  bridge.onQQStatus((s) => {
    BrowserWindow.getAllWindows().forEach(w => w.webContents.send(IPC_CHANNELS.ON_QQ_STATUS, s));
  });
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  registerIpcHandlers();
  forwardEventsToFocusedWindow();
  mainWindow = createMainWindow();
  createTray({
    onShowMain: () => {
      if (mainWindow) {
        mainWindow.show();
        mainWindow.focus();
      } else {
        mainWindow = createMainWindow();
      }
    },
    onShowChat: showChat,
    onShowTrace: showTrace,
    onShowSettings: showSettings,
    onQuit: () => app.quit(),
  });
  registerGlobalHotkey(DEFAULT_HOTKEY, () => toggleWindow(chatWindow ?? mainWindow));

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  // On macOS, keep app running in menu bar. On other platforms,
  // quit when all windows are closed (e.g. after tray "Quit").
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', async () => {
  isQuitting = true;
  unregisterAllGlobalHotkeys();
  destroyTray();
  await bridge.stop();
});

app.on('second-instance', () => {
  const win = mainWindow ?? chatWindow;
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
});

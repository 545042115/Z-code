// @ziner/app-desktop — main process

import * as path from 'path';
import * as fs from 'fs';
import { app, BrowserWindow, ipcMain, shell, dialog, Menu } from 'electron';
import { IPC_CHANNELS, WINDOW_SIZES, APP_NAME } from './constants';
import { RuntimeBridge } from './runtime-bridge';
import { createTray, destroyTray, updateTrayLanguage, type TrayLanguage } from './tray';
import { registerGlobalHotkey, unregisterAllGlobalHotkeys, toggleWindow, DEFAULT_HOTKEY } from './hotkey';
import { Updater } from './updater';
import { LicenseService } from './license';
import { AgentViewport } from './agent-viewport';
import { setBrowserLifecycleCallbacks, startScreencast, stopScreencast, closeSharedBrowser } from './browser-agent-bridge';
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

// ── Custom protocol registration ──────────────────────────────────────
if (process.defaultApp) {
  // Dev mode: register the protocol manually
  app.setAsDefaultProtocolClient('ziner', process.execPath, [path.resolve(process.argv[1])]);
} else {
  app.setAsDefaultProtocolClient('ziner');
}

let mainWindow: BrowserWindow | null = null;
let chatWindow: BrowserWindow | null = null;
let traceWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
let isQuitting = false;

// Agent Viewport (Marvis-like floating window)
const viewport = new AgentViewport();

function getRendererUrl(file: string): string {
  const url = `file://${path.join(__dirname, 'renderer', file)}`;
  debugLog(`Renderer URL: ${url}`);
  return url;
}

function setupWindowEvents(win: BrowserWindow): void {
  const emitMaximized = (maximized: boolean) => {
    win.webContents.send(IPC_CHANNELS.WINDOW_ON_MAXIMIZE_CHANGE, maximized);
  };
  win.on('maximize', () => emitMaximized(true));
  win.on('unmaximize', () => emitMaximized(false));
}

interface CreateWindowOptions {
  width: number;
  height: number;
  title: string;
  view: string;
  ref: { current: BrowserWindow | null };
  onClosed?: () => void;
  closeToTray?: boolean;
  enableExternalLinks?: boolean;
  enableDebugLogging?: boolean;
}

function createWindow(opts: CreateWindowOptions): BrowserWindow {
  if (opts.ref.current) {
    opts.ref.current.focus();
    return opts.ref.current;
  }

  debugLog(`createWindow: ${opts.view}`);

  const win = new BrowserWindow({
    width: opts.width,
    height: opts.height,
    title: opts.title,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  setupWindowEvents(win);
  win.loadURL(getRendererUrl(`index.html?view=${opts.view}`));
  win.once('ready-to-show', () => win.show());

  if (opts.enableDebugLogging !== false) {
    win.webContents.on('did-finish-load', () => debugLog(`window did-finish-load: ${opts.view}`));
    win.webContents.on('did-fail-load', (_e, ec, ed) => debugLog(`did-fail-load [${opts.view}]: ${ec} ${ed}`));
    win.webContents.on('console-message', (_e, level, msg) => debugLog(`[renderer:${opts.view}] ${msg}`));
  }

  win.on('closed', () => {
    opts.ref.current = null;
    opts.onClosed?.();
  });

  if (opts.enableExternalLinks) {
    win.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url);
      return { action: 'deny' };
    });
  }

  if (opts.closeToTray) {
    win.on('close', (event) => {
      if (process.platform !== 'darwin' && !isQuitting) {
        event.preventDefault();
        win.hide();
      }
    });
  }

  opts.ref.current = win;
  return win;
}

const mainWindowRef = { current: null as BrowserWindow | null };
const chatWindowRef = { current: null as BrowserWindow | null };
const traceWindowRef = { current: null as BrowserWindow | null };
const settingsWindowRef = { current: null as BrowserWindow | null };

function createMainWindow(): BrowserWindow {
  const win = createWindow({
    width: WINDOW_SIZES.main.width,
    height: WINDOW_SIZES.main.height,
    title: APP_NAME,
    view: 'main',
    ref: mainWindowRef,
    closeToTray: true,
    enableExternalLinks: true,
  });
  mainWindow = win;
  win.once('ready-to-show', () => {
    debugLog('ready-to-show fired');
  });
  return win;
}

function createChatWindow(): BrowserWindow {
  const win = createWindow({
    width: WINDOW_SIZES.chat.width,
    height: WINDOW_SIZES.chat.height,
    title: `${APP_NAME} — Chat`,
    view: 'chat',
    ref: chatWindowRef,
  });
  chatWindow = win;
  return win;
}

function createTraceWindow(): BrowserWindow {
  const win = createWindow({
    width: WINDOW_SIZES.trace.width,
    height: WINDOW_SIZES.trace.height,
    title: `${APP_NAME} — Trace`,
    view: 'trace',
    ref: traceWindowRef,
  });
  traceWindow = win;
  return win;
}

function createSettingsWindow(): BrowserWindow {
  const win = createWindow({
    width: WINDOW_SIZES.settings.width,
    height: WINDOW_SIZES.settings.height,
    title: `${APP_NAME} — Settings`,
    view: 'settings',
    ref: settingsWindowRef,
  });
  settingsWindow = win;
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

function withBridge<T extends unknown[], R>(
  fn: (...args: T) => R | Promise<R>,
): (...args: T) => Promise<R> {
  return async (...args: T) => {
    await bridge.start();
    return fn(...args);
  };
}

function registerIpcHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.RUN_TASK, withBridge((_event, task: string, sessionId?: string, planningMode?: 'simple' | 'hierarchical' | 'auto') =>
    bridge.runTask(task, sessionId, planningMode),
  ));
  ipcMain.handle(IPC_CHANNELS.CANCEL_RUN, () => bridge.cancelRun());
  // P3 Checkpoint APIs
  ipcMain.handle(IPC_CHANNELS.LIST_CHECKPOINTS, (_event, opts) => bridge.listCheckpoints(opts));
  ipcMain.handle(IPC_CHANNELS.LOAD_CHECKPOINT, (_event, runId) => bridge.loadCheckpoint(runId));
  ipcMain.handle(IPC_CHANNELS.RESUME_TASK, (_event, runId, planningMode) => bridge.resumeTask(runId, planningMode));
  ipcMain.handle(IPC_CHANNELS.DELETE_CHECKPOINT, (_event, runId) => bridge.deleteCheckpoint(runId));
  ipcMain.handle(IPC_CHANNELS.LIST_RUNS, withBridge((_event, limit?: number, sessionId?: string) =>
    bridge.listRuns(limit, sessionId),
  ));
  ipcMain.handle(IPC_CHANNELS.GET_RUN, withBridge((_event, runId: string) =>
    bridge.getRun(runId),
  ));
  ipcMain.handle(IPC_CHANNELS.GET_SPANS, withBridge((_event, runId: string) =>
    bridge.getSpans(runId),
  ));
  ipcMain.handle(IPC_CHANNELS.GET_SETTINGS, () => bridge.getSettings());
  ipcMain.handle(IPC_CHANNELS.SET_SETTINGS, (_event, patch) => {
    const updated = bridge.updateSettings(patch);
    if (updated.language === 'zh-CN' || updated.language === 'en') {
      updateTrayLanguage(updated.language as TrayLanguage);
    }
    return updated;
  });
  ipcMain.handle(IPC_CHANNELS.RECALL_MEMORY, withBridge((_event, query: string, limit?: number) =>
    bridge.recallMemory(query, limit),
  ));
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
  ipcMain.handle(IPC_CHANNELS.CREATE_SESSION, (_event, title?: string) => bridge.sessions.create({ title }));
  ipcMain.handle(IPC_CHANNELS.APPEND_MESSAGE, (_event, sessionId: string, msg: ChatMessage) =>
    bridge.sessions.appendMessage(sessionId, msg),
  );
  ipcMain.handle(IPC_CHANNELS.DELETE_SESSION, (_event, id: string) => bridge.sessions.delete(id));
  ipcMain.handle(IPC_CHANNELS.EXPORT_SESSION, (_event, id: string, format: string) =>
    bridge.exportSession(id, format as 'json' | 'markdown'),
  );
  ipcMain.handle(IPC_CHANNELS.LIST_MEMORIES, withBridge((_event, kind?: string, limit?: number) =>
    bridge.listMemories(kind, limit),
  ));
  ipcMain.handle(IPC_CHANNELS.STORE_MEMORY, withBridge((_event, content: string, kind: string, scope: string) =>
    bridge.storeMemory(content, kind, scope),
  ));
  ipcMain.handle(IPC_CHANNELS.DELETE_MEMORY, withBridge((_event, id: string) =>
    bridge.deleteMemory(id),
  ));
  ipcMain.handle(IPC_CHANNELS.PURGE_MEMORIES, withBridge(() =>
    bridge.purgeMemories(),
  ));
  ipcMain.handle(IPC_CHANNELS.EXPORT_MEMORIES, withBridge(() =>
    bridge.exportMemories(),
  ));

  ipcMain.handle(IPC_CHANNELS.LIST_TRACE_RUNS, withBridge((_event, limit?: number, sessionId?: string) =>
    bridge.listTraceRuns(limit, sessionId),
  ));
  ipcMain.handle(IPC_CHANNELS.GET_TRACE_RUN, withBridge((_event, id: string) =>
    bridge.getTraceRun(id),
  ));
  ipcMain.handle(IPC_CHANNELS.LIST_TRACE_SESSIONS, withBridge((_event, limit?: number) =>
    bridge.listTraceSessions(limit),
  ));
  ipcMain.handle(IPC_CHANNELS.DELETE_TRACE_RUN, withBridge((_event, id: string) =>
    bridge.deleteTraceRun(id),
  ));
  ipcMain.handle(IPC_CHANNELS.CLEAR_TRACE, withBridge(() =>
    bridge.clearTrace(),
  ));
  ipcMain.handle(IPC_CHANNELS.COUNT_MEMORIES, withBridge((_event, kind?: string) =>
    bridge.countMemories(kind),
  ));

  // ── Skill Review Queue IPC handlers ───────────────────────────
  ipcMain.handle(IPC_CHANNELS.LIST_SKILL_CANDIDATES, withBridge(() =>
    bridge.listSkillCandidates(),
  ));
  ipcMain.handle(IPC_CHANNELS.APPROVE_SKILL_CANDIDATE, withBridge((_event, id: string, note?: string) =>
    bridge.approveSkillCandidate(id, note),
  ));
  ipcMain.handle(IPC_CHANNELS.REJECT_SKILL_CANDIDATE, withBridge((_event, id: string, note?: string) =>
    bridge.rejectSkillCandidate(id, note),
  ));
  ipcMain.handle(IPC_CHANNELS.RUN_SUCCESS_SKILL_DISCOVERY, withBridge((_event, historyDir?: string, minTurns?: number) =>
    bridge.runSuccessSkillDiscovery({ historyDir, minTurns }),
  ));
  ipcMain.handle(IPC_CHANNELS.CREATE_SKILL_FROM_SESSION, withBridge((_event, sessionId: string) =>
    bridge.createSkillFromSession(sessionId),
  ));

  // ── P3 Harness: Benchmarks IPC handlers ───────────────────────
  ipcMain.handle(IPC_CHANNELS.CHECK_DOCKER, withBridge(() =>
    bridge.checkDocker(),
  ));
  ipcMain.handle(IPC_CHANNELS.LIST_BENCHMARK_SUITES, () =>
    bridge.listBenchmarkSuites(),
  );
  ipcMain.handle(IPC_CHANNELS.RUN_BENCHMARK_SUITE, withBridge((_event, suiteId: string) =>
    bridge.runBenchmarkSuite(suiteId),
  ));

  // ── Storage backend IPC handlers ────────────────────────────
  ipcMain.handle(IPC_CHANNELS.GET_STORAGE_BACKEND, () =>
    bridge.getStorageBackend(),
  );
  ipcMain.handle(IPC_CHANNELS.SET_STORAGE_BACKEND, withBridge((_event, backend: 'jsonl' | 'sqlite') =>
    bridge.setStorageBackend(backend),
  ));

  // ── WeChat Hook IPC handlers ────────────────────────────────
  ipcMain.handle(IPC_CHANNELS.START_WECHAT_HOOK, withBridge(async (_event, config) => {
    await bridge.startWeChatHook(config);
    return bridge.getWeChatHookStatus();
  }));
  ipcMain.handle(IPC_CHANNELS.STOP_WECHAT_HOOK, async () => {
    await bridge.stopWeChatHook();
    return bridge.getWeChatHookStatus();
  });
  ipcMain.handle(IPC_CHANNELS.GET_WECHAT_HOOK_STATUS, () => bridge.getWeChatHookStatus());

  // ── QQ Bot IPC handlers ──────────────────────────────────────
  ipcMain.handle(IPC_CHANNELS.START_QQ, withBridge(async (_event, config) => {
    await bridge.startQQ(config);
    return bridge.getQQStatus();
  }));
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

  // ── File System IPC handlers ────────────────────────────────────
  ipcMain.handle(IPC_CHANNELS.WRITE_FILE, async (_event, filePath: string, content: string) => {
    try {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(filePath, content, 'utf-8');
      return { success: true };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: msg };
    }
  });
  ipcMain.handle(IPC_CHANNELS.SELECT_SAVE_DIR, async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      title: 'Select save directory',
    });
    return result.canceled ? null : result.filePaths[0];
  });

  // ── Confirmation (P1-2 HITL) IPC handlers ───────────────────────
  ipcMain.handle(
    IPC_CHANNELS.CONFIRM_ACTION,
    (_event, requestId: string, decision: import('@ziner/contracts').Decision) =>
      bridge.resolveConfirmation(requestId, decision),
  );

  // ── Audit log (P1-2 HITL) IPC handlers ──────────────────────────
  ipcMain.handle(IPC_CHANNELS.LIST_AUDIT_ENTRIES, withBridge((_event, filter?: { runId?: string; toolName?: string; outcome?: string; limit?: number }) =>
    bridge.listAuditEntries(filter as any),
  ));
  ipcMain.handle(IPC_CHANNELS.COUNT_AUDIT_ENTRIES, withBridge((_event, filter?: { runId?: string; toolName?: string; outcome?: string }) =>
    bridge.countAuditEntries(filter as any),
  ));
  ipcMain.handle(IPC_CHANNELS.LIST_ALWAYS_RULES, () => bridge.listAlwaysRules());
  ipcMain.handle(IPC_CHANNELS.REMOVE_ALWAYS_RULE, (_event, id: string) => bridge.removeAlwaysRule(id));

  // ── Window control IPC handlers ───────────────────────────
  ipcMain.handle(IPC_CHANNELS.WINDOW_MINIMIZE, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    win?.minimize();
  });
  ipcMain.handle(IPC_CHANNELS.WINDOW_MAXIMIZE, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    if (win.isMaximized()) {
      win.unmaximize();
    } else {
      win.maximize();
    }
  });
  ipcMain.handle(IPC_CHANNELS.WINDOW_CLOSE, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    win?.close();
  });
  ipcMain.handle(IPC_CHANNELS.WINDOW_IS_MAXIMIZED, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return win?.isMaximized() ?? false;
  });
}

function forwardEventsToFocusedWindow(): void {
  bridge.onEvent((e) => {
    const target = chatWindow ?? mainWindow;
    target?.webContents.send(IPC_CHANNELS.ON_RUN_EVENT, e);
    if ((e as { type: string }).type === 'progress') {
      target?.webContents.send(IPC_CHANNELS.ON_PROGRESS, e);
    }
    // Forward streaming events on dedicated channels so the renderer
    // can subscribe only to what it needs (avoids re-parsing every
    // ConnectorEvent for a high-frequency stream).
    if (e.type === 'streamChunk') {
      target?.webContents.send(IPC_CHANNELS.ON_STREAM_CHUNK, e);
    } else if (e.type === 'streamEnd') {
      target?.webContents.send(IPC_CHANNELS.ON_STREAM_END, e);
    } else if (e.type === 'agentActivity') {
      target?.webContents.send(IPC_CHANNELS.ON_AGENT_ACTIVITY, e);
      // Also forward to the viewport window
      viewport.sendActivity(e.agent, e.icon, e.message, e.detail);
    }
  });
  bridge.onWeChatHookStatus((s) => {
    BrowserWindow.getAllWindows().forEach(w => w.webContents.send(IPC_CHANNELS.ON_WECHAT_HOOK_STATUS, s));
  });
  bridge.onQQStatus((s) => {
    BrowserWindow.getAllWindows().forEach(w => w.webContents.send(IPC_CHANNELS.ON_QQ_STATUS, s));
  });
  // P1-2 HITL: forward confirmation requests to every renderer so the
  // modal can pop up on whichever window is currently focused.
  bridge.onConfirmationRequest((req) => {
    debugLog(`[confirmation] request ${req.id} risk=${req.risk} tool=${req.invocation.toolName}`);
    BrowserWindow.getAllWindows().forEach(w => w.webContents.send(IPC_CHANNELS.ON_CONFIRMATION_REQUEST, req));
  });
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  registerIpcHandlers();
  forwardEventsToFocusedWindow();
  mainWindow = createMainWindow();

  // ── License Service ──────────────────────────────────────────
  const license = new LicenseService();
  debugLog(`License: ${license.state.tier} (valid: ${license.state.valid})`);

  // ── Auto Updater ─────────────────────────────────────────────
  const updater = new Updater(mainWindow);
  // Check for updates after a short delay (don't block startup)
  setTimeout(() => {
    try { updater.check(); } catch (e: unknown) {
      debugLog(`Update check error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, 5000);

  // ── Agent Viewport (CDP Screencast + Activity Feed) ──────────
  // TEMPORARILY DISABLED — 2026-06-25
  //   The viewport currently shows a browser window with no live
  //   activity, which is confusing for users. Re-enable once CDP
  //   screencast is wired into every Browser-agent invocation and a
  //   To-do list panel is added. See agent-viewport.ts for the
  //   unhooked implementation.
  // ── viewport.setScreencastFns(startScreencast, stopScreencast);
  // ── setBrowserLifecycleCallbacks({
  // ──   onStarted: () => viewport.startScreencast(),
  // ──   onStopped: () => viewport.stopScreencast(),
  // ── });
  // Toggle viewport via IPC
  ipcMain.handle(IPC_CHANNELS.TOGGLE_AGENT_VIEWPORT, () => {
    // viewport.toggle();
    // return viewport.isVisible;
    return false;
  });

  const initialLang = bridge.getSettings().language;
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
    onShowViewport: () => viewport.toggle(),
    onQuit: () => app.quit(),
    language: (initialLang === 'zh-CN' || initialLang === 'en' ? initialLang : 'en') as TrayLanguage,
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
  await viewport.destroy();
  await closeSharedBrowser();
  await bridge.stop();
});

app.on('second-instance', (_event, argv) => {
  const win = mainWindow ?? chatWindow;
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
  // Handle file association on Windows (second instance passes file path in argv)
  const filePath = argv.find((a) => a.endsWith('.zap') || a.endsWith('.zconfig') || a.endsWith('.zlog'));
  if (filePath) {
    debugLog(`File association: ${filePath}`);
    // Open the file in the main window
    mainWindow?.webContents.send(IPC_CHANNELS.ON_RUN_EVENT, { type: 'progress', phase: 'file', detail: filePath });
  }
  // Handle custom protocol URL on Windows
  const protocolUrl = argv.find((a) => a.startsWith('ziner://'));
  if (protocolUrl) {
    debugLog(`Protocol URL: ${protocolUrl}`);
    mainWindow?.webContents.send(IPC_CHANNELS.ON_RUN_EVENT, { type: 'progress', phase: 'protocol', detail: protocolUrl });
  }
});

// macOS: handle open-file event
app.on('open-file', (event, filePath) => {
  event.preventDefault();
  debugLog(`open-file: ${filePath}`);
  const win = mainWindow ?? createMainWindow();
  win.show();
  win.focus();
  win.webContents.send(IPC_CHANNELS.ON_RUN_EVENT, { type: 'progress', phase: 'file', detail: filePath });
});

// macOS: handle custom protocol URL (open-url)
app.on('open-url', (event, url) => {
  event.preventDefault();
  debugLog(`open-url: ${url}`);
  const win = mainWindow ?? createMainWindow();
  win.show();
  win.focus();
  win.webContents.send(IPC_CHANNELS.ON_RUN_EVENT, { type: 'progress', phase: 'protocol', detail: url });
});

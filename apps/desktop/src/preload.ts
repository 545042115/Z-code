// @z-assistant/app-desktop — preload script
//
// Exposes a safe, typed API to the renderer via contextBridge.

import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS } from './constants';
import type { ConnectorEvent } from '@z-assistant/app-vscode-connector';
import type { AgentRun, AgentSpan, MemoryHit } from '@z-assistant/contracts';
import type { DesktopSettings } from './runtime-bridge';
import type { ChatSession, ChatMessage } from './session-manager';

export interface ZDesktopAPI {
  runTask: (task: string, sessionId?: string) => Promise<{ runId: string; result?: string }>;
  listRuns: (limit?: number, sessionId?: string) => Promise<AgentRun[]>;
  getRun: (runId: string) => Promise<AgentRun | undefined>;
  getSpans: (runId: string) => Promise<AgentSpan[]>;
  getSettings: () => Promise<DesktopSettings>;
  setSettings: (patch: Partial<DesktopSettings>) => Promise<DesktopSettings>;
  recallMemory: (query: string, limit?: number) => Promise<MemoryHit[]>;
  onRunEvent: (cb: (e: ConnectorEvent) => void) => () => void;
  selectDirectory: () => Promise<string | null>;
  // Session management
  listSessions: () => Promise<ChatSession[]>;
  getSession: (id: string) => Promise<ChatSession | undefined>;
  createSession: (title?: string) => Promise<ChatSession>;
  appendMessage: (sessionId: string, msg: ChatMessage) => Promise<ChatSession | undefined>;
  deleteSession: (id: string) => Promise<boolean>;
  // WeChat Hook (WeChatFerry DLL injection — captures ALL messages)
  startWeChatHook: (config?: { nickname?: string }) => Promise<WeChatHookStatus>;
  stopWeChatHook: () => Promise<WeChatHookStatus>;
  getWeChatHookStatus: () => Promise<WeChatHookStatus>;
  onWeChatHookStatus: (cb: (status: WeChatHookStatus) => void) => () => void;
  // QQ Bot (official Tencent Bot API)
  startQQ: (config?: { wsUrl?: string; accessToken?: string; nickname?: string }) => Promise<QQStatus>;
  stopQQ: () => Promise<QQStatus>;
  getQQStatus: () => Promise<QQStatus>;
  onQQStatus: (cb: (status: QQStatus) => void) => () => void;
  // Chat profile
  getProfile: () => Promise<{ count: number; description: string | null; enabled: boolean }>;
  rebuildProfile: () => Promise<void>;
  setProfileEnabled: (enabled: boolean) => Promise<void>;
  clearProfile: () => Promise<void>;
}

interface WeChatHookStatus {
  online: boolean;
  nickname: string;
  wxid: string;
  messageCount: number;
}

interface QQStatus {
  online: boolean;
  nickname: string;
  userId: string;
  messageCount: number;
  lastEvent: string;
}

const api: ZDesktopAPI = {
  runTask: (task, sessionId) => ipcRenderer.invoke(IPC_CHANNELS.RUN_TASK, task, sessionId),
  listRuns: (limit, sessionId) => ipcRenderer.invoke(IPC_CHANNELS.LIST_RUNS, limit, sessionId),
  getRun: (runId) => ipcRenderer.invoke(IPC_CHANNELS.GET_RUN, runId),
  getSpans: (runId) => ipcRenderer.invoke(IPC_CHANNELS.GET_SPANS, runId),
  getSettings: () => ipcRenderer.invoke(IPC_CHANNELS.GET_SETTINGS),
  setSettings: (patch) => ipcRenderer.invoke(IPC_CHANNELS.SET_SETTINGS, patch),
  recallMemory: (query, limit) => ipcRenderer.invoke(IPC_CHANNELS.RECALL_MEMORY, query, limit),
  onRunEvent: (cb) => {
    const handler = (_: unknown, e: ConnectorEvent) => cb(e);
    ipcRenderer.on(IPC_CHANNELS.ON_RUN_EVENT, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.ON_RUN_EVENT, handler);
  },
  selectDirectory: () => ipcRenderer.invoke(IPC_CHANNELS.SELECT_DIRECTORY),
  // Session management
  listSessions: () => ipcRenderer.invoke(IPC_CHANNELS.LIST_SESSIONS),
  getSession: (id) => ipcRenderer.invoke(IPC_CHANNELS.GET_SESSION, id),
  createSession: (title) => ipcRenderer.invoke(IPC_CHANNELS.CREATE_SESSION, title),
  appendMessage: (sessionId, msg) => ipcRenderer.invoke(IPC_CHANNELS.APPEND_MESSAGE, sessionId, msg),
  deleteSession: (id) => ipcRenderer.invoke(IPC_CHANNELS.DELETE_SESSION, id),
  // WeChat Hook
  startWeChatHook: (config) => ipcRenderer.invoke(IPC_CHANNELS.START_WECHAT_HOOK, config),
  stopWeChatHook: () => ipcRenderer.invoke(IPC_CHANNELS.STOP_WECHAT_HOOK),
  getWeChatHookStatus: () => ipcRenderer.invoke(IPC_CHANNELS.GET_WECHAT_HOOK_STATUS),
  onWeChatHookStatus: (cb) => {
    const handler = (_: unknown, s: WeChatHookStatus) => cb(s);
    ipcRenderer.on(IPC_CHANNELS.ON_WECHAT_HOOK_STATUS, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.ON_WECHAT_HOOK_STATUS, handler);
  },
  // QQ Bot
  startQQ: (config) => ipcRenderer.invoke(IPC_CHANNELS.START_QQ, config),
  stopQQ: () => ipcRenderer.invoke(IPC_CHANNELS.STOP_QQ),
  getQQStatus: () => ipcRenderer.invoke(IPC_CHANNELS.GET_QQ_STATUS),
  onQQStatus: (cb) => {
    const handler = (_: unknown, s: QQStatus) => cb(s);
    ipcRenderer.on(IPC_CHANNELS.ON_QQ_STATUS, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.ON_QQ_STATUS, handler);
  },
  // Chat profile
  getProfile: () => ipcRenderer.invoke(IPC_CHANNELS.GET_PROFILE),
  rebuildProfile: () => ipcRenderer.invoke(IPC_CHANNELS.REBUILD_PROFILE),
  setProfileEnabled: (enabled) => ipcRenderer.invoke(IPC_CHANNELS.SET_PROFILE_ENABLED, enabled),
  clearProfile: () => ipcRenderer.invoke(IPC_CHANNELS.CLEAR_CHAT_PROFILE),
};

contextBridge.exposeInMainWorld('zApi', api);

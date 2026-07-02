// @ziner/app-desktop — preload script
//
// Exposes a safe, typed API to the renderer via contextBridge.

import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS } from './constants';
import type { ConnectorEvent, Checkpoint, CheckpointIndexEntry } from '@ziner/app-vscode-connector';
import type { AgentRun, AgentSpan, MemoryHit, MemoryRecord, ConfirmationRequest, Decision, AuditLogEntry, AlwaysRule, CandidateSkill } from '@ziner/contracts';
import type { DesktopSettings } from './runtime-bridge';
import type { ChatSession, ChatMessage } from './session-manager';

export interface ZDesktopAPI {
  runTask: (task: string, sessionId?: string, planningMode?: 'simple' | 'hierarchical' | 'auto') => Promise<{ runId: string; result?: string }>;
  listRuns: (limit?: number, sessionId?: string) => Promise<AgentRun[]>;
  getRun: (runId: string) => Promise<AgentRun | undefined>;
  getSpans: (runId: string) => Promise<AgentSpan[]>;
  getSettings: () => Promise<DesktopSettings>;
  setSettings: (patch: Partial<DesktopSettings>) => Promise<DesktopSettings>;
  recallMemory: (query: string, limit?: number) => Promise<MemoryHit[]>;
  onRunEvent: (cb: (e: ConnectorEvent) => void) => () => void;
  onProgress: (cb: (e: { phase: string; detail: string }) => void) => () => void;
  cancelRun: () => Promise<boolean>;
  // P3 Checkpoint APIs
  listCheckpoints: (opts?: { sessionId?: string; limit?: number }) => Promise<CheckpointIndexEntry[]>;
  loadCheckpoint: (runId: string) => Promise<Checkpoint | null>;
  resumeTask: (runId: string, planningMode?: 'simple' | 'hierarchical' | 'auto') => Promise<{ runId: string; result?: string }>;
  deleteCheckpoint: (runId: string) => Promise<boolean>;
  onStreamChunk: (cb: (e: { runId: string; delta: string }) => void) => () => void;
  onStreamEnd: (cb: (e: { runId: string }) => void) => () => void;
  selectDirectory: () => Promise<string | null>;
  // Session management
  listSessions: () => Promise<ChatSession[]>;
  getSession: (id: string) => Promise<ChatSession | undefined>;
  createSession: (title?: string) => Promise<ChatSession>;
  appendMessage: (sessionId: string, msg: ChatMessage) => Promise<ChatSession | undefined>;
  deleteSession: (id: string) => Promise<boolean>;
  exportSession: (id: string, format: 'json' | 'markdown') => Promise<string>;
  listMemories: (kind?: string, limit?: number) => Promise<MemoryRecord[]>;
  storeMemory: (content: string, kind: string, scope: string) => Promise<void>;
  deleteMemory: (id: string) => Promise<boolean>;
  purgeMemories: () => Promise<number>;
  exportMemories: () => Promise<string>;
  countMemories: (kind?: string) => Promise<number>;
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
  // File System
  writeFile: (filePath: string, content: string) => Promise<{ success: boolean; error?: string }>;
  selectSaveDir: () => Promise<string | null>;
  // Confirmation (P1-2 HITL)
  onConfirmationRequest: (cb: (req: ConfirmationRequest) => void) => () => void;
  confirmAction: (requestId: string, decision: Decision) => Promise<void>;
  // Audit log (P1-2 HITL)
  listAuditEntries: (filter?: { runId?: string; toolName?: string; outcome?: 'pending' | 'success' | 'error' | 'blocked'; limit?: number }) => Promise<AuditLogEntry[]>;
  countAuditEntries: (filter?: { runId?: string; toolName?: string; outcome?: 'pending' | 'success' | 'error' | 'blocked' }) => Promise<number>;
  listAlwaysRules: () => Promise<AlwaysRule[]>;
  removeAlwaysRule: (id: string) => Promise<boolean>;
  // Skill review queue
  listSkillCandidates: () => Promise<CandidateSkill[]>;
  approveSkillCandidate: (id: string, note?: string) => Promise<void>;
  rejectSkillCandidate: (id: string, note?: string) => Promise<void>;
  runSuccessSkillDiscovery: (historyDir?: string, minTurns?: number) => Promise<{ candidates: number; facts: number }>;
  // Manual skill creation from a session
  createSkillFromSession: (sessionId: string) => Promise<{ name: string; path: string }>;
  // Agent activity (side-panel feed)
  onAgentActivity: (cb: (e: { agent: string; icon: string; message: string; detail?: string }) => void) => () => void;
  // Window controls
  windowMinimize: () => Promise<void>;
  windowMaximize: () => Promise<void>;
  windowClose: () => Promise<void>;
  windowIsMaximized: () => Promise<boolean>;
  windowOnMaximizeChange: (cb: (maximized: boolean) => void) => () => void;
  // Browser preview (Marvis-like live view)
  onBrowserPreview: (cb: (base64Data: string) => void) => () => void;
  // Agent Viewport (floating window)
  toggleAgentViewport: () => Promise<boolean>;
  // P3 Harness: Benchmarks
  checkDocker: () => Promise<{ ok: boolean; version?: string; reason?: string }>;
  listBenchmarkSuites: () => Promise<Array<{ id: string; name: string; cases: Array<{ id: string; name: string }> }>>;
  runBenchmarkSuite: (suiteId: string) => Promise<any>;
  // Storage backend
  getStorageBackend: () => Promise<'jsonl' | 'sqlite'>;
  setStorageBackend: (backend: 'jsonl' | 'sqlite') => Promise<boolean>;
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

function createEventListener<T>(channel: string): (cb: (event: T) => void) => () => void {
  return (cb: (event: T) => void) => {
    const handler = (_: unknown, event: T) => cb(event);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  };
}

const onRunEvent = createEventListener<ConnectorEvent>(IPC_CHANNELS.ON_RUN_EVENT);
const onProgress = createEventListener<{ phase: string; detail: string }>(IPC_CHANNELS.ON_PROGRESS);
const onStreamChunk = createEventListener<{ runId: string; delta: string }>(IPC_CHANNELS.ON_STREAM_CHUNK);
const onStreamEnd = createEventListener<{ runId: string }>(IPC_CHANNELS.ON_STREAM_END);
const onWeChatHookStatus = createEventListener<WeChatHookStatus>(IPC_CHANNELS.ON_WECHAT_HOOK_STATUS);
const onQQStatus = createEventListener<QQStatus>(IPC_CHANNELS.ON_QQ_STATUS);
const onConfirmationRequest = createEventListener<ConfirmationRequest>(IPC_CHANNELS.ON_CONFIRMATION_REQUEST);
const onAgentActivity = createEventListener<{ agent: string; icon: string; message: string; detail?: string }>(IPC_CHANNELS.ON_AGENT_ACTIVITY);
const windowOnMaximizeChange = createEventListener<boolean>(IPC_CHANNELS.WINDOW_ON_MAXIMIZE_CHANGE);
const onBrowserPreview = createEventListener<string>(IPC_CHANNELS.ON_BROWSER_PREVIEW);

const api: ZDesktopAPI = {
  runTask: (task, sessionId, planningMode) => ipcRenderer.invoke(IPC_CHANNELS.RUN_TASK, task, sessionId, planningMode),
  listRuns: (limit, sessionId) => ipcRenderer.invoke(IPC_CHANNELS.LIST_RUNS, limit, sessionId),
  getRun: (runId) => ipcRenderer.invoke(IPC_CHANNELS.GET_RUN, runId),
  getSpans: (runId) => ipcRenderer.invoke(IPC_CHANNELS.GET_SPANS, runId),
  getSettings: () => ipcRenderer.invoke(IPC_CHANNELS.GET_SETTINGS),
  setSettings: (patch) => ipcRenderer.invoke(IPC_CHANNELS.SET_SETTINGS, patch),
  recallMemory: (query, limit) => ipcRenderer.invoke(IPC_CHANNELS.RECALL_MEMORY, query, limit),
  onRunEvent,
  onProgress,
  cancelRun: () => ipcRenderer.invoke(IPC_CHANNELS.CANCEL_RUN),
  // P3 Checkpoint APIs
  listCheckpoints: (opts) => ipcRenderer.invoke(IPC_CHANNELS.LIST_CHECKPOINTS, opts),
  loadCheckpoint: (runId) => ipcRenderer.invoke(IPC_CHANNELS.LOAD_CHECKPOINT, runId),
  resumeTask: (runId, planningMode) => ipcRenderer.invoke(IPC_CHANNELS.RESUME_TASK, runId, planningMode),
  deleteCheckpoint: (runId) => ipcRenderer.invoke(IPC_CHANNELS.DELETE_CHECKPOINT, runId),
  onStreamChunk,
  onStreamEnd,
  selectDirectory: () => ipcRenderer.invoke(IPC_CHANNELS.SELECT_DIRECTORY),
  // Session management
  listSessions: () => ipcRenderer.invoke(IPC_CHANNELS.LIST_SESSIONS),
  getSession: (id) => ipcRenderer.invoke(IPC_CHANNELS.GET_SESSION, id),
  createSession: (title) => ipcRenderer.invoke(IPC_CHANNELS.CREATE_SESSION, title),
  appendMessage: (sessionId, msg) => ipcRenderer.invoke(IPC_CHANNELS.APPEND_MESSAGE, sessionId, msg),
  deleteSession: (id) => ipcRenderer.invoke(IPC_CHANNELS.DELETE_SESSION, id),
  exportSession: (id, format) => ipcRenderer.invoke(IPC_CHANNELS.EXPORT_SESSION, id, format),
  listMemories: (kind, limit) => ipcRenderer.invoke(IPC_CHANNELS.LIST_MEMORIES, kind, limit),
  storeMemory: (content, kind, scope) => ipcRenderer.invoke(IPC_CHANNELS.STORE_MEMORY, content, kind, scope),
  deleteMemory: (id) => ipcRenderer.invoke(IPC_CHANNELS.DELETE_MEMORY, id),
  purgeMemories: () => ipcRenderer.invoke(IPC_CHANNELS.PURGE_MEMORIES),
  exportMemories: () => ipcRenderer.invoke(IPC_CHANNELS.EXPORT_MEMORIES),
  countMemories: (kind) => ipcRenderer.invoke(IPC_CHANNELS.COUNT_MEMORIES, kind),
  // WeChat Hook
  startWeChatHook: (config) => ipcRenderer.invoke(IPC_CHANNELS.START_WECHAT_HOOK, config),
  stopWeChatHook: () => ipcRenderer.invoke(IPC_CHANNELS.STOP_WECHAT_HOOK),
  getWeChatHookStatus: () => ipcRenderer.invoke(IPC_CHANNELS.GET_WECHAT_HOOK_STATUS),
  onWeChatHookStatus,
  // QQ Bot
  startQQ: (config) => ipcRenderer.invoke(IPC_CHANNELS.START_QQ, config),
  stopQQ: () => ipcRenderer.invoke(IPC_CHANNELS.STOP_QQ),
  getQQStatus: () => ipcRenderer.invoke(IPC_CHANNELS.GET_QQ_STATUS),
  onQQStatus,
  // Chat profile
  getProfile: () => ipcRenderer.invoke(IPC_CHANNELS.GET_PROFILE),
  rebuildProfile: () => ipcRenderer.invoke(IPC_CHANNELS.REBUILD_PROFILE),
  setProfileEnabled: (enabled) => ipcRenderer.invoke(IPC_CHANNELS.SET_PROFILE_ENABLED, enabled),
  clearProfile: () => ipcRenderer.invoke(IPC_CHANNELS.CLEAR_CHAT_PROFILE),
  // File System
  writeFile: (filePath, content) => ipcRenderer.invoke(IPC_CHANNELS.WRITE_FILE, filePath, content),
  selectSaveDir: () => ipcRenderer.invoke(IPC_CHANNELS.SELECT_SAVE_DIR),
  // Confirmation (P1-2 HITL)
  onConfirmationRequest,
  confirmAction: (requestId, decision) => ipcRenderer.invoke(IPC_CHANNELS.CONFIRM_ACTION, requestId, decision),
  // Audit log (P1-2 HITL)
  listAuditEntries: (filter) => ipcRenderer.invoke(IPC_CHANNELS.LIST_AUDIT_ENTRIES, filter),
  countAuditEntries: (filter) => ipcRenderer.invoke(IPC_CHANNELS.COUNT_AUDIT_ENTRIES, filter),
  listAlwaysRules: () => ipcRenderer.invoke(IPC_CHANNELS.LIST_ALWAYS_RULES),
  removeAlwaysRule: (id) => ipcRenderer.invoke(IPC_CHANNELS.REMOVE_ALWAYS_RULE, id),
  // Skill review queue
  listSkillCandidates: () => ipcRenderer.invoke(IPC_CHANNELS.LIST_SKILL_CANDIDATES),
  approveSkillCandidate: (id, note) => ipcRenderer.invoke(IPC_CHANNELS.APPROVE_SKILL_CANDIDATE, id, note),
  rejectSkillCandidate: (id, note) => ipcRenderer.invoke(IPC_CHANNELS.REJECT_SKILL_CANDIDATE, id, note),
  runSuccessSkillDiscovery: (historyDir, minTurns) => ipcRenderer.invoke(IPC_CHANNELS.RUN_SUCCESS_SKILL_DISCOVERY, historyDir, minTurns),
  // Manual skill creation from a session
  createSkillFromSession: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.CREATE_SKILL_FROM_SESSION, sessionId),
  // Agent activity (side-panel feed)
  onAgentActivity,
  // Window controls
  windowMinimize: () => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_MINIMIZE),
  windowMaximize: () => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_MAXIMIZE),
  windowClose: () => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_CLOSE),
  windowIsMaximized: () => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_IS_MAXIMIZED),
  windowOnMaximizeChange,
  // Browser preview
  onBrowserPreview,
  // Agent Viewport
  toggleAgentViewport: () => ipcRenderer.invoke(IPC_CHANNELS.TOGGLE_AGENT_VIEWPORT),
  // P3 Harness: Benchmarks
  checkDocker: () => ipcRenderer.invoke(IPC_CHANNELS.CHECK_DOCKER),
  listBenchmarkSuites: () => ipcRenderer.invoke(IPC_CHANNELS.LIST_BENCHMARK_SUITES),
  runBenchmarkSuite: (suiteId: string) => ipcRenderer.invoke(IPC_CHANNELS.RUN_BENCHMARK_SUITE, suiteId),
  // Storage backend
  getStorageBackend: () => ipcRenderer.invoke(IPC_CHANNELS.GET_STORAGE_BACKEND),
  setStorageBackend: (backend: 'jsonl' | 'sqlite') => ipcRenderer.invoke(IPC_CHANNELS.SET_STORAGE_BACKEND, backend),
};

contextBridge.exposeInMainWorld('zApi', api);

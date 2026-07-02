// @ziner/app-desktop — constants

export const APP_NAME = 'Ziner';

export const IPC_CHANNELS = {
  RUN_TASK: 'z:run-task',
  LIST_RUNS: 'z:list-runs',
  GET_SPANS: 'z:get-spans',
  GET_RUN: 'z:get-run',
  GET_SETTINGS: 'z:get-settings',
  SET_SETTINGS: 'z:set-settings',
  RECALL_MEMORY: 'z:recall-memory',
  ON_RUN_EVENT: 'z:on-run-event',
  ON_PROGRESS: 'z:on-progress',
  CANCEL_RUN: 'z:cancel-run',
  // P3 Checkpoint APIs
  LIST_CHECKPOINTS: 'z:list-checkpoints',
  LOAD_CHECKPOINT: 'z:load-checkpoint',
  RESUME_TASK: 'z:resume-task',
  DELETE_CHECKPOINT: 'z:delete-checkpoint',
  // Streaming (chat token deltas + stream end marker)
  ON_STREAM_CHUNK: 'z:on-stream-chunk',
  ON_STREAM_END: 'z:on-stream-end',
  SELECT_DIRECTORY: 'z:select-directory',
  // Session management
  LIST_SESSIONS: 'z:list-sessions',
  GET_SESSION: 'z:get-session',
  CREATE_SESSION: 'z:create-session',
  APPEND_MESSAGE: 'z:append-message',
  DELETE_SESSION: 'z:delete-session',
  EXPORT_SESSION: 'z:export-session',
  LIST_MEMORIES: 'z:list-memories',
  STORE_MEMORY: 'z:store-memory',
  DELETE_MEMORY: 'z:delete-memory',
  PURGE_MEMORIES: 'z:purge-memories',
  EXPORT_MEMORIES: 'z:export-memories',
  COUNT_MEMORIES: 'z:count-memories',
  // WeChat Hook (WeChatFerry DLL injection)
  START_WECHAT_HOOK: 'z:start-wechat-hook',
  STOP_WECHAT_HOOK: 'z:stop-wechat-hook',
  GET_WECHAT_HOOK_STATUS: 'z:get-wechat-hook-status',
  ON_WECHAT_HOOK_STATUS: 'z:on-wechat-hook-status',
  // QQ Bot (official Tencent Bot API)
  START_QQ: 'z:start-qq',
  STOP_QQ: 'z:stop-qq',
  GET_QQ_STATUS: 'z:get-qq-status',
  ON_QQ_STATUS: 'z:on-qq-status',
  // Chat profile
  GET_PROFILE: 'z:get-profile',
  REBUILD_PROFILE: 'z:rebuild-profile',
  SET_PROFILE_ENABLED: 'z:set-profile-enabled',
  CLEAR_CHAT_PROFILE: 'z:clear-chat-profile',
  // File System
  WRITE_FILE: 'z:write-file',
  SELECT_SAVE_DIR: 'z:select-save-dir',
  // Confirmation (P1-2 HITL)
  ON_CONFIRMATION_REQUEST: 'z:on-confirmation-request',
  CONFIRM_ACTION: 'z:confirm-action',
  // Audit log (P1-2 HITL)
  LIST_AUDIT_ENTRIES: 'z:list-audit-entries',
  COUNT_AUDIT_ENTRIES: 'z:count-audit-entries',
  LIST_ALWAYS_RULES: 'z:list-always-rules',
  REMOVE_ALWAYS_RULE: 'z:remove-always-rule',
  // Skill review queue
  LIST_SKILL_CANDIDATES: 'z:list-skill-candidates',
  APPROVE_SKILL_CANDIDATE: 'z:approve-skill-candidate',
  REJECT_SKILL_CANDIDATE: 'z:reject-skill-candidate',
  RUN_SUCCESS_SKILL_DISCOVERY: 'z:run-success-skill-discovery',
  // Manual skill creation from a session
  CREATE_SKILL_FROM_SESSION: 'z:create-skill-from-session',
  // Agent activity (side-panel feed)
  ON_AGENT_ACTIVITY: 'z:on-agent-activity',
  // Window controls
  WINDOW_MINIMIZE: 'z:window-minimize',
  WINDOW_MAXIMIZE: 'z:window-maximize',
  WINDOW_CLOSE: 'z:window-close',
  WINDOW_IS_MAXIMIZED: 'z:window-is-maximized',
  WINDOW_ON_MAXIMIZE_CHANGE: 'z:window-on-maximize-change',
  // Browser preview (Marvis-like live view)
  ON_BROWSER_PREVIEW: 'z:on-browser-preview',
  // Agent Viewport (floating window)
  TOGGLE_AGENT_VIEWPORT: 'z:toggle-agent-viewport',
  VIEWPORT_MODE: 'z:viewport-mode',
  // P3 Harness: Benchmarks
  CHECK_DOCKER: 'z:check-docker',
  LIST_BENCHMARK_SUITES: 'z:list-benchmark-suites',
  RUN_BENCHMARK_SUITE: 'z:run-benchmark-suite',
  // Storage backend
  GET_STORAGE_BACKEND: 'z:get-storage-backend',
  SET_STORAGE_BACKEND: 'z:set-storage-backend',
} as const;

export const WINDOW_SIZES = {
  main: { width: 1200, height: 800 },
  chat: { width: 900, height: 700 },
  trace: { width: 1200, height: 800 },
  settings: { width: 800, height: 600 },
} as const;

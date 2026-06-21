// @z-assistant/app-desktop — constants

export const APP_NAME = 'Z Assistant';

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
} as const;

export const WINDOW_SIZES = {
  main: { width: 1200, height: 800 },
  chat: { width: 900, height: 700 },
  trace: { width: 1200, height: 800 },
  settings: { width: 800, height: 600 },
} as const;

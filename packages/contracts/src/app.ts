// App-level Contracts — unified types shared between Desktop and Mobile.
//
// These types define the application-level data structures that both
// platforms use for UI, settings, sessions, and MCP configuration.
// Platform-specific fields are marked with @platform annotations.

import type { ToolPolicy, BudgetPolicy } from './config';
import type { MemoryKind, MemoryScope } from './memory';

// ── MCP Server Config ─────────────────────────────────────────────────

/** Configuration for a single MCP server connection. */
export interface McpServerConfig {
  /** Human-readable name for this server; used in tool prefixes and logs. */
  name: string;
  /**
   * Transport type.
   * - `stdio`: spawn a local process (command + args). Desktop only.
   * - `sse`: connect to a remote Server-Sent Events endpoint.
   * - `streamablehttp`: connect to a remote Streamable HTTP endpoint.
   */
  transport: 'stdio' | 'sse' | 'streamablehttp';
  /** For stdio: command to spawn. @platform desktop */
  command?: string;
  /** For stdio: command arguments. @platform desktop */
  args?: string[];
  /** For stdio: environment variables to pass to the spawned process. @platform desktop */
  env?: Record<string, string>;
  /** For sse/streamablehttp: server URL. */
  url?: string;
  /** Optional HTTP headers (e.g. Authorization: Bearer xxx). */
  headers?: Record<string, string>;
}

// ── Chat Message (UI level) ───────────────────────────────────────────

/**
 * A chat message as seen by the UI layer. This is distinct from LLMMessage
 * (which is the wire format for LLM API calls). ChatMessage includes
 * UI-specific metadata like streaming state and timestamps.
 */
export interface ChatMessage {
  /** Unique message id (uuid v4). */
  id: string;
  /** Message role. */
  role: 'user' | 'assistant' | 'system';
  /** Message text content. */
  content: string;
  /** Creation timestamp (epoch ms). */
  createdAt: number;
  /** Set while the assistant is streaming a response. */
  streaming?: boolean;
  /** Tool calls made by the assistant (if any). */
  toolCalls?: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
    result?: string;
  }>;
  /** Optional model that produced this message. */
  model?: string;
  /** Token usage for this message (if known). */
  tokensIn?: number;
  tokensOut?: number;
}

// ── Session ───────────────────────────────────────────────────────────

/** Summary of a chat session for list views. */
export interface SessionSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** Number of messages in the session. */
  messageCount: number;
  /** Preview of the last message (truncated). */
  preview?: string;
  /** Optional tags for categorising sessions. */
  tags?: string[];
  /** True if the session is archived (hidden from default list). */
  archived?: boolean;
}

/** Full session detail with messages. */
export interface SessionDetail extends SessionSummary {
  messages: ChatMessage[];
  /** Number of times this session was opened. */
  accessCount?: number;
  /** Optional short summary for search previews. */
  summary?: string;
}

/** Options for searching sessions. */
export interface SessionSearchOptions {
  /** Search query (matches title, messages, tags). */
  query?: string;
  /** Include archived sessions. Default false. */
  includeArchived?: boolean;
  /** Only return sessions with these tags. */
  tags?: string[];
  /** Max results. Default 50. */
  limit?: number;
  /** Sort order. Default 'recent'. */
  sort?: 'recent' | 'oldest' | 'alphabetical';
}

// ── App Settings ──────────────────────────────────────────────────────

/**
 * Unified application settings shared between Desktop and Mobile.
 * Platform-specific fields are marked with @platform annotations.
 */
export interface AppSettings {
  // ── Core (shared) ──────────────────────────────────────────────

  /** UI language: 'zh-CN' or 'en'. */
  language: string;
  /** Whether long-term memory is enabled. */
  memoryEnabled: boolean;
  /** Storage backend for memory: 'jsonl' or 'sqlite'. */
  storageBackend: 'jsonl' | 'sqlite';
  /** Default LLM model configuration. */
  defaultModel: { provider: string; name: string };
  /** API key for the LLM provider. */
  apiKey: string;
  /** API endpoint for the LLM provider (OpenAI-compatible). */
  apiEndpoint: string;

  // ── MCP ────────────────────────────────────────────────────────

  /** McDonald's China MCP token. */
  mcdMcpToken?: string;
  /** AMap (Gaode) Maps MCP API key. */
  amapApiKey?: string;
  /** Custom MCP server list. */
  mcpServers?: McpServerConfig[];

  // ── Tool Policy ────────────────────────────────────────────────

  /** Tool allow/deny policy (glob patterns). */
  toolPolicy: ToolPolicy;

  // ── Budget ─────────────────────────────────────────────────────

  /** Optional budget/cost caps. */
  budget?: BudgetPolicy;

  /** P1-2 HITL: when true, tool calls are simulated (no side effects). */
  dryRun?: boolean;

  // ── Desktop-specific ───────────────────────────────────────────

  /** @platform desktop — Storage directory for app data. */
  storageDir?: string;
  /** @platform desktop — Project/workspace directory. */
  projectDir?: string;
  /** @platform desktop — WeChat Hook configuration. */
  wechatHook?: { enabled: boolean };
  /** @platform desktop — QQ OneBot configuration. */
  qq?: { enabled: boolean };

  // ── Mobile-specific ────────────────────────────────────────────

  /** @platform mobile — Bridge mode: 'local' or 'remote'. */
  bridgeMode?: 'local' | 'remote';
  /** @platform mobile — Remote Runtime server URL. */
  runtimeServerUrl?: string;
  /** @platform mobile — API key for the remote Runtime server. */
  runtimeApiKey?: string;
}

/** Default settings shared across platforms. */
export const DEFAULT_APP_SETTINGS: AppSettings = {
  language: 'zh-CN',
  memoryEnabled: true,
  storageBackend: 'jsonl',
  defaultModel: { provider: 'openai', name: 'gpt-4o' },
  apiKey: '',
  apiEndpoint: '',
  mcdMcpToken: '',
  amapApiKey: '',
  toolPolicy: { allow: [], deny: [] },
  dryRun: false,
};

// ── Bridge / Connection Status ────────────────────────────────────────

export interface BridgeStatus {
  connected: boolean;
  backend: 'local' | 'remote';
  version?: string;
  latencyMs?: number;
  /** Reason for disconnection (if known). */
  reason?: string;
}

// ── Memory (UI-level helpers) ─────────────────────────────────────────

/** Memory kind labels for UI display. */
export const MEMORY_KIND_LABELS: Record<MemoryKind, string> = {
  'short-term': '短期',
  'long-term': '长期',
  'episodic': '情节',
  'semantic': '语义',
  'procedural': '技能',
  'preference': '偏好',
};

/** Memory scope labels for UI display. */
export const MEMORY_SCOPE_LABELS: Record<MemoryScope, string> = {
  'session': '会话',
  'user': '用户',
  'agent': 'Agent',
  'project': '项目',
  'global': '全局',
};

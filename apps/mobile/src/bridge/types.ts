// Mobile Runtime Bridge Interface
//
// A lightweight bridge between the mobile UI and the Runtime backend.
// Two implementations:
//   - LocalRuntimeBridge:   full local runtime running on device
//   - RemoteRuntimeBridge:  connects to a remote Runtime server via HTTP API

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: number;
  /** Set while the assistant is streaming. */
  streaming?: boolean;
}

export interface MemoryRecord {
  id: string;
  content: string;
  kind: 'fact' | 'preference' | 'episodic' | 'procedural' | 'long-term' | 'short-term' | 'working';
  scope: 'long-term' | 'short-term' | 'working' | 'user' | 'project' | 'session';
  createdAt: number;
  updatedAt?: number;
  accessedAt?: number;
  metadata?: Record<string, unknown>;
}

export interface MemoryListFilter {
  kind?: MemoryRecord['kind'];
  scope?: MemoryRecord['scope'];
  limit?: number;
  offset?: number;
}

export interface AppSettings {
  /** UI language. */
  language: string;
  /** Whether long-term memory is enabled. */
  memoryEnabled: boolean;
  /** Storage backend: 'sqlite' (recommended for mobile) or 'jsonl'. */
  storageBackend: 'sqlite' | 'jsonl';
  /** Default LLM model configuration. */
  defaultModel: { provider: string; name: string };
  /** API key for the LLM provider. */
  apiKey: string;
  /** API endpoint for the LLM provider (OpenAI-compatible). */
  apiEndpoint: string;
  /** McDonald's China MCP token (injected as MCD_MCP_TOKEN env var). */
  mcdMcpToken?: string;
  /** AMap (Gaode) Maps MCP API key (injected as AMAP_MAPS_API_KEY env var). */
  amapApiKey?: string;
  /** Remote Runtime server URL (for RemoteRuntimeBridge). */
  runtimeServerUrl?: string;
  /** API key for the remote Runtime server (if protected). */
  runtimeApiKey?: string;
  /**
   * Tool allow/deny policy (glob patterns).
   *   - allow: empty = allow all
   *   - deny wins over allow
   *   - requireConfirm: tools that need user confirmation per-call
   */
  toolPolicy: {
    allow: string[];
    deny: string[];
    requireConfirm?: string[];
  };
  /**
   * Bridge mode:
   *   - 'local':   full local runtime (memory + tools + multi-round agents)
   *   - 'remote':  connect to a Ziner Runtime server
   */
  bridgeMode: 'local' | 'remote';
  /**
   * Plan mode:
   *   - 'chat':    single-turn chat with tools (default)
   *   - 'plan':    multi-agent plan mode with checkpoint persistence
   *   - 'auto':    automatically choose based on task complexity
   */
  planMode: 'chat' | 'plan' | 'auto';
}

export interface BridgeStatus {
  connected: boolean;
  backend: 'local' | 'remote';
  version?: string;
  latencyMs?: number;
  /** Reason for disconnection (if known). */
  reason?: string;
}

export type BridgeEventType =
  | 'status'
  | 'chatMessage'
  | 'memoryUpdated';

export interface BridgeEvent {
  type: BridgeEventType;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data?: any;
}

export type BridgeEventListener = (event: BridgeEvent) => void;

/**
 * Lightweight Runtime bridge for mobile.
 *
 * Implementations:
 *   - LocalRuntimeBridge:   full runtime running on the device
 *   - RemoteRuntimeBridge:  talks to a remote Runtime server over HTTP
 */
export interface MobileRuntimeBridge {
  /** Current bridge status. */
  readonly status: BridgeStatus;

  /**
   * Initialize the bridge with settings.
   * Call this once at app startup or when settings change.
   */
  init(settings: AppSettings): Promise<void>;

  /** Disconnect and clean up resources. */
  close(): Promise<void>;

  // ── Chat ──────────────────────────────────────────────────────────

  /** Send a chat message; returns the response (non-streaming). */
  sendChat(
    message: string,
    conversationId?: string,
    options?: ChatRunOptions,
  ): Promise<ChatMessage>;

  /** Stream a chat response (calls onChunk for each delta). */
  streamChat?(
    message: string,
    conversationId: string | undefined,
    onChunk: (delta: string, fullMessage: string) => void,
    signal?: AbortSignal,
    options?: ChatRunOptions,
  ): Promise<ChatMessage>;

  /** Cancel the currently running task (chat/plan), if any. */
  cancelRun(): boolean;

  /** Get chat history for a conversation. */
  getChatHistory?(conversationId?: string): Promise<ChatMessage[]>;

  // ── Checkpoints ───────────────────────────────────────────────────

  /** List persisted checkpoints (most recently updated first). */
  listCheckpoints?(options?: { sessionId?: string; limit?: number }): Promise<CheckpointSummary[]>;

  /** Load a single checkpoint by runId. */
  getCheckpoint?(runId: string): Promise<CheckpointDetail | null>;

  /** Delete a checkpoint by runId. */
  deleteCheckpoint?(runId: string): Promise<void>;

  /** Get the current active plan mode. */
  getPlanMode?(): 'chat' | 'plan' | 'auto';

  /** List chat sessions (most recent first). */
  listSessions?(): Promise<ChatSessionSummary[]>;
  /** Create a new chat session. */
  createSession?(title?: string): Promise<ChatSessionSummary>;
  /** Delete a chat session by id. */
  deleteSession?(id: string): Promise<boolean>;
  /** Rename a chat session. */
  renameSession?(id: string, title: string): Promise<void>;
  /** Archive / unarchive a chat session. */
  archiveSession?(id: string, archived: boolean): Promise<void>;
  /** Search chat sessions by query. */
  searchSessions?(query: string, limit?: number): Promise<ChatSessionSummary[]>;
  /** Export a session as JSON or Markdown. */
  exportSession?(id: string, format: 'json' | 'markdown'): Promise<string>;

  // ── Memory ────────────────────────────────────────────────────────

  /** List memories with optional filters. */
  listMemories(filter?: MemoryListFilter): Promise<MemoryRecord[]>;
  /** Export all memories as JSON. */
  exportMemories?(): Promise<string>;

  /** Search memories by query (vector + keyword). */
  searchMemories(query: string, limit?: number): Promise<MemoryRecord[]>;

  /** Manually add a memory. */
  addMemory(content: string, kind?: MemoryRecord['kind']): Promise<MemoryRecord>;

  /** Delete a memory by ID. */
  deleteMemory(id: string): Promise<void>;

  // ── Trace ────────────────────────────────────────────────────────

  /** List recent runs (most recent first). */
  listTraceRuns(limit?: number, sessionId?: string): Promise<TraceRunSummary[]>;
  /** Get a single run with full span details. */
  getTraceRun(id: string): Promise<TraceRunDetail | undefined>;
  /** List sessions. */
  listTraceSessions(limit?: number): Promise<TraceSessionSummary[]>;
  /** Delete one run. */
  deleteTraceRun(id: string): Promise<void>;
  /** Clear all trace history. */
  clearTrace(): Promise<void>;

  // ── Events ────────────────────────────────────────────────────────

  /** Subscribe to bridge events. */
  addEventListener(type: BridgeEventType, listener: BridgeEventListener): void;

  /** Unsubscribe from bridge events. */
  removeEventListener(type: BridgeEventType, listener: BridgeEventListener): void;
}

export interface TraceRunSummary {
  id: string;
  sessionId: string;
  userMessage: string;
  assistantMessage?: string;
  startTime: number;
  durationMs?: number;
  status: 'running' | 'ok' | 'error';
  llmCalls: number;
  toolCalls: number;
  totalTokens?: number;
  skills?: string[];
  mcpServers?: string[];
}

export interface TraceRunDetail extends TraceRunSummary {
  endTime?: number;
  spans: TraceSpanInfo[];
  error?: string;
}

export interface TraceSpanInfo {
  id: string;
  type: 'llm' | 'tool' | 'orchestrator';
  name: string;
  startTime: number;
  endTime?: number;
  durationMs?: number;
  status: 'ok' | 'error' | 'pending';
  input?: unknown;
  output?: unknown;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface ChatSessionSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  preview?: string;
  tags?: string[];
  archived?: boolean;
}

export interface TraceSessionSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

/** Per-run options for sendChat / streamChat. */
export interface ChatRunOptions {
  /** Explicit plan mode override for this run. */
  mode?: 'chat' | 'plan' | 'auto';
  /** Resume a previously interrupted plan run from its checkpoint. */
  resumeFromRunId?: string;
}

/** Lightweight checkpoint summary exposed to the mobile UI. */
export interface CheckpointSummary {
  runId: string;
  task: string;
  sessionId: string;
  status: 'in_progress' | 'completed' | 'cancelled' | 'failed';
  completedCount: number;
  totalCount: number;
  createdAt: number;
  updatedAt: number;
}

/** Checkpoint detail exposed to the mobile UI. */
export interface CheckpointDetail extends CheckpointSummary {
  subtasks: {
    id: string;
    title: string;
    status: 'pending' | 'running' | 'done' | 'failed';
    output?: string;
  }[];
}

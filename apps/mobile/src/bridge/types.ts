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
  sendChat(message: string, conversationId?: string): Promise<ChatMessage>;

  /** Stream a chat response (calls onChunk for each delta). */
  streamChat?(
    message: string,
    conversationId: string | undefined,
    onChunk: (delta: string, fullMessage: string) => void,
  ): Promise<ChatMessage>;

  /** Get chat history for a conversation. */
  getChatHistory?(conversationId?: string): Promise<ChatMessage[]>;

  // ── Memory ────────────────────────────────────────────────────────

  /** List memories with optional filters. */
  listMemories(filter?: MemoryListFilter): Promise<MemoryRecord[]>;

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

export interface TraceSessionSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

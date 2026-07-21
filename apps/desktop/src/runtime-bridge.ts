// @ziner/app-desktop — runtime bridge

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import {
  VSCodeConnector,
  type VSCodeConnectorConfig,
  type ConnectorEvent,
  type McpServerConfig,
  type AgentFactory,
  type WeChatHookStatus,
  type QQOneBotStatus,
  type Checkpoint,
  type CheckpointIndexEntry,
  type BenchmarkSuiteSummary,
  type BenchmarkSuiteSpec,
} from '@ziner/app-vscode-connector';
import { createBrowserAgent } from './browser-agent-bridge';
import { createResearchAgentBridge } from './research-agent-bridge';
import { onAgentActivity } from './agent-activity-bus';
import type {
  AgentRun,
  AgentSpan,
  MemoryHit,
  MemoryRecord,
  MemoryKind,
  ConfirmationRequest,
  Decision,
  AlwaysRule,
  ToolPreview,
  CandidateSkill,
  ILLMProvider,
  ModelSpec,
} from '@ziner/contracts';
import { ConfirmationGate, AuditLogger } from '@ziner/runtime';
import { SessionManager } from './session-manager';
import { FileTraceStore } from '@ziner/platform-node';
import type { TraceRunSummary, TraceRunDetail, TraceSessionSummary } from '@ziner/runtime-core';

type ConfirmationListener = (req: ConfirmationRequest) => void;
type PendingConfirmation = {
  resolve: (decision: Decision) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
};

export interface DesktopSettings {
  defaultModel: { provider: string; name: string };
  memoryEnabled: boolean;
  storageDir: string;
  language: string;
  apiKey: string;
  apiEndpoint: string;
  projectDir: string;
  /** P1-2 HITL: when true, tool calls are simulated (no side effects). */
  dryRun: boolean;
  /** WeChat Hook configuration (WeChatFerry DLL injection) */
  wechatHook: { enabled: boolean };
  /** QQ OneBot configuration (NapCat + OneBot protocol) */
  qq: { enabled: boolean };
  /** MCP server list — exposed as additional tools to the agent. */
  mcpServers?: McpServerConfig[];
  /** McDonald's China MCP token (injected as MCD_MCP_TOKEN env var for MCP headers). */
  mcdMcpToken?: string;
  /** AMap (Gaode) Maps MCP API key (injected as AMAP_MAPS_API_KEY env var). */
  amapApiKey?: string;
  /** P1-2: optional tool allow/deny policy. */
  toolPolicy?: { allow: string[]; deny: string[] };
  /** P1-3: optional budget/cost caps. */
  budget?: { perRunTokens?: number; perRunUsd?: number; perDayUsd?: number };
  /** Storage backend for memory: 'jsonl' (default) or 'sqlite' (faster, lower memory). */
  storageBackend?: 'jsonl' | 'sqlite';
}

const DEFAULT_SETTINGS: DesktopSettings = {
  defaultModel: { provider: 'sglang', name: 'default' },
  memoryEnabled: true,
  storageDir: path.join(os.homedir(), '.ziner', 'desktop'),
  language: 'zh-CN',
  apiKey: '',
  apiEndpoint: '',
  projectDir: process.cwd(),
  dryRun: false,
  wechatHook: { enabled: false },
  qq: { enabled: false },
  mcdMcpToken: '',
  amapApiKey: '',
  toolPolicy: { allow: [], deny: [] },
  budget: { perRunTokens: 1_000_000, perRunUsd: 5, perDayUsd: 50 },
};

export class RuntimeBridge {
  private connector: VSCodeConnector | null = null;
  private settings: DesktopSettings;
  private eventListeners = new Set<(e: ConnectorEvent) => void>();
  private wechatHookStatusListeners = new Set<(s: { online: boolean; nickname: string; wxid: string; messageCount: number }) => void>();
  private qqStatusListeners = new Set<(s: { online: boolean; nickname: string; userId: string; messageCount: number; lastEvent: string }) => void>();
  private settingsPath: string;
  private _sessions: SessionManager;
  private _traceStore: FileTraceStore | null = null;
  private saveSettingsTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly SAVE_DEBOUNCE_MS = 200;

  // ── P1-2 HITL Confirmation ──────────────────────────────────────
  private confirmationGate: ConfirmationGate | null = null;
  private confirmationListeners = new Set<ConfirmationListener>();
  private pendingConfirmations = new Map<string, PendingConfirmation>();
  private alwaysRulesPath: string;
  private auditLogger: AuditLogger | null = null;
  private _unsubActivity: (() => void) | null = null;
  private static readonly CONFIRMATION_TIMEOUT_MS = 5 * 60 * 1000; // 5 min

  constructor(settings?: Partial<DesktopSettings>) {
    this.settings = { ...DEFAULT_SETTINGS, ...settings };
    this.settingsPath = path.join(this.settings.storageDir, 'settings.json');
    this.alwaysRulesPath = path.join(this.settings.storageDir, 'always-rules.json');
    this.loadSettings();
    this._sessions = new SessionManager(this.settings.storageDir);
  }

  get sessions(): SessionManager { return this._sessions; }

  private loadSettings(): void {
    try {
      if (fs.existsSync(this.settingsPath)) {
        const raw = fs.readFileSync(this.settingsPath, 'utf-8');
        const saved = JSON.parse(raw);
        this.settings = { ...DEFAULT_SETTINGS, ...saved };
      }
    } catch { /* ignore */ }
  }

  private saveSettings(): void {
    if (this.saveSettingsTimer) {
      clearTimeout(this.saveSettingsTimer);
    }
    this.saveSettingsTimer = setTimeout(() => {
      this.flushSaveSettings();
    }, RuntimeBridge.SAVE_DEBOUNCE_MS);
  }

  private flushSaveSettings(): void {
    this.saveSettingsTimer = null;
    try {
      const dir = path.dirname(this.settingsPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.settingsPath, JSON.stringify(this.settings, null, 2), 'utf-8');
    } catch (e: any) {
      console.error('[RuntimeBridge] save settings error:', e);
    }
  }

  get storageDir(): string { return this.settings.storageDir; }

  async start(): Promise<void> {
    if (this.connector) return;
    // Build the audit logger first so the confirmation gate can use it.
    if (!this.auditLogger) {
      this.auditLogger = new AuditLogger({ rootDir: this.settings.storageDir });
    }
    // Inject McDonald's MCP token as env var so ${env:MCD_MCP_TOKEN} placeholders resolve.
    if (this.settings.mcdMcpToken) {
      process.env.MCD_MCP_TOKEN = this.settings.mcdMcpToken;
    }
    // Inject AMap MCP API key as env var so ${env:AMAP_MAPS_API_KEY} placeholders resolve.
    if (this.settings.amapApiKey) {
      process.env.AMAP_MAPS_API_KEY = this.settings.amapApiKey;
    }
    // Build the confirmation gate first so it can be injected into the connector.
    if (!this.confirmationGate) {
      this.confirmationGate = new ConfirmationGate({
        onRequest: (req) => this.dispatchConfirmation(req),
        onPersistRule: (rule) => this.persistAlwaysRule(rule),
        rules: this.loadAlwaysRules(),
        previewGenerator: (toolName, args) => this.generatePreview(toolName, args),
        userId: 'desktop-user',
        auditLogger: this.auditLogger,
      });
    }
    // Assemble MCP server list. If the user supplied a known service key/token
    // but no explicit server for it, inject the default configuration so the
    // credentials actually wire up the MCP tools.
    const mcpServers: McpServerConfig[] = [...(this.settings.mcpServers ?? [])];
    if (this.settings.mcdMcpToken && !mcpServers.some((s) => s.name === 'mcdonalds')) {
      mcpServers.push({
        name: 'mcdonalds',
        transport: 'streamablehttp',
        url: 'https://mcp.mcd.cn',
        headers: {
          Authorization: 'Bearer ${env:MCD_MCP_TOKEN}',
        },
      });
    }
    if (this.settings.amapApiKey && !mcpServers.some((s) => s.name === 'amap')) {
      mcpServers.push({
        name: 'amap',
        transport: 'streamablehttp',
        url: 'https://mcp.amap.com/mcp?key=${env:AMAP_MAPS_API_KEY}',
      });
    }

    const config: VSCodeConnectorConfig = {
      storageDir: this.settings.storageDir,
      projectKey: 'desktop',
      defaultModel: this.settings.defaultModel,
      apiKey: this.settings.apiKey || undefined,
      apiEndpoint: this.settings.apiEndpoint || undefined,
      projectDir: this.settings.projectDir,
      confirmationGate: this.confirmationGate,
      dryRun: this.settings.dryRun,
      auditLogger: this.auditLogger ?? undefined,
      mcpServers,
      toolPolicy: this.settings.toolPolicy,
      budget: this.settings.budget,
      storageBackend: this.settings.storageBackend,
      autoMigrateStorage: true,
      onStorageMigrationProgress: (processed: number, total: number) => {
        this.dispatchEvent({
          type: 'storageMigrationProgress',
          processed,
          total,
        } as any);
      },
      // Wire the stream callback so the chat-agent's LLM deltas surface
      // as `streamChunk` events on the bridge event bus. The desktop
      // main process forwards them to the renderer over IPC.
      onStreamChunk: (runId: string, delta: string) => {
        this.dispatchEvent({ type: 'streamChunk', runId, delta });
      },
      agentFactories: [
        (({ llmProvider, model, mcpTools }: { llmProvider: ILLMProvider; model: ModelSpec; mcpTools?: import('@ziner/contracts').ITool[] }) => createBrowserAgent({ llmProvider, model, mcpTools })) satisfies AgentFactory,
        (({ llmProvider, model, mcpTools }: { llmProvider: ILLMProvider; model: ModelSpec; mcpTools?: import('@ziner/contracts').ITool[] }) => createResearchAgentBridge({ llmProvider, model, storageDir: this.settings.storageDir, mcpTools })) satisfies AgentFactory,
      ],
    };
    this.connector = new VSCodeConnector(config);
    this.connector.onEvent((e) => {
      for (const l of this.eventListeners) l(e);
    });
    // Wire agent activity bus → connector events → IPC → renderer
    this._unsubActivity = onAgentActivity((activity) => {
      this.dispatchEvent({
        type: 'agentActivity',
        agent: activity.agent,
        icon: activity.icon,
        message: activity.message,
        detail: activity.detail,
      });
    });
    if (!this._traceStore) {
      this._traceStore = new FileTraceStore({ rootDir: this.settings.storageDir });
    }
    await this.connector.start();
  }

  async stop(): Promise<void> {
    // Cancel any pending confirmation requests so the agent doesn't hang.
    for (const id of Array.from(this.pendingConfirmations.keys())) {
      this.cancelConfirmation(id, 'runtime stopped');
    }
    // Flush pending writes to avoid data loss on shutdown.
    this.flushSaveSettings();
    this._sessions.flush();
    // Flush audit log so no entries are lost on shutdown.
    await this.auditLogger?.flush();
    await this.connector?.stop();
    this.connector = null;
  }

  isReady(): boolean { return this.connector?.isReady() ?? false; }

  async runTask(
    task: string,
    sessionId?: string,
    planningMode?: 'simple' | 'hierarchical' | 'auto',
  ): Promise<{ runId: string; result?: string }> {
    if (!this.connector) throw new Error('Runtime not started');
    // P1-2: pass a loader that returns the last N turns of this session
    // so the Orchestrator can inject the user's earlier intent (e.g.
    // "帮我点个麦当劳") into the downstream sub-task context for a
    // follow-up like "我想要1+1, 不要番茄酱".
    const loadRecentMessages = sessionId
      ? async (sid: string, limit: number): Promise<Array<{ role: 'user' | 'assistant'; content: string }>> => {
          try {
            const s = this.sessions.get(sid);
            if (!s || s.id !== sid) return [];
            const last = s.messages.slice(-Math.max(1, limit));
            return last.map((m) => ({ role: m.role, content: m.content }));
          } catch {
            return [];
          }
        }
      : undefined;
    return this.connector.runTask(task, 'desktop', sessionId, planningMode, loadRecentMessages);
  }

  async runEvolution(windowMs?: number): Promise<{ reportId: string; readyToApply: boolean }> {
    if (!this.connector) throw new Error('Runtime not started');
    const report = await this.connector.runEvolution(windowMs);
    return { reportId: `evo-${Date.now()}`, readyToApply: report?.readyToApply ?? false };
  }

  async runSkillDiscovery(cfg?: { windowMs?: number; minOccurrences?: number }): Promise<unknown> {
    if (!this.connector) throw new Error('Runtime not started');
    return this.connector.runSkillDiscovery(cfg);
  }

  /**
   * Cancel the currently running task, if any. Returns true if a run
   * was cancelled, false if nothing was running. Idempotent.
   */
  cancelRun(): boolean {
    if (!this.connector) return false;
    return this.connector.cancelRun();
  }

  /**
   * P3 Checkpoint APIs. List / load / resume a previously-saved run.
   * The IPC layer (`apps/desktop/src/main.ts`) wires these through to
   * the renderer; the UI uses them to show a "Resume" button for any
   * in-progress or cancelled run.
   */
  async listCheckpoints(
    opts?: { sessionId?: string; limit?: number },
  ): Promise<CheckpointIndexEntry[]> {
    if (!this.connector) return [];
    return this.connector.listCheckpoints(opts);
  }

  async loadCheckpoint(runId: string): Promise<Checkpoint | null> {
    if (!this.connector) return null;
    return this.connector.loadCheckpoint(runId);
  }

  async resumeTask(
    runId: string,
    planningMode?: 'simple' | 'hierarchical' | 'auto',
  ): Promise<{ runId: string; result?: string }> {
    if (!this.connector) throw new Error('Runtime not started');
    return this.connector.resumeTask(runId, planningMode);
  }

  async deleteCheckpoint(runId: string): Promise<boolean> {
    if (!this.connector) return false;
    return this.connector.deleteCheckpoint(runId);
  }

  // ── P3 Harness: Benchmarks ────────────────────────────────────

  /** Check if Docker is available for benchmark runs. */
  async checkDocker(): Promise<{ ok: boolean; version?: string; reason?: string }> {
    if (!this.connector) return { ok: false, reason: 'runtime not started' };
    return this.connector.checkDocker();
  }

  /** List all built-in benchmark suites. */
  listBenchmarkSuites(): BenchmarkSuiteSpec[] {
    if (!this.connector) return [];
    return this.connector.listBenchmarkSuites();
  }

  /**
   * Run a benchmark suite by id. Returns the summary when complete.
   * Progress events are forwarded via the main event bus as
   * `benchmark.caseStarted` / `benchmark.caseCompleted` /
   * `benchmark.suiteCompleted` (tunnelled through `ConnectorEvent`
   * as a synthetic `progress` event with a benchmark phase).
   */
  async runBenchmarkSuite(suiteId: string): Promise<BenchmarkSuiteSummary> {
    if (!this.connector) throw new Error('Runtime not started');
    return this.connector.runBenchmarkSuite(suiteId);
  }

  // ── Storage backend ────────────────────────────────────────────────

  /** Get the current memory storage backend. */
  getStorageBackend(): 'jsonl' | 'sqlite' {
    if (!this.connector) return this.settings.storageBackend ?? 'jsonl';
    return this.connector.getStorageBackend();
  }

  /**
   * Set the memory storage backend. Requires a full restart to take effect.
   * Returns true if a restart is needed (i.e. the backend changed).
   */
  setStorageBackend(backend: 'jsonl' | 'sqlite'): boolean {
    const current = this.settings.storageBackend ?? 'jsonl';
    if (current === backend) return false;
    this.settings.storageBackend = backend;
    this.saveSettings();
    return true;
  }

  async runSuccessSkillDiscovery(cfg?: { historyDir?: string; minTurns?: number }): Promise<{ candidates: number; facts: number }> {
    if (!this.connector) throw new Error('Runtime not started');
    const historyDir = cfg?.historyDir ?? path.join(this.settings.storageDir, 'History');
    return this.connector.runSuccessSkillDiscovery({ ...cfg, historyDir });
  }

  async listSkillCandidates(): Promise<CandidateSkill[]> {
    if (!this.connector) throw new Error('Runtime not started');
    return this.connector.listSkillCandidates();
  }

  async approveSkillCandidate(id: string, note?: string): Promise<void> {
    if (!this.connector) throw new Error('Runtime not started');
    const candidate = await this.connector.approveSkillCandidate(id, note);
    // On approval, write the skill to <storageDir>/.skills/<name>/SKILL.md so
    // it becomes active on the next chat agent run.
    const skillRoot = this.settings.storageDir;
    const skillDir = path.join(skillRoot, '.skills', candidate.draft.name);
    fs.mkdirSync(skillDir, { recursive: true });
    const frontmatter = [
      '---',
      `name: ${candidate.draft.name}`,
      `description: ${candidate.draft.description}`,
      `tags: [${candidate.draft.tags.map((t: string) => `"${t}"`).join(', ')}]`,
      `priority: ${candidate.draft.priority}`,
      `mode: ${candidate.draft.mode}`,
      'triggers:',
      `  keywords: [${candidate.draft.triggers.keywords?.map((k: string) => `"${k}"`).join(', ') ?? ''}]`,
      '---',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), frontmatter + candidate.draft.body, 'utf-8');
  }

  async rejectSkillCandidate(id: string, note?: string): Promise<void> {
    if (!this.connector) throw new Error('Runtime not started');
    await this.connector.rejectSkillCandidate(id, note);
  }

  async createSkillFromSession(sessionId: string): Promise<{ name: string; path: string }> {
    if (!this.connector) throw new Error('Runtime not started');
    const session = this._sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);

    // Build conversation markdown from session messages
    const conversationMarkdown = session.messages
      .map((m: any) => `## ${m.role === 'user' ? 'User' : 'Assistant'}\n${m.content}`)
      .join('\n\n');

    // Create an LLM provider for skill extraction using the user's configured model
    const { OpenAIProvider } = require('@ziner/app-vscode-connector');
    const model = this.settings.defaultModel ?? { provider: 'openai', name: 'gpt-4o' };
    let baseURL: string;
    if (this.settings.apiEndpoint) {
      baseURL = this.settings.apiEndpoint;
    } else {
      switch (model.provider) {
        case 'deepseek': baseURL = 'https://api.deepseek.com/v1'; break;
        case 'openai':   baseURL = 'https://api.openai.com/v1'; break;
        case 'anthropic': baseURL = 'https://api.anthropic.com/v1'; break;
        case 'gemini':   baseURL = 'https://generativelanguage.googleapis.com/v1'; break;
        case 'ollama':   baseURL = 'http://localhost:11434/v1'; break;
        default:         baseURL = 'https://api.openai.com/v1'; break;
      }
    }
    const llmProvider = new OpenAIProvider({
      baseURL,
      apiKey: this.settings.apiKey,
      defaultModel: model.name,
      name: model.provider,
    });

    // Use the LLM success extractor to create a skill draft
    const { LlmSuccessSkillExtractor } = require('@ziner/runtime');
    const extractor = new LlmSuccessSkillExtractor({
      llmProvider,
      model,
    });
    const result = await extractor.extract({
      key: sessionId,
      taskPattern: session.title || 'manual-skill',
      cases: [{
        id: sessionId,
        task: session.title || 'Manual skill creation',
        conversationMarkdown,
        outcome: 'success' as const,
        durationMs: 0,
        timestamp: session.updatedAt || session.createdAt,
      }],
    });

    // Write the skill to <storageDir>/.skills/<name>/SKILL.md
    // Use storageDir (user data dir) instead of projectDir to avoid writing
    // into the packaged app directory (dist/win-unpacked/).
    const skillRoot = this.settings.storageDir;
    const skillDir = path.join(skillRoot, '.skills', result.draft.name);
    fs.mkdirSync(skillDir, { recursive: true });
    const frontmatter = [
      '---',
      `name: ${result.draft.name}`,
      `description: ${result.draft.description}`,
      `tags: [${result.draft.tags.map((t: string) => `"${t}"`).join(', ')}]`,
      `priority: ${result.draft.priority}`,
      `mode: ${result.draft.mode}`,
      'triggers:',
      `  keywords: [${result.draft.triggers.keywords?.map((k: string) => `"${k}"`).join(', ') ?? ''}]`,
      '---',
      '',
    ].join('\n');
    const skillPath = path.join(skillDir, 'SKILL.md');
    fs.writeFileSync(skillPath, frontmatter + result.draft.body, 'utf-8');

    return { name: result.draft.name, path: skillPath };
  }

  async listRuns(limit = 50, sessionId?: string): Promise<AgentRun[]> {
    const store = this.connector?.store();
    if (!store) return [];
    return store.runs.list(sessionId ? { limit, sessionId } : { limit });
  }

  async getRun(runId: string): Promise<AgentRun | undefined> {
    return this.connector?.store()?.runs.get(runId);
  }

  async getSpans(runId: string): Promise<AgentSpan[]> {
    const store = this.connector?.store();
    if (!store) return [];
    return store.spans.listByRun(runId, { limit: 1000 });
  }

  onEvent(fn: (e: ConnectorEvent) => void): () => void {
    this.eventListeners.add(fn);
    return () => { this.eventListeners.delete(fn); };
  }

  /** Emit a synthetic `ConnectorEvent` to all listeners. Used by the
   *  bridge layer to inject events that the connector itself doesn't
   *  generate (e.g. `streamChunk` driven by the chat agent's onStreamChunk). */
  private dispatchEvent(e: ConnectorEvent): void {
    for (const l of this.eventListeners) l(e);
  }

  onWeChatHookStatus(fn: (s: { online: boolean; nickname: string; wxid: string; messageCount: number }) => void): () => void {
    this.wechatHookStatusListeners.add(fn);
    return () => this.wechatHookStatusListeners.delete(fn);
  }

  onQQStatus(fn: (s: { online: boolean; nickname: string; userId: string; messageCount: number; lastEvent: string }) => void): () => void {
    this.qqStatusListeners.add(fn);
    return () => this.qqStatusListeners.delete(fn);
  }

  // ── P1-2 HITL Confirmation API ──────────────────────────────────

  /**
   * Subscribe to confirmation requests. The main process uses this to
   * forward requests to the renderer via IPC.
   */
  onConfirmationRequest(fn: ConfirmationListener): () => void {
    this.confirmationListeners.add(fn);
    return () => this.confirmationListeners.delete(fn);
  }

  /**
   * Resolve a pending confirmation request. Called by the main process
   * when the renderer responds via IPC.
   */
  resolveConfirmation(requestId: string, decision: Decision): boolean {
    const pending = this.pendingConfirmations.get(requestId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.pendingConfirmations.delete(requestId);
    pending.resolve(decision);
    return true;
  }

  /**
   * Cancel a pending confirmation (e.g. on timeout or window close).
   */
  cancelConfirmation(requestId: string, reason = 'cancelled'): void {
    const pending = this.pendingConfirmations.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingConfirmations.delete(requestId);
    pending.reject(new Error(reason));
  }

  /** List active always-rules (for the settings UI). */
  listAlwaysRules(): AlwaysRule[] {
    return this.confirmationGate?.listRules() ?? [];
  }

  /** Remove an always-rule by id (persists to disk). */
  removeAlwaysRule(id: string): boolean {
    const removed = this.confirmationGate?.removeRule(id) ?? false;
    if (removed) this.saveAlwaysRules();
    return removed;
  }

  // ── Audit log API ───────────────────────────────────────────────

  /**
   * List audit entries matching the filter. Used by the Trace UI to
   * show what the Agent did.
   */
  async listAuditEntries(filter?: {
    runId?: string;
    toolName?: string;
    outcome?: 'pending' | 'success' | 'error' | 'blocked';
    limit?: number;
  }): Promise<import('@ziner/contracts').AuditLogEntry[]> {
    if (!this.auditLogger) return [];
    return this.auditLogger.list(filter ?? {});
  }

  /** Count audit entries matching the filter. */
  async countAuditEntries(filter?: {
    runId?: string;
    toolName?: string;
    outcome?: 'pending' | 'success' | 'error' | 'blocked';
  }): Promise<number> {
    if (!this.auditLogger) return 0;
    return this.auditLogger.count(filter ?? {});
  }

  // ── Internal helpers ────────────────────────────────────────────

  /**
   * Called by the ConfirmationGate when a tool call needs user input.
   * Notifies all subscribers (main.ts → renderer) and awaits a decision.
   */
  private dispatchConfirmation(req: ConfirmationRequest): Promise<Decision> {
    return new Promise<Decision>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingConfirmations.delete(req.id);
        reject(new Error('Confirmation timed out'));
      }, RuntimeBridge.CONFIRMATION_TIMEOUT_MS);

      this.pendingConfirmations.set(req.id, { resolve, reject, timer });

      // Notify subscribers (main.ts forwards to renderer via IPC).
      for (const fn of this.confirmationListeners) {
        try { fn(req); } catch (e: any) { console.error('[RuntimeBridge] confirmation listener error:', e); }
      }
    });
  }

  /**
   * Generate a human-readable preview for the confirmation modal.
   */
  private generatePreview(toolName: string, args: Record<string, unknown>): ToolPreview | undefined {
    const cmd = args.command ?? args.cmd;
    if (typeof cmd === 'string' && (toolName === 'run_terminal' || toolName === 'shell')) {
      return { kind: 'command', content: cmd, title: 'Terminal command' };
    }
    const content = args.content ?? args.text ?? args.code;
    if (typeof content === 'string' && (toolName === 'write_file' || toolName === 'replace_text' || toolName === 'append_file')) {
      const filePath = typeof args.path === 'string' ? args.path : toolName;
      return { kind: 'diff', content, title: filePath };
    }
    const url = args.url;
    if (typeof url === 'string') {
      return { kind: 'url', content: url, title: 'URL' };
    }
    // Fallback: render args as JSON.
    try {
      return { kind: 'text', content: JSON.stringify(args, null, 2), title: toolName };
    } catch {
      return undefined;
    }
  }

  // ── Always-rule persistence ─────────────────────────────────────

  private loadAlwaysRules(): AlwaysRule[] {
    try {
      if (!fs.existsSync(this.alwaysRulesPath)) return [];
      const raw = fs.readFileSync(this.alwaysRulesPath, 'utf-8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private persistAlwaysRule(rule: AlwaysRule): void {
    // Append to the in-memory list (already done by ConfirmationGate)
    // and persist the full list to disk.
    this.saveAlwaysRules();
  }

  private saveAlwaysRules(): void {
    try {
      const dir = path.dirname(this.alwaysRulesPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const rules = this.confirmationGate?.listRules() ?? [];
      fs.writeFileSync(this.alwaysRulesPath, JSON.stringify(rules, null, 2), 'utf-8');
    } catch (e: any) {
      console.error('[RuntimeBridge] save always-rules error:', e);
    }
  }

  getSettings(): DesktopSettings { return { ...this.settings }; }

  updateSettings(patch: Partial<DesktopSettings>): DesktopSettings {
    this.settings = { ...this.settings, ...patch };
    this.saveSettings();
    if (this.connector) {
      this.connector.config.defaultModel = this.settings.defaultModel;
      this.connector.config.apiKey = this.settings.apiKey || undefined;
      this.connector.config.apiEndpoint = this.settings.apiEndpoint || undefined;
      this.connector.config.projectDir = this.settings.projectDir;
      this.connector.config.dryRun = this.settings.dryRun;
      this.connector.config.toolPolicy = this.settings.toolPolicy;
      this.connector.config.budget = this.settings.budget;
    }
    return this.getSettings();
  }

  async recallMemory(query: string, limit = 10): Promise<MemoryHit[]> {
    try {
      // Use the runtime's shared MemoryManager (G4 aggregated) instead of
      // creating a throwaway JsonlMemoryProvider on every call.
      const memory = this.connector?.memory();
      if (!memory) return [];
      return await memory.recall(query, { limit });
    } catch {
      return [];
    }
  }

  async exportSession(id: string, format: 'json' | 'markdown'): Promise<string> {
    const session = this._sessions.get(id);
    if (!session) throw new Error('Session not found');

    if (format === 'json') {
      return JSON.stringify(session, null, 2);
    }

    // Markdown format
    const lines: string[] = [];
    lines.push(`# ${session.title}`);
    lines.push('');
    lines.push(`> Created: ${new Date(session.createdAt).toLocaleString()}`);
    lines.push(`> Updated: ${new Date(session.updatedAt).toLocaleString()}`);
    lines.push(`> Messages: ${session.messages.length}`);
    lines.push('');
    lines.push('---');
    lines.push('');
    for (const msg of session.messages) {
      const role = msg.role === 'user' ? '**You**' : '**Assistant**';
      const time = new Date(msg.timestamp).toLocaleString();
      lines.push(`${role} (${time}):`);
      lines.push('');
      lines.push(msg.content);
      lines.push('');
      lines.push('---');
      lines.push('');
    }
    return lines.join('\n');
  }

  async listMemories(kind?: string, limit = 50): Promise<MemoryRecord[]> {
    const memory = this.connector?.memory();
    if (!memory) return [];
    try {
      const filter: { limit: number; kind?: MemoryKind } = { limit };
      if (kind) filter.kind = kind as MemoryKind;
      return await memory.list(filter);
    } catch {
      return [];
    }
  }

  async storeMemory(content: string, kind: string, scope: string): Promise<void> {
    const memory = this.connector?.memory();
    if (!memory) return;
    try {
      await memory.remember(content, kind as any, scope as any);
    } catch {
      // best-effort
    }
  }

  async deleteMemory(id: string): Promise<boolean> {
    const memory = this.connector?.memory();
    if (!memory) return false;
    try {
      return await memory.forget(id);
    } catch {
      return false;
    }
  }

  async purgeMemories(): Promise<number> {
    const memory = this.connector?.memory();
    if (!memory) return 0;
    try {
      // MemoryPurgeFilter requires userId for safety; use the manager's default.
      return await memory.purge({ userId: memory.userId ?? 'desktop-user' });
    } catch {
      return 0;
    }
  }

  async exportMemories(): Promise<string> {
    const memory = this.connector?.memory();
    if (!memory) return '[]';
    try {
      const records = await memory.list({ limit: 10000 });
      return JSON.stringify(records, null, 2);
    } catch {
      return '[]';
    }
  }

  async countMemories(kind?: string): Promise<number> {
    const memory = this.connector?.memory();
    if (!memory) return 0;
    try {
      const filter: { kind?: MemoryKind } = {};
      if (kind) filter.kind = kind as MemoryKind;
      return await memory.count(filter);
    } catch {
      return 0;
    }
  }

  // ── Trace (Mobile parity: listTraceRuns / getTraceRun / listTraceSessions / deleteTraceRun / clearTrace) ───

  async listTraceRuns(limit = 50, sessionId?: string): Promise<TraceRunSummary[]> {
    if (!this._traceStore) return [];
    try {
      return await this._traceStore.listRuns(limit, sessionId);
    } catch (e) {
      console.error('[RuntimeBridge] listTraceRuns error:', e);
      return [];
    }
  }

  async getTraceRun(id: string): Promise<TraceRunDetail | undefined> {
    if (!this._traceStore) return undefined;
    try {
      return await this._traceStore.getRun(id);
    } catch (e) {
      console.error('[RuntimeBridge] getTraceRun error:', e);
      return undefined;
    }
  }

  async listTraceSessions(limit = 50): Promise<TraceSessionSummary[]> {
    if (!this._traceStore) return [];
    try {
      return await this._traceStore.listSessions(limit);
    } catch (e) {
      console.error('[RuntimeBridge] listTraceSessions error:', e);
      return [];
    }
  }

  async deleteTraceRun(id: string): Promise<boolean> {
    if (!this._traceStore) return false;
    try {
      await this._traceStore.deleteRun(id);
      return true;
    } catch (e) {
      console.error('[RuntimeBridge] deleteTraceRun error:', e);
      return false;
    }
  }

  async clearTrace(): Promise<number> {
    if (!this._traceStore) return 0;
    try {
      const runs = await this._traceStore.listRuns(10_000);
      const count = runs.length;
      await this._traceStore.clear();
      return count;
    } catch (e) {
      console.error('[RuntimeBridge] clearTrace error:', e);
      return 0;
    }
  }

  // ── WeChat Hook (WeChatFerry DLL injection) ───────────────────

  async startWeChatHook(config?: { nickname?: string }): Promise<void> {
    if (!this.connector) throw new Error('Runtime not started');
    this.connector.onWeChatHookStatus((s: WeChatHookStatus) => {
      for (const fn of this.wechatHookStatusListeners) fn(s);
    });
    await this.connector.startWeChatHook({ enabled: true, nickname: config?.nickname });
  }

  async stopWeChatHook(): Promise<void> {
    await this.connector?.stopWeChatHook();
  }

  getWeChatHookStatus(): { online: boolean; nickname: string; wxid: string; messageCount: number } {
    if (!this.connector) return { online: false, nickname: '', wxid: '', messageCount: 0 };
    return this.connector.wechatHook.status;
  }

  // ── QQ OneBot (NapCat + OneBot protocol) ────────────────────

  async startQQ(config?: { wsUrl?: string; accessToken?: string; nickname?: string }): Promise<void> {
    if (!this.connector) throw new Error('Runtime not started');
    this.connector.onQQStatus((s: QQOneBotStatus) => {
      for (const fn of this.qqStatusListeners) fn(s);
    });
    await this.connector.startQQ({
      wsUrl: config?.wsUrl || 'ws://localhost:3001',
      accessToken: config?.accessToken,
      nickname: config?.nickname,
    });
  }

  async stopQQ(): Promise<void> {
    await this.connector?.stopQQ();
  }

  getQQStatus(): { online: boolean; nickname: string; userId: string; messageCount: number; lastEvent: string } {
    if (!this.connector) return { online: false, nickname: '', userId: '', messageCount: 0, lastEvent: '' };
    return this.connector.qq.status;
  }

  // ── Chat Profile ──────────────────────────────────────────────

  getProfile(): { count: number; description: string | null; enabled: boolean } {
    if (!this.connector) return { count: 0, description: null, enabled: true };
    return {
      count: this.connector.profile.count,
      description: this.connector.profile.profile?.description ?? null,
      enabled: this.connector.profileEnabled,
    };
  }

  rebuildProfile(): void { if (this.connector) this.connector.profile.rebuild(); }
  setProfileEnabled(enabled: boolean): void { if (this.connector) this.connector.profileEnabled = enabled; }
  clearProfile(): void { if (this.connector) this.connector.profile.clear(); }
}

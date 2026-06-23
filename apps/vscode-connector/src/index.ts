// @z-assistant/app-vscode-connector
//
// V2 VSCode Connector — the only file in the V2 tree that bridges
// the V1 VSCode extension (`extensions/coding-agent`) to the V2
// Assistant Runtime (`@z-assistant/runtime`).

import * as path from 'path';
import * as fs from 'fs/promises';

import {
  AgentRegistry,
  Orchestrator,
  registerExampleAgents,
  MemoryManager,
  JsonlMemoryProvider,
  EvolutionEngine,
  BackgroundScheduler,
  AuditLogger,
  HistoryMarkdownSuccessCaseStore,
  LlmSuccessSkillExtractor,
  createLocalEmbeddingProvider,
  type OrchestratorMode,
  type OrchestratorResult,
  type EvolutionReport,
} from '@z-assistant/runtime';

import {
  AutoDiscoveryEngine,
  JsonlFailureCaseStore,
  TemplateSkillExtractor,
  JsonFileSkillReviewQueue,
} from '@z-assistant/runtime/skills';
import { TraceManager, type RunTracker } from '@z-assistant/trace';
import { createFileStore } from '@z-assistant/infra-storage';
import { BudgetGuard } from '@z-assistant/infra-cost';

import type { Store } from '@z-assistant/infra-storage';
import type { AgentResult, IAgent, IConfirmationGate, AutoDiscoveryReport, ITool, CandidateSkill, ModelSpec, ILLMProvider } from '@z-assistant/contracts';

/** Factory supplied by the host (e.g. desktop app) to inject additional IAgents (P1-1). */
export type AgentFactory = (deps: { llmProvider: ILLMProvider; model: ModelSpec; config: VSCodeConnectorConfig }) => IAgent;

import { OpenAIProvider } from './llm-provider';
import { DryRunExecutor } from '@z-assistant/runtime/permission';
import { createChatAgent, CHAT_HISTORY_KEY } from './chat-agent';
import { discoverChatSkills } from './skill-loader';
import { selectAgentsForTask } from './agent-router';
import { ResultCache, shouldCacheTask } from './result-cache';
import { ChatProfile, StyleProfile } from './chat-profile';
import { WeChatHookService, type WeChatHookConfig, type WeChatHookStatus } from './wechat-hook-service';
import { QQOneBotService, type QQOneBotConfig, type QQOneBotStatus } from './qq-onebot-service';
import {
  createCodingAgentFromChat,
  ChatToolRegistry,
  type CodingAgentFactoryOptions,
} from './coding-agent-factory';
import { connectMcpServers, type McpServerConfig } from './mcp-tools';

// ── Configuration shape coming from V1 ─────────────────────────────────

export interface VSCodeConnectorConfig {
  /** Where V2 stores its data; defaults to `<globalStorage>/v2` in the workspace. */
  storageDir: string;
  /** Project key for multi-root workspaces. */
  projectKey?: string;
  /** Optional model override applied to the default Coding agent. */
  defaultModel?: { provider: string; name: string };
  /** Budget policy (sane defaults applied if missing). */
  budget?: { perRunTokens?: number; perRunUsd?: number; perDayUsd?: number };
  /** API key for the model provider (e.g. OpenAI, DeepSeek). */
  apiKey?: string;
  /** Custom API endpoint (e.g. for self-hosted or OpenAI-compatible providers). */
  apiEndpoint?: string;
  /** Project working directory for file/shell operations (default: process.cwd()). */
  projectDir?: string;
  /**
   * Optional confirmation gate (P1-2 HITL). When provided, every tool
   * call passes through `gate.confirm()` before execution. Denied calls
   * are skipped. When not provided, all tools execute without confirmation.
   */
  confirmationGate?: IConfirmationGate;
  /**
   * Optional: when true, tool calls are simulated instead of executed
   * (P1-2 HITL dry-run mode). The agent produces a full plan without
   * any side effects, so the user can preview before committing.
   */
  dryRun?: boolean;
  /**
   * Optional audit logger (P1-2 HITL). When provided, direct V2 tool
   * invocations via ChatToolRegistry are logged.
   */
  auditLogger?: AuditLogger;
  /** WeChat Hook configuration (optional) — uses WeChatFerry DLL injection for full message access. */
  wechatHook?: WeChatHookConfig;
  /** QQ OneBot configuration (optional) — connects to NapCat via OneBot protocol. */
  qq?: QQOneBotConfig;
  /** MCP server list (optional) — exposed as additional tools to the agent. */
  mcpServers?: McpServerConfig[];
  /**
   * Optional V2 tool policy (P1-2). When set, restricts which tools the
   * chat agent and V2 tool registry will invoke.
   */
  toolPolicy?: { allow: string[]; deny: string[] };
  /**
   * Optional agent factories supplied by the host (P1-1). The connector
   * will instantiate them at task time so specialized agents (Browser,
   * Research, etc.) can participate in routing without the connector
   * depending on their packages.
   */
  agentFactories?: AgentFactory[];
}

// ── Lifecycle event types ──────────────────────────────────────────────

export type ConnectorEvent =
  | { type: 'runStart'; runId: string; task: string }
  | { type: 'runEnd'; runId: string; status: 'ok' | 'error' | 'cancelled' }
  | { type: 'spanStart'; runId: string; spanId: string; name: string }
  | { type: 'spanEnd'; runId: string; spanId: string; status: 'ok' | 'error' }
  | { type: 'progress'; runId: string; phase: string; detail: string }
  | { type: 'evalComplete'; evaluationId: string; pass: boolean }
  | { type: 'evolutionReport'; reportId: string; readyToApply: boolean };

export type ConnectorEventListener = (e: ConnectorEvent) => void;

// ── Public types for multi-agent run ──────────────────────────────────

export interface RunMultiAgentTaskOptions {
  task: string;
  mode: OrchestratorMode;
  model: { provider: string; name: string };
  sessionId?: string;
  registerAgents?: (registry: AgentRegistry) => void;
  /** Optional subset of agent names to run; defaults to all registered agents. */
  agents?: string[];
  maxAgentCalls?: number;
  initialState?: Record<string, unknown>;
}

export interface RunMultiAgentTaskResult {
  runId: string;
  result: OrchestratorResult;
  outputText?: string;
}

// ── The connector itself ──────────────────────────────────────────────

export class VSCodeConnector {
  private listeners = new Set<ConnectorEventListener>();
  private _wcHookStatusListeners = new Set<(s: WeChatHookStatus) => void>();
  private _qqStatusListeners = new Set<(s: QQOneBotStatus) => void>();
  private _runtime: AssistantRuntime | null = null;
  private _runCounter = 0;
  private _conversationHistory: Record<string, unknown> = {};
  /** Queue for bot task runs to avoid "Run already active" conflicts */
  private _taskQueue: Array<() => Promise<void>> = [];
  private _taskProcessing = false;
  /** AbortController for the currently running user task */
  private _currentRunAbort: AbortController | null = null;
  /** Cache for repeated pure-query tasks. */
  private _resultCache = new ResultCache<RunMultiAgentTaskResult>({ ttlMs: 5 * 60 * 1000, maxSize: 100 });
  /** WeChat Hook service (WeChatFerry DLL injection — captures ALL messages) */
  readonly wechatHook: WeChatHookService;
  /** QQ OneBot service (NapCat + OneBot protocol) */
  readonly qq: QQOneBotService;
  /** Chat style profile for mimicking user's tone. */
  readonly profile: ChatProfile;
  /** Whether style mimic is enabled. */
  profileEnabled = true;

  constructor(public readonly config: VSCodeConnectorConfig) {
    this.wechatHook = new WeChatHookService();
    this.qq = new QQOneBotService();
    this.profile = new ChatProfile(config.storageDir);
  }

  private createLlmProvider(): ILLMProvider {
    const model = this.config.defaultModel ?? { provider: 'openai', name: 'gpt-4o' };
    const apiKey = this.config.apiKey ?? '';
    let baseURL: string;
    if (this.config.apiEndpoint) {
      baseURL = this.config.apiEndpoint;
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
    return new OpenAIProvider({
      baseURL,
      apiKey,
      defaultModel: model.name,
      name: model.provider,
    });
  }

  /** Wire the V2 runtime. Idempotent. */
  async start(): Promise<void> {
    if (this._runtime) return;

    // F-1: success-driven skill discovery from History/*.md.
    const historyDir = path.join(process.cwd(), 'History');
    const successStore = new HistoryMarkdownSuccessCaseStore({ historyDir });
    const model = this.config.defaultModel ?? { provider: 'openai', name: 'gpt-4o' };
    const successExtractor = new LlmSuccessSkillExtractor({
      llmProvider: this.createLlmProvider(),
      model,
    });

    this._runtime = await AssistantRuntime.boot({
      storageDir: this.config.storageDir,
      projectKey: this.config.projectKey,
      auditLogger: this.config.auditLogger,
      successStore,
      successExtractor,
    });
  }

  /** Stop the V2 runtime. Idempotent. */
  async stop(): Promise<void> {
    if (!this._runtime) return;
    await this._runtime.shutdown();
    this._runtime = null;
    await this.wechatHook.disconnect().catch(() => {});
    await this.qq.disconnect().catch(() => {});
  }

  // ── Task Queue ───────────────────────────────────────────────

  /** Enqueue a bot task to avoid "Run already active" conflicts with user chat */
  private _enqueueBotTask(fn: () => Promise<void>): void {
    this._taskQueue.push(fn);
    this._processTaskQueue();
  }

  private async _processTaskQueue(): Promise<void> {
    if (this._taskProcessing) return;
    this._taskProcessing = true;
    while (this._taskQueue.length > 0) {
      const task = this._taskQueue.shift()!;
      try { await task(); } catch { /* individual task errors handled internally */ }
    }
    this._taskProcessing = false;
  }

  // ── WeChat Hook Integration (WeChatFerry DLL injection) ────────

  /** Start WeChat Hook service (captures ALL messages via DLL injection). */
  async startWeChatHook(config: WeChatHookConfig): Promise<void> {
    this.config.wechatHook = config;
    this.wechatHook.onMessage(async (msg) => {
      // Group chat: only reply if @mentioned (nickname configured)
      if (msg.isGroup && config.nickname) {
        const atText = msg.text || '';
        const nick = config.nickname.replace(/^@/, '').trim();
        if (!nick || !atText.includes(`@${nick}`)) {
          return; // Skip group messages not mentioning the user
        }
      }
      this._enqueueBotTask(async () => {
        try {
          const sessionId = `wechat-hook:${msg.isGroup ? 'group' : 'friend'}:${msg.fromWxid}`;
          const result = await this.runTask(msg.text, 'desktop', sessionId);

          // Collect both sides of the conversation for style profiling
          this.profile.add(msg.text, 'wechat');
          if (result.result) this.profile.add(result.result, 'wechat');

          if (result.result) {
            if (msg.isGroup && msg.roomId) {
              // Group reply: send to roomId with @mention to the sender
              await this.wechatHook.sendMessage(msg.roomId, result.result, [msg.fromWxid]);
            } else {
              // Private reply: send to the sender's wxid
              await this.wechatHook.sendMessage(msg.fromWxid, result.result);
            }
          }
        } catch (e: unknown) {
          console.error('[WeChat-Hook] Error:', e instanceof Error ? e.message : String(e));
        }
      });
    });
    this.wechatHook.onStatusChange = (s) => {
      for (const fn of this._wcHookStatusListeners) fn(s);
    };
    await this.wechatHook.connect(config);
  }

  /** Stop WeChat Hook service. */
  async stopWeChatHook(): Promise<void> {
    this.wechatHook.onStatusChange = null;
    await this.wechatHook.disconnect();
  }

  // ── QQ OneBot Integration (NapCat + OneBot protocol) ─────────

  /** Start QQ OneBot service (connects to NapCat via OneBot WebSocket). */
  async startQQ(config: QQOneBotConfig): Promise<void> {
    this.config.qq = config;
    this.qq.onMessage(async (msg) => {
      // Group chat: only reply if @mentioned (nickname configured)
      if (msg.isGroup && config.nickname) {
        const atText = msg.text || '';
        const nick = config.nickname.replace(/^@/, '').trim();
        if (!nick || !atText.includes(`@${nick}`)) {
          return; // Skip group messages not mentioning the user
        }
      }
      this._enqueueBotTask(async () => {
        try {
          const sessionId = `qq:${msg.isGroup ? 'group' : 'friend'}:${msg.fromId}`;
          const result = await this.runTask(msg.text, 'desktop', sessionId);

          // Collect both sides of the conversation for style profiling
          this.profile.add(msg.text, 'qq');
          if (result.result) this.profile.add(result.result, 'qq');

          if (result.result) {
            await this.qq.sendMessage(msg.fromId, result.result, msg.isGroup);
          }
        } catch (e: unknown) {
          console.error('[QQ-OneBot] Error:', e instanceof Error ? e.message : String(e));
        }
      });
    });
    this.qq.onStatusChange = (s) => {
      for (const fn of this._qqStatusListeners) fn(s);
    };
    await this.qq.connect(config);
  }

  /** Stop QQ OneBot service. */
  async stopQQ(): Promise<void> {
    await this.qq.disconnect();
  }

  /** V1 panels subscribe here for live updates. */
  onEvent(fn: ConnectorEventListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onWeChatHookStatus(fn: (s: WeChatHookStatus) => void): () => void {
    this._wcHookStatusListeners.add(fn);
    return () => this._wcHookStatusListeners.delete(fn);
  }

  onQQStatus(fn: (s: QQOneBotStatus) => void): () => void {
    this._qqStatusListeners.add(fn);
    return () => this._qqStatusListeners.delete(fn);
  }

  async runMultiAgentTask(opts: RunMultiAgentTaskOptions): Promise<RunMultiAgentTaskResult> {
    if (!this._runtime) throw new Error('VSCodeConnector not started');
    const runtime = this._runtime;
    const sessionId = opts.sessionId ?? `ma-${Date.now()}`;

    // Cancel any previous user-initiated run to avoid resource contention.
    if (this._currentRunAbort) {
      this._currentRunAbort.abort();
      this._currentRunAbort = null;
    }
    const abortController = new AbortController();
    this._currentRunAbort = abortController;

    // Per-task registry: callers can register task-specific agents
    // (e.g. the chat agent) via opts.registerAgents. Falls back to the
    // runtime's pre-registered example agents.
    const registry = new AgentRegistry();
    (opts.registerAgents ?? registerExampleAgents)(registry);

    const guard = new BudgetGuard({
      perRunTokens: this.config.budget?.perRunTokens ?? 1_000_000,
      perRunUsd: this.config.budget?.perRunUsd ?? 5,
      perDayUsd: this.config.budget?.perDayUsd ?? 50,
    });

    // P1-1: if the caller requested a subset of agents, build a filtered
    // registry so the Orchestrator dispatches only those agents.
    let effectiveRegistry = registry;
    if (opts.agents && opts.agents.length > 0 && opts.agents.length < registry.list().length) {
      effectiveRegistry = new AgentRegistry();
      for (const name of opts.agents) {
        effectiveRegistry.register(registry.get(name));
      }
    }

    const { tracker, orchestrator: orch } = await runtime.createOrchestrator({
      task: opts.task,
      model: opts.model,
      sessionId,
      mode: opts.mode,
      maxAgentCalls: opts.maxAgentCalls ?? 8,
      initialState: opts.initialState,
      budgetGuard: guard,
      registry: effectiveRegistry,
      signal: abortController.signal,
    });

    this._runCounter++;
    this.emit({ type: 'runStart', runId: tracker.id, task: opts.task });

    let status: 'ok' | 'error' | 'cancelled' = 'ok';
    try {
      const result = await orch.run();
      await tracker.flush();
      await tracker.finish();
      status = result.status === 'success' ? 'ok' : 'error';
      this.emit({ type: 'runEnd', runId: tracker.id, status });

      let outputText: string | undefined;
      if (result.outputs && result.outputs.length > 0) {
        const first = result.outputs[0];
        if (first.ok && typeof first.output === 'string') {
          outputText = first.output;
        }
        if (first.ok && first.artifacts?.history) {
          this._conversationHistory = {
            [CHAT_HISTORY_KEY]: first.artifacts.history as Array<unknown>,
          };
        }
      }

      return { runId: tracker.id, result, outputText };
    } catch (e) {
      if ((e as Error).message === 'run cancelled' || abortController.signal.aborted) {
        status = 'cancelled';
      } else {
        status = 'error';
      }
      try { await tracker.flush(); await tracker.finish(); } catch { /* ignore */ }
      this.emit({ type: 'runEnd', runId: tracker.id, status });
      throw e;
    } finally {
      if (this._currentRunAbort === abortController) {
        this._currentRunAbort = null;
      }
    }
  }

  isReady(): boolean {
    return this._runtime !== null;
  }

  async runTask(task: string, _projectKey?: string, sessionId?: string, planningMode?: 'simple' | 'hierarchical' | 'auto'): Promise<{ runId: string; result?: string }> {
    const model = this.config.defaultModel ?? { provider: 'openai', name: 'gpt-4o' };
    const apiKey = this.config.apiKey;
    const apiEndpoint = this.config.apiEndpoint;
    const providerName = model.provider;

    let baseURL: string;
    if (apiEndpoint) {
      baseURL = apiEndpoint;
    } else {
      switch (providerName) {
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
      apiKey: apiKey ?? '',
      defaultModel: model.name,
      name: providerName,
    });

    // G6 wiring: connect optional MCP servers and expose their tools
    // alongside built-in tools.
    let mcpCleanup: (() => Promise<void>) | undefined;
    let mcpTools: ITool[] = [];
    if (this.config.mcpServers && this.config.mcpServers.length > 0) {
      try {
        this.emit({ type: 'progress', runId: '', phase: 'mcp', detail: 'Connecting MCP servers...' });
        const mcp = await connectMcpServers(this.config.mcpServers);
        mcpTools = mcp.tools;
        mcpCleanup = mcp.close;
        this.emit({ type: 'progress', runId: '', phase: 'mcp', detail: `Loaded ${mcp.tools.length} MCP tool(s)` });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.emit({ type: 'progress', runId: '', phase: 'mcp', detail: `MCP connection failed: ${msg}` });
      }
    }

    const registerAgents = (reg: AgentRegistry) => {
      const tracker = this._runtime?.trace.active();
      // G1 wiring: use createCodingAgentFromChat so the chat agent is
      // wrapped in the V2 CodingAgentLoop (agent.impl + tools.impl).
      // This gives the V2 Orchestrator a real Coding agent instead of
      // a bare chat agent, and exposes the chat tools via V2 IToolRegistry.
      // G4 wiring: pass runtime.memory so the chat agent shares the
      // runtime's MemoryManager (single provider + userId) instead of
      // creating its own.
      // P1-2 HITL: also wire the dry-run executor and audit logger into
      // ChatToolRegistry so direct V2 tool invocations cannot bypass the
      // confirmation gate / dry-run mode / audit trail.
      // G6 wiring: pass MCP tools into the agent loop and V2 registry.
      const dryRunExecutor = this.config.dryRun ? new DryRunExecutor() : undefined;
      // Load OpenClaw / Claude Code compatible skills from <projectDir>/.skills
      const skillRoot = this.config.projectDir || this.config.storageDir;
      const skillIndex = discoverChatSkills({ rootDir: skillRoot });
      const loop = createCodingAgentFromChat({
        extraTools: mcpTools,
        toolPolicy: this.config.toolPolicy,
        chatAgent: {
          llmProvider,
          projectDir: this.config.projectDir,
          profileDescription: this.profileEnabled ? (this.profile.profile?.description) : undefined,
          storageDir: this.config.storageDir,
          memoryManager: this._runtime?.memory,
          confirmationGate: this.config.confirmationGate,
          dryRun: this.config.dryRun,
          planningMode,
          skillIndex,
          onProgress: (phase, detail) => {
            this.emit({ type: 'progress', runId: '', phase, detail });
          },
          startSpan: (name, type, input) => {
            // Lazily resolve the active tracker when the span is actually
            // used. registerAgents runs before runtime.createOrchestrator()
            // starts the run, so tracker is null at construction time.
            let span: ReturnType<NonNullable<RunTracker['startSpan']>> | undefined;
            const getSpan = () => {
              if (!span) {
                span = this._runtime?.trace.active()?.startSpan({ name, type: type as any, input });
              }
              return span;
            };
            return {
              end: (output) => { const s = getSpan(); s?.setOutput(output); s?.end(); },
              fail: (err) => { const s = getSpan(); s?.fail(TraceManager.errorOf(err)); },
              addEvent: (name) => { const s = getSpan(); s?.addEvent(name); },
            };
          },
        },
        defaultModel: model,
        confirmationGate: this.config.confirmationGate,
        dryRunExecutor,
        auditLogger: this.config.auditLogger ?? this._runtime?.auditLogger,
        runId: '',
        userId: 'desktop-user',
      });
      reg.register(loop.asIAgent());

      // P1-1: register any additional agents supplied by the host
      // (e.g. Browser agent from the desktop app) so they can participate
      // in task routing without adding heavy/optional deps to this package.
      const extraAgents = (this.config.agentFactories ?? []).map((factory) =>
        factory({ llmProvider, model, config: this.config }),
      );
      for (const agent of extraAgents) {
        reg.register(agent);
      }
    };

    // P1-1: route the user task to the most appropriate registered agent(s).
    const routingRegistry = new AgentRegistry();
    registerAgents(routingRegistry);
    const localEmbedding = createLocalEmbeddingProvider();
    const selectedAgents = await selectAgentsForTask(routingRegistry, task, model, {
      embeddingProvider: localEmbedding,
    });
    this.emit({ type: 'progress', runId: '', phase: 'routing', detail: `Dispatching to: ${selectedAgents.join(', ')}` });

    const cacheKey = `${model.provider}:${model.name}|${selectedAgents.join(',')}|${task}`;
    if (shouldCacheTask(task)) {
      const cached = this._resultCache.get(cacheKey);
      if (cached) {
        this.emit({ type: 'progress', runId: cached.runId, phase: 'cache', detail: 'Returning cached result' });
        return { runId: cached.runId, result: cached.outputText };
      }
    }

    try {
      const fullResult = await this.runMultiAgentTask({
        task,
        mode: (selectedAgents.length > 1 ? 'dag' : 'sequential') as OrchestratorMode,
        model,
        registerAgents,
        agents: selectedAgents,
        maxAgentCalls: selectedAgents.length,
        initialState: this._conversationHistory,
        sessionId,
      });

      if (shouldCacheTask(task) && fullResult.result.status === 'success') {
        this._resultCache.set(cacheKey, fullResult);
      }

      return { runId: fullResult.runId, result: fullResult.outputText };
    } finally {
      if (mcpCleanup) {
        await mcpCleanup().catch(() => {});
      }
    }
  }

  trace(): TraceManager | null {
    return this._runtime?.trace ?? null;
  }

  store(): Store | null {
    return this._runtime?.store ?? null;
  }

  /** The runtime's shared MemoryManager (G4 aggregated). Null before start(). */
  memory(): MemoryManager | null {
    return this._runtime?.memory ?? null;
  }

  auditLogger(): AuditLogger | null {
    return this._runtime?.auditLogger ?? null;
  }

  /**
   * Run the evolution engine over recent failed runs and emit a
   * 'evolutionReport' event if recurring failures are found.
   */
  async runEvolution(windowMs?: number): Promise<EvolutionReport | null> {
    if (!this._runtime) throw new Error('VSCodeConnector not started');
    const report = await this._runtime.evolution.generate({ windowMs });
    this.emit({ type: 'evolutionReport', reportId: `evo-${Date.now()}`, readyToApply: report.readyToApply });
    return report;
  }

  /**
   * Run a skill auto-discovery sweep over recent failure cases.
   * Proposed candidates are enqueued for human review.
   */
  async runSkillDiscovery(cfg?: { windowMs?: number; minOccurrences?: number }): Promise<AutoDiscoveryReport | null> {
    if (!this._runtime) throw new Error('VSCodeConnector not started');
    return this._runtime.skillDiscovery.discover(cfg);
  }

  /**
   * Run a success-driven skill discovery sweep over History/*.md.
   * Conversations that required user corrections before succeeding are
   * summarized into workflow skill candidates and durable user facts.
   */
  async runSuccessSkillDiscovery(cfg?: { historyDir?: string; minTurns?: number }): Promise<{ candidates: number; facts: number }> {
    if (!this._runtime) throw new Error('VSCodeConnector not started');
    const report = await this._runtime.skillDiscovery.discover({
      source: 'success',
      successMinTurns: cfg?.minTurns ?? 4,
    });
    return {
      candidates: report.proposedCandidates.length,
      facts: report.discoveredFacts?.length ?? 0,
    };
  }

  async listSkillCandidates(): Promise<CandidateSkill[]> {
    if (!this._runtime) throw new Error('VSCodeConnector not started');
    return this._runtime.skillReviewQueue.listPending();
  }

  async approveSkillCandidate(id: string, note?: string): Promise<CandidateSkill> {
    if (!this._runtime) throw new Error('VSCodeConnector not started');
    return this._runtime.skillReviewQueue.approve(id, { reviewer: 'user', note });
  }

  async rejectSkillCandidate(id: string, note?: string): Promise<CandidateSkill> {
    if (!this._runtime) throw new Error('VSCodeConnector not started');
    return this._runtime.skillReviewQueue.reject(id, { reviewer: 'user', note });
  }

  private emit(e: ConnectorEvent): void {
    for (const l of this.listeners) {
      try { l(e); } catch { /* swallow */ }
    }
  }
}

// ── AssistantRuntime façade ──────────────────────────────────────────

import { RUNTIME_VERSION } from '@z-assistant/runtime';

export interface AssistantRuntimeBootOptions {
  storageDir: string;
  projectKey?: string;
  /** Optional user id for memory defaults; defaults to 'local'. */
  userId?: string;
  /** Optional agent registrar; defaults to `registerExampleAgents`. */
  registerAgents?: (registry: AgentRegistry) => void;
  /** Optional shared audit logger. If omitted, one is created automatically. */
  auditLogger?: AuditLogger;
  /** Optional success case store for F-1 success-driven skill discovery. */
  successStore?: import('@z-assistant/contracts').ISuccessCaseStore;
  /** Optional success skill extractor for F-1. */
  successExtractor?: import('@z-assistant/contracts').ISuccessSkillExtractor;
}

/**
 * Aggregated V2 Runtime. Boot creates real instances of every core
 * subsystem — Trace, Store, Memory, AgentRegistry — so callers have a
 * single entry point instead of wiring each one manually.
 *
 * The Orchestrator is per-task (it takes a task + model + sessionId),
 * so use `createOrchestrator()` to get one wired to this runtime's
 * registry + trace.
 */
export class AssistantRuntime {
  static readonly RUNTIME_VERSION = RUNTIME_VERSION;

  readonly memory: MemoryManager;
  readonly registry: AgentRegistry;
  readonly evolution: EvolutionEngine;
  readonly skillDiscovery: AutoDiscoveryEngine;
  readonly skillReviewQueue: JsonFileSkillReviewQueue;
  readonly auditLogger: AuditLogger;
  private scheduler?: BackgroundScheduler;

  private constructor(
    public readonly trace: TraceManager,
    public readonly store: Store,
    memory: MemoryManager,
    registry: AgentRegistry,
    evolution: EvolutionEngine,
    skillDiscovery: AutoDiscoveryEngine,
    skillReviewQueue: JsonFileSkillReviewQueue,
    auditLogger: AuditLogger,
  ) {
    this.memory = memory;
    this.registry = registry;
    this.evolution = evolution;
    this.skillDiscovery = skillDiscovery;
    this.skillReviewQueue = skillReviewQueue;
    this.auditLogger = auditLogger;
  }

  static async boot(opts: AssistantRuntimeBootOptions): Promise<AssistantRuntime> {
    const dataDir = opts.storageDir;
    const tracesDir = path.join(dataDir, 'traces');
    await fs.mkdir(tracesDir, { recursive: true });

    // Mechanism layer: storage + trace.
    const store = await createFileStore({ rootDir: dataDir });
    const trace = new TraceManager({ store, tracesDir });

    // Framework layer: memory (JsonlMemoryProvider over the storage dir).
    // userId 'desktop-user' matches the existing chat-agent + runtime-bridge
    // convention so all memory access paths share the same user scope.
    const memoryProvider = new JsonlMemoryProvider({ rootDir: dataDir });
    const memory = new MemoryManager({
      provider: memoryProvider,
      userId: opts.userId ?? 'desktop-user',
      agentName: 'runtime',
    });

    // Framework layer: agent registry (pre-registered with example agents
    // unless the caller supplies a custom registrar).
    const registry = new AgentRegistry();
    (opts.registerAgents ?? registerExampleAgents)(registry);

    // Framework layer: evolution + skill auto-discovery. Wired to the same
    // store and storage dir so they are usable by callers instead of sitting
    // unused.
    const evolution = new EvolutionEngine(store, trace);
    const failureStore = new JsonlFailureCaseStore({ rootDir: dataDir });
    const reviewQueue = new JsonFileSkillReviewQueue({ rootDir: dataDir });
    const extractor = new TemplateSkillExtractor();
    const skillDiscovery = new AutoDiscoveryEngine({
      failureStore,
      extractor,
      reviewQueue,
      successStore: opts.successStore,
      successExtractor: opts.successExtractor,
    });

    // P1-2 HITL: shared audit logger. Sub-systems that need auditing should
    // use this instance so the background scheduler can observe failures.
    const auditLogger = opts.auditLogger ?? new AuditLogger({ rootDir: dataDir });

    const runtime = new AssistantRuntime(trace, store, memory, registry, evolution, skillDiscovery, reviewQueue, auditLogger);

    // Phase 5: background evolution scheduler observes audit failures and
    // automatically triggers evolution + skill discovery when thresholds are met.
    runtime.scheduler = new BackgroundScheduler({
      auditLogger,
      evolution,
      skillDiscovery,
      reviewQueue,
      failureThreshold: 2,
      cooldownMs: 5 * 60 * 1000,
    });
    runtime.scheduler.start();

    return runtime;
  }

  /**
   * Create a per-task Orchestrator wired to this runtime's trace.
   *
   * Starts a new Run on the trace, then returns the Orchestrator ready
   * to `.run()`. The caller is responsible for `tracker.flush()` +
   * `tracker.finish()` after the orchestrator completes (or fails).
   *
   * By default the orchestrator uses `this.registry` (the runtime's
   * shared registry, pre-registered with example agents). Pass
   * `registry` to use a per-task registry instead (e.g. when the
   * caller needs to register task-specific agents like the chat agent).
   */
  async createOrchestrator(opts: {
    task: string;
    model: { provider: string; name: string };
    sessionId?: string;
    mode?: OrchestratorMode;
    maxAgentCalls?: number;
    initialState?: Record<string, unknown>;
    budgetGuard?: BudgetGuard;
    /** Optional per-task registry; defaults to this.registry. */
    registry?: AgentRegistry;
    /** Optional abort signal to cancel the run. */
    signal?: AbortSignal;
  }): Promise<{ tracker: RunTracker; orchestrator: Orchestrator }> {
    const sessionId = opts.sessionId ?? `run-${Date.now()}`;
    const tracker = await this.trace.startRun({
      task: opts.task,
      model: opts.model,
      sessionId,
      userId: 'local',
    });
    const orchestrator = new Orchestrator({
      tracker,
      registry: opts.registry ?? this.registry,
      task: opts.task,
      model: opts.model,
      sessionId,
      mode: opts.mode,
      maxAgentCalls: opts.maxAgentCalls,
      initialState: opts.initialState,
      budgetGuard: opts.budgetGuard,
      signal: opts.signal,
    });
    return { tracker, orchestrator };
  }

  async shutdown(): Promise<void> {
    this.scheduler?.stop();
    // Close the storage backend and memory provider to release file handles.
    await this.store.close();
    await this.memory.provider.close();
  }
}

// ── Public exports ────────────────────────────────────────────────────

export { RUNTIME_VERSION };
export type { AgentResult, Store, TraceManager, OrchestratorMode, OrchestratorResult };
export { createCodingAgentFromChat, ChatToolRegistry };
export type { CodingAgentFactoryOptions };
export { webSearch, webSearchResults, webFetch, getLocation } from './web-tools';
export type { SearchResult } from './web-tools';
export { connectMcpServer, connectMcpServers } from './mcp-tools';
export type { McpServerConfig, ConnectedMcpServer } from './mcp-tools';

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
  type OrchestratorMode,
  type OrchestratorResult,
} from '@z-assistant/runtime';
import { TraceManager } from '@z-assistant/trace';
import { createFileStore } from '@z-assistant/infra-storage';
import { BudgetGuard } from '@z-assistant/infra-cost';

import type { Store } from '@z-assistant/infra-storage';
import type { AgentResult } from '@z-assistant/contracts';

import { OpenAIProvider } from './llm-provider';
import { createChatAgent, CHAT_HISTORY_KEY } from './chat-agent';
import { ChatProfile, StyleProfile } from './chat-profile';
import { WeChatHookService, type WeChatHookConfig, type WeChatHookStatus } from './wechat-hook-service';
import { QQOneBotService, type QQOneBotConfig, type QQOneBotStatus } from './qq-onebot-service';

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
  /** WeChat Hook configuration (optional) — uses WeChatFerry DLL injection for full message access. */
  wechatHook?: WeChatHookConfig;
  /** QQ OneBot configuration (optional) — connects to NapCat via OneBot protocol. */
  qq?: QQOneBotConfig;
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

  /** Wire the V2 runtime. Idempotent. */
  async start(): Promise<void> {
    if (this._runtime) return;
    this._runtime = await AssistantRuntime.boot({
      storageDir: this.config.storageDir,
      projectKey: this.config.projectKey,
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

    const tracker = await runtime.trace.startRun({
      task: opts.task,
      model: opts.model,
      sessionId,
      userId: 'local',
    });

    const registry = new AgentRegistry();
    (opts.registerAgents ?? registerExampleAgents)(registry);

    const guard = new BudgetGuard({
      perRunTokens: this.config.budget?.perRunTokens ?? 1_000_000,
      perRunUsd: this.config.budget?.perRunUsd ?? 5,
      perDayUsd: this.config.budget?.perDayUsd ?? 50,
    });

    const orch = new Orchestrator({
      tracker,
      registry,
      task: opts.task,
      model: opts.model,
      sessionId,
      mode: opts.mode,
      budgetGuard: guard,
      maxAgentCalls: opts.maxAgentCalls ?? 8,
      initialState: opts.initialState,
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
      status = 'error';
      try { await tracker.flush(); await tracker.finish(); } catch { /* ignore */ }
      this.emit({ type: 'runEnd', runId: tracker.id, status });
      throw e;
    }
  }

  isReady(): boolean {
    return this._runtime !== null;
  }

  async runTask(task: string, _projectKey?: string, sessionId?: string): Promise<{ runId: string; result?: string }> {
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

    const registerChatAgent = (reg: AgentRegistry) => {
      const tracker = this._runtime?.trace.active();
      reg.register(createChatAgent({
        llmProvider,
        projectDir: this.config.projectDir,
        profileDescription: this.profileEnabled ? (this.profile.profile?.description) : undefined,
        storageDir: this.config.storageDir,
        onProgress: (phase, detail) => {
          this.emit({ type: 'progress', runId: '', phase, detail });
        },
        startSpan: (name, type, input) => {
          const span = tracker?.startSpan({ name, type: type as any, input });
          return {
            end: (output) => { span?.setOutput(output); span?.end(); },
            fail: (err) => { span?.fail(TraceManager.errorOf(err)); },
            addEvent: (name) => { span?.addEvent(name); },
          };
        },
      }));
    };

    const fullResult = await this.runMultiAgentTask({
      task,
      mode: 'sequential' as OrchestratorMode,
      model,
      registerAgents: registerChatAgent,
      maxAgentCalls: 1,
      initialState: this._conversationHistory,
      sessionId,
    });

    return { runId: fullResult.runId, result: fullResult.outputText };
  }

  trace(): TraceManager | null {
    return this._runtime?.trace ?? null;
  }

  store(): Store | null {
    return this._runtime?.store ?? null;
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
}

export class AssistantRuntime {
  static readonly RUNTIME_VERSION = RUNTIME_VERSION;

  private constructor(
    public readonly trace: TraceManager,
    public readonly store: Store,
  ) {}

  static async boot(opts: AssistantRuntimeBootOptions): Promise<AssistantRuntime> {
    const dataDir = opts.storageDir;
    const tracesDir = path.join(dataDir, 'traces');
    await fs.mkdir(tracesDir, { recursive: true });
    const store = await createFileStore({ rootDir: dataDir });
    const trace = new TraceManager({ store, tracesDir });
    return new AssistantRuntime(trace, store);
  }

  async shutdown(): Promise<void> {
    // Trace events are flushed per-tracker; FileStore has no global handle.
  }
}

// ── Public exports ────────────────────────────────────────────────────

export { RUNTIME_VERSION };
export type { AgentResult, Store, TraceManager, OrchestratorMode, OrchestratorResult };

// LocalRuntimeBridge
//
// Full local runtime running entirely on the device. Bundles:
// - MemoryManager (IndexedDB)
// - LLMProvider (direct API call)
// - Orchestrator (multi-round tool calling)
// - ToolRegistry (built-in)
// - SKILL system (from bundled SKILL.md files, sharing desktop's
//   skill framework from @ziner/runtime/skills)
// - MCP client (using @modelcontextprotocol/sdk, same as desktop)

import type {
  AppSettings,
  BridgeEventListener,
  BridgeEventType,
  ChatMessage,
  MemoryRecord,
  MemoryListFilter,
  MobileRuntimeBridge,
  BridgeStatus,
  BridgeEvent,
  ChatRunOptions,
  CheckpointSummary,
  CheckpointDetail,
} from './types';
import {
  MemoryManager,
  LLMProvider,
  connectMcpServers,
  getTraceLogger,
  createMobileToolRegistry,
  MobileSessionManager,
  MobileCheckpointStore,
  type MemoryRecord as RuntimeMemoryRecord,
  type McpServerConfig as McpCfg,
  type MobileNativeBridge,
  type MobileTool,
  type TraceSpan,
} from '@ziner/platform-web';
import { getNativeCapabilities } from '../native';
import { Orchestrator } from '../runtime/orchestrator';
import type { ToolRegistry as MobileToolRegistryShape } from '../runtime/tools';
import { SkillRegistry } from '../runtime/skill-registry';

/** Combine an external AbortSignal with an internal one. */
function combineSignals(external?: AbortSignal, internal?: AbortSignal): AbortSignal {
  if (!external && !internal) return new AbortController().signal;
  if (!external) return internal!;
  if (!internal) return external;
  if (external.aborted) return external;
  if (internal.aborted) return internal;
  if (typeof AbortSignal !== 'undefined' && 'any' in AbortSignal && typeof AbortSignal.any === 'function') {
    return AbortSignal.any([external, internal]);
  }
  // Fallback for older runtimes (Capacitor Android webviews).
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  external.addEventListener('abort', onAbort, { once: true });
  internal.addEventListener('abort', onAbort, { once: true });
  return controller.signal;
}

export class LocalRuntimeBridge implements MobileRuntimeBridge {
  private settings: AppSettings | null = null;
  private memory: MemoryManager | null = null;
  private provider: LLMProvider | null = null;
  private orchestrator: Orchestrator | null = null;
  private skills: SkillRegistry | null = null;
  private mcpCleanup: (() => Promise<void>) | null = null;
  private mcpConnected: string[] = [];
  private listeners = new Map<BridgeEventType, Set<BridgeEventListener>>();
  private msgCounter = 0;
  private conversations = new Map<string, ChatMessage[]>();
  private sessionStore: MobileSessionManager | null = null;
  private checkpointStore: MobileCheckpointStore | null = null;
  private runAbortController: AbortController | null = null;

  readonly status: BridgeStatus = {
    connected: false,
    backend: 'local',
    version: 'local-runtime',
  };

  async init(settings: AppSettings): Promise<void> {
    this.settings = settings;
    const api = this.getActiveApi();

    // Always init memory (independent of API)
    this.memory = new MemoryManager({ userId: 'default' });
    await this.memory.init();

    this.sessionStore = new MobileSessionManager();
    this.checkpointStore = new MobileCheckpointStore();

    // Load bundled skills
    this.skills = new SkillRegistry({ maxInjected: 3 });

    if (!api) {
      this.status.connected = false;
      this.status.reason = '未配置 API';
      this.emit('status', this.status);
      return;
    }

    this.provider = new LLMProvider({ api });
    const policy = settings.toolPolicy ?? { allow: [], deny: [] };

    let mcpTools: MobileTool[] = [];
    try {
      const cfgs = this.getEnabledMcpServers();
      if (cfgs.length > 0) {
        const mcpResult = await connectMcpServers(cfgs, policy);
        mcpTools = mcpResult.tools;
        this.mcpCleanup = mcpResult.close;
        this.mcpConnected = cfgs.map((c) => c.name);
      }
    } catch (e) {
      console.warn('[LocalRuntimeBridge] MCP init failed:', e);
    }

    const native = this.createMobileNativeBridge();
    const registry = createMobileToolRegistry({ memory: this.memory, native, mcpTools });
    const tools = registry as unknown as MobileToolRegistryShape;

    try {
      const { isToolAllowed } = await import('@ziner/contracts');
      const all = tools.list();
      for (const t of all) {
        if (!isToolAllowed(policy, t.definition.function.name)) {
          tools.remove(t.definition.function.name);
        }
      }
    } catch (e) {
      console.warn('[LocalRuntimeBridge] Tool policy filter failed:', e);
    }

    this.orchestrator = new Orchestrator({
      provider: this.provider,
      memory: this.memory,
      tools,
      checkpointStore: this.checkpointStore,
      // Will be set per-run via getSystemPromptAddition
    });

    this.status.connected = true;
    this.status.reason = undefined;
    this.emit('status', this.status);
  }

  private createMobileNativeBridge(): MobileNativeBridge {
    const caps = getNativeCapabilities();
    return {
      requestNotificationPermission: () => caps.requestNotificationPermission(),
      scheduleNotification: (input) => caps.scheduleNotification({
        id: input.id,
        title: input.title,
        body: input.body,
      }),
      copyToClipboard: (text) => caps.copyToClipboard(text),
      vibrate: (style) => caps.vibrate({ style }),
      writeFile: (input) => caps.writeFile({
        path: input.path,
        data: input.content,
        directory: (input.directory as 'Data' | 'Documents' | 'Cache' | 'External' | 'ExternalStorage') ?? 'Documents',
      }),
      readFile: (path, directory) => caps.readFile(path, directory as 'Data' | 'Documents' | 'Cache' | 'External' | 'ExternalStorage' | undefined),
    };
  }

  async close(): Promise<void> {
    this.status.connected = false;
    this.orchestrator = null;
    this.provider = null;
    if (this.mcpCleanup) {
      try { await this.mcpCleanup(); } catch { /* ignore */ }
      this.mcpCleanup = null;
    }
    this.mcpConnected = [];
    this.emit('status', this.status);
  }

  // ── Chat ──────────────────────────────────────────────────────

  async sendChat(
    message: string,
    conversationId?: string,
    options?: ChatRunOptions,
  ): Promise<ChatMessage> {
    if (!this.orchestrator) {
      throw new Error('Runtime not initialized. Configure an API in settings.');
    }
    const sessionId = conversationId ?? 'default';
    const skills = this.skills?.selectFor(message);
    const skillIds = skills?.map((s) => s.skill.id);

    const trace = getTraceLogger();
    const runId = trace.startRun({
      sessionId,
      userMessage: message,
      skills: skillIds,
      mcpServers: this.mcpConnected,
    });

    this.runAbortController = new AbortController();

    try {
      const mode = this.resolvePlanMode(options?.mode);
      const resumeFrom = options?.resumeFromRunId && this.checkpointStore
        ? (await this.checkpointStore.load(options.resumeFromRunId)) ?? undefined
        : undefined;
      const result = await this.orchestrator.run(message, {
        sessionId,
        mode,
        signal: this.runAbortController.signal,
        systemPromptAddition: skills ? this.buildSkillPromptAddition(skills) : undefined,
        onToolCall: (name, args, toolResult) => {
          this.recordToolSpan(name, args, toolResult);
        },
        resumeFrom,
        runId,
      });
      await trace.endRun({ assistantMessage: result.content });
      this.persistTurn(sessionId, message, result.content);
      return this.toChatMessage(result.content);
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      await trace.endRun({ assistantMessage: '', error: err });
      throw e;
    } finally {
      this.runAbortController = null;
    }
  }

  async streamChat(
    message: string,
    conversationId: string | undefined,
    onChunk: (delta: string, fullMessage: string) => void,
    signal?: AbortSignal,
    options?: ChatRunOptions,
  ): Promise<ChatMessage> {
    if (!this.orchestrator) {
      throw new Error('Runtime not initialized. Configure an API in settings.');
    }
    // Bail out early if already aborted before starting any work.
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    const sessionId = conversationId ?? 'default';
    const skills = this.skills?.selectFor(message);
    const skillIds = skills?.map((s) => s.skill.id);

    const trace = getTraceLogger();
    const runId = trace.startRun({
      sessionId,
      userMessage: message,
      skills: skillIds,
      mcpServers: this.mcpConnected,
    });

    // Record a streaming LLM span
    const llmSpan = trace.recordSpan({
      type: 'llm',
      name: 'stream_chat',
      status: 'pending',
      metadata: { model: this.settings?.defaultModel?.name },
    });

    this.runAbortController = new AbortController();
    const combined = combineSignals(signal, this.runAbortController.signal);

    try {
      let fullMessage = '';
      const mode = this.resolvePlanMode(options?.mode);
      const resumeFrom = options?.resumeFromRunId && this.checkpointStore
        ? (await this.checkpointStore.load(options.resumeFromRunId)) ?? undefined
        : undefined;
      const result = await this.orchestrator.run(message, {
        sessionId,
        mode,
        stream: true,
        signal: combined,
        onChunk: async (delta) => {
          fullMessage += delta;
          onChunk(delta, fullMessage);
        },
        onToolCall: (name, args, toolResult) => {
          this.recordToolSpan(name, args, toolResult);
        },
        systemPromptAddition: skills ? this.buildSkillPromptAddition(skills) : undefined,
        resumeFrom,
        runId,
      });
      // Mark LLM span as done
      await llmSpan.end(result.content);
      await trace.endRun({ assistantMessage: result.content });
      this.persistTurn(sessionId, message, result.content);
      return this.toChatMessage(result.content);
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      await llmSpan.end(undefined, err);
      await trace.endRun({ assistantMessage: '', error: err });
      throw e;
    } finally {
      this.runAbortController = null;
    }
  }

  cancelRun(): boolean {
    if (this.runAbortController) {
      this.runAbortController.abort('User cancellation');
      this.runAbortController = null;
      return true;
    }
    return false;
  }

  /** Record a tool-call span into the active run. */
  private recordToolSpan(name: string, args: unknown, result: { success: boolean; output: string; error?: string }): void {
    const trace = getTraceLogger();
    const span = trace.recordSpan({
      type: 'tool',
      name,
      status: result.success ? 'ok' : 'error',
      input: args,
      output: result.output,
      error: result.error,
    });
    // Fire-and-forget end; span gets ended by the time the tool is done
    void span.end(result.output, result.error);
  }

  async getChatHistory(conversationId?: string): Promise<ChatMessage[]> {
    const id = conversationId ?? 'default';
    if (this.sessionStore) {
      const session = this.sessionStore.get(id);
      if (session) {
        return session.messages.map((m) => this.mobileMessageToChatMessage(m));
      }
      return [];
    }
    return this.conversations.get(id) ?? [];
  }

  async listSessions(): Promise<import('./types').ChatSessionSummary[]> {
    if (this.sessionStore) {
      return this.sessionStore.list().map((s) => this.mobileSessionToSummary(s));
    }
    return [];
  }

  async createSession(title?: string): Promise<import('./types').ChatSessionSummary> {
    if (!this.sessionStore) {
      throw new Error('Session store not initialized');
    }
    const created = this.sessionStore.create({ title });
    return this.mobileSessionToSummary(created);
  }

  async deleteSession(id: string): Promise<boolean> {
    return this.sessionStore?.delete(id) ?? false;
  }

  async renameSession(id: string, title: string): Promise<void> {
    this.sessionStore?.rename(id, title);
  }

  async archiveSession(id: string, archived: boolean): Promise<void> {
    if (archived) this.sessionStore?.archive(id);
    else this.sessionStore?.unarchive(id);
  }

  async searchSessions(query: string, limit = 50): Promise<import('./types').ChatSessionSummary[]> {
    if (!this.sessionStore) return [];
    return this.sessionStore.search({ query, limit }).map((s) => this.mobileSessionToSummary(s));
  }

  async exportSession(id: string, format: 'json' | 'markdown'): Promise<string> {
    const session = this.sessionStore?.get(id);
    if (!session) throw new Error('Session not found');

    if (format === 'json') {
      return JSON.stringify(
        {
          id: session.id,
          title: session.title,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          messageCount: session.messages.length,
          messages: session.messages,
          tags: session.tags,
        },
        null,
        2,
      );
    }

    const lines: string[] = [];
    lines.push(`# ${session.title}`);
    lines.push('');
    lines.push(`> 导出时间：${new Date().toLocaleString()}`);
    lines.push(`> 消息数：${session.messages.length}`);
    lines.push('');
    lines.push('---');
    lines.push('');

    for (const msg of session.messages) {
      const role = msg.role === 'user' ? '**用户**' : '**助手**';
      const time = new Date(msg.timestamp).toLocaleString();
      lines.push(`${role} · ${time}`);
      lines.push('');
      lines.push(msg.content);
      lines.push('');
      lines.push('---');
      lines.push('');
    }

    return lines.join('\n');
  }

  async exportMemories(): Promise<string> {
    const memories = await this.listMemories();
    return JSON.stringify(
      {
        exportedAt: Date.now(),
        count: memories.length,
        memories,
      },
      null,
      2,
    );
  }

  private mobileSessionToSummary(s: import('@ziner/platform-web').MobileChatSession): import('./types').ChatSessionSummary {
    const last = s.messages[s.messages.length - 1];
    return {
      id: s.id,
      title: s.title,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      messageCount: s.messages.length,
      preview: last?.content.slice(0, 160),
      tags: s.tags,
      archived: s.archived,
    };
  }

  private mobileMessageToChatMessage(m: import('@ziner/platform-web').MobileChatMessage): ChatMessage {
    return {
      id: `${m.timestamp}-${Math.random().toString(36).slice(2, 6)}`,
      role: m.role,
      content: m.content,
      createdAt: m.timestamp,
    };
  }

  private persistTurn(sessionId: string, userContent: string, assistantContent: string): void {
    if (!this.sessionStore) return;
    let session = this.sessionStore.get(sessionId);
    if (!session) {
      session = this.sessionStore.create({ title: userContent.slice(0, 60) });
    }
    const now = Date.now();
    this.sessionStore.appendMessage(session.id, { role: 'user', content: userContent, timestamp: now });
    this.sessionStore.appendMessage(session.id, { role: 'assistant', content: assistantContent, timestamp: now });
  }

  // ── Memory ────────────────────────────────────────────────────

  async listMemories(filter?: MemoryListFilter): Promise<MemoryRecord[]> {
    if (!this.memory) return [];
    const runtime = await this.memory.list({
      kind: filter?.kind as any,
      limit: filter?.limit,
      offset: filter?.offset,
    });
    return runtime.map(this.toMemoryRecord);
  }

  async searchMemories(query: string, limit?: number): Promise<MemoryRecord[]> {
    if (!this.memory) return [];
    const results = await this.memory.recall({ query, limit });
    return results.map((r) => this.toMemoryRecord(r.memory));
  }

  async addMemory(content: string, kind?: MemoryRecord['kind']): Promise<MemoryRecord> {
    if (!this.memory) throw new Error('Memory not initialized');
    const mem = await this.memory.remember(content, (kind as any) ?? 'long-term', 'user');
    this.emit('memoryUpdated', { memory: this.toMemoryRecord(mem) });
    return this.toMemoryRecord(mem);
  }

  async deleteMemory(id: string): Promise<void> {
    if (!this.memory) return;
    await this.memory.forget(id);
    this.emit('memoryUpdated', { id });
  }

  // ── Trace ──────────────────────────────────────────────────────

  async listTraceRuns(limit = 50, sessionId?: string) {
    const trace = getTraceLogger();
    const runs = await trace.listRuns(limit, sessionId);
    return runs.map((r) => ({
      id: r.id,
      sessionId: r.sessionId,
      userMessage: r.userMessage,
      assistantMessage: r.assistantMessage,
      startTime: r.startTime,
      durationMs: r.durationMs,
      status: r.status,
      llmCalls: r.metrics?.llmCalls ?? 0,
      toolCalls: r.metrics?.toolCalls ?? 0,
      totalTokens: r.metrics?.totalTokens,
      skills: r.skills,
      mcpServers: r.mcpServers,
    }));
  }

  async getTraceRun(id: string) {
    const trace = getTraceLogger();
    const r = await trace.getRun(id);
    if (!r) return undefined;
    return {
      id: r.id,
      sessionId: r.sessionId,
      userMessage: r.userMessage,
      assistantMessage: r.assistantMessage,
      startTime: r.startTime,
      endTime: r.endTime,
      durationMs: r.durationMs,
      status: r.status,
      llmCalls: r.metrics?.llmCalls ?? 0,
      toolCalls: r.metrics?.toolCalls ?? 0,
      totalTokens: r.metrics?.totalTokens,
      skills: r.skills,
      mcpServers: r.mcpServers,
      error: r.error,
      spans: r.spans,
    };
  }

  async listTraceSessions(limit = 50) {
    return getTraceLogger().listSessions(limit);
  }

  async deleteTraceRun(id: string) {
    await getTraceLogger().deleteRun(id);
  }

  async clearTrace() {
    await getTraceLogger().clearAll();
  }

  // ── Events ────────────────────────────────────────────────────

  addEventListener(type: BridgeEventType, listener: BridgeEventListener): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }

  removeEventListener(type: BridgeEventType, listener: BridgeEventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  /** Ping the active API to check connectivity. */
  async pingApi(): Promise<{ ok: boolean; latencyMs: number; reason?: string }> {
    if (!this.provider) {
      return { ok: false, latencyMs: 0, reason: 'Provider not initialized' };
    }
    return this.provider.ping();
  }

  /** Get a list of available bundled skills. */
  getSkills(): { id: string; name: string; description?: string; tags: string[] }[] {
    return (this.skills?.listSkills() ?? []).map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      tags: s.tags,
    }));
  }

  /** Get list of connected MCP servers. */
  getMcpServers(): string[] {
    return this.mcpConnected;
  }

  // ── Helpers ───────────────────────────────────────────────────

  private getActiveApi() {
    if (!this.settings) return undefined;
    const { defaultModel, apiKey, apiEndpoint } = this.settings;
    if (!apiKey && !apiEndpoint) return undefined;
    return {
      id: 'default',
      name: defaultModel?.provider || 'default',
      endpoint: apiEndpoint || '',
      apiKey: apiKey || '',
      model: defaultModel?.name || 'default',
      enabled: true,
    };
  }

  private getEnabledMcpServers(): McpCfg[] {
    if (!this.settings) return [];
    const servers: McpCfg[] = [];
    const { mcdMcpToken, amapApiKey } = this.settings;

    // McDonald's China MCP
    if (mcdMcpToken) {
      servers.push({
        name: 'mcd',
        url: 'https://mcp.api-inference.modelscope.cn/@modelscope/mcdonalds-china-mcp',
        transport: 'streamablehttp',
        headers: { Authorization: `Bearer ${mcdMcpToken}` },
        timeoutMs: 15_000,
      });
    }

    // AMap (Gaode) Maps MCP
    if (amapApiKey) {
      servers.push({
        name: 'amap',
        url: 'https://mcp.api-inference.modelscope.cn/@modelscope/amap-maps-mcp',
        transport: 'streamablehttp',
        headers: { 'amap-key': amapApiKey },
        timeoutMs: 15_000,
      });
    }

    return servers;
  }

  private buildSkillPromptAddition(selected: { skill: { name: string; content: string } }[]): string {
    if (selected.length === 0) return '';
    return selected
      .map((s) => `# 技能：${s.skill.name}\n\n${s.skill.content}`)
      .join('\n\n---\n\n');
  }

  private toChatMessage(content: string): ChatMessage {
    return {
      id: `msg-${++this.msgCounter}`,
      role: 'assistant',
      content,
      createdAt: Date.now(),
    };
  }

  private toMemoryRecord(m: RuntimeMemoryRecord): MemoryRecord {
    return {
      id: m.id,
      content: m.content,
      kind: (m.kind as MemoryRecord['kind']) || 'long-term',
      scope: (m.scope as MemoryRecord['scope']) || 'user',
      createdAt: m.createdAt,
      metadata: m.metadata,
    };
  }

  // ── Checkpoints & Plan mode ───────────────────────────────────

  async listCheckpoints(options?: { sessionId?: string; limit?: number }): Promise<CheckpointSummary[]> {
    if (!this.checkpointStore) return [];
    const entries = await this.checkpointStore.list(options);
    return entries.map((e) => ({
      runId: e.runId,
      task: e.task,
      sessionId: e.sessionId,
      status: e.status,
      completedCount: e.completedCount,
      totalCount: e.totalCount,
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
    }));
  }

  async getCheckpoint(runId: string): Promise<CheckpointDetail | null> {
    if (!this.checkpointStore) return null;
    const ck = await this.checkpointStore.load(runId);
    if (!ck) return null;
    const completedSet = new Set(ck.completedSubTaskIds);
    return {
      runId: ck.runId,
      task: ck.task,
      sessionId: ck.sessionId,
      status: ck.status,
      completedCount: ck.completedSubTaskIds.length,
      totalCount: ck.planDag.subtasks.length,
      createdAt: ck.createdAt,
      updatedAt: ck.updatedAt,
      subtasks: ck.planDag.subtasks.map((st) => {
        const output = ck.subtaskOutputs[st.id];
        return {
          id: st.id,
          title: st.title,
          status: completedSet.has(st.id)
            ? output?.ok
              ? 'done'
              : 'failed'
            : 'pending',
          output: typeof output?.output === 'string' ? output.output : undefined,
        };
      }),
    };
  }

  async deleteCheckpoint(runId: string): Promise<void> {
    await this.checkpointStore?.delete(runId);
  }

  getPlanMode(): 'chat' | 'plan' | 'auto' {
    return this.settings?.planMode ?? 'auto';
  }

  private resolvePlanMode(mode?: 'chat' | 'plan' | 'auto'): 'chat' | 'plan' {
    const settingsMode = this.settings?.planMode ?? 'auto';
    const effective = mode ?? settingsMode;
    if (effective === 'chat' || effective === 'plan') return effective;
    // Auto: use plan mode when the task looks like it needs multiple steps.
    return 'plan';
  }

  private emit(type: BridgeEventType, data?: unknown): void {
    const event: BridgeEvent = { type, data };
    this.listeners.get(type)?.forEach((listener) => {
      try {
        listener(event);
      } catch (e) {
        console.error('Bridge listener error:', e);
      }
    });
  }
}

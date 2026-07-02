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
} from './types';
import { MemoryManager, type MemoryRecord as RuntimeMemoryRecord } from '../runtime/memory-manager';
import { LLMProvider } from '../runtime/llm-provider';
import { Orchestrator } from '../runtime/orchestrator';
import { buildDefaultRegistry } from '../runtime/tools';
import { SkillRegistry } from '../runtime/skill-registry';
import { connectMcpServers, type McpServerConfig as McpCfg } from '../runtime/mcp-client';
import { getTraceLogger, type TraceSpan } from '../runtime/trace-logger';

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

    // Load bundled skills
    this.skills = new SkillRegistry({ maxInjected: 3 });

    if (!api) {
      this.status.connected = false;
      this.status.reason = '未配置 API';
      this.emit('status', this.status);
      return;
    }

    this.provider = new LLMProvider({ api });
    const tools = buildDefaultRegistry(this.memory);

    // Apply tool policy to built-in tools (same as desktop)
    const policy = settings.toolPolicy ?? { allow: [], deny: [] };
    try {
      const { isToolAllowed } = await import('@ziner/contracts');
      const allTools = tools.list();
      for (const t of allTools) {
        if (!isToolAllowed(policy, t.definition.function.name)) {
          tools.remove?.(t.definition.function.name);
        }
      }
    } catch (e) {
      console.warn('[LocalRuntimeBridge] Tool policy filter failed:', e);
    }

    // Connect MCP servers (best-effort: failures don't block init)
    try {
      const cfgs = this.getEnabledMcpServers();
      if (cfgs.length > 0) {
        const { tools: mcpTools, close } = await connectMcpServers(cfgs, policy);
        for (const t of mcpTools) tools.register(t);
        this.mcpCleanup = close;
        this.mcpConnected = cfgs.map((c) => c.name);
      }
    } catch (e) {
      console.warn('[LocalRuntimeBridge] MCP init failed:', e);
    }

    this.orchestrator = new Orchestrator({
      provider: this.provider,
      memory: this.memory,
      tools,
      // Will be set per-run via getSystemPromptAddition
    });

    this.status.connected = true;
    this.status.reason = undefined;
    this.emit('status', this.status);
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

  async sendChat(message: string, conversationId?: string): Promise<ChatMessage> {
    if (!this.orchestrator) {
      throw new Error('Runtime not initialized. Configure an API in settings.');
    }
    const sessionId = conversationId ?? 'default';
    const skills = this.skills?.selectFor(message);
    const skillIds = skills?.map((s) => s.skill.id);

    const trace = getTraceLogger();
    trace.startRun({
      sessionId,
      userMessage: message,
      skills: skillIds,
      mcpServers: this.mcpConnected,
    });

    try {
      const result = await this.orchestrator.run(message, {
        sessionId,
        systemPromptAddition: skills ? this.buildSkillPromptAddition(skills) : undefined,
        onToolCall: (name, args, toolResult) => {
          this.recordToolSpan(name, args, toolResult);
        },
      });
      await trace.endRun({ assistantMessage: result.content });
      return this.toChatMessage(result.content);
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      await trace.endRun({ assistantMessage: '', error: err });
      throw e;
    }
  }

  async streamChat(
    message: string,
    conversationId: string | undefined,
    onChunk: (delta: string, fullMessage: string) => void,
  ): Promise<ChatMessage> {
    if (!this.orchestrator) {
      throw new Error('Runtime not initialized. Configure an API in settings.');
    }
    const sessionId = conversationId ?? 'default';
    const skills = this.skills?.selectFor(message);
    const skillIds = skills?.map((s) => s.skill.id);

    const trace = getTraceLogger();
    trace.startRun({
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

    try {
      let fullMessage = '';
      const result = await this.orchestrator.run(message, {
        sessionId,
        stream: true,
        onChunk: async (delta) => {
          fullMessage += delta;
          onChunk(delta, fullMessage);
        },
        onToolCall: (name, args, toolResult) => {
          this.recordToolSpan(name, args, toolResult);
        },
        systemPromptAddition: skills ? this.buildSkillPromptAddition(skills) : undefined,
      });
      // Mark LLM span as done
      await llmSpan.end(result.content);
      await trace.endRun({ assistantMessage: result.content });
      return this.toChatMessage(result.content);
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      await llmSpan.end(undefined, err);
      await trace.endRun({ assistantMessage: '', error: err });
      throw e;
    }
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
    return this.conversations.get(conversationId ?? 'default') ?? [];
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

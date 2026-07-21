// Mobile Orchestrator
//
// Coordinates the LLM Provider, Memory, and Tools to execute user requests.
// Supports: streaming responses, multi-turn tool calling, memory integration,
// and a simplified multi-agent plan mode with checkpoint persistence.

import type { LLMProvider, ChatMessage, ChatResponse, ToolDefinition } from './llm-provider';
import { ToolRegistry, type ToolContext, type ToolResult } from './tools';
import type { MemoryManager } from './memory-manager';
import type { BridgeEvent, BridgeEventListener, BridgeEventType } from '../bridge/types';
import type { PlanDag, SubTask } from '@ziner/contracts';
import type { Checkpoint, CheckpointStore, SubTaskResult } from '@ziner/runtime-core';

export interface OrchestratorOptions {
  provider: LLMProvider;
  memory: MemoryManager;
  tools: ToolRegistry;
  systemPrompt?: string;
  maxToolRounds?: number;
  temperature?: number;
  maxTokens?: number;
  /** Max context messages to keep. */
  maxContextMessages?: number;
  /** Whether to auto-extract facts into long-term memory. */
  autoExtractFacts?: boolean;
  /** Optional checkpoint store for plan mode resume. */
  checkpointStore?: CheckpointStore | null;
  /** Max sub-tasks in plan mode. */
  maxPlanSubtasks?: number;
}

export interface OrchestratorRunOptions {
  userId?: string;
  sessionId?: string;
  /** If true, stream tokens via onChunk. */
  stream?: boolean;
  /** Token callback. */
  onChunk?: (delta: string, full: string) => void;
  /** Tool progress callback. */
  onToolCall?: (tool: string, args: unknown, result: ToolResult) => void;
  /** Signal for cancellation. */
  signal?: AbortSignal;
  /** Optional per-run addition to the system prompt (e.g. injected SKILL content). */
  systemPromptAddition?: string;
  /** Execution mode: 'chat' (single-turn with tools) or 'plan' (multi-step plan). */
  mode?: 'chat' | 'plan';
  /** Optional checkpoint to resume a previously interrupted plan run. */
  resumeFrom?: Checkpoint;
  /** Run id used for checkpoint persistence. */
  runId?: string;
}

export interface OrchestratorRunResult {
  content: string;
  toolCalls: { name: string; args: unknown; result: ToolResult }[];
  totalTokens?: number;
  finishReason: 'stop' | 'tool_calls' | 'length' | 'error';
}

/** Standard system prompt for the mobile agent. */
export const DEFAULT_SYSTEM_PROMPT = `你是 Ziner —— 一个智能、友善、专业的 AI 助手，运行在用户的手机/平板上。

# 核心原则
1. 简洁直接：用用户的语言风格回答，避免冗长
2. 主动使用工具：遇到需要查询/保存信息时主动调用工具
3. 长期记忆：当用户说"记住..."、"我喜欢..."、"别忘了..."等，使用 save_memory 工具
4. 上下文回忆：当用户问"我之前说过什么"、"我叫什么"等，使用 search_memory 工具
5. 时区感知：用户时区是 Asia/Shanghai，但用 get_current_time 工具获取准确时间

# 工具使用
- 工具可以串行调用多轮
- 每次工具调用后，工具结果会自动传回给你
- 当所有信息都齐备时，停止调用工具并给出最终回答

# 行为约束
- 不要编造事实，需要时查 memory 或用工具
- 数字/时间不要估算，用 get_current_time 或 calculate
- 涉及用户隐私时，优先用 search_memory 而不是问
`;

/** Planner prompt for plan mode. */
const PLANNER_SYSTEM_PROMPT = `你是 Ziner 的任务规划器。请将用户的请求拆分为一组可顺序执行的子任务。

规则：
- 每个子任务应简短、具体、可独立完成。
- 如果请求明显只需要一步（例如简单问候、单个计算），返回单个 subtask 即可。
- 子任务最多 6 个。
- 必须按以下 JSON 格式输出（不要包含解释文字）：

{
  "task": "用户原始请求",
  "rationale": "拆分理由",
  "subtasks": [
    {
      "id": "step-1",
      "title": "子任务标题",
      "prompt": "交给执行 Agent 的完整提示",
      "assignedTo": "chat",
      "dependsOn": []
    }
  ]
}

每个 subtask 的 dependsOn 填写必须在此列表中先完成的 step id；没有依赖则为空数组。
`;

/** Synthesizer prompt for plan mode. */
const SYNTHESIZER_SYSTEM_PROMPT = `你是 Ziner 的结果整合器。请根据已完成的子任务输出，给出一段完整、简洁、对用户友好的最终回答。
- 直接回答用户的问题，不要提及"子任务"等内部概念。
- 如果子任务结果有冲突，请说明并给出最合理的结论。
- 使用中文回答。`;

interface SharedStateEntry {
  value: unknown;
  version: number;
  updatedAt: number;
  writer?: string;
}

export class Orchestrator {
  private provider: LLMProvider;
  private memory: MemoryManager;
  private tools: ToolRegistry;
  private options: Required<OrchestratorOptions>;
  private conversationHistory = new Map<string, ChatMessage[]>();
  private listeners = new Map<BridgeEventType, Set<BridgeEventListener>>();

  constructor(options: OrchestratorOptions) {
    this.provider = options.provider;
    this.memory = options.memory;
    this.tools = options.tools;
    this.options = {
      provider: options.provider,
      memory: options.memory,
      tools: options.tools,
      systemPrompt: options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
      maxToolRounds: options.maxToolRounds ?? 6,
      temperature: options.temperature ?? 0.7,
      maxTokens: options.maxTokens ?? 2000,
      maxContextMessages: options.maxContextMessages ?? 30,
      autoExtractFacts: options.autoExtractFacts ?? true,
      checkpointStore: options.checkpointStore ?? null,
      maxPlanSubtasks: options.maxPlanSubtasks ?? 6,
    };
  }

  /** Update the LLM provider (e.g. switch APIs). */
  setProvider(provider: LLMProvider): void {
    this.provider = provider;
    this.options.provider = provider;
  }

  /** Run a single user message through the agent. */
  async run(userMessage: string, options: OrchestratorRunOptions = {}): Promise<OrchestratorRunResult> {
    const sessionId = options.sessionId ?? 'default';
    const mode = options.mode ?? 'chat';

    if (mode === 'plan') {
      return this.runPlan(userMessage, sessionId, options);
    }

    return this.runChat(userMessage, sessionId, options);
  }

  private async runChat(
    userMessage: string,
    sessionId: string,
    options: OrchestratorRunOptions,
  ): Promise<OrchestratorRunResult> {
    const history = this.getHistory(sessionId);
    const systemContent = options.systemPromptAddition
      ? `${this.options.systemPrompt}\n\n${options.systemPromptAddition}`
      : this.options.systemPrompt;

    const messages: ChatMessage[] = [
      { role: 'system', content: systemContent },
      ...history,
      { role: 'user', content: userMessage },
    ];

    this.appendHistory(sessionId, { role: 'user', content: userMessage });

    const result = await this.executeAgentLoop(messages, options);

    this.appendHistory(sessionId, { role: 'assistant', content: result.content });

    if (this.options.autoExtractFacts && options.signal && !options.signal.aborted) {
      this.extractFacts(userMessage, result.content, sessionId).catch(() => {});
    }

    return result;
  }

  private async runPlan(
    userMessage: string,
    sessionId: string,
    options: OrchestratorRunOptions,
  ): Promise<OrchestratorRunResult> {
    const runId = options.runId ?? `plan-${Date.now()}`;
    const checkpointStore = this.options.checkpointStore;
    const signal = options.signal;

    // Shared state restored from checkpoint, or fresh.
    const sharedState = new Map<string, SharedStateEntry>();
    const completedIds = new Set<string>();
    const subtaskResults = new Map<string, SubTaskResult>();
    let planDag: PlanDag | null = null;

    if (options.resumeFrom) {
      const ck = options.resumeFrom;
      for (const [key, entry] of Object.entries(ck.sharedState)) {
        sharedState.set(key, { ...entry });
      }
      for (const id of ck.completedSubTaskIds) completedIds.add(id);
      for (const [id, result] of Object.entries(ck.subtaskOutputs)) {
        subtaskResults.set(id, result);
        sharedState.set(`subtasks.${id}.output`, {
          value: result.output,
          version: 1,
          updatedAt: result.completedAt,
          writer: result.agent,
        });
      }
      planDag = ck.planDag;
    }

    const persistCheckpoint = async (status: Checkpoint['status']): Promise<void> => {
      if (!checkpointStore) return;
      try {
        const outputs: Record<string, SubTaskResult> = {};
        for (const [id, r] of subtaskResults) outputs[id] = r;
        const sharedSnapshot: Record<string, SharedStateEntry> = {};
        for (const [k, v] of sharedState) sharedSnapshot[k] = v;
        await checkpointStore.save({
          runId,
          task: userMessage,
          mode: 'plan',
          sessionId,
          planDag: planDag ?? { task: userMessage, subtasks: [] },
          completedSubTaskIds: [...completedIds],
          subtaskOutputs: outputs,
          sharedState: sharedSnapshot,
          plannerAgent: 'planner',
          synthesizerAgent: 'synthesizer',
          createdAt: options.resumeFrom?.createdAt ?? Date.now(),
          updatedAt: Date.now(),
          status,
        });
      } catch (e) {
        console.warn('[Orchestrator] checkpoint save failed:', e);
      }
    };

    try {
      // Phase 1: Plan decomposition (skip if resuming).
      if (!planDag) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

        const history = this.getHistory(sessionId);
        const systemContent = options.systemPromptAddition
          ? `${PLANNER_SYSTEM_PROMPT}\n\n${options.systemPromptAddition}`
          : PLANNER_SYSTEM_PROMPT;
        const messages: ChatMessage[] = [
          { role: 'system', content: systemContent },
          ...history.slice(-this.options.maxContextMessages),
          { role: 'user', content: userMessage },
        ];

        const plannerResponse = await this.provider.chat(messages, {
          temperature: this.options.temperature,
          maxTokens: this.options.maxTokens,
          signal,
        });

        planDag = this.parsePlanDag(plannerResponse.content);
        if (!planDag || planDag.subtasks.length === 0) {
          // Fallback: treat the planner output as the final answer.
          await persistCheckpoint('completed');
          return {
            content: plannerResponse.content,
            toolCalls: [],
            totalTokens: plannerResponse.usage?.totalTokens,
            finishReason: plannerResponse.finishReason,
          };
        }

        if (planDag.subtasks.length > this.options.maxPlanSubtasks) {
          planDag.subtasks = planDag.subtasks.slice(0, this.options.maxPlanSubtasks);
        }

        await persistCheckpoint('in_progress');
      }

      // Phase 2: Execute subtasks in dependency waves.
      const waves = this.planToWaves(planDag);
      const successfulOutputs: { id: string; title: string; output: string }[] = [];
      let totalTokens = 0;
      const allToolCalls: { name: string; args: unknown; result: ToolResult }[] = [];

      for (const wave of waves) {
        if (signal?.aborted) {
          await persistCheckpoint('cancelled');
          throw new DOMException('Aborted', 'AbortError');
        }

        for (const subTask of wave) {
          if (completedIds.has(subTask.id)) {
            const existing = subtaskResults.get(subTask.id);
            if (existing?.ok) {
              successfulOutputs.push({ id: subTask.id, title: subTask.title, output: String(existing.output ?? '') });
            }
            continue;
          }

          const t0 = Date.now();
          const result = await this.executeAgentLoop(
            [
              { role: 'system', content: DEFAULT_SYSTEM_PROMPT },
              { role: 'user', content: subTask.prompt },
            ],
            { ...options, stream: false },
          );
          allToolCalls.push(...result.toolCalls);
          totalTokens += result.totalTokens ?? 0;

          const ok = result.finishReason !== 'error';
          const output = result.content;
          const entry: SubTaskResult = {
            ok,
            output,
            agent: 'chat',
            durationMs: Date.now() - t0,
            completedAt: Date.now(),
          };
          subtaskResults.set(subTask.id, entry);
          sharedState.set(`subtasks.${subTask.id}.output`, {
            value: output,
            version: 1,
            updatedAt: Date.now(),
            writer: 'chat',
          });
          completedIds.add(subTask.id);

          if (ok) {
            successfulOutputs.push({ id: subTask.id, title: subTask.title, output });
          }

          await persistCheckpoint('in_progress');

          if (signal?.aborted) {
            await persistCheckpoint('cancelled');
            throw new DOMException('Aborted', 'AbortError');
          }
        }
      }

      // Phase 3: Synthesize results.
      if (signal?.aborted) {
        await persistCheckpoint('cancelled');
        throw new DOMException('Aborted', 'AbortError');
      }

      if (successfulOutputs.length === 0) {
        const errorContent = '计划执行失败，没有子任务成功完成。';
        await persistCheckpoint('failed');
        return { content: errorContent, toolCalls: allToolCalls, totalTokens, finishReason: 'error' };
      }

      if (successfulOutputs.length === 1) {
        await persistCheckpoint('completed');
        return {
          content: successfulOutputs[0].output,
          toolCalls: allToolCalls,
          totalTokens,
          finishReason: 'stop',
        };
      }

      const synthesisInput = successfulOutputs
        .map((o) => `## ${o.title}\n${o.output}`)
        .join('\n\n');
      const synthesisMessages: ChatMessage[] = [
        { role: 'system', content: SYNTHESIZER_SYSTEM_PROMPT },
        { role: 'user', content: `用户请求：${userMessage}\n\n子任务结果：\n\n${synthesisInput}\n\n请给出最终回答。` },
      ];

      let finalResult: OrchestratorRunResult;
      if (options.stream && options.onChunk) {
        finalResult = await this.streamAgentLoop(synthesisMessages, options);
      } else {
        finalResult = await this.executeAgentLoop(synthesisMessages, options);
      }
      finalResult.toolCalls = [...allToolCalls, ...finalResult.toolCalls];
      finalResult.totalTokens = (finalResult.totalTokens ?? 0) + totalTokens;

      await persistCheckpoint('completed');
      return finalResult;
    } catch (e) {
      if (this.isAbortError(e)) {
        await persistCheckpoint('cancelled');
        throw e;
      }
      await persistCheckpoint('failed');
      throw e;
    }
  }

  /** Execute a multi-round agent loop (non-streaming or first-round streaming). */
  private async executeAgentLoop(
    messages: ChatMessage[],
    options: OrchestratorRunOptions,
  ): Promise<OrchestratorRunResult> {
    const toolDefinitions = this.tools.definitions();
    const allToolCalls: { name: string; args: unknown; result: ToolResult }[] = [];
    let totalTokens = 0;
    let lastResponse: ChatResponse | null = null;
    let finalContent = '';

    for (let round = 0; round <= this.options.maxToolRounds; round++) {
      if (options.signal?.aborted) break;

      let response: ChatResponse;
      if (options.stream && options.onChunk && round === 0) {
        const streamResult = await this.streamAgentLoop(messages, options);
        // streamAgentLoop already returns final result; no further tool rounds.
        return streamResult;
      } else {
        response = await this.provider.chat(messages, {
          tools: toolDefinitions,
          temperature: this.options.temperature,
          maxTokens: this.options.maxTokens,
          signal: options.signal,
        });
      }

      totalTokens += response.usage?.totalTokens ?? 0;
      lastResponse = response;

      if (response.finishReason === 'stop' || !response.tool_calls?.length) {
        finalContent = response.content;
        break;
      }

      const assistantMsg: ChatMessage = {
        role: 'assistant',
        content: response.content || null,
        tool_calls: response.tool_calls,
      };
      messages.push(assistantMsg);

      for (const toolCall of response.tool_calls) {
        if (options.signal?.aborted) break;

        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(toolCall.function.arguments);
        } catch {
          // ignore
        }

        const tool = this.tools.get(toolCall.function.name);
        let result: ToolResult;
        if (!tool) {
          result = { success: false, output: '', error: `Unknown tool: ${toolCall.function.name}` };
        } else {
          try {
            const ctx: ToolContext = {
              memory: this.memory,
              userId: options.userId,
              sessionId: options.sessionId,
              signal: options.signal,
            };
            result = await tool.execute(args, ctx);
          } catch (e) {
            result = { success: false, output: '', error: e instanceof Error ? e.message : 'Tool error' };
          }
        }

        allToolCalls.push({ name: toolCall.function.name, args, result });
        options.onToolCall?.(toolCall.function.name, args, result);

        const toolMsg: ChatMessage = {
          role: 'tool',
          content: result.success ? result.output : `Error: ${result.error}`,
          tool_call_id: toolCall.id,
        };
        messages.push(toolMsg);
      }
    }

    return {
      content: finalContent,
      toolCalls: allToolCalls,
      totalTokens: totalTokens > 0 ? totalTokens : undefined,
      finishReason: lastResponse?.finishReason ?? 'stop',
    };
  }

  /** Streaming agent loop: returns the full result after the stream ends. */
  private async streamAgentLoop(
    messages: ChatMessage[],
    options: OrchestratorRunOptions,
  ): Promise<OrchestratorRunResult> {
    const toolDefinitions = this.tools.definitions();
    const stream = this.provider.stream(messages, {
      tools: toolDefinitions,
      temperature: this.options.temperature,
      maxTokens: this.options.maxTokens,
      signal: options.signal,
    });

    let fullContent = '';
    let result: ChatResponse | null = null;

    while (true) {
      if (options.signal?.aborted) break;
      try {
        const { value, done } = await stream.next();
        if (done) {
          if (typeof value === 'object' && value !== null) {
            result = value as ChatResponse;
          }
          break;
        }
        const chunk = value;
        if (chunk.delta) {
          fullContent += chunk.delta;
          options.onChunk?.(chunk.delta, fullContent);
        }
      } catch (e) {
        if (this.isAbortError(e)) break;
        throw e;
      }
    }

    if (!result) {
      result = { content: fullContent, finishReason: 'stop' };
    }

    return {
      content: fullContent,
      toolCalls: [],
      totalTokens: result.usage?.totalTokens,
      finishReason: result.finishReason,
    };
  }

  private parsePlanDag(content: string): PlanDag | null {
    const json = extractJsonObject(content);
    if (!json) return null;
    try {
      const parsed = JSON.parse(json) as Partial<PlanDag>;
      if (!parsed.subtasks || !Array.isArray(parsed.subtasks)) return null;
      const subtasks: SubTask[] = parsed.subtasks
        .filter((st: unknown) => st && typeof st === 'object')
        .map((st: any) => ({
          id: String(st.id ?? ''),
          title: String(st.title ?? ''),
          prompt: String(st.prompt ?? ''),
          assignedTo: String(st.assignedTo ?? 'chat'),
          dependsOn: Array.isArray(st.dependsOn) ? st.dependsOn.map(String) : [],
        }))
        .filter((st) => st.id && st.title);
      if (subtasks.length === 0) return null;
      return {
        task: String(parsed.task ?? ''),
        rationale: typeof parsed.rationale === 'string' ? parsed.rationale : undefined,
        subtasks,
      };
    } catch {
      return null;
    }
  }

  /** Group subtasks into waves respecting dependsOn. */
  private planToWaves(plan: PlanDag): SubTask[][] {
    const items = plan.subtasks;
    const byId = new Map<string, SubTask>();
    for (const st of items) byId.set(st.id, st);

    const waves: SubTask[][] = [];
    const placed = new Set<string>();
    const remaining = new Set(byId.keys());

    while (remaining.size > 0) {
      const wave: SubTask[] = [];
      for (const id of remaining) {
        const st = byId.get(id)!;
        const ready = st.dependsOn.every((d) => placed.has(d) || !byId.has(d));
        if (ready) wave.push(st);
      }
      if (wave.length === 0) {
        // Cycle or invalid dependency: flush remaining as a final wave.
        for (const id of remaining) wave.push(byId.get(id)!);
      }
      waves.push(wave);
      for (const st of wave) {
        placed.add(st.id);
        remaining.delete(st.id);
      }
    }
    return waves;
  }

  private isAbortError(e: unknown): boolean {
    return e instanceof DOMException && e.name === 'AbortError';
  }

  private getHistory(sessionId: string): ChatMessage[] {
    if (!this.conversationHistory.has(sessionId)) {
      this.conversationHistory.set(sessionId, []);
    }
    const history = this.conversationHistory.get(sessionId)!;
    if (history.length > this.options.maxContextMessages) {
      return history.slice(-this.options.maxContextMessages);
    }
    return history;
  }

  private appendHistory(sessionId: string, msg: ChatMessage): void {
    if (!this.conversationHistory.has(sessionId)) {
      this.conversationHistory.set(sessionId, []);
    }
    this.conversationHistory.get(sessionId)!.push(msg);
  }

  clearHistory(sessionId?: string): void {
    if (sessionId) {
      this.conversationHistory.delete(sessionId);
    } else {
      this.conversationHistory.clear();
    }
  }

  /** Simple fact extraction from the user message. */
  private async extractFacts(userMessage: string, assistantReply: string, sessionId: string): Promise<void> {
    const patterns = [
      // 记住/别忘记 + 内容
      /(?:记住|别忘记|请记住|remember)\s*[：:]\s*(.{2,100})/i,
      // 我叫/我是 + 内容
      /(?:我叫|我的名字是|我是)\s*([^\s,.，。]+)/,
      // 我喜欢/我爱 + 内容
      /(?:我喜欢|我爱)\s*([^.。!?\n]{2,30})/,
      // 我不喜欢 + 内容
      /(?:我不喜欢|我讨厌)\s*([^.。!?\n]{2,30})/,
    ];

    for (const pattern of patterns) {
      const match = userMessage.match(pattern);
      if (match && match[1]) {
        const value = match[1].trim();
        if (value.length > 1 && value.length < 200) {
          await this.memory.rememberFact('preference', 'user', value, 0.9);
        }
      }
    }
  }

  // ── Event listeners ───────────────────────────────────────────

  addEventListener(type: BridgeEventType, listener: BridgeEventListener): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }

  removeEventListener(type: BridgeEventType, listener: BridgeEventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  private emit(type: BridgeEventType, data?: unknown): void {
    const event: BridgeEvent = { type, data };
    this.listeners.get(type)?.forEach((listener) => {
      try {
        listener(event);
      } catch (e) {
        console.error('Listener error:', e);
      }
    });
  }
}

/** Extract the first JSON object from a string (handles markdown fences). */
function extractJsonObject(text: string): string | null {
  const trimmed = text.trim();
  // Try fenced code block first.
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    const inner = fenceMatch[1].trim();
    if (inner.startsWith('{')) return inner;
  }
  // Try the whole string.
  if (trimmed.startsWith('{')) {
    try {
      JSON.parse(trimmed);
      return trimmed;
    } catch {
      // fall through
    }
  }
  // Find first balanced object using brace counting.
  const start = trimmed.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\') {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return trimmed.slice(start, i + 1);
      }
    }
  }
  return null;
}

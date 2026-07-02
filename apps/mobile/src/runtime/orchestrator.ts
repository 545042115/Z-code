// Mobile Orchestrator
//
// Coordinates the LLM Provider, Memory, and Tools to execute user requests.
// Supports: streaming responses, multi-turn tool calling, and memory integration.

import type { LLMProvider, ChatMessage, ChatResponse, ToolDefinition } from './llm-provider';
import { ToolRegistry, type ToolContext, type ToolResult } from './tools';
import type { MemoryManager } from './memory-manager';
import type { BridgeEvent, BridgeEventListener, BridgeEventType } from '../bridge/types';

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
    const history = this.getHistory(sessionId);
    const toolDefinitions = this.tools.definitions();

    // Build messages: system + history + user
    const systemContent = options.systemPromptAddition
      ? `${this.options.systemPrompt}\n\n${options.systemPromptAddition}`
      : this.options.systemPrompt;
    const messages: ChatMessage[] = [
      { role: 'system', content: systemContent },
      ...history,
      { role: 'user', content: userMessage },
    ];

    this.appendHistory(sessionId, { role: 'user', content: userMessage });

    const allToolCalls: { name: string; args: unknown; result: ToolResult }[] = [];
    let totalTokens = 0;
    let lastResponse: ChatResponse | null = null;
    let finalContent = '';

    // Multi-round tool calling loop
    for (let round = 0; round <= this.options.maxToolRounds; round++) {
      if (options.signal?.aborted) break;

      let response: ChatResponse;
      if (options.stream && options.onChunk && round === 0) {
        // First round: stream to UI
        response = await this.streamResponse(messages, toolDefinitions, options.onChunk, options.signal);
      } else {
        response = await this.provider.chat(messages, {
          tools: toolDefinitions,
          temperature: this.options.temperature,
          maxTokens: this.options.maxTokens,
        });
      }

      totalTokens += response.usage?.totalTokens ?? 0;
      lastResponse = response;

      if (response.finishReason === 'stop' || !response.tool_calls?.length) {
        finalContent = response.content;
        break;
      }

      // Execute tool calls
      const assistantMsg: ChatMessage = {
        role: 'assistant',
        content: response.content || null,
        tool_calls: response.tool_calls,
      };
      messages.push(assistantMsg);
      this.appendHistory(sessionId, assistantMsg);

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
              sessionId,
              signal: options.signal,
            };
            result = await tool.execute(args, ctx);
          } catch (e) {
            result = { success: false, output: '', error: e instanceof Error ? e.message : 'Tool error' };
          }
        }

        allToolCalls.push({ name: toolCall.function.name, args, result });
        options.onToolCall?.(toolCall.function.name, args, result);

        // Add tool result to messages
        const toolMsg: ChatMessage = {
          role: 'tool',
          content: result.success ? result.output : `Error: ${result.error}`,
          tool_call_id: toolCall.id,
        };
        messages.push(toolMsg);
        this.appendHistory(sessionId, toolMsg);
      }
    }

    if (lastResponse) {
      this.appendHistory(sessionId, { role: 'assistant', content: finalContent });
    }

    // Auto-extract facts
    if (this.options.autoExtractFacts && options.signal && !options.signal.aborted) {
      this.extractFacts(userMessage, finalContent, sessionId).catch(() => {});
    }

    return {
      content: finalContent,
      toolCalls: allToolCalls,
      totalTokens: totalTokens > 0 ? totalTokens : undefined,
      finishReason: lastResponse?.finishReason ?? 'stop',
    };
  }

  private async streamResponse(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    onChunk: (delta: string, full: string) => void,
    signal?: AbortSignal,
  ): Promise<ChatResponse> {
    const stream = this.provider.stream(messages, {
      tools,
      temperature: this.options.temperature,
      maxTokens: this.options.maxTokens,
    });

    let fullContent = '';
    let result: ChatResponse | null = null;

    while (true) {
      if (signal?.aborted) break;
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
        onChunk(chunk.delta, fullContent);
      }
    }

    if (!result) {
      result = { content: fullContent, finishReason: 'stop' };
    }
    return result;
  }

  private getHistory(sessionId: string): ChatMessage[] {
    if (!this.conversationHistory.has(sessionId)) {
      this.conversationHistory.set(sessionId, []);
    }
    const history = this.conversationHistory.get(sessionId)!;
    // Trim to max
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

// Mobile LLM Provider
//
// OpenAI-compatible chat completions provider for the mobile runtime.
// Supports streaming, function/tool calling, and multiple API configs.

export interface ApiConfig {
  id: string;
  name: string;
  endpoint: string;
  apiKey: string;
  model: string;
  enabled: boolean;
}

export type ChatMessageRole = 'system' | 'user' | 'assistant' | 'tool' | 'function';

export interface ChatMessage {
  role: ChatMessageRole;
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChatResponse {
  content: string;
  tool_calls?: ToolCall[];
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  finishReason: 'stop' | 'tool_calls' | 'length' | 'error';
}

export interface StreamChunk {
  delta: string;
  toolCalls?: ToolCall[];
  fullContent: string;
}

export interface LLMProviderOptions {
  /** API configuration (endpoint, key, model). */
  api: ApiConfig;
  /** Optional override for fetch (e.g. for testing). */
  fetchImpl?: typeof fetch;
}

export class LLMProvider {
  private api: ApiConfig;
  private fetchImpl: typeof fetch;

  constructor(options: LLMProviderOptions) {
    this.api = options.api;
    this.fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
  }

  /** Update the active API config. */
  setApi(api: ApiConfig): void {
    this.api = api;
  }

  /** Build the full chat completions URL from the endpoint base. */
  private getChatUrl(): string {
    const endpoint = this.api.endpoint.trim();
    if (!endpoint) return '';
    const queryIndex = endpoint.indexOf('?');
    const rawBase = queryIndex >= 0 ? endpoint.slice(0, queryIndex) : endpoint;
    const query = queryIndex >= 0 ? endpoint.slice(queryIndex) : '';
    const base = rawBase.replace(/\/+$/, '');

    const terminalPaths = ['/v1/chat/completions', '/chat/completions'];
    if (terminalPaths.some((p) => base.endsWith(p))) {
      return `${base}${query}`;
    }

    if (base.endsWith('/v1')) {
      return `${base}/chat/completions${query}`;
    }

    return `${base}/v1/chat/completions${query}`;
  }

  /** Send a chat completion request. */
  async chat(
    messages: ChatMessage[],
    options: { tools?: ToolDefinition[]; temperature?: number; maxTokens?: number } = {},
  ): Promise<ChatResponse> {
    const body: Record<string, unknown> = {
      model: this.api.model,
      messages: messages.map(stripMessage),
      stream: false,
    };
    if (options.tools) body.tools = options.tools;
    if (options.temperature !== undefined) body.temperature = options.temperature;
    if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens;

    const res = await this.fetchImpl(this.getChatUrl(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.api.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`LLM API error ${res.status}: ${text}`);
    }

    const data = await res.json();
    const choice = data.choices?.[0];
    if (!choice) {
      throw new Error('No choices in response');
    }

    return {
      content: choice.message?.content ?? '',
      tool_calls: choice.message?.tool_calls,
      usage: data.usage
        ? {
            promptTokens: data.usage.prompt_tokens,
            completionTokens: data.usage.completion_tokens,
            totalTokens: data.usage.total_tokens,
          }
        : undefined,
      finishReason: choice.finish_reason === 'tool_calls' ? 'tool_calls' : 'stop',
    };
  }

  /** Stream a chat completion, calling onChunk for each token. */
  async *stream(
    messages: ChatMessage[],
    options: { tools?: ToolDefinition[]; temperature?: number; maxTokens?: number } = {},
  ): AsyncGenerator<StreamChunk, ChatResponse, void> {
    const body: Record<string, unknown> = {
      model: this.api.model,
      messages: messages.map(stripMessage),
      stream: true,
    };
    if (options.tools) body.tools = options.tools;
    if (options.temperature !== undefined) body.temperature = options.temperature;
    if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens;

    const res = await this.fetchImpl(this.getChatUrl(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.api.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`LLM API error ${res.status}: ${text}`);
    }

    if (!res.body) {
      throw new Error('Response body is null');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');

    let fullContent = '';
    const toolCallMap = new Map<number, ToolCall>();
    let finishReason: 'stop' | 'tool_calls' | 'length' | 'error' = 'stop';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n');

      for (const line of lines) {
        if (!line.trim() || line.startsWith(':')) continue;
        const data = line.replace(/^data: /, '');
        if (data === '[DONE]') continue;

        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta;
          const content = delta?.content ?? '';
          if (content) {
            fullContent += content;
            yield { delta: content, fullContent };
          }

          // Handle streaming tool calls
          if (delta?.tool_calls) {
            for (const tcDelta of delta.tool_calls) {
              const idx = tcDelta.index;
              if (!toolCallMap.has(idx)) {
                toolCallMap.set(idx, {
                  id: tcDelta.id ?? `call-${idx}`,
                  type: 'function',
                  function: { name: tcDelta.function?.name ?? '', arguments: '' },
                });
              }
              const tc = toolCallMap.get(idx)!;
              if (tcDelta.function?.name) tc.function.name += tcDelta.function.name;
              if (tcDelta.function?.arguments) tc.function.arguments += tcDelta.function.arguments;
            }
          }

          if (parsed.choices?.[0]?.finish_reason) {
            finishReason = parsed.choices[0].finish_reason === 'tool_calls' ? 'tool_calls' : 'stop';
          }
        } catch {
          // ignore malformed JSON
        }
      }
    }

    return {
      content: fullContent,
      tool_calls: toolCallMap.size > 0 ? Array.from(toolCallMap.values()) : undefined,
      finishReason,
    };
  }

  /** Simple ping to check if the API is reachable. */
  async ping(): Promise<{ ok: boolean; latencyMs: number; reason?: string }> {
    const start = Date.now();
    try {
      const res = await this.fetchImpl(this.getChatUrl(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.api.apiKey}`,
        },
        body: JSON.stringify({
          model: this.api.model,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
        }),
      });
      const latencyMs = Date.now() - start;
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return { ok: false, latencyMs, reason: `HTTP ${res.status}: ${text.slice(0, 200)}` };
      }
      return { ok: true, latencyMs };
    } catch (e) {
      return { ok: false, latencyMs: Date.now() - start, reason: e instanceof Error ? e.message : 'Network error' };
    }
  }
}

function stripMessage(msg: ChatMessage): unknown {
  const out: Record<string, unknown> = { role: msg.role };
  if (msg.content !== null && msg.content !== undefined) out.content = msg.content;
  if (msg.name) out.name = msg.name;
  if (msg.tool_call_id) out.tool_call_id = msg.tool_call_id;
  if (msg.tool_calls) out.tool_calls = msg.tool_calls;
  return out;
}

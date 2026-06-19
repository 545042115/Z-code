// OpenAI-compatible LLM Provider
//
// Implements ILLMProvider for any OpenAI-compatible API (OpenAI,
// DeepSeek, Ollama, vLLM, sglang, etc.). Uses the native fetch()
// API so there are zero npm dependencies.
//
// Supports native function calling (tool_calls).

import { performance } from 'node:perf_hooks';
import type {
  ILLMProvider,
  LLMRequest,
  LLMResponse,
  LLMMessage,
  ToolCallRef,
} from '@z-assistant/contracts';

// ── Helpers: map our LLMMessage ↔ OpenAI chat format ────────────────

interface OpenAIMessage {
  role: string;
  content: string | null;
  name?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

function toOpenAI(msg: LLMMessage): OpenAIMessage {
  const m: OpenAIMessage = { role: msg.role, content: msg.content ?? null, name: msg.name };

  // Assistant message with tool calls
  if (msg.toolCalls && msg.toolCalls.length > 0) {
    m.tool_calls = msg.toolCalls.map((tc) => ({
      id: tc.id,
      type: 'function' as const,
      function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
    }));
  }

  // Tool result message
  if (msg.toolCallId) {
    m.tool_call_id = msg.toolCallId;
  }

  return m;
}

function fromOpenAIToolCalls(
  rawCalls: Array<{
    id?: string;
    function?: { name?: string; arguments?: string };
  }>
): ToolCallRef[] {
  return rawCalls
    .filter((c) => c.function?.name)
    .map((c) => ({
      id: c.id ?? `call_${Math.random().toString(36).slice(2, 10)}`,
      name: c.function!.name!,
      arguments: safeParseJson(c.function!.arguments ?? '{}'),
    }));
}

function safeParseJson(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

// ── Provider ──────────────────────────────────────────────────────────

export interface OpenAIProviderOptions {
  /** Base URL, e.g. "https://api.openai.com/v1" or "https://api.deepseek.com/v1" */
  baseURL: string;
  /** API key */
  apiKey: string;
  /** Default model name (e.g. "gpt-4o", "deepseek-chat") */
  defaultModel: string;
  /** Friendly provider name (default: "openai-compatible") */
  name?: string;
  /** Request timeout in ms (default: 60_000) */
  timeout?: number;
}

export class OpenAIProvider implements ILLMProvider {
  readonly name: string;
  readonly supportedModels: string[];
  private baseURL: string;
  private apiKey: string;
  private defaultModel: string;
  private timeout: number;

  constructor(opts: OpenAIProviderOptions) {
    this.name = opts.name ?? 'openai-compatible';
    this.supportedModels = [opts.defaultModel];
    this.baseURL = opts.baseURL.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.defaultModel = opts.defaultModel;
    this.timeout = opts.timeout ?? 60_000;
  }

  async generate(req: LLMRequest): Promise<LLMResponse> {
    const model = req.model.name || this.defaultModel;
    const t0 = performance.now();

    const body: Record<string, unknown> = {
      model,
      messages: req.messages.map(toOpenAI),
      temperature: req.temperature ?? 0.7,
      max_tokens: req.maxTokens ?? 2048,
      stream: false,
    };

    // Pass tools for function calling
    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools.map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.argsSchema,
        },
      }));
    }

    const url = `${this.baseURL}/chat/completions`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: req.signal ?? controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => 'unknown');
        throw new Error(`LLM API error ${res.status}: ${text.slice(0, 500)}`);
      }

      const json = await res.json() as {
        choices: Array<{
          message: {
            role: string;
            content: string | null;
            tool_calls?: Array<{
              id?: string;
              function?: { name?: string; arguments?: string };
            }>;
          };
          finish_reason: string;
        }>;
        usage?: { prompt_tokens: number; completion_tokens: number };
      };

      const choice = json.choices?.[0];
      if (!choice) throw new Error('LLM returned empty choices');

      const durationMs = Math.round(performance.now() - t0);
      const tokensIn = json.usage?.prompt_tokens ?? 0;
      const tokensOut = json.usage?.completion_tokens ?? 0;

      let finishReason: LLMResponse['finishReason'] = 'end_turn';
      if (choice.finish_reason === 'tool_calls') finishReason = 'tool_calls';
      else if (choice.finish_reason === 'length') finishReason = 'max_tokens';

      // Parse tool calls if present
      const toolCalls = choice.message.tool_calls
        ? fromOpenAIToolCalls(choice.message.tool_calls)
        : undefined;

      const response: LLMResponse = {
        message: {
          role: 'assistant',
          content: choice.message.content ?? undefined,
          toolCalls,
        },
        usage: { tokensIn, tokensOut },
        durationMs,
        finishReason,
        costUsd: 0, // infra/cost can compute this later
      };

      return response;
    } finally {
      clearTimeout(timer);
    }
  }

  async health(): Promise<{ ok: boolean; reason?: string; checkedAt: number }> {
    try {
      const res = await fetch(`${this.baseURL}/models`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(10_000),
      });
      return { ok: res.ok, reason: res.ok ? undefined : `${res.status}`, checkedAt: Date.now() };
    } catch (e: unknown) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e), checkedAt: Date.now() };
    }
  }
}

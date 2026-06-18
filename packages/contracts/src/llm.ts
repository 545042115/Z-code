// LLM Provider Contracts — interface for V2 LLM adapters.
//
// `ILLMProvider` is the smallest unit a V2 agent needs to talk
// to any LLM. Concrete providers (OpenAI / Anthropic / sglang /
// DeepSeek) implement this; the Orchestrator can route between
// providers via `ILLMRegistry`.

import type { ModelSpec } from './agent';
import type { ErrorRef } from './run';

// ── Message / Role ────────────────────────────────────────────────────

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCallRef {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface LLMMessage {
  role: MessageRole;
  /** Plain text content; required unless `toolCalls` is set. */
  content?: string;
  /** For tool messages, the tool call id being responded to. */
  toolCallId?: string;
  /** For assistant messages, tool calls the model wants to make. */
  toolCalls?: ToolCallRef[];
  /** Optional per-message name (e.g. function name). */
  name?: string;
}

// ── Request / Response ────────────────────────────────────────────────

export interface LLMRequest {
  model: ModelSpec;
  messages: LLMMessage[];
  /** Available tools the model may call. */
  tools?: Array<{ name: string; description: string; argsSchema: Record<string, unknown> }>;
  /** Force JSON-object output if supported. */
  jsonMode?: boolean;
  /** Sampling temperature override. */
  temperature?: number;
  /** Max output tokens override. */
  maxTokens?: number;
  /** Cancellation signal. */
  signal?: AbortSignal;
}

export interface LLMResponse {
  /** Assistant message (text and/or tool calls). */
  message: LLMMessage;
  /** Token usage. */
  usage: {
    tokensIn: number;
    tokensOut: number;
  };
  /** Wall-clock duration. */
  durationMs: number;
  /** Stop reason: end_turn | tool_calls | max_tokens | error. */
  finishReason: 'end_turn' | 'tool_calls' | 'max_tokens' | 'error';
  /** Cost in USD; computed by infra/cost. */
  costUsd?: number;
  /** Provider-specific metadata. */
  metadata?: Record<string, string | number | boolean | null>;
}

// ── ILLMProvider ──────────────────────────────────────────────────────

export interface ILLMProvider {
  readonly name: string;
  readonly supportedModels: string[];
  /**
   * Send a single request. Implementations MUST emit a Span for
   * the call and respect `signal` for cancellation.
   */
  generate(req: LLMRequest): Promise<LLMResponse>;
  /** Stream a response. Same semantics as `generate` but yields
   *  incremental chunks. */
  stream?(req: LLMRequest, onChunk: (chunk: LLMMessage) => void): Promise<LLMResponse>;
  /** Cheap health check; returns true if the provider is reachable. */
  health?(): Promise<{ ok: boolean; reason?: string; checkedAt: number }>;
}

// ── ILLMRegistry ──────────────────────────────────────────────────────

/**
 * The V2 LLM Registry. Each provider implementation registers at
 * boot; the agent loop looks them up by model name.
 */
export interface ILLMRegistry {
  register(provider: ILLMProvider): void;
  unregister(name: string): boolean;
  get(name: string): ILLMProvider | undefined;
  list(): string[];
  /** Resolve a ModelSpec to a provider that supports it. */
  resolve(model: ModelSpec): ILLMProvider | undefined;
  /** Last error encountered while resolving / generating. */
  lastError(): ErrorRef | undefined;
}

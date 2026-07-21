// ILLMProvider — LLM call abstraction.
// Uses fetch (available in both Node.js 18+ and browsers).
// Re-exports ILLMProvider from contracts for compatibility.

export type { ILLMProvider, LLMRequest, LLMResponse, LLMMessage, MessageRole, ToolCallRef } from '@ziner/contracts';

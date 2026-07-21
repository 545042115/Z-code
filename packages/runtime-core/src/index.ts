// @ziner/runtime-core — Platform-agnostic runtime interfaces.
//
// This package contains the core orchestration logic, LLM provider,
// tool registry, memory manager, and MCP client.
// It has ZERO Node.js dependencies — all platform-specific
// functionality is injected via interfaces.

export * from './interfaces';
export * from './orchestrator';

// Tool Contracts — interfaces for the V2 Tool Registry.
//
// `ITool` is the smallest unit the Orchestrator / Agent can invoke.
// `IToolRegistry` is the lookup + invocation surface shared by every
// agent (Coding's file/edit/shell, Browser's DOM tools, etc.).
// Concrete tools live in their own agent packages and register
// themselves with the registry on boot.

import type { ErrorRef } from './run';
import type { ToolPolicy } from './config';

// ── Tool invocation ──────────────────────────────────────────────────

export interface ToolInvocation {
  /** Unique id (uuid v4) for this call; used in spans. */
  id: string;
  /** Name of the tool; e.g. "edit_file", "shell_exec". */
  toolName: string;
  /** Free-form arguments; validated by the tool. */
  args: Record<string, unknown>;
}

// ── Tool result ───────────────────────────────────────────────────────

export interface ToolResult {
  ok: boolean;
  /** Tool's primary output. Shape depends on the tool. */
  output?: unknown;
  /** Free-form artifacts (file URIs, ids, etc.) for SharedState. */
  artifacts?: Record<string, unknown>;
  /** Failure reason; required when ok === false. */
  error?: ErrorRef;
  /** Per-call metrics; aggregated into the parent Span. */
  metrics?: {
    durationMs: number;
    /** Number of LLM calls the tool made. */
    llmCalls?: number;
    /** Sub-tool calls made by this tool. */
    subToolCalls?: number;
  };
}

// ── ITool ─────────────────────────────────────────────────────────────

export interface ITool {
  /** Stable name; used in registry and Spans. */
  name: string;
  /** Human-readable role, e.g. "Edit a single file". */
  description: string;
  /** JSON Schema for the tool's arguments. */
  argsSchema?: Record<string, unknown>;
  /** Free-form capability tags for routing. */
  capabilities: string[];
  /** Optional: confirm with the user before invocation. */
  requiresConfirmation?: boolean;

  /** Invoke the tool. MUST emit a Span for any LLM/sub-tool calls. */
  invoke(inv: ToolInvocation): Promise<ToolResult>;
}

// ── IToolRegistry ─────────────────────────────────────────────────────

/**
 * The V2 Tool Registry. Each agent package registers its tools at
 * boot; the orchestrator / agent loop looks them up by name.
 */
export interface IToolRegistry {
  readonly name: string;
  /** Register a tool. Idempotent; re-registration replaces by name. */
  register(tool: ITool): void;
  /** Unregister a tool by name. Returns true if a tool was removed. */
  unregister(name: string): boolean;
  /** Look up a tool by name. */
  get(name: string): ITool | undefined;
  /** List all registered tool names. */
  list(): string[];
  /** Invoke a tool by name. */
  invoke(inv: ToolInvocation): Promise<ToolResult>;
  /** Active tool policy (allow/deny). */
  policy(): ToolPolicy;
}

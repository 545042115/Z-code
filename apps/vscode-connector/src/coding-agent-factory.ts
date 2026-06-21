// Coding Agent Factory — wires the vscode-connector's existing chat-agent
// and tool implementations into the V2 `@z-assistant/agent-coding` adapter
// layer.
//
// Per ADR-001 §4.5, the V2 coding-agent package (`packages/agents/coding-agent`)
// cannot import V1's `extensions/coding-agent` (which depends on vscode).
// Instead, it exposes `impl?` injection points on each sub-adapter. This
// factory is the V2-side wiring point: it constructs a real `IAgent`
// (the chat-agent) and a real `IToolRegistry` (wrapping the chat tools)
// and hands them to `createCodingAgentLoop` so the V2 Orchestrator gets a
// fully functional Coding agent instead of a 3001 stub.
//
// Architecture:
//
//   ┌──────────────────────────────────────────────────────┐
//   │  V2 Orchestrator                                     │
//   │  (packages/runtime/src/orchestrator/)                │
//   └────────────────────┬─────────────────────────────────┘
//                        │ IAgent
//                        ▼
//   ┌──────────────────────────────────────────────────────┐
//   │  CodingAgentLoop (from @z-assistant/agent-coding)     │
//   │  ─ agent.impl    → chatAgent (Plan+ReAct+Reflect)     │
//   │  ─ tools.impl    → ChatToolRegistry (V2 IToolRegistry)│
//   │  ─ planner/reflection/context/skills/verifier: stub   │
//   └────────────────────┬─────────────────────────────────┘
//                        │ delegates
//                        ▼
//   ┌──────────────────────────────────────────────────────┐
//   │  chat-agent.ts (createChatAgent)                      │
//   │  ─ Plan → ReAct loop → Reflect → Memory               │
//   │  ─ Tools: web / file / shell / browser / perception   │
//   └──────────────────────────────────────────────────────┘
//
// The planner / reflection / context / skills / verifier sub-adapters are
// left as Phase 6A stubs because the chat-agent owns its own internal
// Plan+ReAct+Reflect loop. They will be wired individually in a later
// phase when the V1 modules are refactored to not depend on vscode.

import type {
  IAgent,
  ITool,
  IToolRegistry,
  ToolInvocation,
  ToolResult,
  ToolPolicy,
} from '@z-assistant/contracts';
import {
  createCodingAgentLoop,
  type CodingAgentLoop,
} from '@z-assistant/agent-coding';

import {
  createChatAgent,
  executeToolByName,
  ALL_CHAT_TOOLS,
  type ChatAgentOptions,
} from './chat-agent';

// ── ChatToolRegistry — V2 IToolRegistry backed by chat-agent tools ─────

/**
 * V2 `IToolRegistry` implementation that wraps the chat-agent's tool
 * definitions (OpenAI function-calling format) into V2 `ITool` instances.
 *
 * Each tool's `invoke()` delegates to the chat-agent's `executeToolByName`
 * dispatcher, so the V2 Orchestrator can call any chat tool by name and
 * get back a V2 `ToolResult`.
 */
export class ChatToolRegistry implements IToolRegistry {
  readonly name = 'chat-tools';
  private _tools = new Map<string, ITool>();
  private _policy: ToolPolicy;

  constructor(policy?: ToolPolicy) {
    this._policy = policy ?? { allow: [], deny: [] };
    for (const def of ALL_CHAT_TOOLS) {
      this._tools.set(def.name, this._wrapTool(def));
    }
  }

  private _wrapTool(def: (typeof ALL_CHAT_TOOLS)[number]): ITool {
    return {
      name: def.name,
      description: def.description,
      argsSchema: def.argsSchema as Record<string, unknown> | undefined,
      capabilities: ['chat', 'desktop'],
      async invoke(inv: ToolInvocation): Promise<ToolResult> {
        const t0 = Date.now();
        try {
          const output = await executeToolByName(inv.toolName, inv.args);
          return {
            ok: true,
            output,
            metrics: { durationMs: Date.now() - t0 },
          };
        } catch (e: unknown) {
          return {
            ok: false,
            error: {
              code: 'TOOL_ERROR',
              message: e instanceof Error ? e.message : String(e),
            },
            metrics: { durationMs: Date.now() - t0 },
          };
        }
      },
    };
  }

  register(tool: ITool): void {
    this._tools.set(tool.name, tool);
  }

  unregister(name: string): boolean {
    return this._tools.delete(name);
  }

  get(name: string): ITool | undefined {
    return this._tools.get(name);
  }

  list(): string[] {
    return [...this._tools.keys()];
  }

  async invoke(inv: ToolInvocation): Promise<ToolResult> {
    const tool = this._tools.get(inv.toolName);
    if (!tool) {
      return {
        ok: false,
        error: {
          code: 'TOOL_NOT_FOUND',
          message: `ChatToolRegistry has no tool named '${inv.toolName}'`,
        },
      };
    }
    return tool.invoke(inv);
  }

  policy(): ToolPolicy {
    return this._policy;
  }
}

// ── Factory ───────────────────────────────────────────────────────────

/**
 * Options for `createCodingAgentFromChat`.
 *
 * `chatAgent` is forwarded verbatim to `createChatAgent`; `toolPolicy`
 * optionally restricts which tools the V2 registry will allow.
 */
export interface CodingAgentFactoryOptions {
  /** Options forwarded to `createChatAgent`. */
  chatAgent: ChatAgentOptions;
  /** Optional V2 tool policy (allow/deny lists). */
  toolPolicy?: ToolPolicy;
  /** Optional default model for the Coding agent. */
  defaultModel?: { provider: string; name: string };
}

/**
 * Build a V2 `CodingAgentLoop` wired to the vscode-connector's chat-agent.
 *
 * Returns the composite loop; call `.asIAgent()` to hand it to the V2
 * Orchestrator, or access `.tools` / `.agent` / `.planner` / ... directly
 * for inspector / dashboard use.
 *
 * Wiring:
 *   - `agent.impl`    → chat-agent IAgent (full Plan+ReAct+Reflect loop)
 *   - `tools.impl`    → ChatToolRegistry (V2 IToolRegistry over chat tools)
 *   - `planner` / `reflection` / `context` / `skills` / `verifier` → stub
 *     (chat-agent owns its internal loop; these will be wired individually
 *     in a later phase when V1 modules are decoupled from vscode).
 */
export function createCodingAgentFromChat(
  opts: CodingAgentFactoryOptions,
): CodingAgentLoop {
  const chatAgent: IAgent = createChatAgent(opts.chatAgent);
  const toolRegistry = new ChatToolRegistry(opts.toolPolicy);

  return createCodingAgentLoop({
    agent: {
      impl: chatAgent,
      defaultModel: opts.defaultModel,
    },
    tools: {
      impl: toolRegistry,
    },
  });
}

// ── Re-exports for convenience ────────────────────────────────────────

export {
  createCodingAgentFromChat as createCodingAgent,
};

// CodingToolRegistry — V2 `IToolRegistry` adapter backed by V1's
// `extensions/coding-agent/src/tools/tool-registry.ts`.
//
// Phase 6A: skeleton. R7 wires the real V1 registry (file / edit /
// shell / search / web / git) behind this. The shape is fixed:
// implements V2 `IToolRegistry` so V2 Apps / Orchestrator can
// invoke Coding tools by name.

import type { ITool, IToolRegistry, ToolInvocation, ToolResult, ToolPolicy } from '@z-assistant/contracts';

export interface CodingToolOptions {
  impl?: IToolRegistry;
  policy?: ToolPolicy;
}

export class CodingToolRegistry implements IToolRegistry {
  readonly name = 'coding-tools';
  private _tools = new Map<string, ITool>();
  private _policy: ToolPolicy;

  constructor(private readonly opts: CodingToolOptions = {}) {
    this._policy = opts.policy ?? { allow: [], deny: [] };
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
    if (this.opts.impl) return this.opts.impl.invoke(inv);
    // Phase 6A stub — R7 delegates to V1 ToolRegistry
    return {
      ok: false,
      error: {
        code: '3001',
        message: `CodingToolRegistry.invoke is a Phase 6A stub; wire V1 tools in R7 (requested: ${inv.toolName})`,
      },
    };
  }

  policy(): ToolPolicy {
    return this._policy;
  }
}

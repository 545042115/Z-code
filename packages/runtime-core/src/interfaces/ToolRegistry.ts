import type { ITool, IToolRegistry, ToolInvocation, ToolResult, ToolPolicy } from '@ziner/contracts';
import { isToolAllowed } from '@ziner/contracts';
import { hasAllCapabilities, type IPlatformCapabilities } from './IPlatformCapabilities';
import type { ToolMetadata } from './IToolRegistry';

export interface RegisteredTool {
  tool: ITool;
  metadata: ToolMetadata;
}

export interface ToolRegistryOptions {
  capabilities?: IPlatformCapabilities;
  platform?: 'desktop' | 'mobile';
  policy?: ToolPolicy;
  name?: string;
}

export class ToolRegistry implements IToolRegistry {
  readonly name: string;
  private map = new Map<string, RegisteredTool>();
  private activePolicy: ToolPolicy;

  constructor(private readonly options: ToolRegistryOptions = {}) {
    this.name = options.name ?? 'tool-registry';
    this.activePolicy = options.policy ?? { allow: [], deny: [] };
  }

  setPolicy(policy: ToolPolicy): void {
    this.activePolicy = policy;
  }

  policy(): ToolPolicy {
    return this.activePolicy;
  }

  register(tool: ITool, metadata: Partial<ToolMetadata> = {}): void {
    if (this.map.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered`);
    }
    const fullMetadata: ToolMetadata = {
      name: tool.name,
      platforms: metadata.platforms ?? ['desktop', 'mobile'],
      requires: metadata.requires,
      requiresConfirmation: metadata.requiresConfirmation ?? tool.requiresConfirmation,
    };
    this.map.set(tool.name, { tool, metadata: fullMetadata });
  }

  unregister(name: string): boolean {
    return this.map.delete(name);
  }

  get(name: string): ITool | undefined {
    return this.map.get(name)?.tool;
  }

  has(name: string): boolean {
    return this.map.has(name);
  }

  metadata(name: string): ToolMetadata | undefined {
    return this.map.get(name)?.metadata;
  }

  list(): string[] {
    return this.available().map((entry) => entry.tool.name);
  }

  listTools(): ITool[] {
    return this.available().map((entry) => entry.tool);
  }

  listMetadata(): ToolMetadata[] {
    return this.available().map((entry) => entry.metadata);
  }

  async invoke(inv: ToolInvocation): Promise<ToolResult> {
    const entry = this.map.get(inv.toolName);
    if (!entry) {
      return {
        ok: false,
        error: { code: 'TOOL_NOT_FOUND', message: `tool '${inv.toolName}' is not registered` },
      };
    }
    if (!isToolAllowed(this.activePolicy, inv.toolName)) {
      return {
        ok: false,
        error: {
          code: 'TOOL_DENIED_BY_POLICY',
          message: `tool '${inv.toolName}' is not allowed by the active tool policy.`,
        },
      };
    }
    if (this.options.capabilities && entry.metadata.requires?.length) {
      if (!hasAllCapabilities(this.options.capabilities, entry.metadata.requires)) {
        return {
          ok: false,
          error: {
            code: 'TOOL_REQUIRES_CAPABILITY',
            message: `tool '${inv.toolName}' requires unavailable capabilities: ${entry.metadata.requires.join(', ')}`,
          },
        };
      }
    }
    return entry.tool.invoke(inv);
  }

  private available(): RegisteredTool[] {
    const platform = this.options.platform;
    return [...this.map.values()].filter((entry) => this.isAvailable(entry));
  }

  private isAvailable(entry: RegisteredTool): boolean {
    if (this.options.platform && entry.metadata.platforms.length > 0
        && !entry.metadata.platforms.includes(this.options.platform)) {
      return false;
    }
    if (this.options.capabilities && entry.metadata.requires?.length) {
      if (!hasAllCapabilities(this.options.capabilities, entry.metadata.requires)) {
        return false;
      }
    }
    return true;
  }
}

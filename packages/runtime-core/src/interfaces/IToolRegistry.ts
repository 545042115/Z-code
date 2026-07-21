// IToolRegistry — tool registration and invocation abstraction.
// Re-exports IToolRegistry from contracts and adds platform-aware filtering.

export type { ITool, IToolRegistry, ToolInvocation, ToolResult } from '@ziner/contracts';

/**
 * Extended tool metadata for platform-aware registration.
 */
export interface ToolMetadata {
  /** Tool name (must match ITool.name). */
  name: string;
  /** Platforms where this tool is available. */
  platforms: ('desktop' | 'mobile')[];
  /** Platform capabilities required by this tool. */
  requires?: string[];
  /** Whether this tool requires user confirmation before execution. */
  requiresConfirmation?: boolean;
}

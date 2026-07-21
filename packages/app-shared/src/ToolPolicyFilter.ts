import type { ToolPolicy, ITool, ToolResult, ToolInvocation } from '@ziner/contracts';
import { isToolAllowed } from '@ziner/contracts';

export interface ToolFilterOptions {
  policy?: ToolPolicy;
}

export function filterTools(tools: ITool[], options: ToolFilterOptions = {}): ITool[] {
  if (!options.policy) return tools;
  return tools.filter((tool) => isToolAllowed(options.policy!, tool.name));
}

export function withPolicyGuard(tool: ITool, policy?: ToolPolicy): ITool {
  if (!policy) return tool;
  return {
    ...tool,
    invoke: async (inv: ToolInvocation): Promise<ToolResult> => {
      if (!isToolAllowed(policy, inv.toolName)) {
        return {
          ok: false,
          error: {
            code: 'TOOL_DENIED_BY_POLICY',
            message: `tool '${inv.toolName}' is not allowed by the active tool policy.`,
          },
        };
      }
      return tool.invoke(inv);
    },
  };
}

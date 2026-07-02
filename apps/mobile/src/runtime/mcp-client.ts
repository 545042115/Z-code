// MCP (Model Context Protocol) Client for mobile runtime.
//
// Uses the official `@modelcontextprotocol/sdk` package — same
// implementation that the desktop / vscode-connector uses. This
// guarantees the two clients speak the exact same protocol.
//
// In the browser we can only use `sse` and `streamablehttp` transports
// (no `stdio` — that needs a child process). Hosted MCP servers on
// ModelScope (Fetch, AMap, Jina, Charts, etc.) are all HTTP/SSE based.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { Tool, ToolContext, ToolResult } from './tools';
import type { ToolDefinition } from './llm-provider';

/** MCP server connection configuration. Mirrors vscode-connector's config. */
export interface McpServerConfig {
  name: string;
  /** Transport type. Mobile only supports sse / streamablehttp. */
  transport: 'sse' | 'streamablehttp';
  url: string;
  /** Optional HTTP headers (e.g. Authorization: Bearer xxx). */
  headers?: Record<string, string>;
  /** Optional timeout per tool call in ms. */
  timeoutMs?: number;
}

export interface ConnectedMcpServer {
  name: string;
  client: Client;
  tools: Tool[];
  close(): Promise<void>;
}

function normalizeToolName(serverName: string, toolName: string): string {
  // Prefix to avoid collisions with built-in tools.
  return `mcp_${serverName}_${toolName}`;
}

function createTransport(cfg: McpServerConfig): Transport {
  if (cfg.transport === 'sse') {
    return new SSEClientTransport(new URL(cfg.url), {
      requestInit: cfg.headers ? { headers: cfg.headers } : undefined,
    });
  }
  if (cfg.transport === 'streamablehttp') {
    return new StreamableHTTPClientTransport(new URL(cfg.url), {
      requestInit: cfg.headers ? { headers: cfg.headers } : undefined,
    });
  }
  throw new Error(`Unsupported transport: ${cfg.transport}`);
}

function mcpToolToInternal(serverName: string, mcpTool: { name: string; description?: string; inputSchema?: unknown }): Tool {
  const prefixedName = normalizeToolName(serverName, mcpTool.name);
  const inputSchema = mcpTool.inputSchema as ToolDefinition['function']['parameters'] | undefined;
  const definition: ToolDefinition = {
    type: 'function',
    function: {
      name: prefixedName,
      description: `[${serverName}] ${mcpTool.description ?? mcpTool.name}`,
      parameters: inputSchema ?? { type: 'object', properties: {} },
    },
  };

  return {
    definition,
    execute: async (args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> => {
      throw new Error(`MCP tool "${prefixedName}" requires a live client connection. Use ConnectedMcpServer.tools directly.`);
    },
  };
}

/** Connect to one MCP server and return wrapped Tool instances that
 *  can call the live MCP server when invoked. */
export async function connectMcpServer(cfg: McpServerConfig): Promise<ConnectedMcpServer> {
  const client = new Client({ name: 'ziner-mobile', version: '0.1.0' });
  const transport = createTransport(cfg);
  await client.connect(transport);

  const toolsResult = await client.listTools();
  const rawTools = (toolsResult.tools ?? []) as Array<{ name: string; description?: string; inputSchema?: unknown }>;
  const tools: Tool[] = rawTools.map((mcpTool) => {
    const base = mcpToolToInternal(cfg.name, mcpTool);
    // Override execute to actually call the MCP client
    return {
      definition: base.definition,
      execute: async (args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> => {
        const start = Date.now();
        try {
          const result = await client.callTool(
            { name: mcpTool.name, arguments: args },
            undefined,
            { timeout: cfg.timeoutMs ?? 15_000 },
          );
          const durationMs = Date.now() - start;
          const content = Array.isArray(result.content)
            ? result.content
                .map((part) => (typeof part === 'object' && part !== null ? (part as { text?: string }).text ?? '' : String(part)))
                .join('\n')
            : String(result.content ?? '');
          return {
            success: true,
            output: content,
            data: { durationMs, serverName: cfg.name, toolName: mcpTool.name },
          };
        } catch (err) {
          const durationMs = Date.now() - start;
          const message = err instanceof Error ? err.message : String(err);
          return {
            success: false,
            output: '',
            error: `MCP tool "${mcpTool.name}" failed: ${message}`,
            data: { durationMs },
          };
        }
      },
    };
  });

  return {
    name: cfg.name,
    client,
    tools,
    close: async () => {
      try { await client.close(); } catch { /* ignore */ }
      try { await transport.close(); } catch { /* ignore */ }
    },
  };
}

/** Connect to many MCP servers and aggregate their tools.
 *  `policy` is the same allow/deny glob structure used by the desktop runtime. */
export async function connectMcpServers(
  cfgs: McpServerConfig[],
  policy?: { allow: string[]; deny: string[] },
): Promise<{ tools: Tool[]; close: () => Promise<void> }> {
  if (!cfgs.length) return { tools: [], close: async () => {} };
  const { isToolAllowed } = await import('@ziner/contracts');
  const servers = await Promise.all(cfgs.map(connectMcpServer));
  const rawTools = servers.flatMap((s) => s.tools);
  const tools = policy
    ? rawTools.filter((t) => isToolAllowed(policy, t.definition.function.name))
    : rawTools;
  return {
    tools,
    close: async () => {
      await Promise.all(servers.map((s) => s.close()));
    },
  };
}

/** Convert an array of MCP server configs into an ITool[]-compatible list
 *  for the orchestrator's ToolRegistry. */
export function mcpConfigsToDefs(cfgs: McpServerConfig[]): ToolDefinition[] {
  // We can't know tools until connected, so this only returns a placeholder.
  // Use connectMcpServers for real tool registration.
  return [];
}

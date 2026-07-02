// MCP (Model Context Protocol) tool bridge for the VSCode Connector.
//
// Dynamically connects to external MCP servers (stdio or SSE) and exposes
// their tools as V2 `ITool` instances that can be registered in the
// `ChatToolRegistry`. This lets the chat agent and V2 Orchestrator invoke
// external tools without changing the agent core.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { isToolAllowed, type ITool, type ToolInvocation, type ToolPolicy, type ToolResult } from '@ziner/contracts';

/** Configuration for a single MCP server connection. */
export interface McpServerConfig {
  /** Human-readable name for this server; used in tool prefixes and logs. */
  name: string;
  /**
   * Transport type.
   * - `stdio`: spawn a local process (command + args).
   * - `sse`: connect to a remote Server-Sent Events endpoint.
   * - `streamablehttp`: connect to a remote Streamable HTTP endpoint (e.g. McDonald's MCP).
   */
  transport: 'stdio' | 'sse' | 'streamablehttp';
  /** For stdio: command to spawn. */
  command?: string;
  /** For stdio: command arguments. */
  args?: string[];
  /** For stdio: environment variables to pass to the spawned process. */
  env?: Record<string, string>;
  /** For sse / streamablehttp: endpoint URL. */
  url?: string;
  /** For streamablehttp: extra HTTP headers (e.g. Authorization). */
  headers?: Record<string, string>;
  /** Optional timeout for individual tool calls in milliseconds. */
  timeoutMs?: number;
  /** Optional MCP protocol version override (e.g. '2025-06-18'). */
  protocolVersion?: string;
}

/** A connected MCP server together with its discovered tools. */
export interface ConnectedMcpServer {
  name: string;
  client: Client;
  tools: ITool[];
  close(): Promise<void>;
}

const ENV_PLACEHOLDER_RE = /\\?\$\{env:([^}]+)\}/g;

function resolveEnvPlaceholders(value: string): string {
  return value.replace(ENV_PLACEHOLDER_RE, (match, varName) => {
    if (match.startsWith('\\')) return match.slice(1);
    const envValue = process.env[varName];
    if (envValue === undefined) {
      throw new Error(`MCP config references undefined environment variable: ${varName}`);
    }
    return envValue;
  });
}

function resolveHeaders(headers?: Record<string, string>): Record<string, string> | undefined {
  if (!headers) return undefined;
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    resolved[key] = resolveEnvPlaceholders(value);
  }
  return resolved;
}

function createTransport(cfg: McpServerConfig): Transport {
  if (cfg.transport === 'stdio') {
    if (!cfg.command) throw new Error(`MCP server "${cfg.name}" is missing command`);
    return new StdioClientTransport({
      command: cfg.command,
      args: cfg.args ?? [],
      env: cfg.env as Record<string, string> | undefined,
    });
  }
  if (cfg.transport === 'sse') {
    if (!cfg.url) throw new Error(`MCP server "${cfg.name}" is missing url`);
    return new SSEClientTransport(new URL(resolveEnvPlaceholders(cfg.url)));
  }
  if (cfg.transport === 'streamablehttp') {
    if (!cfg.url) throw new Error(`MCP server "${cfg.name}" is missing url`);
    return new StreamableHTTPClientTransport(new URL(resolveEnvPlaceholders(cfg.url)), {
      requestInit: cfg.headers ? { headers: resolveHeaders(cfg.headers) } : undefined,
    });
  }
  throw new Error(`Unsupported MCP transport: ${(cfg as McpServerConfig).transport}`);
}

function normalizeToolName(serverName: string, toolName: string): string {
  // Prefix external tools to avoid collisions with built-ins.
  return `mcp_${serverName}_${toolName}`;
}

/**
 * Connect to one MCP server and wrap its tools as `ITool` instances.
 *
 * Each tool name is prefixed with `mcp_<serverName>_` to avoid collisions
 * with the built-in chat tools.
 */
export async function connectMcpServer(cfg: McpServerConfig): Promise<ConnectedMcpServer> {
  const client = new Client({ name: 'ziner-connector', version: '2.0.0-alpha.1' });
  const transport = createTransport(cfg);
  await client.connect(transport);

  const toolsResult = await client.listTools();
  const tools: ITool[] = (toolsResult.tools ?? []).map((mcpTool) => {
    const prefixedName = normalizeToolName(cfg.name, mcpTool.name);
    return {
      name: prefixedName,
      description: `[${cfg.name}] ${mcpTool.description ?? ''}`,
      argsSchema: mcpTool.inputSchema as Record<string, unknown> | undefined,
      capabilities: ['mcp', cfg.name],
      invoke: async (inv: ToolInvocation): Promise<ToolResult> => {
        const start = Date.now();
        try {
          const result = await client.callTool(
            { name: mcpTool.name, arguments: inv.args },
            undefined,
            { timeout: cfg.timeoutMs ?? 15_000 },
          );
          const durationMs = Date.now() - start;
          const content = Array.isArray(result.content)
            ? result.content.map((part) => (typeof part === 'object' && part !== null ? (part as { text?: string }).text ?? '' : String(part))).join('\n')
            : String(result.content ?? '');
          return {
            ok: true,
            output: content,
            metrics: { durationMs },
          };
        } catch (err: unknown) {
          const durationMs = Date.now() - start;
          const message = err instanceof Error ? err.message : String(err);
          return {
            ok: false,
            error: { code: 'MCP_TOOL_ERROR', message: `MCP tool "${mcpTool.name}" failed: ${message}` },
            metrics: { durationMs },
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
      try {
        await client.close();
      } catch {
        // ignore
      }
      try {
        await transport.close();
      } catch {
        // ignore
      }
    },
  };
}

/**
 * Connect to a list of MCP servers and aggregate their tools.
 *
 * Returns the wrapped tools plus a cleanup function that closes all clients.
 * When `opts.toolPolicy` is provided, every wrapped tool's `invoke()` is
 * pre-checked against the allow/deny lists (deny wins over allow). Calls
 * to denied tools return `{ ok: false, error: { code: 'TOOL_DENIED_BY_POLICY', ... } }`
 * without dispatching to the MCP server.
 */
export async function connectMcpServers(
  cfg: McpServerConfig[],
  opts?: { toolPolicy?: ToolPolicy },
): Promise<{ tools: ITool[]; close: () => Promise<void> }> {
  if (!cfg.length) return { tools: [], close: async () => {} };

  const policy = opts?.toolPolicy ?? { allow: [], deny: [] };
  const servers = await Promise.all(cfg.map(connectMcpServer));
  const rawTools = servers.flatMap((s) => s.tools);

  // Wrap each tool's `invoke` to enforce the active tool policy. Wrapping
  // (instead of mutating in place) keeps the original `ITool` instance
  // intact for any caller that captured a reference to it.
  const tools: ITool[] = rawTools.map((tool) => ({
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
  }));

  return {
    tools,
    close: async () => {
      await Promise.all(servers.map((s) => s.close()));
    },
  };
}
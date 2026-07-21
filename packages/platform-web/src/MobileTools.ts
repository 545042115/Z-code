import type { ToolDefinition } from './WebLLMProvider';
import type { MemoryManager } from './IndexedDBMemoryStore';

export interface MobileToolContext {
  memory: MemoryManager;
  userId?: string;
  sessionId?: string;
  signal?: AbortSignal;
  onProgress?: (data: { tool: string; output: string }) => void;
}

export interface MobileToolResult {
  success: boolean;
  output: string;
  data?: Record<string, unknown>;
  error?: string;
}

export interface MobileTool {
  definition: ToolDefinition;
  execute(args: Record<string, unknown>, ctx: MobileToolContext): Promise<MobileToolResult>;
}

export interface MobileNativeBridge {
  requestNotificationPermission(): Promise<boolean>;
  scheduleNotification(input: { id: number; title: string; body: string }): Promise<number>;
  copyToClipboard(text: string): Promise<void>;
  vibrate(style: 'light' | 'medium' | 'heavy'): Promise<void>;
  writeFile(input: { path: string; content: string; directory?: string }): Promise<string>;
  readFile(path: string, directory?: string): Promise<string | null>;
}

const ok = (output: string, data?: Record<string, unknown>): MobileToolResult => ({ success: true, output, data });
const err = (error: string): MobileToolResult => ({ success: false, output: '', error });

class TimeTool implements MobileTool {
  definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'get_current_time',
      description: 'Get the current time, optionally in a specific timezone.',
      parameters: {
        type: 'object',
        properties: { timezone: { type: 'string', description: 'IANA timezone, e.g. "Asia/Shanghai".' } },
      },
    },
  };

  async execute(args: Record<string, unknown>): Promise<MobileToolResult> {
    try {
      const tz = (args.timezone as string) || Intl.DateTimeFormat().resolvedOptions().timeZone;
      const now = new Date();
      const formatter = new Intl.DateTimeFormat('zh-CN', {
        timeZone: tz,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false, weekday: 'long',
      });
      return ok(formatter.format(now), { timezone: tz, timestamp: now.getTime() });
    } catch (e) {
      return err(e instanceof Error ? e.message : 'Unknown error');
    }
  }
}

class NotificationTool implements MobileTool {
  definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'send_notification',
      description: 'Send a local notification to the user.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Notification title' },
          body: { type: 'string', description: 'Notification body text' },
        },
        required: ['title', 'body'],
      },
    },
  };

  constructor(private readonly native: MobileNativeBridge) {}

  async execute(args: Record<string, unknown>): Promise<MobileToolResult> {
    const granted = await this.native.requestNotificationPermission();
    if (!granted) return err('notification permission not granted');
    const id = Date.now();
    await this.native.scheduleNotification({
      id,
      title: (args.title as string) || 'Ziner',
      body: (args.body as string) || '',
    });
    return ok(`通知已发送 (#${id})`);
  }
}

class ClipboardTool implements MobileTool {
  definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'copy_to_clipboard',
      description: 'Copy text to the device clipboard.',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    },
  };

  constructor(private readonly native: MobileNativeBridge) {}

  async execute(args: Record<string, unknown>): Promise<MobileToolResult> {
    const text = (args.text as string) || '';
    await this.native.copyToClipboard(text);
    return ok(`已复制到剪贴板（${text.length} 字符）`);
  }
}

class VibrateTool implements MobileTool {
  definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'vibrate',
      description: 'Trigger device vibration for haptic feedback.',
      parameters: {
        type: 'object',
        properties: { style: { type: 'string', enum: ['light', 'medium', 'heavy'] } },
      },
    },
  };

  constructor(private readonly native: MobileNativeBridge) {}

  async execute(args: Record<string, unknown>): Promise<MobileToolResult> {
    const style = (args.style as 'light' | 'medium' | 'heavy') || 'medium';
    await this.native.vibrate(style);
    return ok('已触发振动');
  }
}

class CalculatorTool implements MobileTool {
  definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'calculate',
      description: 'Evaluate a mathematical expression. Supports +-*/^ and sqrt/sin/cos/tan/log/ln and constants pi/e.',
      parameters: {
        type: 'object',
        properties: { expression: { type: 'string' } },
        required: ['expression'],
      },
    },
  };

  async execute(args: Record<string, unknown>): Promise<MobileToolResult> {
    const expression = (args.expression as string) || '';
    try {
      const result = safeEvaluate(expression);
      return ok(String(result));
    } catch (e) {
      return err(e instanceof Error ? e.message : 'invalid expression');
    }
  }
}

class WriteFileTool implements MobileTool {
  definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write text to a file on the device storage.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path (relative to Documents)' },
          content: { type: 'string', description: 'Text content to write' },
        },
        required: ['path', 'content'],
      },
    },
  };

  constructor(private readonly native: MobileNativeBridge) {}

  async execute(args: Record<string, unknown>): Promise<MobileToolResult> {
    const path = (args.path as string) || '';
    const content = (args.content as string) || '';
    if (!path) return err('path is required');
    try {
      const written = await this.native.writeFile({ path, content, directory: 'Documents' });
      return ok(`已写入 ${written}（${content.length} 字符）`);
    } catch (e) {
      return err(e instanceof Error ? e.message : 'write failed');
    }
  }
}

class ReadFileTool implements MobileTool {
  definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read text from a file on the device storage.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
  };

  constructor(private readonly native: MobileNativeBridge) {}

  async execute(args: Record<string, unknown>): Promise<MobileToolResult> {
    const path = (args.path as string) || '';
    if (!path) return err('path is required');
    try {
      const data = await this.native.readFile(path, 'Documents');
      if (data === null) return err(`file not found: ${path}`);
      return ok(data);
    } catch (e) {
      return err(e instanceof Error ? e.message : 'read failed');
    }
  }
}

class MemorySearchTool implements MobileTool {
  definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'search_memory',
      description: 'Search the user\'s long-term memory for relevant information.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' }, limit: { type: 'number' } },
        required: ['query'],
      },
    },
  };

  constructor(private readonly memory: MemoryManager) {}

  async execute(args: Record<string, unknown>): Promise<MobileToolResult> {
    const query = (args.query as string) || '';
    const limit = (args.limit as number) || 5;
    const results = await this.memory.recall({ query, limit });
    if (results.length === 0) return ok('未找到相关记忆。');
    const text = results
      .map((r, i) => `${i + 1}. [${(r.score * 100).toFixed(0)}%] ${r.memory.content}`)
      .join('\n');
    return ok(text);
  }
}

class SaveMemoryTool implements MobileTool {
  definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'save_memory',
      description: 'Save important information to long-term memory.',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string' },
          kind: { type: 'string', enum: ['long-term', 'preference', 'fact'] },
        },
        required: ['content'],
      },
    },
  };

  constructor(private readonly memory: MemoryManager) {}

  async execute(args: Record<string, unknown>): Promise<MobileToolResult> {
    const content = (args.content as string) || '';
    const kind = (args.kind as 'long-term' | 'preference' | 'fact') || 'long-term';
    const memory = await this.memory.remember(content, kind, 'user');
    return ok(`已保存到记忆：${memory.id}`);
  }
}

export class MobileToolRegistry {
  private tools = new Map<string, MobileTool>();

  register(tool: MobileTool): void {
    this.tools.set(tool.definition.function.name, tool);
  }

  remove(name: string): boolean {
    return this.tools.delete(name);
  }

  get(name: string): MobileTool | undefined {
    return this.tools.get(name);
  }

  list(): MobileTool[] {
    return Array.from(this.tools.values());
  }

  definitions(): ToolDefinition[] {
    return this.list().map((t) => t.definition);
  }
}

export interface CreateMobileRegistryOptions {
  memory: MemoryManager;
  native: MobileNativeBridge;
  /** Pre-built MCP tool list (e.g. `connectMcpServers` output). */
  mcpTools?: MobileTool[];
}

export function createMobileToolRegistry(options: CreateMobileRegistryOptions): MobileToolRegistry {
  const registry = new MobileToolRegistry();
  registry.register(new TimeTool());
  registry.register(new NotificationTool(options.native));
  registry.register(new ClipboardTool(options.native));
  registry.register(new VibrateTool(options.native));
  registry.register(new CalculatorTool());
  registry.register(new WriteFileTool(options.native));
  registry.register(new ReadFileTool(options.native));
  registry.register(new MemorySearchTool(options.memory));
  registry.register(new SaveMemoryTool(options.memory));
  if (options.mcpTools) {
    for (const t of options.mcpTools) registry.register(t);
  }
  return registry;
}

function safeEvaluate(expr: string): number {
  const sanitized = expr.replace(/[^0-9+\-*/^().,\s\pieE]|sqrt|sin|cos|tan|log|ln/gi, (m) => m);
  const tokens = tokenize(sanitized);
  const output = toRpn(tokens);
  return evalRpn(output);
}

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (/\s/.test(ch)) { i += 1; continue; }
    if (/[0-9.]/.test(ch)) {
      let n = '';
      while (i < input.length && /[0-9.]/.test(input[i])) { n += input[i]; i += 1; }
      tokens.push(n);
      continue;
    }
    if (/[a-zA-Z]/.test(ch)) {
      let ident = '';
      while (i < input.length && /[a-zA-Z]/.test(input[i])) { ident += input[i]; i += 1; }
      tokens.push(ident);
      continue;
    }
    if ('+-*/^(),'.includes(ch)) { tokens.push(ch); i += 1; continue; }
    i += 1;
  }
  return tokens;
}

const PRECEDENCE: Record<string, number> = { '+': 1, '-': 1, '*': 2, '/': 2, '^': 3 };

function toRpn(tokens: string[]): string[] {
  const output: string[] = [];
  const opStack: string[] = [];
  for (const tok of tokens) {
    if (/^[0-9.]/.test(tok)) { output.push(tok); continue; }
    if (['sqrt', 'sin', 'cos', 'tan', 'log', 'ln'].includes(tok.toLowerCase())) { opStack.push(tok); continue; }
    if (tok === ',') { while (opStack[opStack.length - 1] !== '(') output.push(opStack.pop()!); continue; }
    if (tok in PRECEDENCE) {
      while (opStack.length > 0) {
        const top = opStack[opStack.length - 1];
        if (top === '(') break;
        if (top in PRECEDENCE && PRECEDENCE[top] >= PRECEDENCE[tok]) output.push(opStack.pop()!);
        else break;
      }
      opStack.push(tok);
      continue;
    }
    if (tok === '(') { opStack.push(tok); continue; }
    if (tok === ')') { while (opStack.length > 0 && opStack[opStack.length - 1] !== '(') output.push(opStack.pop()!); opStack.pop(); continue; }
  }
  while (opStack.length > 0) output.push(opStack.pop()!);
  return output;
}

function evalRpn(output: string[]): number {
  const stack: number[] = [];
  for (const tok of output) {
    if (/^\d+\.?\d*$/.test(tok)) { stack.push(parseFloat(tok)); continue; }
    const low = tok.toLowerCase();
    if (low === 'pi') { stack.push(Math.PI); continue; }
    if (low === 'e') { stack.push(Math.E); continue; }
    if (['sqrt', 'sin', 'cos', 'tan', 'log', 'ln'].includes(low)) {
      const a = stack.pop()!;
      switch (low) {
        case 'sqrt': stack.push(Math.sqrt(a)); break;
        case 'sin': stack.push(Math.sin(a)); break;
        case 'cos': stack.push(Math.cos(a)); break;
        case 'tan': stack.push(Math.tan(a)); break;
        case 'log': stack.push(Math.log10(a)); break;
        case 'ln': stack.push(Math.log(a)); break;
      }
      continue;
    }
    if (stack.length >= 2) {
      const b = stack.pop()!;
      const a = stack.pop()!;
      switch (tok) {
        case '+': stack.push(a + b); break;
        case '-': stack.push(a - b); break;
        case '*': stack.push(a * b); break;
        case '/': stack.push(a / b); break;
        case '^': stack.push(Math.pow(a, b)); break;
      }
    }
  }
  return stack[0] ?? 0;
}

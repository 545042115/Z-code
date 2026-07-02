// Mobile Tool System
//
// Built-in tools and tool registry for the mobile runtime.
// Includes tools for: time, weather stub, notes, contacts, file system,
// notifications, clipboard, sharing, search memory.

import type { ToolDefinition } from './llm-provider';
import { getNativeCapabilities } from '../native';
import type { MemoryManager } from './memory-manager';

export interface ToolContext {
  memory: MemoryManager;
  userId?: string;
  sessionId?: string;
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
  /** Callback to push intermediate results to UI. */
  onProgress?: (data: { tool: string; output: string }) => void;
}

export interface ToolResult {
  success: boolean;
  output: string;
  data?: Record<string, unknown>;
  error?: string;
}

export interface Tool {
  definition: ToolDefinition;
  /** Execute the tool with the given arguments. */
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.tools.set(tool.definition.function.name, tool);
  }

  remove(name: string): boolean {
    return this.tools.delete(name);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): Tool[] {
    return Array.from(this.tools.values());
  }

  definitions(): ToolDefinition[] {
    return this.list().map((t) => t.definition);
  }
}

// ── Built-in tools ────────────────────────────────────────────────

/** Get current time / date. */
export class TimeTool implements Tool {
  definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'get_current_time',
      description: 'Get the current time, optionally in a specific timezone.',
      parameters: {
        type: 'object',
        properties: {
          timezone: {
            type: 'string',
            description: 'IANA timezone, e.g. "Asia/Shanghai". Default: local.',
          },
        },
      },
    },
  };

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    try {
      const tz = (args.timezone as string) || Intl.DateTimeFormat().resolvedOptions().timeZone;
      const now = new Date();
      const formatter = new Intl.DateTimeFormat('zh-CN', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
        weekday: 'long',
      });
      return {
        success: true,
        output: formatter.format(now),
        data: { timezone: tz, timestamp: now.getTime() },
      };
    } catch (e) {
      return { success: false, output: '', error: e instanceof Error ? e.message : 'Unknown error' };
    }
  }
}

/** Search long-term memory. */
export class MemorySearchTool implements Tool {
  definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'search_memory',
      description: 'Search the user\'s long-term memory for relevant information.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          limit: { type: 'number', description: 'Max results, default 5' },
        },
        required: ['query'],
      },
    },
  };

  constructor(private memory: MemoryManager) {}

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    try {
      const query = (args.query as string) || '';
      const limit = (args.limit as number) || 5;
      const results = await this.memory.recall({ query, limit });
      if (results.length === 0) {
        return { success: true, output: '未找到相关记忆。', data: { results: [] } };
      }
      const output = results
        .map((r, i) => `${i + 1}. [${(r.score * 100).toFixed(0)}%] ${r.memory.content}`)
        .join('\n');
      return { success: true, output, data: { results } };
    } catch (e) {
      return { success: false, output: '', error: e instanceof Error ? e.message : 'Search failed' };
    }
  }
}

/** Save a new memory. */
export class SaveMemoryTool implements Tool {
  definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'save_memory',
      description: 'Save important information to long-term memory for later recall.',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'The information to remember' },
          kind: {
            type: 'string',
            enum: ['long-term', 'preference', 'fact'],
            description: 'Type of memory. Default: long-term',
          },
        },
        required: ['content'],
      },
    },
  };

  constructor(private memory: MemoryManager) {}

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    try {
      const content = (args.content as string) || '';
      const kind = (args.kind as 'long-term' | 'preference' | 'fact') || 'long-term';
      const memory = await this.memory.remember(content, kind, 'user');
      return { success: true, output: `已保存到记忆：${memory.id}`, data: { memory } };
    } catch (e) {
      return { success: false, output: '', error: e instanceof Error ? e.message : 'Save failed' };
    }
  }
}

/** Schedule a local notification. */
export class NotificationTool implements Tool {
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

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    try {
      const native = getNativeCapabilities();
      await native.requestNotificationPermission();
      const id = Date.now();
      await native.scheduleNotification({
        id,
        title: (args.title as string) || 'Ziner',
        body: (args.body as string) || '',
      });
      return { success: true, output: `通知已发送 (#${id})`, data: { id } };
    } catch (e) {
      return { success: false, output: '', error: e instanceof Error ? e.message : 'Notification failed' };
    }
  }
}

/** Copy text to clipboard. */
export class ClipboardTool implements Tool {
  definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'copy_to_clipboard',
      description: 'Copy text to the device clipboard.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text to copy' },
        },
        required: ['text'],
      },
    },
  };

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    try {
      const text = (args.text as string) || '';
      const native = getNativeCapabilities();
      await native.copyToClipboard(text);
      return { success: true, output: `已复制到剪贴板（${text.length} 字符）` };
    } catch (e) {
      return { success: false, output: '', error: e instanceof Error ? e.message : 'Copy failed' };
    }
  }
}

/** Trigger vibration. */
export class VibrateTool implements Tool {
  definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'vibrate',
      description: 'Trigger device vibration for haptic feedback.',
      parameters: {
        type: 'object',
        properties: {
          style: { type: 'string', enum: ['light', 'medium', 'heavy'], description: 'Vibration intensity' },
        },
      },
    },
  };

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    try {
      const style = (args.style as 'light' | 'medium' | 'heavy') || 'medium';
      const native = getNativeCapabilities();
      await native.vibrate({ style });
      return { success: true, output: `已触发 ${style} 振动` };
    } catch (e) {
      return { success: false, output: '', error: e instanceof Error ? e.message : 'Vibrate failed' };
    }
  }
}

/** Calculator for simple math. */
export class CalculatorTool implements Tool {
  definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'calculate',
      description: 'Evaluate a math expression. Supports +, -, *, /, ^, sqrt, sin, cos, tan, log, ln, pi, e, parentheses.',
      parameters: {
        type: 'object',
        properties: {
          expression: { type: 'string', description: 'Math expression' },
        },
        required: ['expression'],
      },
    },
  };

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    try {
      const expression = (args.expression as string) || '';
      const result = evaluateExpression(expression);
      return { success: true, output: `${expression} = ${result}`, data: { result } };
    } catch (e) {
      return { success: false, output: '', error: e instanceof Error ? e.message : 'Calc error' };
    }
  }
}

// Simple expression evaluator (no eval)
function evaluateExpression(expr: string): number {
  // Tokenize
  const tokens = expr.match(/(\d+\.?\d*|\+|\-|\*|\/|\^|\(|\)|sqrt|sin|cos|tan|log|ln|pi|e)/gi) || [];
  if (tokens.length === 0) throw new Error('Empty expression');

  // Convert to postfix (shunting yard)
  const output: string[] = [];
  const ops: string[] = [];
  const precedence: Record<string, number> = { '+': 1, '-': 1, '*': 2, '/': 2, '^': 3 };
  const rightAssoc = new Set(['^']);

  for (const tok of tokens) {
    if (/^\d+\.?\d*$/.test(tok) || ['pi', 'e'].includes(tok.toLowerCase())) {
      output.push(tok);
    } else if (['sqrt', 'sin', 'cos', 'tan', 'log', 'ln'].includes(tok.toLowerCase())) {
      ops.push(tok.toLowerCase());
    } else if (tok === '(') {
      ops.push(tok);
    } else if (tok === ')') {
      while (ops.length && ops[ops.length - 1] !== '(') {
        output.push(ops.pop()!);
      }
      ops.pop(); // remove '('
      if (ops.length && ['sqrt', 'sin', 'cos', 'tan', 'log', 'ln'].includes(ops[ops.length - 1])) {
        output.push(ops.pop()!);
      }
    } else {
      while (ops.length && ops[ops.length - 1] !== '(' &&
             (precedence[ops[ops.length - 1]] ?? 0) > (precedence[tok] ?? 0) ||
             (ops.length && (precedence[ops[ops.length - 1]] ?? 0) === (precedence[tok] ?? 0) && !rightAssoc.has(tok))) {
        output.push(ops.pop()!);
      }
      ops.push(tok);
    }
  }
  while (ops.length) output.push(ops.pop()!);

  // Evaluate postfix
  const stack: number[] = [];
  for (const tok of output) {
    if (/^\d+\.?\d*$/.test(tok)) {
      stack.push(parseFloat(tok));
    } else if (tok.toLowerCase() === 'pi') {
      stack.push(Math.PI);
    } else if (tok.toLowerCase() === 'e') {
      stack.push(Math.E);
    } else if (stack.length >= 1) {
      if (['sqrt', 'sin', 'cos', 'tan', 'log', 'ln'].includes(tok)) {
        const a = stack.pop()!;
        switch (tok) {
          case 'sqrt': stack.push(Math.sqrt(a)); break;
          case 'sin': stack.push(Math.sin(a)); break;
          case 'cos': stack.push(Math.cos(a)); break;
          case 'tan': stack.push(Math.tan(a)); break;
          case 'log': stack.push(Math.log10(a)); break;
          case 'ln': stack.push(Math.log(a)); break;
        }
      } else if (stack.length >= 2) {
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
  }
  return stack[0] ?? 0;
}

/** Write a file to device. */
export class WriteFileTool implements Tool {
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

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    try {
      const path = (args.path as string) || '';
      const content = (args.content as string) || '';
      const native = getNativeCapabilities();
      await native.writeFile({ path, data: content, directory: 'Documents' });
      return { success: true, output: `已写入文件：${path}` };
    } catch (e) {
      return { success: false, output: '', error: e instanceof Error ? e.message : 'Write failed' };
    }
  }
}

/** Read a file from device. */
export class ReadFileTool implements Tool {
  definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read text from a file on device storage.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path' },
        },
        required: ['path'],
      },
    },
  };

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    try {
      const path = (args.path as string) || '';
      const native = getNativeCapabilities();
      const data = await native.readFile(path, 'Documents');
      if (data === null) {
        return { success: false, output: '', error: `文件不存在：${path}` };
      }
      return { success: true, output: data, data: { content: data } };
    } catch (e) {
      return { success: false, output: '', error: e instanceof Error ? e.message : 'Read failed' };
    }
  }
}

/** List available tools. */
export function listBuiltInTools(): Tool[] {
  return [
    new TimeTool(),
    new NotificationTool(),
    new ClipboardTool(),
    new VibrateTool(),
    new CalculatorTool(),
    new WriteFileTool(),
    new ReadFileTool(),
  ];
}

/** Build a default registry for a runtime. */
export function buildDefaultRegistry(memory: MemoryManager): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of listBuiltInTools()) {
    registry.register(tool);
  }
  registry.register(new MemorySearchTool(memory));
  registry.register(new SaveMemoryTool(memory));
  return registry;
}

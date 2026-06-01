import * as vscode from 'vscode';
import { LLMProvider, Message, GenerateRequest, LLMProviderFactory } from '../llm/llm-provider';
import { ToolRegistry } from '../tools/tool-registry';
import { ContextManager } from '../context/context-manager';
import { DiffEngine } from '../utils/diff-engine';

/**
 * 确定性状态机 Agent Core
 * 严格遵循 AGENT_SPEC.md 规范：
 * - 极简状态机：PLAN → ACT → OBSERVE → EDIT → DONE
 * - 核心代码控制在 300 行以内
 * - 禁止引入 LangChain/LangGraph
 * - 编辑操作幂等性
 */

export type AgentState = 'PLAN' | 'ACT' | 'OBSERVE' | 'EDIT' | 'WAIT_USER' | 'DONE';

export const VALID_STATES: AgentState[] = ['PLAN', 'ACT', 'OBSERVE', 'EDIT', 'WAIT_USER', 'DONE'];

export interface AgentContext {
  currentFile?: string;
  selectedCode?: string;
  cursorPosition?: vscode.Position;
  openFiles: string[];
  diagnostics: vscode.Diagnostic[];
}

export interface StateResponse {
  state: AgentState;
  content?: string;
  toolCall?: ToolCall;
  editOps?: EditOperation[];
  question?: string;
  nextState?: AgentState;
}

export interface ToolCall {
  name: string;
  params: Record<string, any>;
}

export interface EditOperation {
  path: string;
  search: string;
  replace: string;
  idempotentKey: string;
}

// 各状态的 JSON Schema（AGENT_SPEC 强制要求使用 json_schema 约束）
const STATE_SCHEMAS: Record<AgentState, object> = {
  PLAN: {
    type: 'object',
    properties: {
      state: { const: 'PLAN' },
      content: { type: 'string', description: '分析思路和执行计划' },
      nextState: { const: 'ACT' },
    },
    required: ['state', 'content', 'nextState'],
  },
  ACT: {
    type: 'object',
    properties: {
      state: { const: 'ACT' },
      toolCall: {
        type: 'object',
        properties: {
          name: { type: 'string', enum: ['read_file', 'write_file', 'search_code', 'run_terminal', 'list_directory', 'get_diagnostics'] },
          params: { type: 'object' },
        },
        required: ['name', 'params'],
      },
    },
    required: ['state', 'toolCall'],
  },
  OBSERVE: {
    type: 'object',
    properties: {
      state: { const: 'OBSERVE' },
      content: { type: 'string', description: '观察结果分析' },
      nextState: { enum: ['ACT', 'EDIT', 'WAIT_USER', 'DONE'] },
    },
    required: ['state', 'content', 'nextState'],
  },
  EDIT: {
    type: 'object',
    properties: {
      state: { const: 'EDIT' },
      editOps: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            search: { type: 'string' },
            replace: { type: 'string' },
            idempotentKey: { type: 'string' },
          },
          required: ['path', 'search', 'replace', 'idempotentKey'],
        },
      },
    },
    required: ['state', 'editOps'],
  },
  WAIT_USER: {
    type: 'object',
    properties: {
      state: { const: 'WAIT_USER' },
      question: { type: 'string' },
    },
    required: ['state', 'question'],
  },
  DONE: {
    type: 'object',
    properties: {
      state: { const: 'DONE' },
      content: { type: 'string' },
    },
    required: ['state', 'content'],
  },
};

export class AgentCore {
  private llm: LLMProvider;
  private tools: ToolRegistry;
  private context: ContextManager;
  private diffEngine: DiffEngine;
  private currentState: AgentState = 'PLAN';
  private messageHistory: Message[] = [];
  private isRunning: boolean = false;

  // 系统 Prompt 缓存（RadixAttention 前缀缓存）
  private readonly SYSTEM_PROMPT: string;

  constructor(private readonly extensionContext: vscode.ExtensionContext) {
    this.llm = LLMProviderFactory.createFromVSCodeConfig();
    this.tools = new ToolRegistry();
    this.context = new ContextManager();
    this.diffEngine = new DiffEngine();

    this.SYSTEM_PROMPT = this.buildSystemPrompt();

    // 监听配置变更
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('codingAgent.llm')) {
        this.llm = LLMProviderFactory.createFromVSCodeConfig();
      }
    });
  }

  /**
   * 主入口：处理用户请求
   */
  async processRequest(
    userMessage: string,
    onStream: (chunk: string) => void,
    onStateChange: (state: AgentState) => void,
    onEditPreview: (ops: EditOperation[]) => void
  ): Promise<void> {
    if (this.isRunning) {
      throw new Error('Agent is already running');
    }

    this.isRunning = true;
    this.currentState = 'PLAN';
    
    try {
      // 收集编辑器上下文
      const editorCtx = await this.context.gatherContext();
      
      // 初始化对话历史
      this.messageHistory = [
        { role: 'system', content: this.SYSTEM_PROMPT },
        { role: 'user', content: this.formatContextMessage(editorCtx, userMessage) },
      ];

      // 状态机主循环
      while (this.currentState !== 'DONE' && this.currentState !== 'WAIT_USER' && this.isRunning) {
        onStateChange(this.currentState);

        const response = await this.executeState(
          this.currentState,
          onStream,
          onEditPreview
        );

        if (response.nextState && VALID_STATES.includes(response.nextState)) {
          this.currentState = response.nextState;
        } else {
          // 默认流转
          this.currentState = this.getDefaultNextState(this.currentState);
        }
      }

      // 标记运行结束（WAIT_USER 时也停止循环，等待 continueWithUserInput）
      if (this.currentState === 'WAIT_USER') {
        onStateChange('WAIT_USER');
      }
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * 执行当前状态
   */
  private async executeState(
    state: AgentState,
    onStream: (chunk: string) => void,
    onEditPreview: (ops: EditOperation[]) => void
  ): Promise<StateResponse> {
    const schema = STATE_SCHEMAS[state];
    
    // 使用 SGLang 生成结构化响应
    const request: GenerateRequest = {
      messages: this.messageHistory,
      jsonSchema: schema,
      stream: false,
    };

    const responseText = await this.llm.generate(request);
    let response: StateResponse;
    try {
      response = JSON.parse(responseText);
    } catch {
      // 模型有时会返回多个 JSON 对象拼在一起，尝试提取第一个
      const firstJson = this.extractFirstJson(responseText);
      if (firstJson) {
        try {
          response = JSON.parse(firstJson);
        } catch {
          throw new Error(`模型返回了无效的 JSON 格式：${responseText.slice(0, 200)}`);
        }
      } else {
        throw new Error(`模型返回了无效的 JSON 格式：${responseText.slice(0, 200)}`);
      }
    }

    switch (state) {
      case 'PLAN':
        onStream(`\n[PLAN] ${response.content}\n`);
        this.messageHistory.push({ role: 'assistant', content: responseText });
        return response;

      case 'ACT':
        if (response.toolCall) {
          onStream(`\n[ACT] Executing: ${response.toolCall.name}\n`);
          const result = await this.tools.execute(response.toolCall.name, response.toolCall.params);
          
          // 添加工具结果到历史（使用 user role 避免 OpenAI API 对 tool_call_id 的要求）
          this.messageHistory.push(
            { role: 'assistant', content: responseText },
            { role: 'user', content: `[Tool Result] ${JSON.stringify(result)}` }
          );
        }
        return { ...response, nextState: 'OBSERVE' };

      case 'OBSERVE':
        const observeContent = response.content || '（无观察结果）';
        onStream(`\n[OBSERVE] ${observeContent}\n`);
        this.messageHistory.push({ role: 'assistant', content: responseText });
        return response;

      case 'EDIT':
        if (response.editOps && response.editOps.length > 0) {
          onStream(`\n[EDIT] Applying ${response.editOps.length} edits...\n`);
          onEditPreview(response.editOps);
          
          // 应用编辑（幂等）
          for (const op of response.editOps) {
            await this.diffEngine.applyEdit(op);
          }
          
          this.messageHistory.push({ role: 'assistant', content: responseText });
        }
        return { ...response, nextState: 'OBSERVE' };

      case 'WAIT_USER':
        onStream(`\n[WAIT] ${response.question}\n`);
        this.messageHistory.push({ role: 'assistant', content: responseText });
        return response;

      case 'DONE':
        onStream(`\n[DONE] ${response.content}\n`);
        return response;

      default:
        throw new Error(`Invalid state: ${state}`);
    }
  }

  /**
   * 继续执行（用户回复后）
   */
  async continueWithUserInput(
    userInput: string,
    onStream: (chunk: string) => void,
    onStateChange: (state: AgentState) => void,
    onEditPreview: (ops: EditOperation[]) => void
  ): Promise<void> {
    if (this.currentState !== 'WAIT_USER') {
      throw new Error('Not waiting for user input');
    }

    this.messageHistory.push({ role: 'user', content: userInput });
    this.currentState = 'PLAN';
    this.isRunning = true;

    try {
      while (this.currentState !== 'DONE' && this.currentState !== 'WAIT_USER' && this.isRunning) {
        onStateChange(this.currentState);

        const response = await this.executeState(
          this.currentState,
          onStream,
          onEditPreview
        );

        if (response.nextState && VALID_STATES.includes(response.nextState)) {
          this.currentState = response.nextState;
        } else {
          this.currentState = this.getDefaultNextState(this.currentState);
        }
      }

      if (this.currentState === 'WAIT_USER') {
        onStateChange('WAIT_USER');
      }
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * 停止 Agent
   */
  stop(): void {
    this.isRunning = false;
  }

  /**
   * 重置状态
   */
  reset(): void {
    this.currentState = 'PLAN';
    this.messageHistory = [];
    this.isRunning = false;
  }

  private getDefaultNextState(current: AgentState): AgentState {
    const transitions: Record<AgentState, AgentState> = {
      PLAN: 'ACT',
      ACT: 'OBSERVE',
      OBSERVE: 'ACT',
      EDIT: 'OBSERVE',
      WAIT_USER: 'WAIT_USER',
      DONE: 'DONE',
    };
    return transitions[current] || 'DONE';
  }

  /**
   * 从文本中提取第一个完整的 JSON 对象
   * 解决模型有时会返回多个 JSON 对象拼在一起的问题
   */
  private extractFirstJson(text: string): string | null {
    let depth = 0;
    let start = -1;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '{') {
        if (start === -1) start = i;
        depth++;
      } else if (text[i] === '}') {
        depth--;
        if (depth === 0 && start !== -1) {
          return text.slice(start, i + 1);
        }
      }
    }
    return null;
  }

  private buildSystemPrompt(): string {
    return `You are a coding assistant. Your task is to help users by reading and modifying code.

## Workflow
You must follow this workflow for EVERY user request:

1. PLAN → 2. ACT(read_file) → 3. OBSERVE → 4. ACT(write_file) or EDIT → 5. OBSERVE → 6. DONE

Never stop at OBSERVE. Always continue to modify the code if changes are needed.

### Step-by-step process:
- **PLAN**: Analyze the request and create a plan. Always plan to read the file first.
- **ACT**: Call a tool. First call read_file to get the code, then call write_file to make changes.
- **OBSERVE**: Examine the tool result and decide next action. If more work is needed, set nextState to ACT. If done, set nextState to DONE.
- **EDIT**: Apply precise search/replace edits (use this when you know exactly what to change).
- **DONE**: Only go to DONE when all requested changes have been applied.

**Important**: After reading a file, do NOT just observe and stop. You MUST continue to ACT (write_file) or EDIT to make the requested changes.

## Available Tools
- read_file: Read file content (required params: path)
- write_file: Write file content (required params: path, content)
- search_code: Search code patterns
- run_terminal: Execute terminal commands (in sandbox)
- list_directory: List directory contents
- get_diagnostics: Get error diagnostics

## State Machine Response Formats

### PLAN
{
  "state": "PLAN",
  "content": "Describe your plan here",
  "nextState": "ACT"
}

### ACT
{
  "state": "ACT",
  "toolCall": {
    "name": "read_file",
    "params": { "path": "d:/path/to/file.py" }
  }
}

### OBSERVE
{
  "state": "OBSERVE",
  "content": "What I observed from the tool result",
  "nextState": "ACT"
}
(nextState must be ACT, EDIT, WAIT_USER, or DONE. If more work remains, use ACT or EDIT.)

### EDIT
{
  "state": "EDIT",
  "editOps": [
    {
      "path": "d:/path/to/file.py",
      "search": "exact code to find (including surrounding lines for uniqueness)",
      "replace": "new code to replace with",
      "idempotentKey": "unique-key-for-this-edit"
    }
  ]
}

### DONE
{
  "state": "DONE",
  "content": "Summary of what was done"
}

## Rules
- Always respond with valid JSON matching the current state schema
- read_file requires "path" parameter (must be a valid file path)
- write_file requires "path" AND "content" parameters
- After OBSERVE, always set nextState to continue working (use ACT or EDIT, never DONE until changes are applied)
- When you have successfully made all requested changes, set nextState to DONE
- If you need clarification, use WAIT_USER state`;
  }

  private formatContextMessage(ctx: AgentContext, userMsg: string): string {
    const parts: string[] = [];
    
    if (ctx.currentFile) {
      parts.push(`Current file: ${ctx.currentFile}`);
    }
    
    if (ctx.selectedCode) {
      parts.push(`Selected code:\n\`\`\`\n${ctx.selectedCode}\n\`\`\``);
    }
    
    if (ctx.diagnostics.length > 0) {
      const errors = ctx.diagnostics.slice(0, 5).map(d => 
        `[${d.severity}] ${d.message} at line ${d.range.start.line}`
      ).join('\n');
      parts.push(`Diagnostics:\n${errors}`);
    }

    parts.push(`\nUser request: ${userMsg}`);
    
    return parts.join('\n\n');
  }
}

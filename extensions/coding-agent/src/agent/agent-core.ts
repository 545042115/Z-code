import * as vscode from 'vscode';
import { LLMProvider, Message, GenerateRequest, LLMProviderFactory } from '../llm/llm-provider';
import { ToolRegistry } from '../tools/tool-registry';
import { ContextManager } from '../context/context-manager';
import { WorkspaceFile } from '../context/workspaceScanner';
import { MemoryManager } from '../memory/memoryManager';
import { EmbeddingManager } from '../embedding/embeddingManager';
import { Planner, ExecutionPlan, IncrementalContext } from '../planner/planner';
import { RepoGraph } from '../context/repoGraph';
import { DiffEngine } from '../utils/diff-engine';
import { Verifier, VerifierOutput } from './verifier';
import { ConfigManager } from '../config/config-manager';

/**
 * 三层混合架构 Agent Core
 *
 * ┌─────────────────────────────────────────────────────┐
 * │  Layer 1: Planner (宏观 Plan-and-Execute)           │
 * │  将复杂需求拆解为子任务列表，生成高层计划            │
 * ├─────────────────────────────────────────────────────┤
 * │  Layer 2: ReAct Executor (微观 ReAct)               │
 * │  每个子任务内：THINK → ACT → OBSERVE 循环          │
 * │  THINK：推理思考，决定工具调用                       │
 * │  ACT：执行工具或编辑                                │
 * │  OBSERVE：观察结果，继续 ReAct 或提交子任务         │
 * ├─────────────────────────────────────────────────────┤
 * │  Layer 3: Reflector (兜底反思)                      │
 * │  子任务完成后审查输出，发现缺陷后自动迭代修正       │
 * └─────────────────────────────────────────────────────┘
 */

export type AgentState = 'PLANNING' | 'THINK' | 'ACT' | 'OBSERVE' | 'VERIFIER' | 'REFLECT' | 'WAIT_USER' | 'DONE';
export type ExecutionMode = 'compact' | 'full';

export const VALID_STATES: AgentState[] = ['PLANNING', 'THINK', 'ACT', 'OBSERVE', 'VERIFIER', 'REFLECT', 'WAIT_USER', 'DONE'];

export interface SubTask {
  id: string;
  description: string;
  goal: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface AgentContext {
  currentFile?: string;
  selectedCode?: string;
  cursorPosition?: vscode.Position;
  openFiles: string[];
  diagnostics: vscode.Diagnostic[];
  workspaceInfo?: string;
  repoMap?: string;
}

export interface StateResponse {
  state: AgentState;
  content?: string;
  context?: string;
  plan?: { title: string; subTasks: SubTask[] };
  subTaskId?: string;
  subTaskPlan?: string;
  toolCall?: ToolCall;
  editOps?: EditOperation[];
  question?: string;
  nextState?: AgentState;
  subTaskStatus?: 'continue' | 'complete';
  reflection?: {
    verdict: 'pass' | 'needs_revision';
    feedback: string;
    issues?: string[];
  };
}

interface ExecutionRouteDecision {
  mode: ExecutionMode;
  reason: string;
  confidence: 'low' | 'medium' | 'high';
  needsContext: 'minimal' | 'focused' | 'broad';
}

interface ReplanDecision {
  action: 'continue_compact' | 'switch_to_full';
  reason: string;
  plan?: { title: string; subTasks: SubTask[] };
}

interface AutoCompactSummary {
  summary: string;
  completedProgress: string[];
  currentFocus: string[];
  importantEvidence: string[];
  openIssues: string[];
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

export interface PlanChecklistItem {
  id: string;
  description: string;
  goal: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface PlanSnapshot {
  planId: string;
  title: string;
  mode: ExecutionMode;
  summary: string;
  items: PlanChecklistItem[];
}

export interface ProcessRequestOptions {
  deferEditApplication?: boolean;
  onPlanUpdate?: (plan: PlanSnapshot) => void;
}

const STATE_SCHEMAS: Record<AgentState, object> = {
  PLANNING: {
    type: 'object',
    properties: {
      state: { const: 'PLANNING' },
      content: { type: 'string', description: '分析用户需求，概述要实现的目标' },
      plan: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'To-Do List 标题，简洁概括本次任务' },
          subTasks: {
            type: 'array',
            description: '结构化 To-Do List。简单任务也必须输出数组，但只保留一步；复杂任务输出多步。',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: '子任务编号，如 "task-1"' },
                description: { type: 'string', description: '待办项描述，适合展示为 Checklist 文案' },
                goal: { type: 'string', description: '完成标准，如何判断该待办项完成' },
              },
              required: ['id', 'description', 'goal'],
            },
            minItems: 1,
          },
        },
        required: ['title', 'subTasks'],
      },
      nextState: { const: 'THINK' },
    },
    required: ['state', 'content', 'plan', 'nextState'],
  },

  THINK: {
    type: 'object',
    properties: {
      state: { const: 'THINK' },
      subTaskId: { type: 'string', description: '当前正在处理的子任务 ID' },
      content: { type: 'string', description: '分析当前子任务，判断需要做什么' },
      subTaskPlan: { type: 'string', description: '针对当前子任务的具体执行计划' },
    },
    required: ['state', 'subTaskId', 'content', 'subTaskPlan'],
  },

  ACT: {
    type: 'object',
    properties: {
      state: { const: 'ACT' },
      subTaskId: { type: 'string', description: '当前子任务 ID' },
      content: { type: 'string', description: '执行说明' },
      toolCall: {
        type: 'object',
        properties: {
          name: { type: 'string', enum: ['read_file', 'write_file', 'search_code', 'run_terminal', 'list_directory', 'get_diagnostics', 'build_context', 'project_context', 'memory_search', 'embedding_search', 'get_repo_graph'] },
          params: { type: 'object' },
        },
        required: ['name', 'params'],
      },
      editOps: {
        type: 'array',
        description: '编辑操作列表。创建新文件时 search 设为空字符串，replace 设为完整文件内容；修改已有文件时 search 设为要查找的代码片段，replace 设为替换后的代码',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '文件的绝对路径' },
            search: { type: 'string', description: '要查找的代码片段。创建新文件时设为空字符串 ""' },
            replace: { type: 'string', description: '替换后的代码。创建新文件时设为完整文件内容' },
            idempotentKey: { type: 'string', description: '幂等键，用于防止重复应用' },
          },
          required: ['path', 'search', 'replace', 'idempotentKey'],
        },
      },
    },
    oneOf: [
      { required: ['state', 'subTaskId', 'toolCall'] },
      { required: ['state', 'subTaskId', 'editOps'] },
    ],
  },

  OBSERVE: {
    type: 'object',
    properties: {
      state: { const: 'OBSERVE' },
      subTaskId: { type: 'string', description: '当前子任务 ID' },
      content: { type: 'string', description: '分析工具返回的结果' },
      subTaskStatus: { enum: ['continue', 'complete'], description: 'continue=子任务还需更多步骤, complete=子任务已完成' },
      nextState: { enum: ['THINK', 'REFLECT', 'WAIT_USER'], description: 'THINK=继续当前子任务, REFLECT=提交审查, WAIT_USER=需要帮助' },
    },
    required: ['state', 'subTaskId', 'content', 'subTaskStatus', 'nextState'],
  },

  VERIFIER: {
    type: 'object',
    properties: {
      state: { const: 'VERIFIER' },
      content: { type: 'string', description: '验证结果总结' },
      nextState: { const: 'REFLECT' },
    },
    required: ['state', 'content', 'nextState'],
  },

  REFLECT: {
    type: 'object',
    properties: {
      state: { const: 'REFLECT' },
      subTaskId: { type: 'string', description: '被审查的子任务 ID' },
      content: { type: 'string', description: '审查总结' },
      reflection: {
        type: 'object',
        properties: {
          verdict: { enum: ['pass', 'needs_revision'], description: 'pass=通过, needs_revision=需要修订' },
          feedback: { type: 'string', description: '详细的审查反馈' },
          issues: {
            type: 'array',
            items: { type: 'string' },
            description: '发现的具体问题列表',
          },
        },
        required: ['verdict', 'feedback'],
      },
      nextState: { enum: ['THINK', 'WAIT_USER', 'DONE'], description: 'THINK=继续修改, WAIT_USER=需要确认, DONE=全部完成' },
    },
    required: ['state', 'subTaskId', 'content', 'reflection', 'nextState'],
  },

  WAIT_USER: {
    type: 'object',
    properties: {
      state: { const: 'WAIT_USER' },
      question: { type: 'string', description: '需要用户确认或提供的额外信息' },
      context: { type: 'string', description: '为什么需要用户提供这些信息' },
    },
    required: ['state', 'question'],
  },

  DONE: {
    type: 'object',
    properties: {
      state: { const: 'DONE' },
      content: { type: 'string', description: '完成总结，列出完成了哪些子任务' },
      summary: {
        type: 'object',
        properties: {
          totalSubTasks: { type: 'number' },
          completed: { type: 'number' },
          details: { type: 'string' },
        },
      },
    },
    required: ['state', 'content'],
  },
};

export class AgentCore {
  private llm: LLMProvider;
  private tools: ToolRegistry;
  private diffEngine: DiffEngine;
  private verifier: Verifier;
  private currentState: AgentState = 'PLANNING';
  private currentExecutionMode: ExecutionMode = 'full';
  private messageHistory: Message[] = [];
  private isRunning: boolean = false;
  private lastVerificationResult: VerifierOutput | null = null;
  private pendingSubTaskForReflect: string | null = null;
  private compactMode: boolean = false;
  private deferEditApplication: boolean = false;
  private hasPendingEditPreview: boolean = false;

  private subTasks: SubTask[] = [];
  private currentSubTaskIndex: number = 0;
  private currentSubTaskReActCount: number = 0;
  private readonly MAX_REACT_PER_SUBTASK = 15;
  private readonly MAX_TOTAL_ITERATIONS = 50;
  private readonly MAX_REFLECT_REVISIONS = 3;
  private readonly AUTO_COMPACT_TOKEN_RATIO = 0.8;
  private readonly AUTO_COMPACT_MIN_HISTORY_MESSAGES = 18;
  private readonly AUTO_COMPACT_KEEP_TAIL_MESSAGES = 10;
  private readonly AUTO_COMPACT_MIN_INTERVAL = 3;
  private readonly AUTO_COMPACT_MAX_SUMMARY_CHARS = 1800;
  private totalIterations = 0;
  private reflectRevisionCount = 0;
  private activeIntent: ExecutionPlan['intent'] = 'other';
  private activeUserMessage: string = '';
  private planUpdateCallback?: (plan: PlanSnapshot) => void;
  private activePlanId: string = '';
  private autoCompactCount = 0;
  private lastAutoCompactIteration = -999;

  private readonly SYSTEM_PROMPT: string;

  constructor(
    private readonly extensionContext: vscode.ExtensionContext,
    private readonly contextManager: ContextManager
  ) {
    this.llm = LLMProviderFactory.createFromConfigManager();
    this.tools = new ToolRegistry(this.contextManager);
    this.diffEngine = new DiffEngine();
    this.verifier = new Verifier();

    this.SYSTEM_PROMPT = this.buildSystemPrompt();

    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('codingAgent.llm')) {
        this.llm = LLMProviderFactory.createFromConfigManager();
      }
    });
  }

  async processRequest(
    userMessage: string,
    onStream: (chunk: string) => void,
    onStateChange: (state: AgentState) => void,
    onEditPreview: (ops: EditOperation[]) => void,
    sessionIdOverride?: string,
    options?: ProcessRequestOptions
  ): Promise<void> {
    if (this.isRunning) {
      throw new Error('Agent is already running');
    }

    this.reset();
    this.isRunning = true;
    this.deferEditApplication = Boolean(options?.deferEditApplication);
    this.planUpdateCallback = options?.onPlanUpdate;
    this.activePlanId = `plan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    try {
      const sessionId = sessionIdOverride || this.getSessionId();
      const planner = this.contextManager.planner;
      const memoryManager = this.contextManager.memoryManager;
      const editorCtx = await this.contextManager.gatherContext();

      const plan = planner.create(userMessage, sessionId);
      this.activeIntent = plan.intent;
      this.activeUserMessage = userMessage;
      const context = plan.context;
      context.currentFile = editorCtx.currentFile;
      const route = await this.decideExecutionRoute(userMessage, plan.intent, editorCtx, sessionId);
      this.currentExecutionMode = route.mode;
      this.compactMode = route.mode === 'compact';

      onStream(`模型判断：${this.describeExecutionMode(route.mode)}。${route.reason}\n\n`);

      let contextMessage = '';
      if (route.mode === 'full') {
        onStream('正在准备上下文...\n');
        for (const step of plan.steps) {
          const result = await planner.executeStep(step, userMessage, sessionId, context);
          if (result.status !== 'completed') {
            console.warn(`Planner step failed: ${step.description}`);
          }
        }
        contextMessage = await this.buildPipelinePrompt(userMessage, plan, context, editorCtx);
      } else {
        contextMessage = this.buildCompactPrompt(userMessage, plan.intent, editorCtx);
      }

      this.messageHistory = [
        { role: 'system', content: this.SYSTEM_PROMPT },
        { role: 'user', content: contextMessage },
      ];

      if (route.mode === 'full' && this.shouldUseDirectProjectAnswer(plan.intent)) {
        onStateChange('DONE');
        const answer = await this.generateDirectProjectAnswer(contextMessage, onStream);
        if (answer && !answer.endsWith('\n')) {
          onStream('\n');
        }
        this.messageHistory.push({ role: 'assistant', content: answer });
        memoryManager.addEntry(sessionId, 'user', userMessage, plan.intent);
        memoryManager.addEntry(sessionId, 'assistant', answer, plan.intent);
        memoryManager.addEntry(sessionId, 'context', plan.summary, plan.intent);
        return;
      }

      if (route.mode === 'compact') {
        this.initializeCompactTask(userMessage, plan.intent);
        this.currentState = 'THINK';
        onStream(`${this.getCompactProgressMessage(plan.intent)}\n`);
      } else {
        this.currentState = 'PLANNING';
      }
      this.totalIterations = 0;

      // Phase 3: ReAct 主循环
      while (
        this.currentState !== 'DONE' &&
        this.currentState !== 'WAIT_USER' &&
        this.isRunning &&
        this.totalIterations < this.MAX_TOTAL_ITERATIONS
      ) {
        if (this.shouldAnnounceState(this.currentState)) {
          onStateChange(this.currentState);
        }

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

        this.totalIterations++;
        await this.maybeAutoCompactHistory(onStream);
      }

      if (this.totalIterations >= this.MAX_TOTAL_ITERATIONS) {
        onStream('\n⚠️ 达到最大迭代次数，自动终止。\n\n');
        this.currentState = 'DONE';
      }

      // DONE 阶段：循环条件阻止了 DONE 的执行，需要单独触发一次以生成最终答案
      if (this.currentState === 'DONE') {
        if (this.shouldAnnounceState('DONE')) {
          onStateChange('DONE');
        }
        const doneResponse = await this.executeState(
          'DONE',
          onStream,
          onEditPreview
        );
        // 将 DONE 的回复也存入记忆
        if (doneResponse.content) {
          this.messageHistory.push({ role: 'assistant', content: doneResponse.content });
        }
      }

      if (this.shouldAnnounceState(this.currentState)) {
        onStateChange(this.currentState);
      }

      // 保存记忆
      memoryManager.addEntry(sessionId, 'user', userMessage, plan.intent);
      const finalAssistantMessage = this.messageHistory
        .slice()
        .reverse()
        .find(m => m.role === 'assistant' && m.content && m.content !== 'undefined');
      if (finalAssistantMessage?.content) {
        memoryManager.addEntry(sessionId, 'assistant', finalAssistantMessage.content, plan.intent);
      }
      memoryManager.addEntry(sessionId, 'context', plan.summary, plan.intent);
    } catch (err) {
      throw err;
    } finally {
      this.isRunning = false;
    }
  }

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
    this.currentState = 'THINK';
    this.isRunning = true;

    try {
      while (this.currentState !== 'DONE' && this.currentState !== 'WAIT_USER' && this.isRunning && this.totalIterations < this.MAX_TOTAL_ITERATIONS) {
        if (this.shouldAnnounceState(this.currentState)) {
          onStateChange(this.currentState);
        }

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

        this.totalIterations++;
        await this.maybeAutoCompactHistory(onStream);
      }

      if (this.totalIterations >= this.MAX_TOTAL_ITERATIONS) {
        onStream('\n⚠️ 达到最大迭代次数，自动终止。\n\n');
        this.currentState = 'DONE';
      }

      if (this.currentState === 'WAIT_USER') {
        if (this.shouldAnnounceState('WAIT_USER')) {
          onStateChange('WAIT_USER');
        }
      }
    } finally {
      this.isRunning = false;
    }
  }

  stop(): void {
    this.isRunning = false;
  }

  clearSessionMemory(sessionId: string): void {
    this.contextManager.memoryManager.clearSession(sessionId);
  }

  reset(): void {
    this.currentState = 'PLANNING';
    this.messageHistory = [];
    this.subTasks = [];
    this.currentSubTaskIndex = 0;
    this.currentSubTaskReActCount = 0;
    this.totalIterations = 0;
    this.reflectRevisionCount = 0;
    this.lastVerificationResult = null;
    this.pendingSubTaskForReflect = null;
    this.compactMode = false;
    this.currentExecutionMode = 'full';
    this.deferEditApplication = false;
    this.hasPendingEditPreview = false;
    this.isRunning = false;
    this.activeIntent = 'other';
    this.activeUserMessage = '';
    this.planUpdateCallback = undefined;
    this.activePlanId = '';
    this.autoCompactCount = 0;
    this.lastAutoCompactIteration = -999;
  }

  private async executeState(
    state: AgentState,
    onStream: (chunk: string) => void,
    onEditPreview: (ops: EditOperation[]) => void
  ): Promise<StateResponse> {
    if (state === 'VERIFIER') {
      return this.executeVerifier(onStream);
    }

    if (state === 'DONE') {
      let content = '';
      for await (const chunk of this.llm.generateStream({
        messages: this.buildMessagesForState(state),
        stream: false,
      })) {
        content += chunk;
        onStream(chunk);
      }
      content = content && content !== 'undefined'
        ? content
        : '(未生成最终答案)';
      if (!content.endsWith('\n')) {
        onStream('\n');
      }
      return { state: 'DONE', content };
    }

    const schema = STATE_SCHEMAS[state];
    const messagesForRequest = this.buildMessagesForState(state);

    const request: GenerateRequest = {
      messages: messagesForRequest,
      jsonSchema: schema,
      stream: false,
    };

    const { responseText, response } = await this.generateStructuredStateResponse(state, request);

    switch (state) {
      case 'PLANNING': {
        const plan = this.normalizePlanCandidate(response.plan) || this.buildFallbackPlan(this.activeUserMessage, this.activeIntent);
        this.commitPlan(plan, 'full');
        const safePlanContent = response.content && response.content !== 'undefined'
          ? response.content
          : '模型已生成执行计划。';
        const subTaskList = this.subTasks.map((st, i) =>
          `  ${i + 1}. ${st.description}`
        ).join('\n');

        if (!this.compactMode) {
          if (!response.plan) {
            onStream(`⚠️ 模型没有返回合法计划，已自动使用兜底计划。\n\n`);
          }
          onStream(`\n## 计划：${plan.title}\n\n${safePlanContent}\n\n\`\`\`\n${subTaskList}\n\`\`\`\n\n`);
        }

        this.messageHistory.push(
          { role: 'assistant', content: responseText },
          { role: 'user', content: `[计划已确认] 共 ${this.subTasks.length} 个子任务。请从第一个子任务开始，每个子任务内使用 THINK → ACT → OBSERVE 循环完成。` }
        );
        return response;
      }

      case 'THINK': {
        const currentTask = this.subTasks.find(st => st.id === response.subTaskId);
        const taskLabel = currentTask ? currentTask.description : response.subTaskId;
        let thinkMessageRecorded = false;

        this.currentSubTaskReActCount++;
        if (this.compactMode && this.currentSubTaskReActCount > 4) {
          this.messageHistory.push({ role: 'assistant', content: responseText });
          thinkMessageRecorded = true;
          const replanDecision = await this.decideCompactReplan(response, taskLabel);
          if (replanDecision.action === 'switch_to_full') {
            const nextPlan = this.normalizePlanCandidate(replanDecision.plan) || this.buildFallbackPlan(this.activeUserMessage, this.activeIntent);
            this.commitPlan(nextPlan, 'full');
            onStream(`任务超出简单模式范围，模型决定切换到完整规划：${replanDecision.reason}\n\n`);
            const subTaskList = this.subTasks.map((st, i) => `  ${i + 1}. ${st.description}`).join('\n');
            onStream(`\`\`\`\n${subTaskList}\n\`\`\`\n\n`);
            this.messageHistory.push({
              role: 'user',
              content: `[重规划已生效] 模型决定切换到完整流程。原因：${replanDecision.reason}`
            });
            return { state: 'THINK', content: response.content, subTaskId: this.subTasks[0]?.id, nextState: 'THINK' };
          }
          this.currentSubTaskReActCount = 0;
          onStream(`模型判断当前仍可继续轻量执行：${replanDecision.reason}\n\n`);
        }

        if (this.currentSubTaskReActCount > this.MAX_REACT_PER_SUBTASK) {
          if (!this.compactMode) {
            onStream(`\n**思考**（子任务: ${taskLabel}）\n\n${response.content}\n\n`);
          } else {
            onStream(`\n\n**[思考]** \n${response.content}\n\n**[/思考]**\n\n`);
          }
          return { state: 'THINK', content: response.content, subTaskId: response.subTaskId, nextState: 'REFLECT' };
        }

        const safeContent = response.content && response.content !== 'undefined' ? response.content : '(分析中...)';
        if (!this.compactMode) {
          onStream(`\n**思考**（子任务: ${taskLabel}）\n\n${safeContent}\n\n`);
        } else {
          onStream(`\n\n**[思考]** \n${safeContent}\n\n**[/思考]**\n\n`);
        }
        if (!thinkMessageRecorded) {
          this.messageHistory.push({ role: 'assistant', content: responseText });
        }
        return { ...response, nextState: 'ACT' };
      }

      case 'ACT': {
        const currentTask = this.subTasks.find(st => st.id === response.subTaskId);
        const taskLabel = currentTask ? currentTask.description : response.subTaskId;
        this.markSubTaskInProgress(response.subTaskId || '');

        if (response.toolCall) {
          if (!this.compactMode) {
            onStream(`**执行**（${taskLabel}）: \`${response.toolCall.name}\`\n\n`);
          }
          try {
            const result = await this.tools.execute(response.toolCall.name, response.toolCall.params);
            this.messageHistory.push(
              { role: 'assistant', content: responseText },
              { role: 'user', content: `[工具结果] ${response.toolCall.name} 返回：${JSON.stringify(result)}` }
            );
          } catch (toolErr) {
            const errMsg = toolErr instanceof Error ? toolErr.message : String(toolErr);
            onStream(`❌ 工具执行失败: ${errMsg}\n\n`);
            const toolName = response.toolCall!.name;
            let suggestion = '';
            if (toolName === 'read_file') {
              suggestion = '提示：路径可以是相对路径（如 "README.md"）或绝对路径。建议先用 list_directory 浏览目录结构，确认文件存在后再读取。';
            } else if (toolName === 'search_code') {
              suggestion = '提示：搜索词可能太具体。尝试简化 pattern（如只搜索函数名），或使用 search_symbols 工具。';
            } else if (toolName === 'list_directory') {
              suggestion = '提示：可以省略 path 参数来列出工作区根目录。';
            } else if (toolName === 'project_context' || toolName === 'build_context') {
              suggestion = '提示：该工具需要 request 参数。';
            }
            this.messageHistory.push(
              { role: 'assistant', content: responseText },
              { role: 'user', content: `[工具错误] ${toolName} 执行失败：${errMsg}。${suggestion}请修正后重试，或换用其他工具。` }
            );
          }
        } else if (response.editOps && response.editOps.length > 0) {
          if (!this.compactMode) {
            onStream(`**编辑**（${taskLabel}）: 修改 ${response.editOps.length} 个文件\n\n`);
          }
          onEditPreview(response.editOps);
          if (this.deferEditApplication) {
            this.hasPendingEditPreview = true;
            const pendingEditMsg = `[编辑待确认] 共生成 ${response.editOps.length} 处修改建议，尚未写入文件，必须等待用户确认后再应用。`;
            this.messageHistory.push(
              { role: 'assistant', content: responseText },
              { role: 'user', content: pendingEditMsg }
            );
            if (!this.compactMode) {
              onStream(`已生成 ${response.editOps.length} 处待确认修改，请在聊天面板中审阅后应用。\n\n`);
            }
            return { ...response, nextState: 'DONE' };
          }
          const failedEdits: string[] = [];
          for (const op of response.editOps) {
            try {
              await this.diffEngine.applyEdit(op);
            } catch (editErr) {
              const errMsg = editErr instanceof Error ? editErr.message : String(editErr);
              failedEdits.push(`${op.path}: ${errMsg}`);
            }
          }
          const editResultMsg = failedEdits.length > 0
            ? `[编辑完成] 已应用 ${response.editOps.length - failedEdits.length} 处修改，${failedEdits.length} 处失败：\n${failedEdits.join('\n')}`
            : `[编辑完成] 已应用 ${response.editOps.length} 处修改`;
          this.messageHistory.push(
            { role: 'assistant', content: responseText },
            { role: 'user', content: editResultMsg }
          );
        }
        return { ...response, nextState: 'OBSERVE' };
      }

      case 'OBSERVE': {
        const currentTask = this.subTasks.find(st => st.id === response.subTaskId);
        const taskLabel = currentTask ? currentTask.description : response.subTaskId;

        const safeObserveContent = response.content && response.content !== 'undefined' ? response.content : '(无观察结果)';
        if (!this.compactMode) {
          onStream(`**观察**（${taskLabel}）\n\n${safeObserveContent}\n\n`);
        } else {
          onStream(`\n\n**[观察]** \n${safeObserveContent}\n\n**[/观察]**\n\n`);
        }

        // 幻觉约束：检测工具返回的空数据或错误模式，注入警告
        const observeContent = response.content || '';
        const isEmptyOrError = this.isToolResultEmptyOrError(observeContent);
        if (isEmptyOrError) {
          const warning = `[系统警告] 工具返回了空数据或错误信息。你绝不能基于此编造内容。你必须：1) 使用其他工具重新获取数据 2) 明确告知用户你无法获取所需信息 3) 不要猜测或编造任何代码内容`;
          this.messageHistory.push(
            { role: 'assistant', content: responseText },
            { role: 'user', content: warning }
          );
        } else {
          this.messageHistory.push({ role: 'assistant', content: responseText });
        }

        if (response.subTaskStatus === 'complete') {
          this.markSubTaskCompleted(response.subTaskId || '');
          this.pendingSubTaskForReflect = response.subTaskId || null;
          if (!this.compactMode) {
            onStream(`→ 子任务 "**${taskLabel}**" 完成，正在验证...\n\n`);
          }
          return { state: 'OBSERVE', content: response.content, subTaskId: response.subTaskId, subTaskStatus: 'complete', nextState: 'VERIFIER' };
        }

        return response;
      }

      case 'REFLECT': {
        const currentTask = this.subTasks.find(st => st.id === response.subTaskId);
        const taskLabel = currentTask ? currentTask.description : response.subTaskId;
        const reflection = response.reflection || { verdict: 'pass', feedback: 'Automatic pass (no reflection data from LLM)', issues: [] };

        if (!this.compactMode) {
          onStream(`## 反思审查（${taskLabel || 'unknown'}）\n\n${response.content || 'No detailed review provided.'}\n\n`);
          if (reflection.issues && reflection.issues.length > 0) {
            onStream(`发现的问题:\n`);
            for (const issue of reflection.issues) {
              onStream(`- ${issue}\n`);
            }
            onStream(`\n`);
          }
        }

        this.messageHistory.push({ role: 'assistant', content: responseText });

        if (reflection.verdict === 'needs_revision') {
          this.reflectRevisionCount++;
          if (this.reflectRevisionCount >= this.MAX_REFLECT_REVISIONS) {
            if (!this.compactMode) {
              onStream(`→ 已修订 ${this.reflectRevisionCount} 次，强制通过\n\n`);
            }
            reflection.verdict = 'pass';
            const nextTaskIndex = this.findNextPendingSubTaskIndex();
            if (nextTaskIndex >= 0) {
              response.nextState = 'THINK';
            } else {
              response.nextState = 'DONE';
            }
          } else {
            if (!this.compactMode) {
              onStream(`→ 需要修订 (${this.reflectRevisionCount}/${this.MAX_REFLECT_REVISIONS}): ${reflection.feedback}\n\n`);
            }
            this.currentSubTaskReActCount = 0;
            // 将子任务状态改回 in_progress
            const task = this.subTasks.find(st => st.id === response.subTaskId);
            if (task) {
              task.status = 'in_progress';
              this.currentSubTaskIndex = this.subTasks.findIndex(st => st.id === response.subTaskId);
              this.emitPlanUpdate(response.content || reflection.feedback || '子任务需要返工');
            }
          }
        } else {
          // verdict === 'pass'
          this.reflectRevisionCount = 0;
          const nextTaskIndex = this.findNextPendingSubTaskIndex();
          if (nextTaskIndex >= 0) {
            if (!this.compactMode) {
              onStream(`→ 通过。继续下一个子任务...\n\n`);
            }
            response.nextState = 'THINK';
          } else {
            if (!this.compactMode) {
              onStream(`→ 全部完成！正在生成最终答案...\n\n`);
            }
            response.nextState = 'DONE';
          }
        }

        return { ...response, reflection, subTaskId: response.subTaskId || this.pendingSubTaskForReflect || '' };
      }

      case 'WAIT_USER':
        onStream(`\n**需要你的确认**\n\n${response.question}\n\n`);
        this.messageHistory.push({ role: 'assistant', content: responseText });
        return response;

      default:
        throw new Error(`Invalid state: ${state}`);
    }
  }

  private async executeVerifier(onStream: (chunk: string) => void): Promise<StateResponse> {
    // 检查是否有任何验证工具可用，没有则直接跳过
    const available = await this.verifier.isAvailable();
    if (!available) {
      this.lastVerificationResult = null; // 清除上一次的验证结果，避免污染 REFLECT
      const subTaskId = this.pendingSubTaskForReflect || '';
      this.pendingSubTaskForReflect = null;
      return { state: 'VERIFIER', content: '(无可用验证工具)', subTaskId, nextState: 'REFLECT' };
    }

    if (!this.compactMode) {
      onStream(`**验证**\n\n`);
    }
    const result = await this.verifier.verify();
    this.lastVerificationResult = result;

    if (!this.compactMode) {
      const icon = result.hasIssues ? '❌' : '✅';
      onStream(`${icon} 验证完成\n\`\`\`\n${result.summary}\n\`\`\`\n\n`);
    }

    this.messageHistory.push({
      role: 'user',
      content: `[验证结果]\n${result.summary}`,
    });

    const subTaskId = this.pendingSubTaskForReflect || '';
    this.pendingSubTaskForReflect = null;

    return { state: 'VERIFIER', content: result.summary, subTaskId, nextState: 'REFLECT' };
  }

  private buildMessagesForState(state: AgentState): Message[] {
    const planContext = this.buildPlanContext();

    if (state === 'PLANNING') {
      return this.buildPlanningMessages();
    }

    const messages: Message[] = [
      {
        role: 'system',
        content: `${this.SYSTEM_PROMPT}\n\n## 当前执行计划\n\n${planContext}`,
      },
      ...this.messageHistory.slice(1),
    ];

    if (this.compactMode && state !== 'DONE') {
      messages[0] = {
        role: 'system',
        content: `${messages[0].content}\n\n## Compact Mode\nThis is a small, localized request. Use a single focused sub-task. Avoid over-planning, avoid inventing extra files or hidden paths, and prefer the active file or files explicitly mentioned by the user. Keep internal reasoning short and action-oriented.`,
      };
    }

    if (state === 'REFLECT') {
      const completedTasks = this.subTasks
        .filter(st => st.status === 'completed')
        .map(st => `  ${st.id}: ${st.description}`)
        .join('\n');
      const lastCompleted = this.subTasks
        .filter(st => st.status === 'completed')
        .pop();
      const lastId = lastCompleted ? lastCompleted.id : '';

      // 只在有验证结果时才注入
      const verifierSection = this.lastVerificationResult && this.lastVerificationResult.summary
        ? `\n\n## 验证结果\n\n${this.lastVerificationResult.summary}\n`
        : '\n\n';

      let reflectPrompt = `## 已完成子任务\n\n${completedTasks}\n\n请审查子任务 ${lastId} 的输出质量。`;

      // 明确区分需要 revision 的情况
      reflectPrompt += `${verifierSection}请严格审查：\n`;
      reflectPrompt += `- 如果存在代码逻辑错误、语法错误、或明显的问题 → verdict: "needs_revision"\n`;
      reflectPrompt += `- 如果文件找不到、无法获取数据，但任务本身是正确的 → verdict: "pass"，在 feedback 中说明情况\n`;
      reflectPrompt += `- 如果任务完全正确 → verdict: "pass"\n`;
      reflectPrompt += `\n你的响应必须包含 subTaskId（值为 "${lastId}"）和 reflection 字段。`;

      messages[0] = {
        role: 'system',
        content: `${messages[0].content}\n\n${reflectPrompt}`,
      };
    }

    if (state === 'DONE') {
      const completedTasks = this.subTasks
        .filter(st => st.status === 'completed')
        .map(st => `  ${st.id}: ${st.description}`)
        .join('\n');
      messages[0] = {
        role: 'system',
        content: `${messages[0].content}\n\n## 最终输出阶段\n\n所有子任务已完成。你的任务是：基于以上所有对话历史，为用户生成一个完整、清晰、适合聊天面板展示的最终答案。\n\n已完成的子任务：\n${completedTasks}\n\n${this.getFinalAnswerFormatInstructions(this.compactMode)}${this.hasPendingEditPreview ? '\n当前有待确认的修改建议尚未写入文件。你必须明确告诉用户这些改动仍处于待审阅状态，不要表述成已经修改完成。' : ''}`,
      };
      // 注入一条 user 消息触发最终答案生成
      messages.push({
        role: 'user',
        content: '请基于以上所有分析和操作，给我一个完整的最终答案。',
      });
    }

    return messages;
  }

  private buildPlanningMessages(): Message[] {
    const planningPrompt = [
      this.SYSTEM_PROMPT,
      '## Planning Mode',
      'Generate a structured JSON To-Do List for the current request.',
      'Use a cache-friendly layout: stable planning rules first, request-specific context later.',
      'Rules:',
      '- Always return a `plan` object with `title` and `subTasks`.',
      '- If the request is simple, create exactly 1 subTask.',
      '- If the request is complex, create multiple subTasks in execution order.',
      '- Each subTask must be user-visible, concise, and suitable for a checklist.',
      '- Do not skip planning even if you think the answer is obvious; represent the direct answer as a single-item checklist.',
      '- Preserve compatibility with the existing ReAct execution flow: every item should be actionable by THINK -> ACT -> OBSERVE.',
    ].join('\n\n');

    return [
      {
        role: 'system',
        content: planningPrompt,
      },
      ...this.messageHistory.slice(1),
    ];
  }

  private shouldUseDirectProjectAnswer(intent: string): boolean {
    return intent === 'project_understanding';
  }

  private describeExecutionMode(mode: ExecutionMode): string {
    return mode === 'compact' ? '适合轻量流程' : '适合完整规划流程';
  }

  private buildCompactPrompt(request: string, intent: string, editorCtx: AgentContext): string {
    return this.buildFastPrompt(request, intent, editorCtx);
  }

  private buildFastPrompt(request: string, intent: string, editorCtx: AgentContext): string {
    const staticParts: string[] = [];
    const dynamicParts: string[] = [];
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    const workspaceName = workspaceRoot
      ? workspaceRoot.replace(/\\/g, '/').split('/').filter(Boolean).pop()
      : 'workspace';

    staticParts.push('You are a coding assistant integrated into VS Code.');
    staticParts.push('## Cache-Friendly Prompt Layout');
    staticParts.push('Static guidance and workspace facts are intentionally placed first. Task-specific context appears later.');
    staticParts.push(`## Intent\n${intent}`);
    staticParts.push(`## Workspace\n${workspaceName}`);
    if (workspaceRoot) {
      staticParts.push(`## Workspace Root\n${workspaceRoot}`);
    }
    staticParts.push('## Operating Rules');
    staticParts.push('Prefer the active file or selected code. Only search broader files when local evidence is insufficient.');
    staticParts.push('Keep tools and edits grounded in actual source evidence. Do not invent hidden files or paths.');

    if (editorCtx.currentFile) {
      dynamicParts.push(`## Active File\n${editorCtx.currentFile}`);
    }
    if (editorCtx.selectedCode) {
      dynamicParts.push(`## Selected Code\n\`\`\`\n${editorCtx.selectedCode}\n\`\`\``);
    }
    if (editorCtx.openFiles.length > 0) {
      dynamicParts.push(`## Open Files\n${editorCtx.openFiles.slice(0, 5).map(file => `- ${file}`).join('\n')}`);
    }
    if (editorCtx.diagnostics.length > 0) {
      const diagnostics = editorCtx.diagnostics
        .slice(0, 5)
        .map(d => `- ${d.message} (line ${d.range.start.line + 1})`)
        .join('\n');
      dynamicParts.push(`## Diagnostics\n${diagnostics}`);
    }

    dynamicParts.push(`## Latest User Request\n${request}`);
    return [...staticParts, ...dynamicParts].join('\n\n');
  }

  private async decideExecutionRoute(
    userMessage: string,
    intent: ExecutionPlan['intent'],
    editorCtx: AgentContext,
    sessionId: string
  ): Promise<ExecutionRouteDecision> {
    const fallbackMode: ExecutionMode = this.shouldUseCompactMode(intent, userMessage, editorCtx) ? 'compact' : 'full';
    const memory = this.contextManager.memoryManager.getContextForPromptWithBudget(sessionId, 1200);
    const routeSchema = {
      type: 'object',
      properties: {
        mode: { enum: ['compact', 'full'] },
        reason: { type: 'string' },
        confidence: { enum: ['low', 'medium', 'high'] },
        needsContext: { enum: ['minimal', 'focused', 'broad'] },
      },
      required: ['mode', 'reason', 'confidence', 'needsContext'],
    };

    const messages: Message[] = [
      {
        role: 'system',
        content: [
          '你是执行路由器，负责决定当前请求适合轻量流程还是完整规划流程。',
          'compact 适用于：单文件、小范围、目标明确、可直接从当前文件或少量工具开始。',
          'full 适用于：跨文件、目标不明确、需要先规划、涉及架构/测试/重构/多阶段修改。',
          '如果需要广泛上下文或你不确定，请选择 full。',
          '只输出符合 schema 的 JSON。'
        ].join('\n'),
      },
      {
        role: 'user',
        content: [
          `Intent: ${intent}`,
          editorCtx.currentFile ? `Active file: ${editorCtx.currentFile}` : 'Active file: (none)',
          editorCtx.selectedCode ? `Selected code:\n${editorCtx.selectedCode.slice(0, 800)}` : 'Selected code: (none)',
          editorCtx.openFiles.length > 0 ? `Open files:\n${editorCtx.openFiles.slice(0, 5).join('\n')}` : 'Open files: (none)',
          memory ? memory : 'Conversation history: (none)',
          `User request: ${userMessage}`,
          `Heuristic fallback mode: ${fallbackMode}`,
        ].join('\n\n'),
      },
    ];

    try {
      const { response } = await this.generateJsonObject<ExecutionRouteDecision>({
        messages,
        jsonSchema: routeSchema,
        stream: false,
      }, 'execution-route');
      return this.sanitizeExecutionRoute(response, intent, fallbackMode);
    } catch {
      return this.sanitizeExecutionRoute(undefined, intent, fallbackMode);
    }
  }

  private sanitizeExecutionRoute(
    route: Partial<ExecutionRouteDecision> | undefined,
    intent: ExecutionPlan['intent'],
    fallbackMode: ExecutionMode
  ): ExecutionRouteDecision {
    let mode: ExecutionMode = route?.mode === 'compact' ? 'compact' : route?.mode === 'full' ? 'full' : fallbackMode;
    let needsContext: ExecutionRouteDecision['needsContext'] =
      route?.needsContext === 'minimal' || route?.needsContext === 'focused' || route?.needsContext === 'broad'
        ? route.needsContext
        : mode === 'compact' ? 'minimal' : 'broad';
    const confidence = route?.confidence === 'low' || route?.confidence === 'medium' || route?.confidence === 'high'
      ? route.confidence
      : 'low';

    if ((intent === 'project_understanding' || intent === 'refactor' || intent === 'removal' || intent === 'testing') && mode === 'compact') {
      mode = 'full';
      needsContext = 'broad';
    }
    if (needsContext === 'broad') {
      mode = 'full';
    }

    return {
      mode,
      confidence,
      needsContext,
      reason: route?.reason?.trim() || (mode === 'compact' ? '当前任务目标较集中，可先轻量执行。' : '当前任务需要规划或更广上下文支持。'),
    };
  }

  private async decideCompactReplan(
    response: StateResponse,
    taskLabel?: string
  ): Promise<ReplanDecision> {
    const schema = {
      type: 'object',
      properties: {
        action: { enum: ['continue_compact', 'switch_to_full'] },
        reason: { type: 'string' },
        plan: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            subTasks: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  description: { type: 'string' },
                  goal: { type: 'string' },
                },
                required: ['id', 'description', 'goal'],
              },
            },
          },
          required: ['title', 'subTasks'],
        },
      },
      required: ['action', 'reason'],
    };

    const recentMessages = this.messageHistory.slice(-8).map(m => `[${m.role}] ${m.content}`).join('\n\n');
    try {
      const { response: decision } = await this.generateJsonObject<ReplanDecision>({
        messages: [
          {
            role: 'system',
            content: [
              '你负责判断当前轻量流程是否仍然合适。',
              '如果任务已经明显变成跨文件、多阶段、需要完整规划，请返回 switch_to_full 并给出新的完整计划。',
              '如果当前轻量流程仍可继续，请返回 continue_compact。',
              '只输出符合 schema 的 JSON。'
            ].join('\n'),
          },
          {
            role: 'user',
            content: [
              `Original request: ${this.activeUserMessage}`,
              `Intent: ${this.activeIntent}`,
              `Current compact task: ${taskLabel || 'compact-task'}`,
              `Latest reasoning: ${response.content || '(none)'}`,
              `Current plan context:\n${this.buildPlanContext()}`,
              recentMessages ? `Recent history:\n${recentMessages}` : 'Recent history: (none)',
            ].join('\n\n'),
          },
        ],
        jsonSchema: schema,
        stream: false,
      }, 'compact-replan');

      if (decision.action === 'switch_to_full') {
        const normalizedPlan = this.normalizePlanCandidate(decision.plan);
        if (normalizedPlan) {
          return { ...decision, plan: normalizedPlan };
        }
      }
      return {
        action: decision.action === 'switch_to_full' ? 'continue_compact' : decision.action,
        reason: decision.reason || '模型未给出充分升级理由，继续轻量流程。',
      };
    } catch {
      return {
        action: 'continue_compact',
        reason: '重规划判断失败，暂时继续轻量流程。',
      };
    }
  }

  private normalizePlanCandidate(plan?: { title: string; subTasks: SubTask[] } | null): { title: string; subTasks: SubTask[] } | null {
    if (!plan || !plan.title || !Array.isArray(plan.subTasks) || plan.subTasks.length === 0) {
      return null;
    }

    const normalizedTasks = plan.subTasks
      .filter(st => st && typeof st.id === 'string' && typeof st.description === 'string' && typeof st.goal === 'string')
      .map((st, index) => ({
        id: st.id.trim() || `task-${index + 1}`,
        description: st.description.trim() || `子任务 ${index + 1}`,
        goal: st.goal.trim() || '完成当前步骤',
        status: 'pending' as const,
      }));

    if (normalizedTasks.length === 0) {
      return null;
    }

    return {
      title: plan.title.trim() || '执行计划',
      subTasks: normalizedTasks,
    };
  }

  private buildFallbackPlan(userMessage: string, intent: ExecutionPlan['intent']): { title: string; subTasks: SubTask[] } {
    return {
      title: '兜底执行计划',
      subTasks: [
        {
          id: 'task-1',
          description: this.buildCompactTaskDescription(userMessage, intent),
          goal: '先收集足够证据并完成当前请求',
          status: 'pending',
        },
      ],
    };
  }

  private commitPlan(plan: { title: string; subTasks: SubTask[] }, mode: ExecutionMode): void {
    this.subTasks = plan.subTasks.map(st => ({ ...st, status: st.status || 'pending' }));
    this.currentSubTaskIndex = 0;
    this.currentSubTaskReActCount = 0;
    this.compactMode = mode === 'compact';
    this.currentExecutionMode = mode;
    this.emitPlanUpdate(`已生成 ${this.subTasks.length} 项待办`);
  }

  private emitPlanUpdate(summary: string): void {
    if (!this.planUpdateCallback || !this.activePlanId || this.subTasks.length === 0) {
      return;
    }

    this.planUpdateCallback({
      planId: this.activePlanId,
      title: this.currentExecutionMode === 'compact' ? '轻量待办清单' : '执行待办清单',
      mode: this.currentExecutionMode,
      summary,
      items: this.subTasks.map(st => ({
        id: st.id,
        description: st.description,
        goal: st.goal,
        status: st.status,
      })),
    });
  }

  private readonly RESERVED_OUTPUT_TOKENS = 4096;

  private getActiveContextWindowTokens(): number {
    const profile = ConfigManager.getActiveProfile();
    const modelMaxTokens = Math.max(profile?.maxTokens || 32768, 8192);
    return Math.max(modelMaxTokens - this.RESERVED_OUTPUT_TOKENS, 4096);
  }

  private estimateMessageTokens(message: Message): number {
    const content = message.content || '';
    const cjkChars = (content.match(/[\u3400-\u9fff]/g) || []).length;
    const otherChars = Math.max(content.length - cjkChars, 0);
    const roleCost = message.role === 'system' ? 12 : 8;
    return roleCost + cjkChars + Math.ceil(otherChars / 4);
  }

  private estimateHistoryTokens(messages: Message[]): number {
    return messages.reduce((total, message) => total + this.estimateMessageTokens(message), 0);
  }

  private getCompactableHistoryRange(): { start: number; end: number } | null {
    if (this.messageHistory.length < this.AUTO_COMPACT_MIN_HISTORY_MESSAGES) {
      return null;
    }

    const protectedPrefix = 2; // system prompt + initial context prompt
    const tailCount = Math.min(this.AUTO_COMPACT_KEEP_TAIL_MESSAGES, Math.max(this.messageHistory.length - protectedPrefix, 0));
    const start = protectedPrefix;
    const end = this.messageHistory.length - tailCount;
    if (end - start < 6) {
      return null;
    }
    return { start, end };
  }

  private shouldAutoCompactHistory(): boolean {
    const range = this.getCompactableHistoryRange();
    if (!range) {
      return false;
    }
    if (this.totalIterations - this.lastAutoCompactIteration < this.AUTO_COMPACT_MIN_INTERVAL) {
      return false;
    }

    const windowTokens = this.getActiveContextWindowTokens();
    const historyTokens = this.estimateHistoryTokens(this.messageHistory);
    const overTokenBudget = historyTokens >= Math.floor(windowTokens * this.AUTO_COMPACT_TOKEN_RATIO);
    const overMessageBudget = this.messageHistory.length >= this.AUTO_COMPACT_MIN_HISTORY_MESSAGES + 4;
    return overTokenBudget || overMessageBudget;
  }

  private buildAutoCompactPrompt(messagesToCompact: Message[]): Message[] {
    const transcript = messagesToCompact
      .map((message, index) => {
        const content = (message.content || '').trim();
        return `### ${index + 1}. ${message.role}\n${content}`;
      })
      .join('\n\n');

    return [
      {
        role: 'system',
        content: [
          '你负责将 Coding Agent 的历史执行记录压缩成可继续推理的摘要。',
          '保留以下信息：已完成进度、当前焦点、关键代码证据、工具错误/未解决问题。',
          '不要编造不存在的文件、工具结果或修改。',
          '输出必须是符合 schema 的 JSON，内容紧凑，可用于替换原始 THINK/ACT/OBSERVE 历史。',
        ].join('\n'),
      },
      {
        role: 'user',
        content: [
          `原始用户请求：${this.activeUserMessage}`,
          `当前执行模式：${this.currentExecutionMode}`,
          `当前计划：\n${this.buildPlanContext()}`,
          this.lastVerificationResult?.summary ? `最近验证结果：\n${this.lastVerificationResult.summary}` : '最近验证结果：无',
          this.hasPendingEditPreview ? '当前存在待确认的编辑预览，摘要必须保留该信息。' : '当前没有待确认的编辑预览。',
          '请压缩以下历史消息：',
          transcript,
        ].join('\n\n'),
      },
    ];
  }

  private formatAutoCompactSummary(summary: AutoCompactSummary): string {
    const sections: string[] = [];
    sections.push(`[Auto-Compact Summary #${this.autoCompactCount}]`);
    sections.push(`摘要：${summary.summary.trim()}`);

    if (summary.completedProgress.length > 0) {
      sections.push(`已完成进度：\n- ${summary.completedProgress.join('\n- ')}`);
    }
    if (summary.currentFocus.length > 0) {
      sections.push(`当前焦点：\n- ${summary.currentFocus.join('\n- ')}`);
    }
    if (summary.importantEvidence.length > 0) {
      sections.push(`关键证据：\n- ${summary.importantEvidence.join('\n- ')}`);
    }
    if (summary.openIssues.length > 0) {
      sections.push(`未解决问题：\n- ${summary.openIssues.join('\n- ')}`);
    }
    if (this.hasPendingEditPreview) {
      sections.push('待确认修改：存在未应用的编辑预览，最终答复前必须明确告知用户。');
    }

    return sections.join('\n\n').slice(0, this.AUTO_COMPACT_MAX_SUMMARY_CHARS);
  }

  private async summarizeHistoryForCompact(messagesToCompact: Message[]): Promise<string> {
    const schema = {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        completedProgress: { type: 'array', items: { type: 'string' } },
        currentFocus: { type: 'array', items: { type: 'string' } },
        importantEvidence: { type: 'array', items: { type: 'string' } },
        openIssues: { type: 'array', items: { type: 'string' } },
      },
      required: ['summary', 'completedProgress', 'currentFocus', 'importantEvidence', 'openIssues'],
    };

    const { response } = await this.generateJsonObject<AutoCompactSummary>({
      messages: this.buildAutoCompactPrompt(messagesToCompact),
      jsonSchema: schema,
      stream: false,
    }, 'auto-compact');

    return this.formatAutoCompactSummary({
      summary: response.summary || '已压缩较早的执行历史。',
      completedProgress: Array.isArray(response.completedProgress) ? response.completedProgress.slice(0, 6) : [],
      currentFocus: Array.isArray(response.currentFocus) ? response.currentFocus.slice(0, 4) : [],
      importantEvidence: Array.isArray(response.importantEvidence) ? response.importantEvidence.slice(0, 6) : [],
      openIssues: Array.isArray(response.openIssues) ? response.openIssues.slice(0, 4) : [],
    });
  }

  private buildFallbackCompactSummary(messagesToCompact: Message[]): string {
    const lastMessages = messagesToCompact.slice(-4).map(message => `[${message.role}] ${message.content}`.slice(0, 260));
    const lines = [
      `[Auto-Compact Summary #${this.autoCompactCount}]`,
      `摘要：已压缩较早的执行历史，保留最近上下文以继续当前任务。`,
      `当前计划：${this.buildPlanContext().slice(0, 400)}`,
    ];
    if (lastMessages.length > 0) {
      lines.push(`最近记录：\n- ${lastMessages.join('\n- ')}`);
    }
    if (this.lastVerificationResult?.summary) {
      lines.push(`最近验证：${this.lastVerificationResult.summary.slice(0, 300)}`);
    }
    if (this.hasPendingEditPreview) {
      lines.push('待确认修改：存在未应用的编辑预览。');
    }
    return lines.join('\n\n').slice(0, this.AUTO_COMPACT_MAX_SUMMARY_CHARS);
  }

  private async maybeAutoCompactHistory(onStream: (chunk: string) => void): Promise<void> {
    if (!this.isRunning || this.currentState === 'DONE' || this.currentState === 'WAIT_USER') {
      return;
    }
    if (!this.shouldAutoCompactHistory()) {
      return;
    }

    const range = this.getCompactableHistoryRange();
    if (!range) {
      return;
    }

    const messagesToCompact = this.messageHistory.slice(range.start, range.end);
    if (messagesToCompact.length === 0) {
      return;
    }

    const historyTokens = this.estimateHistoryTokens(this.messageHistory);
    onStream(`上下文接近上限，正在压缩历史...（约 ${historyTokens} tokens）\n`);

    this.autoCompactCount++;
    let summaryText = '';
    try {
      summaryText = await this.summarizeHistoryForCompact(messagesToCompact);
    } catch {
      summaryText = this.buildFallbackCompactSummary(messagesToCompact);
    }

    this.messageHistory = [
      ...this.messageHistory.slice(0, range.start),
      { role: 'assistant', content: summaryText },
      ...this.messageHistory.slice(range.end),
    ];
    this.lastAutoCompactIteration = this.totalIterations;
    onStream('历史压缩完成，已保留关键进度并继续执行。\n\n');
  }

  private shouldUseCompactMode(intent: string, userMessage: string, editorCtx: AgentContext): boolean {
    const trimmed = userMessage.trim();
    if (trimmed.length <= 10 && /^(你好|您好|hello|hi|hey)\s*[!！]?$/i.test(trimmed)) {
      return true;
    }

    if (intent === 'project_understanding' || intent === 'refactor' || intent === 'removal' || intent === 'testing') {
      return false;
    }

    const lower = userMessage.toLowerCase();
    if (this.looksComplexRequest(lower)) {
      return false;
    }

    if (intent === 'bug_fix') {
      return Boolean(editorCtx.currentFile);
    }

    if (intent === 'feature_add') {
      return this.isSmallGenerationRequest(lower) || Boolean(editorCtx.currentFile);
    }

    if (intent === 'documentation' || intent === 'other') {
      return Boolean(editorCtx.currentFile || editorCtx.selectedCode);
    }

    return false;
  }

  private looksComplexRequest(lower: string): boolean {
    return /(多文件|多个文件|整个项目|全局|整体|架构|跨文件|数据库|接口|模块|测试|部署|迁移|重构|repo|workspace|multi-file|across files|architecture|database|schema|integration|end-to-end|refactor)/i.test(lower);
  }

  private isSmallGenerationRequest(lower: string): boolean {
    return /(简短|简单|小程序|小游戏|示例|demo|sample|脚本|单文件|贪吃蛇|snake|python)/i.test(lower);
  }

  private initializeCompactTask(userMessage: string, intent: string): void {
    this.subTasks = [
      {
        id: 'compact-task-1',
        description: this.buildCompactTaskDescription(userMessage, intent),
        goal: '完成用户当前请求并给出直接结果',
        status: 'pending',
      },
    ];
    this.currentSubTaskIndex = 0;
    this.currentSubTaskReActCount = 0;
  }

  private buildCompactTaskDescription(userMessage: string, intent: string): string {
    if (intent === 'bug_fix') {
      return '检查当前问题并完成单点修复';
    }
    if (intent === 'feature_add') {
      return '实现用户请求的小范围功能';
    }
    if (intent === 'documentation') {
      return '解释当前代码或文件';
    }

    const trimmed = userMessage.replace(/\s+/g, ' ').trim();
    return trimmed.length > 36 ? `${trimmed.slice(0, 36)}...` : trimmed;
  }

  private getCompactProgressMessage(intent: string): string {
    if (intent === 'bug_fix') {
      return '正在检查问题并尝试修复...';
    }
    if (intent === 'feature_add') {
      return '正在生成并整理实现...';
    }
    if (intent === 'documentation') {
      return '正在读取代码并整理说明...';
    }
    return '正在处理请求...';
  }

  private shouldAnnounceState(state: AgentState): boolean {
    return !this.compactMode || state === 'WAIT_USER' || state === 'DONE';
  }

  private async generateDirectProjectAnswer(
    contextMessage: string,
    onStream: (chunk: string) => void
  ): Promise<string> {
    let responseText = '';
    for await (const chunk of this.llm.generateStream({
      messages: [
        {
          role: 'system',
          content: [
            '你是一个代码助手。',
            '你的任务是直接回答用户，不要展示内部计划、思考、子任务、验证、反思审查或工具执行过程。',
            '当用户要求介绍项目时，必须基于源码证据总结项目用途、核心模块、入口点、服务/路由、构建配置和测试方式。',
            '不要基于 README 正文作答，不要猜测不存在的文件路径。',
            this.getProjectAnswerFormatInstructions(),
          ].join('\n'),
        },
        {
          role: 'user',
          content: `${contextMessage}\n\n请直接根据以上上下文回答用户问题，只输出面向用户的最终答案。`,
        },
      ],
      stream: false,
    })) {
      responseText += chunk;
      onStream(chunk);
    }

    return responseText && responseText !== 'undefined'
      ? responseText
      : '未能生成项目介绍。';
  }

  private getProjectAnswerFormatInstructions(): string {
    return [
      '回答要简洁、准确，使用美观、稳定的 Markdown 结构。',
      '默认按下面结构输出：',
      '# 项目概述',
      '- 先用 1 句话总结这是一个什么项目、解决什么问题',
      '## 核心入口',
      '- 列出实际入口文件或启动点；没有就明确写未发现',
      '## 主要模块',
      '- 每条只讲一个模块及职责，优先引用实际源码文件',
      '## 运行与验证',
      '- 说明运行方式、构建配置、测试方式；没有就明确写未发现',
      '## 依据',
      '- 列出你实际参考的源码文件路径，使用行内代码',
      '要求：',
      '- 不要写“我分析了/根据上文/通过工具”等过程化措辞',
      '- 不要使用嵌套列表',
      '- 不要省略“依据”部分',
      '- 如果信息不足，明确写“未在当前代码中发现”，不要猜',
      '不要输出 JSON。'
    ].join('\n');
  }

  private getFinalAnswerFormatInstructions(compactMode: boolean): string {
    return [
      '请直接输出最终答案，不要输出 JSON。',
      '默认使用短标题 + 扁平项目符号，避免长段落堆叠。',
      '建议优先包含这些部分（按任务相关性取舍）：',
      '- 结果概述：先直接告诉用户完成了什么',
      '- 变更内容：说明关键修改点',
      '- 涉及文件：列出实际文件路径，使用行内代码',
      '- 使用方式：给出运行、验证或下一步操作',
      '- 注意事项：只写真正重要的限制或风险',
      compactMode
        ? '不要提及计划、思考、观察、验证、反思等内部阶段。对于简单任务，直接给结果、涉及的文件和运行/验证方式。'
        : '不要复述内部状态机过程，重点呈现结果本身。'
    ].join('\n');
  }

  private buildPlanContext(): string {
    if (this.subTasks.length === 0) {
      return '（计划尚未生成）';
    }

    const lines: string[] = [];
    for (let i = 0; i < this.subTasks.length; i++) {
      const st = this.subTasks[i];
      const statusMarker = st.status === 'completed' ? '✅' :
        st.status === 'in_progress' ? '🔄' : '  ';
      const highlight = i === this.currentSubTaskIndex ? ' ← 当前' : '';
      lines.push(`  ${statusMarker} ${st.id}: ${st.description}${highlight}`);
    }
    return lines.join('\n');
  }

  private getDefaultNextState(current: AgentState): AgentState {
    const transitions: Record<AgentState, AgentState> = {
      PLANNING: 'THINK',
      THINK: 'ACT',
      ACT: 'OBSERVE',
      OBSERVE: 'THINK',
      VERIFIER: 'REFLECT',
      REFLECT: 'THINK',
      WAIT_USER: 'WAIT_USER',
      DONE: 'DONE',
    };
    return transitions[current] || 'DONE';
  }

  private markSubTaskInProgress(subTaskId: string): void {
    const index = this.subTasks.findIndex(st => st.id === subTaskId);
    const task = index >= 0 ? this.subTasks[index] : undefined;
    if (task && task.status === 'pending') {
      task.status = 'in_progress';
      this.currentSubTaskIndex = index;
      this.emitPlanUpdate(`正在执行：${task.description}`);
    }
  }

  private markSubTaskCompleted(subTaskId: string): void {
    const task = this.subTasks.find(st => st.id === subTaskId);
    if (task) {
      task.status = 'completed';
      this.currentSubTaskIndex = this.subTasks.findIndex(st => st.id === subTaskId) + 1;
      this.currentSubTaskReActCount = 0;
      this.emitPlanUpdate(`已完成：${task.description}`);
    }
  }

  private findNextPendingSubTaskIndex(): number {
    return this.subTasks.findIndex(st => st.status === 'pending');
  }

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

  private tryParseStateResponse(responseText: string): StateResponse | null {
    try {
      return JSON.parse(responseText);
    } catch {
      const firstJson = this.extractFirstJson(responseText);
      if (!firstJson) return null;
      try {
        return JSON.parse(firstJson);
      } catch {
        return null;
      }
    }
  }

  private tryParseJsonResponse<T>(responseText: string): T | null {
    try {
      return JSON.parse(responseText) as T;
    } catch {
      const firstJson = this.extractFirstJson(responseText);
      if (!firstJson) return null;
      try {
        return JSON.parse(firstJson) as T;
      } catch {
        return null;
      }
    }
  }

  private async generateJsonObject<T>(
    request: GenerateRequest,
    label: string
  ): Promise<{ responseText: string; response: T }> {
    let messages = request.messages;

    for (let attempt = 0; attempt < 2; attempt++) {
      const responseText = await this.llm.generate({
        ...request,
        messages,
      });
      const response = this.tryParseJsonResponse<T>(responseText);
      if (response) {
        return { responseText, response };
      }

      if (attempt === 0) {
        messages = [
          ...messages,
          { role: 'assistant', content: responseText },
          {
            role: 'user',
            content: `你上一条回复不是合法 JSON。请严格按照既定 schema 重新输出一个且仅一个 JSON 对象。不要包含解释、Markdown、代码块或额外文本。任务标签：${label}。`,
          },
        ];
      } else {
        throw new Error(`模型返回了无效的 JSON 格式：${label}`);
      }
    }

    throw new Error(`模型返回了无效的 JSON 格式：${label}`);
  }

  private async generateStructuredStateResponse(
    state: AgentState,
    request: GenerateRequest
  ): Promise<{ responseText: string; response: StateResponse }> {
    let messages = request.messages;

    for (let attempt = 0; attempt < 2; attempt++) {
      const responseText = await this.llm.generate({
        ...request,
        messages,
      });
      const response = this.tryParseStateResponse(responseText);
      if (response) {
        return { responseText, response };
      }

      if (attempt === 0) {
        messages = [
          ...messages,
          { role: 'assistant', content: responseText },
          {
            role: 'user',
            content: `你上一条回复不是合法 JSON。请严格按照既定 schema 重新输出一个且仅一个 JSON 对象。不要包含解释、Markdown、代码块或额外文本。state 必须是 "${state}"。`,
          },
        ];
      } else {
        throw new Error(`模型返回了无效的 JSON 格式：${responseText.slice(0, 200)}`);
      }
    }

    throw new Error(`模型返回了无效的 JSON 格式：state=${state}`);
  }

  private buildSystemPrompt(): string {
    return `You are a coding assistant using a three-layer hybrid architecture: Plan-and-Execute + ReAct + Reflection.

## Architecture

### Layer 1: Planner (宏观)
When you receive a complex request, first break it down into sub-tasks.
Each sub-task should be a self-contained unit of work with a clear goal.

### Layer 2: ReAct Executor (微观)
For each sub-task, use the ReAct loop:
- **THINK**: Analyze the current sub-task. What do you need to do? What's the current state?
- **ACT**: Execute ONE action (tool call or edit). Only do one thing at a time.
- **OBSERVE**: Review the result. Decide: continue working on this sub-task or mark it complete.

### Layer 3: Reflector (兜底反思)
After completing a sub-task (subTaskStatus: "complete"), the system automatically transitions to REFLECT.
In REFLECT, review the work critically:
- Check for logic errors, missing edge cases, code quality issues
- If issues found → verdict: "needs_revision" → goes back to THINK
- If quality is good → verdict: "pass" → moves to next sub-task or DONE

## State Flow
PLANNING → THINK → ACT → OBSERVE → (THINK | VERIFIER) → REFLECT → (THINK | DONE)

- PLANNING: Create a plan with sub-tasks
- THINK: Reason about current sub-task, decide what to do
- ACT: Execute tool call or edit
- OBSERVE: Review result. Set subTaskStatus to "continue" or "complete"
- VERIFIER: (auto) Automated verification: tsc --noEmit, eslint, npm test. Runs when subTaskStatus is "complete".
- REFLECT: Review completed sub-task with verification results. Pass or request revision
- WAIT_USER: Need user input
- DONE: All done

## Available Tools
- build_context: Analyze a user request and build a focused context package (optional: currentFile). Call this FIRST when starting a new task.
- project_context: Build a comprehensive project understanding. Collects architecture files, build configs, server modules, core modules, entry points. Use when user asks "what does this project do" or "analyze project architecture".
- memory_search: Search conversation history from previous sessions. Retrieves relevant context by intent (project_understanding, bug_fix, feature_add, refactor) or recent N entries.
- embedding_search: Search for semantically relevant files using TF-IDF style embedding. Returns top-K files ranked by relevance to a natural language query.
- get_repo_graph: Get the RepoGraph: module dependency overview, data flow direction, cross-module dependencies, and module hierarchy tree.
- planner_execute: Execute the full pipeline planner: intent → memory → embedding → repo graph → context building.
- read_file: Read file content (required: path, optional: startLine, lineCount)
- write_file: Write file content (required: path, content)
- search_code: Search text patterns across workspace files (required: pattern, optional: filePattern)
- run_terminal: Execute terminal commands
- list_directory: List directory contents
- get_diagnostics: Get error/warning diagnostics
- search_symbols: Search for code symbols (classes, functions, interfaces) by name using LSP index (required: query, optional: kind, maxResults)
- get_workspace_context: Get workspace overview: file counts, languages, symbol statistics (optional: detail)
- find_related_files: Find files related to a given file (required: filePath, optional: maxResults)
- get_definition: Find definition of a symbol at a position using LSP (required: filePath, line, column)
- get_references: Find all references to a symbol at a position using LSP (required: filePath, line, column, optional: maxResults)
- get_repo_map: Get structured repository overview: directory tree, entry points, critical files, module breakdown (optional: depth, detail)
- get_dependency_graph: Get dependency relationships for a file or overall graph (optional: filePath, depth)
- analyze_impact: Analyze impact of changing a file or symbol: dependents, entry points, critical score (optional: filePath, symbolName, depth)

Before making any code changes, use search_symbols or get_repo_map to understand the codebase.
Use get_dependency_graph and analyze_impact before modifying critical files.
Use get_definition and get_references when you need to understand how symbols are connected.
Use embedding_search to find files related to a concept.
Use memory_search to recall previous conversation context.

## Response Formats

### PLANNING
{
  "state": "PLANNING",
  "content": "Analysis of the request",
  "plan": {
    "title": "Add user login feature",
    "subTasks": [
      { "id": "task-1", "description": "Research existing auth logic", "goal": "Understand current implementation" },
      { "id": "task-2", "description": "Create login API endpoint", "goal": "POST /api/login working" },
      { "id": "task-3", "description": "Add frontend login form", "goal": "Login page functional" }
    ]
  },
  "nextState": "THINK"
}

### THINK
{
  "state": "THINK",
  "subTaskId": "task-1",
  "content": "I need to read auth.config.ts to understand the current auth setup",
  "subTaskPlan": "1. Read auth.config.ts, 2. Check middleware, 3. Document findings"
}

### ACT (tool)
{
  "state": "ACT",
  "subTaskId": "task-1",
  "toolCall": {
    "name": "read_file",
    "params": { "path": "src/auth/config.ts" }
  }
}

### ACT (edit - modify existing file)
{
  "state": "ACT",
  "subTaskId": "task-2",
  "editOps": [
    {
      "path": "src/auth/login.ts",
      "search": "// TODO: implement login",
      "replace": "async function login(req, res) { ... }",
      "idempotentKey": "login-impl"
    }
  ]
}

### ACT (edit - create new file)
{
  "state": "ACT",
  "subTaskId": "task-2",
  "editOps": [
    {
      "path": "src/auth/login.ts",
      "search": "",
      "replace": "import express from 'express';\n\nexport async function login(req, res) {\n  // implementation\n}\n",
      "idempotentKey": "login-file-create"
    }
  ]
}

### OBSERVE
{
  "state": "OBSERVE",
  "subTaskId": "task-1",
  "content": "Found the auth config. It uses JWT. I now understand the setup.",
  "subTaskStatus": "complete",
  "nextState": "REFLECT"
}

If more work is needed:
{
  "state": "OBSERVE",
  "subTaskId": "task-1",
  "content": "Read the file but need to also check the middleware",
  "subTaskStatus": "continue",
  "nextState": "THINK"
}

### REFLECT
{
  "state": "REFLECT",
  "subTaskId": "task-1",
  "content": "Review completed. The research is thorough.",
  "reflection": {
    "verdict": "pass",
    "feedback": "All findings are accurate",
    "issues": []
  },
  "nextState": "THINK"
}

If revision needed:
{
  "state": "REFLECT",
  "subTaskId": "task-2",
  "content": "Found issues in the login implementation",
  "reflection": {
    "verdict": "needs_revision",
    "feedback": "Missing input validation and error handling",
    "issues": ["No validation for empty fields", "Error responses not standardized"]
  },
  "nextState": "THINK"
}

### DONE
{
  "state": "DONE",
  "content": "All 3 sub-tasks completed: researched auth, implemented login, added frontend"
}

## Rules
- In PLANNING, break complex requests into meaningful sub-tasks
- In THINK, analyze before acting. Be specific about what you'll do.
- In ACT, do ONE thing at a time — one tool call OR one set of edits
- **CRITICAL: In ACT, you MUST use editOps or write_file tool to write code to files. NEVER write code only in the content field. The content field is for descriptions, NOT for actual code output.**
- **To CREATE a new file: use editOps with search="" and replace=full file content, or use write_file tool**
- **To MODIFY an existing file: use editOps with search=code to find and replace=new code**
- **When creating or editing files, ONLY use paths inside the current workspace root. Never invent paths like "/workspace/..." or "/vibe-coding/...". After writing a file, only report the actual path returned by the tool.**
- **CRITICAL: You must base ALL answers on the actual source code in the project. The README is ONLY for getting the project name. You MUST use read_file, search_code, or search_symbols tools to read source files before answering ANY question about the codebase. Do NOT use README content as the basis for your answer.**
- In OBSERVE, set subTaskStatus to "complete" only when the sub-task goal is met
- In REFLECT, be a strict reviewer. If you find issues, set verdict to "needs_revision"
- After REFLECT with "needs_revision", the system goes back to THINK for fixes
- After REFLECT with "pass", move to next sub-task or DONE`;
  }

  private formatContextMessage(ctx: AgentContext, userMsg: string): string {
    const parts: string[] = [];

    if (ctx.workspaceInfo) {
      parts.push(`Workspace overview:\n${ctx.workspaceInfo}`);
    }

    if (ctx.repoMap) {
      parts.push(`Repository structure:\n${ctx.repoMap}`);
    }

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

    if (this.contextManager.isInitialized()) {
      const reason = `Auto-built context for: "${userMsg.slice(0, 50)}"`;
      parts.push(`\nContext package:\n`);
      parts.push(`To analyze this request, use \`build_context\` tool with request="${userMsg.slice(0, 60)}" to get focused file selection.`);
    }

    parts.push(`\nUser request: ${userMsg}`);

    return parts.join('\n\n');
  }

  private async buildPipelinePrompt(
    request: string,
    plan: ExecutionPlan,
    context: IncrementalContext,
    editorCtx: AgentContext
  ): Promise<string> {
    const staticParts: string[] = [];
    const dynamicParts: string[] = [];

    const cm = this.contextManager;
    const scanner = cm.scanner;

    if ((scanner.getFiles() || []).length === 0) {
      try {
        await scanner.scan();
      } catch {
        // scan failed, continue with whatever we have
      }
    }

    const allFiles = scanner.getPrimaryWorkspaceFiles() || [];
    const sourceFiles = scanner.getPrimaryWorkspaceSourceFiles() || [];

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    const workspaceName = workspaceRoot
      ? workspaceRoot.replace(/\\/g, '/').split('/').filter(Boolean).pop()
      : 'workspace';

    staticParts.push(`You are a coding assistant integrated into VS Code. You have access to the user's project.`);
    staticParts.push(`## Cache-Friendly Prompt Layout`);
    staticParts.push(`Stable workspace facts and reusable guidance are intentionally placed first. Task-specific instructions and latest context are appended near the end.`);
    staticParts.push(`## Intent\n${plan.intent}`);
    staticParts.push(`## Project Identity\nWorkspace: ${workspaceName}\nUse this only as a label. The project description must come from source code evidence, not from README prose.`);

    if (workspaceRoot) {
      staticParts.push(`## Workspace Root\n${workspaceRoot}\nUse relative paths under this root when reading or writing files.`);
    }

    staticParts.push(`## Project Overview\n- Source files: ${sourceFiles.length}\n- Total files: ${allFiles.length}`);

    if (workspaceRoot && sourceFiles.length > 0) {
      const relPaths = sourceFiles.map(f =>
        f.path.replace(workspaceRoot + '\\', '').replace(/\\/g, '/')
      );
      const topDirs = Array.from(new Set(relPaths.map(p => p.split('/')[0]))).sort();
      const structureLines: string[] = [];
      structureLines.push(`## Project Structure`);
      structureLines.push(`Top-level directories: ${topDirs.join(', ')}`);
      const allExtensions = new Set(relPaths.map(p => p.split('.').pop()?.toLowerCase()).filter(Boolean));
      structureLines.push(`File types: ${Array.from(allExtensions).join(', ')}`);
      staticParts.push(structureLines.join('\n'));
    }

    const packageFiles = allFiles.filter(f => /package\.json$/i.test(f.path) && !f.path.includes('node_modules'));
    if (packageFiles.length > 0) {
      try {
        const rootPkg = packageFiles.find(f => {
          const dir = f.path.replace(/\\/g, '/').substring(0, f.path.replace(/\\/g, '/').lastIndexOf('/'));
          return dir === workspaceRoot.replace(/\\/g, '/');
        });
        const selectedPkg = rootPkg || packageFiles[0];
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(selectedPkg.path));
        const pkg = JSON.parse(doc.getText());
        if (pkg.name || pkg.description || pkg.dependencies) {
          const pkgLines: string[] = ['## package.json'];
          if (pkg.name) pkgLines.push(`Name: ${pkg.name}`);
          if (pkg.version) pkgLines.push(`Version: ${pkg.version}`);
          if (pkg.description) pkgLines.push(`Description: ${pkg.description}`);
          if (pkg.dependencies) {
            const depNames = Object.keys(pkg.dependencies);
            pkgLines.push(`Dependencies (${depNames.length}): ${depNames.join(', ')}`);
          }
          if (pkg.devDependencies) {
            const devDepNames = Object.keys(pkg.devDependencies);
            pkgLines.push(`Dev dependencies (${devDepNames.length}): ${devDepNames.join(', ')}`);
          }
          if (pkg.scripts) {
            pkgLines.push(`Scripts: ${Object.keys(pkg.scripts).join(', ')}`);
          }
          staticParts.push(pkgLines.join('\n'));
        }
      } catch {
        // skip
      }
    }

    if (context.repoGraphOverview) {
      staticParts.push(`## Module Layers\n${context.repoGraphOverview}`);
    } else if (cm.repoGraph.isBuilt) {
      staticParts.push(`## Module Layers\n${cm.repoGraph.getDependencyOverview()}`);
    }

    // 关键源码通常跨轮次变化较小，前置可提升缓存命中
    const keyFileContents = await this.readKeySourceFiles(sourceFiles, allFiles);
    if (keyFileContents.length > 0) {
      const keyCodeLines: string[] = ['## Key Source Code (READ THIS FIRST)'];
      for (const { path, content } of keyFileContents) {
        const shortName = path.replace(/\\/g, '/').split('/').slice(-2).join('/');
        keyCodeLines.push(`### ${shortName}`);
        keyCodeLines.push('```');
        keyCodeLines.push(content);
        keyCodeLines.push('```');
      }
      staticParts.push(keyCodeLines.join('\n'));
    }

    staticParts.push(`## Stable Guidance\nYour answer MUST be based on the actual source code shown above and the tools you use (read_file, search_code, search_symbols). For project introduction requests, summarize the project from entry points, core modules, server/routes, and build configuration. Do NOT answer from README prose. If code evidence is insufficient, read more source files before answering.`);
    if (plan.intent === 'project_understanding') {
      staticParts.push(`When answering a project-understanding request, use this Markdown structure if possible: "项目概述" -> "核心入口" -> "主要模块" -> "运行与验证" -> "依据". Keep bullet lists flat, avoid internal process narration, and explicitly say "未在当前代码中发现" when evidence is missing.`);
    }
    if (plan.intent === 'bug_fix') {
      staticParts.push(`For bug-fix requests, prefer reading the active file or files explicitly referenced by the user before calling broad architecture tools. Do not guess hidden file paths.`);
    }

    if (context.memoryFragment) {
      dynamicParts.push(`## Previous Conversation\n${context.memoryFragment}`);
    }
    if (editorCtx.currentFile) {
      dynamicParts.push(`## Active File\n${editorCtx.currentFile}\nFor bug fixing or runtime issues, inspect this file first before searching broader modules.`);
    }
    if (editorCtx.openFiles.length > 0) {
      dynamicParts.push(`## Open Files\n${editorCtx.openFiles.slice(0, 8).map(file => `- ${file}`).join('\n')}`);
    }
    if (editorCtx.selectedCode) {
      dynamicParts.push(`## Selected Code\n\`\`\`\n${editorCtx.selectedCode}\n\`\`\``);
    }
    if (editorCtx.diagnostics.length > 0) {
      const diagnostics = editorCtx.diagnostics
        .slice(0, 5)
        .map(d => `- ${d.message} (line ${d.range.start.line + 1})`)
        .join('\n');
      dynamicParts.push(`## Diagnostics\n${diagnostics}`);
    }
    if (context.embeddingResults.length > 0) {
      dynamicParts.push(`## Semantically Relevant Files\n${context.embeddingResults.slice(0, 5).map(r => `- ${r.filePath} (relevance: ${r.score})`).join('\n')}`);
    }
    if (context.contextPackage) {
      const pkg = context.contextPackage;
      const contextLines: string[] = ['## Context Files for This Task', `Reason: ${pkg.reason}`];
      for (const f of pkg.selectedFiles.slice(0, 10)) {
        contextLines.push(`- ${f}`);
      }
      if (pkg.selectedFiles.length > 10) {
        contextLines.push(`... and ${pkg.selectedFiles.length - 10} more`);
      }
      dynamicParts.push(contextLines.join('\n'));
    }
    dynamicParts.push(`## Latest User Request\n${request}`);

    return [...staticParts, ...dynamicParts].join('\n\n');
  }

  private buildTechStackSummary(context: IncrementalContext): string {
    const lines: string[] = [];
    const allFiles = context.selectedFiles;

    const extensions = new Set<string>();
    const frameworks = new Set<string>();
    const languages = new Set<string>();

    for (const f of allFiles) {
      const ext = f.split('.').pop()?.toLowerCase();
      if (ext) extensions.add(ext);

      const lower = f.toLowerCase();
      if (lower.includes('node_modules') || lower.includes('package.json')) {
        frameworks.add('Node.js');
      }
      if (lower.includes('tsconfig')) {
        languages.add('TypeScript');
        frameworks.add('TypeScript');
      }
      if (lower.includes('webpack')) {
        frameworks.add('Webpack');
      }
      if (lower.includes('vite')) {
        frameworks.add('Vite');
      }
      if (lower.includes('react')) {
        frameworks.add('React');
      }
      if (lower.includes('vue')) {
        frameworks.add('Vue');
      }
      if (lower.includes('express') || lower.includes('server')) {
        frameworks.add('Express');
      }
      if (lower.includes('docker')) {
        frameworks.add('Docker');
      }
      if (lower.includes('jest') || lower.includes('mocha') || lower.includes('vitest')) {
        frameworks.add('Test Framework');
      }
    }

    if (languages.size > 0) {
      lines.push(`**Languages:** ${Array.from(languages).join(', ')}`);
    }
    if (frameworks.size > 0) {
      lines.push(`**Frameworks:** ${Array.from(frameworks).join(', ')}`);
    }
    if (extensions.size > 0) {
      lines.push(`**File Types:** ${Array.from(extensions).join(', ')}`);
    }

    return lines.length > 0 ? lines.join('\n') : '（技术栈信息可从项目文件分析得出）\n';
  }

  private detectDependencies(context: IncrementalContext): string[] {
    const deps: string[] = [];
    for (const f of context.selectedFiles) {
      const lower = f.toLowerCase();
      if (lower.endsWith('package.json')) {
        const dir = f.replace(/\\/g, '/').split('/').slice(-2, -1)[0];
        deps.push(`npm project: ${dir || f.split(/[/\\]/).pop()}`);
      }
      if (lower.endsWith('cargo.toml')) {
        deps.push('Rust/Cargo project');
      }
      if (lower.endsWith('go.mod')) {
        deps.push('Go module project');
      }
      if (lower.endsWith('pom.xml') || lower.endsWith('build.gradle')) {
        deps.push('Java/Maven/Gradle project');
      }
      if (lower.endsWith('requirements.txt') || lower.endsWith('pyproject.toml')) {
        deps.push('Python project');
      }
      if (lower.endsWith('docker-compose.yml') || lower.endsWith('docker-compose.yaml')) {
        deps.push('Docker Compose');
      }
    }
    return [...new Set(deps)];
  }

  /**
   * 读取关键源码文件的前 N 行内容，注入到 pipeline prompt 中。
   * 优先选择入口文件和核心模块文件，确保 LLM 基于源码而非 README 作答。
   */
  private async readKeySourceFiles(
    sourceFiles: WorkspaceFile[],
    allFiles: WorkspaceFile[],
    maxFiles: number = 5,
    maxLinesPerFile: number = 80
  ): Promise<{ path: string; content: string }[]> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    const results: { path: string; content: string; priority: number }[] = [];

    // 优先级关键词：入口文件 > 核心模块 > 其他
    const priorityPatterns: { pattern: RegExp; score: number }[] = [
      { pattern: /\/(main|index|app|entry)\.(ts|js|tsx|jsx|py|go|rs|java)$/i, score: 100 },
      { pattern: /\/(agent|core|engine|service|server|router)\.(ts|js|tsx|jsx)$/i, score: 80 },
      { pattern: /src\/(agent|core|engine|service|server|router)\//i, score: 70 },
      { pattern: /\/extension\.(ts|js)$/i, score: 90 },
    ];

    // 排除测试文件和配置文件
    const excludePattern = /\.(test|spec)\.(ts|js|tsx|jsx)$/i;

    for (const file of sourceFiles) {
      if (excludePattern.test(file.path)) continue;

      let priority = 0;
      for (const { pattern, score } of priorityPatterns) {
        if (pattern.test(file.path.replace(/\\/g, '/'))) {
          priority = Math.max(priority, score);
        }
      }

      if (priority > 0) {
        results.push({ path: file.path, content: '', priority });
      }
    }

    // 如果没有匹配到优先文件，取前几个源码文件
    if (results.length === 0 && sourceFiles.length > 0) {
      for (const file of sourceFiles.slice(0, maxFiles)) {
        results.push({ path: file.path, content: '', priority: 1 });
      }
    }

    // 按优先级排序，取前 maxFiles 个
    results.sort((a, b) => b.priority - a.priority);
    const selected = results.slice(0, maxFiles);

    // 读取文件内容
    for (const item of selected) {
      try {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(item.path));
        const text = doc.getText();
        const lines = text.split('\n').slice(0, maxLinesPerFile);
        item.content = lines.join('\n');
        if (text.split('\n').length > maxLinesPerFile) {
          item.content += `\n... (${text.split('\n').length - maxLinesPerFile} more lines)`;
        }
      } catch {
        // skip unreadable files
      }
    }

    return selected.filter(r => r.content.length > 0);
  }

  /**
   * 检测工具返回内容是否为空数据或错误信息。
   * 用于 OBSERVE 阶段的幻觉约束——当工具返回无效数据时，
   * 注入警告阻止 LLM 编造内容。
   */
  private isToolResultEmptyOrError(content: string): boolean {
    if (!content || content.trim().length === 0) return true;

    const lower = content.toLowerCase();
    const errorPatterns = [
      'error reading file',
      'error writing file',
      'error searching code',
      'error listing directory',
      'no results found',
      'no symbols found',
      'no related files found',
      'no references found',
      'no definition found',
      'no diagnostics found',
      'code index not yet initialized',
      'not yet built',
      'not yet initialized',
      'cannot read properties',
      'enoent',
      'no such file',
      'permission denied',
    ];

    return errorPatterns.some(p => lower.includes(p));
  }

  private getSessionId(): string {
    const repoPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || 'unknown';
    return `session-${repoPath.replace(/[^a-zA-Z0-9]/g, '-')}`;
  }

  async applyEditOperation(op: EditOperation): Promise<void> {
    await this.diffEngine.applyEdit(op);
  }

  async applyEditOperations(ops: EditOperation[]): Promise<{ success: boolean; failed: EditOperation[] }> {
    return this.diffEngine.applyEdits(ops);
  }
}

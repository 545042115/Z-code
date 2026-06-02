import * as vscode from 'vscode';
import { LLMProvider, Message, GenerateRequest, LLMProviderFactory } from '../llm/llm-provider';
import { ToolRegistry } from '../tools/tool-registry';
import { ContextManager } from '../context/context-manager';
import { MemoryManager } from '../memory/memoryManager';
import { EmbeddingManager } from '../embedding/embeddingManager';
import { Planner, ExecutionPlan, IncrementalContext } from '../planner/planner';
import { RepoGraph } from '../context/repoGraph';
import { DiffEngine } from '../utils/diff-engine';
import { Verifier, VerifierOutput } from './verifier';

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

const STATE_SCHEMAS: Record<AgentState, object> = {
  PLANNING: {
    type: 'object',
    properties: {
      state: { const: 'PLANNING' },
      content: { type: 'string', description: '分析用户需求，概述要实现的目标' },
      plan: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '计划标题' },
          subTasks: {
            type: 'array',
            description: '子任务列表，每个子任务应是独立可执行的工作单元',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: '子任务编号，如 "task-1"' },
                description: { type: 'string', description: '子任务描述' },
                goal: { type: 'string', description: '完成标准，如何判断该子任务完成' },
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
          name: { type: 'string', enum: ['read_file', 'write_file', 'search_code', 'run_terminal', 'list_directory', 'get_diagnostics', 'build_context', 'project_context', 'memory_search', 'embedding_search', 'get_repo_graph', 'planner_execute'] },
          params: { type: 'object' },
        },
        required: ['name', 'params'],
      },
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
  private messageHistory: Message[] = [];
  private isRunning: boolean = false;
  private lastVerificationResult: VerifierOutput | null = null;
  private pendingSubTaskForReflect: string | null = null;

  private subTasks: SubTask[] = [];
  private currentSubTaskIndex: number = 0;
  private currentSubTaskReActCount: number = 0;
  private readonly MAX_REACT_PER_SUBTASK = 15;

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
    onEditPreview: (ops: EditOperation[]) => void
  ): Promise<void> {
    if (this.isRunning) {
      throw new Error('Agent is already running');
    }

    this.isRunning = true;

    try {
      const sessionId = this.getSessionId();
      const intent = this.contextManager.contextBuilder.classifyIntent(userMessage);

      if (intent === 'project_understanding') {
        await this.handleProjectUnderstanding(userMessage, onStream, sessionId);
        return;
      }

      const planner = this.contextManager.planner;
      const memoryManager = this.contextManager.memoryManager;

      await onStream(`\n## 🧠 分析请求中...\n\n`);

      const plan = planner.create(userMessage, sessionId);
      const context = plan.context;

      for (const step of plan.steps) {
        onStateChange('PLANNING');

        const description = step.description;
        onStream(`- ${description}... `);

        const result = await planner.executeStep(step, userMessage, sessionId, context);

        if (result.status === 'completed') {
          onStream(`✅\n`);
        } else {
          onStream(`❌\n`);
        }
      }

      onStream(`\n## 🤖 回答\n\n`);

      const editorCtx = await this.contextManager.gatherContext();
      const answerPrompt = this.buildPipelinePrompt(userMessage, plan, context, editorCtx);

      this.messageHistory = [
        { role: 'system', content: answerPrompt },
        { role: 'user', content: userMessage },
      ];

      const request: GenerateRequest = {
        messages: this.messageHistory,
        stream: true,
      };

      let fullResponse = '';
      for await (const chunk of this.llm.generateStream(request)) {
        fullResponse += chunk;
        onStream(chunk);
      }

      onStream(`\n\n`);

      memoryManager.addEntry(sessionId, 'user', userMessage, plan.intent);
      memoryManager.addEntry(sessionId, 'assistant', fullResponse, plan.intent);
      memoryManager.addEntry(sessionId, 'context', plan.summary, plan.intent);

      this.currentState = 'DONE';
      onStateChange('DONE');
    } catch (err) {
      this.isRunning = false;
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

  private async handleProjectUnderstanding(userMessage: string, onStream: (chunk: string) => void, sessionId: string): Promise<void> {
    this.reset();
    onStream(`\n## 🧠 项目理解\n\n自动分析项目结构和架构...\n\n`);

    const planner = this.contextManager.planner;
    const plan = planner.create(userMessage, sessionId);
    const context = plan.context;

    for (const step of plan.steps) {
      const description = step.description;
      onStream(`- ${description}... `);

      const result = await planner.executeStep(step, userMessage, sessionId, context);

      if (result.status === 'completed') {
        onStream(`✅\n`);
      } else {
        onStream(`❌\n`);
      }
    }

    onStream(`\n## 📋 项目架构概览\n\n`);

    const repoGraph = this.contextManager.repoGraph;
    const depOverview = repoGraph.getDependencyOverview();
    const hierarchy = repoGraph.formatForPrompt();
    const embeddingResults = context.embeddingResults;

    onStream(`### 技术栈\n\n`);
    const techStack = this.buildTechStackSummary(context);
    onStream(techStack);

    onStream(`\n### 模块分层\n\n`);
    onStream(depOverview);

    onStream(`\n### 模块层级树\n\n`);
    onStream(hierarchy);

    onStream(`\n### 关键文件\n\n`);
    if (embeddingResults.length > 0) {
      for (const r of embeddingResults.slice(0, 10)) {
        const shortPath = r.filePath.split(/[/\\]/).slice(-3).join('/');
        onStream(`- **${shortPath}** (相关性: ${r.score})\n`);
        if (r.summary) {
          onStream(`  ${r.summary.slice(0, 120)}\n`);
        }
      }
    }

    onStream(`\n### 数据流\n\n`);
    onStream(`\`\`\`\nRequest → Entry Point → Server Layer → Core Layer → Response\nUI Layer → Server Layer → Core Layer → Data\nConfig/Build → All Layers (cross-cutting)\n\`\`\`\n\n`);

    const buildFiles = context.selectedFiles.filter(f =>
      /CMakeLists\.txt$|package\.json$|\.config\.(js|ts|json)$|tsconfig\..+\.json$|webpack\.config|Dockerfile|docker-compose|Makefile$/i.test(f)
    );
    if (buildFiles.length > 0) {
      onStream(`### Build System\n\n`);
      for (const f of buildFiles) {
        onStream(`- ${f.split(/[/\\]/).pop()}\n`);
      }
      onStream(`\n`);
    }

    onStream(`\n### Dependencies\n\n`);
    const deps = this.detectDependencies(context);
    if (deps.length > 0) {
      for (const dep of deps) {
        onStream(`- ${dep}\n`);
      }
    } else {
      onStream('（可从 package.json 等配置文件查看详细依赖）\n');
    }

    onStream(`\n## ✅ 完成\n\n项目架构信息已收集完毕。你可以进一步询问具体模块的细节。\n\n`);

    this.contextManager.memoryManager.addEntry(sessionId, 'user', userMessage, 'project_understanding');
    this.contextManager.memoryManager.addEntry(sessionId, 'assistant', `[项目理解] ${plan.summary}`, 'project_understanding');
    this.contextManager.memoryManager.addEntry(sessionId, 'context', hierarchy, 'project_understanding');

    this.currentState = 'DONE';
  }

  stop(): void {
    this.isRunning = false;
  }

  reset(): void {
    this.currentState = 'PLANNING';
    this.messageHistory = [];
    this.subTasks = [];
    this.currentSubTaskIndex = 0;
    this.currentSubTaskReActCount = 0;
    this.lastVerificationResult = null;
    this.pendingSubTaskForReflect = null;
    this.isRunning = false;
  }

  private async executeState(
    state: AgentState,
    onStream: (chunk: string) => void,
    onEditPreview: (ops: EditOperation[]) => void
  ): Promise<StateResponse> {
    if (state === 'VERIFIER') {
      return this.executeVerifier(onStream);
    }

    const schema = STATE_SCHEMAS[state];
    const messagesForRequest = this.buildMessagesForState(state);

    const request: GenerateRequest = {
      messages: messagesForRequest,
      jsonSchema: schema,
      stream: false,
    };

    const responseText = await this.llm.generate(request);

    let response: StateResponse;
    try {
      response = JSON.parse(responseText);
    } catch {
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
      case 'PLANNING': {
        const plan = response.plan!;
        this.subTasks = plan.subTasks.map(st => ({ ...st, status: 'pending' as const }));
        const subTaskList = this.subTasks.map((st, i) =>
          `  ${i + 1}. ${st.description}`
        ).join('\n');

        onStream(`\n## 计划：${plan.title}\n\n${response.content}\n\n\`\`\`\n${subTaskList}\n\`\`\`\n\n`);

        this.messageHistory.push(
          { role: 'assistant', content: responseText },
          { role: 'user', content: `[计划已确认] 共 ${this.subTasks.length} 个子任务。请从第一个子任务开始，每个子任务内使用 THINK → ACT → OBSERVE 循环完成。` }
        );
        return response;
      }

      case 'THINK': {
        const currentTask = this.subTasks.find(st => st.id === response.subTaskId);
        const taskLabel = currentTask ? currentTask.description : response.subTaskId;

        this.currentSubTaskReActCount++;
        if (this.currentSubTaskReActCount > this.MAX_REACT_PER_SUBTASK) {
          onStream(`\n**思考**（子任务: ${taskLabel}）\n\n${response.content}\n\n`);
          return { state: 'THINK', content: response.content, subTaskId: response.subTaskId, nextState: 'REFLECT' };
        }

        onStream(`\n**思考**（子任务: ${taskLabel}）\n\n${response.content}\n\n`);
        this.messageHistory.push({ role: 'assistant', content: responseText });
        return { ...response, nextState: 'ACT' };
      }

      case 'ACT': {
        const currentTask = this.subTasks.find(st => st.id === response.subTaskId);
        const taskLabel = currentTask ? currentTask.description : response.subTaskId;
        this.markSubTaskInProgress(response.subTaskId || '');

        if (response.toolCall) {
          onStream(`**执行**（${taskLabel}）: \`${response.toolCall.name}\`\n\n`);
          const result = await this.tools.execute(response.toolCall.name, response.toolCall.params);
          this.messageHistory.push(
            { role: 'assistant', content: responseText },
            { role: 'user', content: `[工具结果] ${response.toolCall.name} 返回：${JSON.stringify(result)}` }
          );
        } else if (response.editOps && response.editOps.length > 0) {
          onStream(`**编辑**（${taskLabel}）: 修改 ${response.editOps.length} 个文件\n\n`);
          onEditPreview(response.editOps);
          for (const op of response.editOps) {
            await this.diffEngine.applyEdit(op);
          }
          this.messageHistory.push(
            { role: 'assistant', content: responseText },
            { role: 'user', content: `[编辑完成] 已应用 ${response.editOps.length} 处修改` }
          );
        }
        return { ...response, nextState: 'OBSERVE' };
      }

      case 'OBSERVE': {
        const currentTask = this.subTasks.find(st => st.id === response.subTaskId);
        const taskLabel = currentTask ? currentTask.description : response.subTaskId;

        onStream(`**观察**（${taskLabel}）\n\n${response.content}\n\n`);

        if (response.subTaskStatus === 'complete') {
          this.markSubTaskCompleted(response.subTaskId || '');
          this.pendingSubTaskForReflect = response.subTaskId || null;
          onStream(`→ 子任务 "**${taskLabel}**" 完成，正在验证...\n\n`);
          this.messageHistory.push({ role: 'assistant', content: responseText });
          return { state: 'OBSERVE', content: response.content, subTaskId: response.subTaskId, subTaskStatus: 'complete', nextState: 'VERIFIER' };
        }

        this.messageHistory.push({ role: 'assistant', content: responseText });
        return response;
      }

      case 'REFLECT': {
        const currentTask = this.subTasks.find(st => st.id === response.subTaskId);
        const taskLabel = currentTask ? currentTask.description : response.subTaskId;
        const reflection = response.reflection || { verdict: 'pass', feedback: 'Automatic pass (no reflection data from LLM)', issues: [] };

        onStream(`## 反思审查（${taskLabel || 'unknown'}）\n\n${response.content || 'No detailed review provided.'}\n\n`);
        if (reflection.issues && reflection.issues.length > 0) {
          onStream(`发现的问题:\n`);
          for (const issue of reflection.issues) {
            onStream(`- ${issue}\n`);
          }
          onStream(`\n`);
        }

        this.messageHistory.push({ role: 'assistant', content: responseText });

        if (reflection.verdict === 'needs_revision') {
          onStream(`→ 需要修订: ${reflection.feedback}\n\n`);
          this.currentSubTaskReActCount = 0;
        }

        return { ...response, reflection, subTaskId: response.subTaskId || this.pendingSubTaskForReflect || '' };
      }

      case 'WAIT_USER':
        onStream(`\n**需要你的确认**\n\n${response.question}\n\n`);
        this.messageHistory.push({ role: 'assistant', content: responseText });
        return response;

      case 'DONE':
        onStream(`\n## 完成\n\n${response.content}\n\n`);
        return response;

      default:
        throw new Error(`Invalid state: ${state}`);
    }
  }

  private async executeVerifier(onStream: (chunk: string) => void): Promise<StateResponse> {
    onStream(`**验证**\n\n`);
    const result = await this.verifier.verify();
    this.lastVerificationResult = result;

    const icon = result.hasIssues ? '❌' : '✅';
    onStream(`${icon} 验证完成\n\`\`\`\n${result.summary}\n\`\`\`\n\n`);

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
      return this.messageHistory;
    }

    const messages: Message[] = [
      {
        role: 'system',
        content: `${this.SYSTEM_PROMPT}\n\n## 当前执行计划\n\n${planContext}`,
      },
      ...this.messageHistory.slice(1),
    ];

    if (state === 'REFLECT' && this.currentSubTaskIndex > 0) {
      const completedTasks = this.subTasks
        .filter(st => st.status === 'completed')
        .map(st => `  ${st.id}: ${st.description}`)
        .join('\n');
      const lastCompleted = this.subTasks
        .filter(st => st.status === 'completed')
        .pop();
      const lastId = lastCompleted ? lastCompleted.id : '';
      let reflectPrompt = `## 已完成子任务\n\n${completedTasks}\n\n请审查子任务 ${lastId} 的输出质量。你的响应必须包含 subTaskId 字段（值为 "${lastId}"）和 reflection 字段。`;

      if (this.lastVerificationResult) {
        const result = this.lastVerificationResult;
        reflectPrompt += `\n\n## 验证结果\n\n${result.summary}\n\n请参考以上验证结果进行审查。如果存在问题未解决，请设置 verdict 为 "needs_revision"。`;
      }

      messages[0] = {
        role: 'system',
        content: `${messages[0].content}\n\n${reflectPrompt}`,
      };
    }

    return messages;
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
    const task = this.subTasks.find(st => st.id === subTaskId);
    if (task && task.status === 'pending') {
      task.status = 'in_progress';
    }
  }

  private markSubTaskCompleted(subTaskId: string): void {
    const task = this.subTasks.find(st => st.id === subTaskId);
    if (task) {
      task.status = 'completed';
      this.currentSubTaskIndex = this.subTasks.findIndex(st => st.id === subTaskId) + 1;
      this.currentSubTaskReActCount = 0;
    }
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

### ACT (edit)
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

  private buildPipelinePrompt(
    request: string,
    plan: ExecutionPlan,
    context: IncrementalContext,
    editorCtx: AgentContext
  ): string {
    const parts: string[] = [];

    parts.push(`You are a coding assistant with multi-turn memory and repo-level context awareness.`);
    parts.push(``);
    parts.push(`## Intent\n${plan.intent}`);
    parts.push(``);

    if (context.memoryFragment) {
      parts.push(`## Previous Conversation\n${context.memoryFragment}`);
      parts.push(``);
    }

    if (context.embeddingResults.length > 0) {
      parts.push(`## Semantically Relevant Files\n`);
      for (const r of context.embeddingResults.slice(0, 5)) {
        parts.push(`- ${r.filePath} (relevance: ${r.score})`);
      }
      parts.push(``);
    }

    if (context.repoGraphOverview) {
      parts.push(context.repoGraphOverview);
      parts.push(``);
    }

    if (context.contextPackage) {
      const pkg = context.contextPackage;
      parts.push(`## Focused Files for This Task\n`);
      parts.push(`Reason: ${pkg.reason}`);
      parts.push(`Selected ${pkg.selectedFiles.length} files:`);
      for (const f of pkg.selectedFiles.slice(0, 10)) {
        parts.push(`- ${f}`);
      }
      if (pkg.selectedFiles.length > 10) {
        parts.push(`... and ${pkg.selectedFiles.length - 10} more`);
      }
      parts.push(``);
    }

    if (editorCtx.workspaceInfo) {
      parts.push(`## Workspace Overview\n${editorCtx.workspaceInfo}`);
      parts.push(``);
    }

    if (editorCtx.repoMap) {
      parts.push(context.repoGraphOverview || `## Repo Structure\n${editorCtx.repoMap}`);
      parts.push(``);
    }

    parts.push(`## Task\n${request}`);
    parts.push(``);
    parts.push(`Provide a clear, detailed answer based on the above context.`);
    parts.push(`Only load and read files when necessary. Use the incremental context already provided.`);

    return parts.join('\n');
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

  private getSessionId(): string {
    const repoPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || 'unknown';
    return `session-${repoPath.replace(/[^a-zA-Z0-9]/g, '-')}`;
  }
}
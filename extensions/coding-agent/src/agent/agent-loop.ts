import { LLMProvider, Message } from '../llm/llm-provider';
import { ToolRegistry } from '../tools/tool-registry';
import { Planner, ExecutionPlan, IncrementalContext, PlanStep } from '../planner/planner';
import { RuntimeVerifier, VerificationResult } from '../verifier/runtime-verifier';
import { ContextManager } from '../context/context-manager';
import { DiscoveryReport } from '../discovery/discovery';
import { ArchitectureReviewReport } from '../architecture-review/architecture-review';
import { GitAnalyzer } from '../git/git-analyzer';
import { ToolUsageAnalyzer } from '../debug/tool-usage-analyzer';
import { ReflectionEngine, ReflectionReport } from '../reflection/reflectionEngine';
import { ReflectionAgent, ReflectionRecord, ToolResult, ReflectionOutput, ReflectionInput } from '../reflection/reflection-agent';
import { ChangeImpactReport, ChangeImpactAnalysis, ChangePlanInput } from '../change-impact/change-impact-analysis';
import { ComplexityEstimate } from '../complexity/complexity-estimator';
import { SelectedSkill } from '../skills/skill-types';

export type LoopState = 'PLAN' | 'EXECUTE' | 'VERIFY' | 'REFLECT' | 'REPLAN' | 'COMPLETE' | 'FAILED';

export interface LoopMetrics {
  attempts: number;
  maxAttempts: number;
  totalDurationMs: number;
  toolCalls: number;
  verificationResults: VerificationResult[];
}

export interface ToolIteration {
  iteration: number;
  role: 'llm' | 'tool';
  content: string;
  toolName?: string;
  toolResult?: string;
}

export interface LoopAttempt {
  attempt: number;
  state: LoopState;
  plan?: ExecutionPlan;
  executionOutput: string;
  verificationResults: VerificationResult[];
  reflectionReport?: ReflectionReport;
  reflectionOutput?: ReflectionOutput;
  repairPrompt?: string;
  modifiedFiles: string[];
  iterations: ToolIteration[];
  terminatedCorrectly: boolean;
}

export interface LoopResult {
  state: LoopState;
  finalAnswer: string;
  metrics: LoopMetrics;
  history: LoopAttempt[];
}

export interface ToolCall {
  name: string;
  params: Record<string, any>;
}

interface AgentAction {
  thought: string;
  action: 'tool_call' | 'final_answer';
  tool?: string;
  params?: Record<string, any>;
  answer?: string;
}

/**
 * AgentLoop implements the full Plan → Execute → Verify → Repair cycle.
 *
 * 1. PLAN: Use Planner to build context and create execution plan
 * 2. EXECUTE: Run LLM tool loop to perform code changes
 * 3. VERIFY: Run RuntimeVerifier to check build/tests/lint
 * 4. REPAIR: If verification fails, construct repair prompt and retry
 * 5. COMPLETE / FAILED: Return final result
 */
export class AgentLoop {
  private readonly MAX_RETRIES = 3;
  private readonly MAX_REFLECTION_CYCLES = 3;
  private readonly MAX_TOOL_ITERATIONS = 15;

  constructor(
    private readonly llmProvider: LLMProvider,
    private readonly planner: Planner,
    private readonly tools: ToolRegistry,
    private readonly verifier: RuntimeVerifier,
    private readonly contextManager: ContextManager,
    private readonly reflectionEngine?: ReflectionEngine,
    private readonly reflectionAgent?: ReflectionAgent,
    private readonly toolUsageAnalyzer?: ToolUsageAnalyzer
  ) {}

  /**
   * Execute a task with the full Plan → Execute → Verify → Repair loop.
   */
  async executeTask(task: string): Promise<LoopResult> {
    const startTime = Date.now();
    const history: LoopAttempt[] = [];
    let currentTask = task;
    let finalAnswer = '';
    let totalToolCalls = 0;
    const reflectionHistory: ReflectionReport[] = [];

    const maxCycles = (this.reflectionAgent || this.reflectionEngine) ? this.MAX_REFLECTION_CYCLES : this.MAX_RETRIES;

    for (let attempt = 1; attempt <= maxCycles; attempt++) {
      const attemptStart = Date.now();
      console.log(`[AgentLoop] Attempt ${attempt}/${maxCycles} for task: ${task.slice(0, 60)}`);

      // ── DISCOVERY ────────────────────────────────────────────────────────
      let discoveryReport: DiscoveryReport | undefined;
      if (this.contextManager.discoveryPhase) {
        try {
          const intent = this.planner.classifyIntent(currentTask);
          const contextPackage = await this.contextManager.contextBuilder.build(currentTask);
          discoveryReport = await this.contextManager.discoveryPhase.run(currentTask, contextPackage, intent);
          console.log(`[AgentLoop] Discovery: ${discoveryReport?.summary}`);
        } catch (err) {
          console.warn('[AgentLoop] Discovery phase failed:', err);
        }
      }

      // ── SKILL DISCOVERY ──────────────────────────────────────────────────
      let selectedSkills: SelectedSkill[] = [];
      if (this.contextManager.skillManager) {
        selectedSkills = this.contextManager.skillManager.select({
          userRequest: currentTask,
          taskType: undefined, // will be set after TaskUnderstanding
          discoveryReport: discoveryReport ? { involvedFiles: discoveryReport.involvedFiles, relatedSymbols: discoveryReport.relatedSymbols } : undefined,
          topK: 3,
        });
        if (selectedSkills.length > 0) {
          console.log(`[AgentLoop] Skills loaded: ${selectedSkills.map(s => s.name).join(', ')}`);
        }
      }

      // ── TASK UNDERSTANDING ───────────────────────────────────────────────
      let taskUnderstanding = this.contextManager.taskUnderstanding?.analyze(currentTask, discoveryReport);
      if (taskUnderstanding) {
        console.log(`[AgentLoop] Task Understanding: ${taskUnderstanding.taskType} (${Math.round(taskUnderstanding.confidence * 100)}% confidence)`);
      }

      // ── COMPLEXITY ESTIMATION ────────────────────────────────────────────
      let complexityEstimate: ComplexityEstimate | undefined;
      if (this.contextManager.complexityEstimator && taskUnderstanding) {
        complexityEstimate = this.contextManager.complexityEstimator.estimate(currentTask, taskUnderstanding);
        console.log(`[AgentLoop] Complexity: ${complexityEstimate.level.toUpperCase()} (${complexityEstimate.fastPathEligible ? 'Fast Path' : 'Full Path'})`);
      }

      // ── ARCHITECTURE REVIEW (Full Path only) ─────────────────────────────
      let architectureReview: ArchitectureReviewReport | undefined;
      if (!complexityEstimate?.fastPathEligible && this.contextManager.architectureReview && discoveryReport && taskUnderstanding) {
        try {
          architectureReview = this.contextManager.architectureReview.review(discoveryReport, taskUnderstanding);
          console.log(`[AgentLoop] Architecture Review: ${architectureReview.rationale}`);
        } catch (err) {
          console.warn('[AgentLoop] Architecture review failed:', err);
        }
      }

      // ── CHANGE IMPACT ANALYSIS (Full Path only) ──────────────────────────
      let changeImpactReport: ChangeImpactReport | undefined;
      if (!complexityEstimate?.fastPathEligible && this.contextManager.changeImpactAnalysis && discoveryReport && taskUnderstanding) {
        try {
          const changeInput: ChangePlanInput = {
            userRequest: currentTask,
            taskType: taskUnderstanding.taskType,
            taskUnderstanding,
            architectureReview: architectureReview || { shouldSplitFunction: false, shouldExtractClass: false, shouldAddNewFile: false, shouldUpdateReferences: false, violatesSingleResponsibility: false, suggestions: [], recommendedFiles: [], rationale: 'no review' },
            discoveryReport,
          };
          changeImpactReport = this.contextManager.changeImpactAnalysis.analyze(changeInput);
          console.log(`[AgentLoop] Change Impact: ${changeImpactReport.directImpactFiles.length} direct + ${changeImpactReport.indirectImpactFiles.length} indirect files, confidence=${Math.round(changeImpactReport.confidence * 100)}%`);
        } catch (err) {
          console.warn('[AgentLoop] Change impact analysis failed:', err);
        }
      }

      // ── PLAN ─────────────────────────────────────────────────────────────
      const plan = this.planner.create(currentTask, `loop-${Date.now()}`, discoveryReport, taskUnderstanding, architectureReview, changeImpactReport, complexityEstimate);
      const context = plan.context;

      // 若 Discovery 已构建 contextPackage，直接复用
      if (discoveryReport?.contextPackage) {
        context.contextPackage = discoveryReport.contextPackage;
      }

      // Execute planner steps (context building)
      for (const step of plan.steps) {
        await this.planner.executeStep(step, currentTask, `loop-${Date.now()}`, context, plan.searchTerms, discoveryReport);
      }

      // ── EXECUTE ──────────────────────────────────────────────────────────
      const { output, toolCalls, modifiedFiles, iterations, terminatedCorrectly } = await this.runExecutionLoop(
        currentTask,
        context,
        attempt,
        plan.taskType,
        selectedSkills
      );
      totalToolCalls += toolCalls;
      finalAnswer = output;

      // ── VERIFY ───────────────────────────────────────────────────────────
      const verificationResults = await this.verifier.verifyPatch(modifiedFiles);
      const allPassed = verificationResults.every(r => r.passed || r.skipped);

      history.push({
        attempt,
        state: allPassed ? 'COMPLETE' : 'VERIFY',
        plan,
        executionOutput: output,
        verificationResults,
        modifiedFiles,
        iterations,
        terminatedCorrectly,
      });

      // COMPLETE only when ReAct loop terminated with final_answer AND verification passed
      if (terminatedCorrectly && allPassed) {
        console.log(`[AgentLoop] Verification passed on attempt ${attempt}`);
        const result: LoopResult = {
          state: 'COMPLETE',
          finalAnswer,
          metrics: {
            attempts: attempt,
            maxAttempts: maxCycles,
            totalDurationMs: Date.now() - startTime,
            toolCalls: totalToolCalls,
            verificationResults,
          },
          history,
        };
        this.toolUsageAnalyzer?.recordExecution(task, result);
        return result;
      }

      // If ReAct loop ended without final_answer, mark as FAILED and do not retry
      if (!terminatedCorrectly) {
        console.log(`[AgentLoop] Execution loop terminated without final_answer on attempt ${attempt}`);
        history[history.length - 1].state = 'FAILED';
        break;
      }

      // ── CONDITIONAL REFLECT + REPLAN ───────────────────────────────────
      // Only triggered when verification failed (we reached here because allPassed === false)
      if (this.reflectionAgent) {
        // Build standardized ReflectionInput
        const reflectionInput = this.buildReflectionInput(
          task,
          plan,
          output,
          iterations,
          verificationResults,
          this.reflectionAgent.reflectionRecords
        );

        // Trigger ReflectionAgent
        const reflectionOutput = this.reflectionAgent.reflect(reflectionInput);

        history[history.length - 1].state = 'REFLECT';
        history[history.length - 1].reflectionOutput = reflectionOutput;

        console.log(`[AgentLoop] Reflection: rootCause="${reflectionOutput.rootCause}", shouldContinue=${reflectionOutput.shouldContinue}, shouldReplan=${reflectionOutput.shouldReplan}`);

        if (!reflectionOutput.shouldContinue) {
          console.log(`[AgentLoop] ReflectionAgent decided to stop at attempt ${attempt}`);
          history[history.length - 1].state = 'FAILED';
          break;
        }

        if (reflectionOutput.shouldReplan) {
          if (attempt >= maxCycles) {
            console.log(`[AgentLoop] Max reflection cycles exceeded`);
            break;
          }

          currentTask = this.reflectionAgent.formatRepairPrompt(reflectionOutput, task, plan, reflectionInput.toolResults);
          history[history.length - 1].state = 'REPLAN';
          history[history.length - 1].repairPrompt = currentTask;

          console.log(`[AgentLoop] ReflectionAgent replanning for attempt ${attempt + 1}...`);
        }
      } else if (this.reflectionEngine) {
        // ── Legacy ReflectionEngine fallback ──────────────────────────────
        const analysis = this.reflectionEngine.analyzeFailures(verificationResults, modifiedFiles);
        const repairPlan = this.reflectionEngine.generateRepairPlan(analysis, task, attempt);

        const reflectionReport: ReflectionReport = {
          attempt,
          rawResults: verificationResults,
          analysis,
          repairPlan,
          memory: this.reflectionEngine.reflectionMemory,
          timestamp: Date.now(),
        };
        reflectionHistory.push(reflectionReport);

        history[history.length - 1].state = 'REFLECT';
        history[history.length - 1].reflectionReport = reflectionReport;

        const shouldContinue = this.reflectionEngine.shouldContinueReflection(verificationResults, attempt);
        if (!shouldContinue) {
          console.log(`[AgentLoop] ReflectionEngine decided to stop at attempt ${attempt}`);
          history[history.length - 1].state = 'FAILED';
          break;
        }

        if (attempt >= maxCycles) {
          console.log(`[AgentLoop] Max reflection cycles exceeded`);
          break;
        }

        currentTask = this.reflectionEngine.formatRepairPrompt(repairPlan, task, reflectionHistory);

        history[history.length - 1].state = 'REPLAN';
        history[history.length - 1].repairPrompt = currentTask;

        console.log(`[AgentLoop] ReflectionEngine replanning for attempt ${attempt + 1}...`);
      } else {
        // ── REPAIR (Legacy fallback without any reflection) ───────────────
        if (attempt >= this.MAX_RETRIES) {
          console.log(`[AgentLoop] Max retries exceeded`);
          break;
        }

        const repairPrompt = this.buildRepairPrompt(currentTask, verificationResults, modifiedFiles, attempt);
        currentTask = repairPrompt;

        history[history.length - 1].state = 'REPLAN';
        history[history.length - 1].repairPrompt = repairPrompt;

        console.log(`[AgentLoop] Repair prompt generated, retrying...`);
      }
    }

    const result: LoopResult = {
      state: 'FAILED',
      finalAnswer,
      metrics: {
        attempts: history.length,
        maxAttempts: maxCycles,
        totalDurationMs: Date.now() - startTime,
        toolCalls: totalToolCalls,
        verificationResults: history[history.length - 1]?.verificationResults || [],
      },
      history,
    };
    this.toolUsageAnalyzer?.recordExecution(task, result);
    return result;
  }

  /**
   * Run the execution phase: LLM tool loop to perform code changes.
   */
  private async runExecutionLoop(
    task: string,
    plannerContext: IncrementalContext,
    attempt: number,
    taskType?: string,
    selectedSkills?: SelectedSkill[]
  ): Promise<{ output: string; toolCalls: number; modifiedFiles: string[]; iterations: ToolIteration[]; terminatedCorrectly: boolean }> {
    const modifiedFiles: string[] = [];
    const iterations: ToolIteration[] = [];
    let toolCalls = 0;
    const messages: Message[] = [
      { role: 'system', content: this.buildSystemPrompt() },
      { role: 'user', content: this.buildExecutionPrompt(task, plannerContext, attempt, taskType, selectedSkills) },
    ];

    for (let i = 0; i < this.MAX_TOOL_ITERATIONS; i++) {
      const responseText = await this.llmProvider.generate({ messages });

      iterations.push({
        iteration: i + 1,
        role: 'llm',
        content: responseText,
      });

      const action = this.parseAction(responseText);

      if (!action) {
        // Parsing failed: feed error back to LLM and continue the loop
        const errorMsg = 'Error: Your response was not valid JSON. Please respond with exactly one JSON object containing "thought", "action", and either "tool"/"params" or "answer".';
        iterations.push({
          iteration: i + 1,
          role: 'tool',
          content: errorMsg,
        });
        messages.push({ role: 'assistant', content: responseText });
        messages.push({ role: 'user', content: errorMsg });
        continue;
      }

      if (action.action === 'final_answer') {
        return {
          output: action.answer || action.thought || '(no answer)',
          toolCalls,
          modifiedFiles,
          iterations,
          terminatedCorrectly: true,
        };
      }

      if (action.action === 'tool_call' && action.tool) {
        toolCalls++;
        const params = this.normalizeToolParams(action.tool, action.params || {});

        let toolResult: string;
        try {
          const rawResult = await this.tools.execute(action.tool, params);
          toolResult = typeof rawResult === 'string' ? rawResult : JSON.stringify(rawResult, null, 2);
        } catch (err: any) {
          toolResult = `Error: ${err?.message || String(err)}`;
        }

        // Track modified files
        if ((action.tool === 'write_file' || action.tool === 'replace_text' ||
             action.tool === 'insert_before' || action.tool === 'insert_after' || action.tool === 'append_text')
            && params.filePath) {
          modifiedFiles.push(params.filePath);
        }

        iterations.push({
          iteration: i + 1,
          role: 'tool',
          content: toolResult,
          toolName: action.tool,
          toolResult,
        });

        messages.push({ role: 'assistant', content: responseText });
        messages.push({
          role: 'user',
          content: `[Tool Result: ${action.tool}]\n${toolResult}`,
        });
        continue;
      }

      // Unknown action: feed error back to LLM and continue
      const errorMsg = `Error: Unknown action "${action.action}". Please use "tool_call" or "final_answer".`;
      iterations.push({
        iteration: i + 1,
        role: 'tool',
        content: errorMsg,
      });
      messages.push({ role: 'assistant', content: responseText });
      messages.push({ role: 'user', content: errorMsg });
    }

    return {
      output: 'Agent terminated without final_answer',
      toolCalls,
      modifiedFiles,
      iterations,
      terminatedCorrectly: false,
    };
  }

  // ── Prompt Building ──────────────────────────────────────────────────────

  private buildSystemPrompt(): string {
    const toolList = this.tools.getAll()
      .map(tool => `- ${tool.name}: ${tool.description}`)
      .join('\n');

    return `You are a coding assistant. You must respond in JSON format.

Available tools:
${toolList}

Respond with exactly one JSON object:

For tool calls:
{\n  "thought": "your reasoning",\n  "action": "tool_call",\n  "tool": "tool_name",\n  "params": { "paramName": "value" }\n}

For final answer (when done):
{\n  "thought": "your reasoning",\n  "action": "final_answer",\n  "answer": "your final response"\n}

Rules:
- Use only the listed tools.
- Do ONE thing at a time.
- When editing EXISTING files, ALWAYS prefer replace_text, insert_before, insert_after, or append_text over write_file.
  * replace_text: Provide oldText with 2-3 lines of surrounding context for uniqueness, and newText.
  * insert_before/insert_after: Provide anchorText (unique enough) and newText.
  * append_text: Provide newText to add at the end of the file.
- Only use write_file when creating a NEW file or when you need to COMPLETELY rewrite an existing file.
- Always provide a thoughtful "thought" field.`;
  }

  private buildExecutionPrompt(task: string, context: IncrementalContext, attempt: number, taskType?: string, selectedSkills?: SelectedSkill[]): string {
    const parts: string[] = [];
    parts.push(`## Task (Attempt ${attempt})`);
    parts.push(`Type: ${taskType || 'general'}`);
    parts.push(task);
    parts.push('');

    // Inject Active Skills at the top of the prompt
    if (selectedSkills && selectedSkills.length > 0 && this.contextManager.skillManager) {
      parts.push(this.contextManager.skillManager.getPrompt(selectedSkills));
      parts.push('');
    }

    if (context.memoryFragment) {
      parts.push('## Conversation History');
      parts.push(context.memoryFragment);
      parts.push('');
    }

    if (context.embeddingResults.length > 0) {
      parts.push('## Relevant Files');
      for (const r of context.embeddingResults.slice(0, 5)) {
        parts.push(`- ${r.filePath} (score: ${r.score})`);
      }
      parts.push('');
    }

    if (context.repoGraphOverview) {
      parts.push('## Repository Overview');
      parts.push(context.repoGraphOverview);
      parts.push('');
    }

    if (context.contextPackage) {
      parts.push('## Selected Context Files');
      parts.push(context.contextPackage.selectedFiles.join('\n'));
      parts.push('');
    }

    if (context.gitRecentCommits) {
      parts.push('## Recent Commits');
      parts.push(context.gitRecentCommits);
      parts.push('');
    }

    if (context.gitChangedFiles) {
      parts.push('## Changed Files');
      parts.push(context.gitChangedFiles);
      parts.push('');
    }

    parts.push('## Instructions');
    parts.push(...this.buildTaskInstructions(taskType));

    return parts.join('\n');
  }

  private buildTaskInstructions(taskType?: string): string[] {
    const base = 'Analyze the task, use tools to make necessary changes, then provide a final_answer.';
    switch (taskType) {
      case 'replace': {
        return [
          base,
          '',
          'This is a REPLACE task. Follow this workflow strictly:',
          '1. LOCATE OLD IMPLEMENTATION: Read the existing file(s) to understand the current logic.',
          '2. CREATE NEW IMPLEMENTATION: Create the new file/module with the replacement logic. Do NOT modify the old implementation in-place unless explicitly allowed.',
          '3. UPDATE REFERENCES: Find all call sites / imports of the old implementation and redirect them to the new one.',
          '4. VERIFY BEHAVIOR: Confirm that the public interface remains unchanged and behavior is consistent.',
          '5. Provide a final_answer summarizing what was replaced and where.',
        ];
      }
      case 'migrate': {
        return [
          base,
          '',
          'This is a MIGRATE task. Follow this workflow strictly:',
          '1. LOCATE OLD IMPLEMENTATION: Understand the current code to be migrated.',
          '2. CREATE NEW ADAPTER / MODULE: Build the new target implementation or compatibility layer.',
          '3. UPDATE REFERENCES: Redirect consumers to the new module.',
          '4. VERIFY BEHAVIOR: Run tests or checks to ensure nothing is broken.',
          '5. Provide a final_answer summarizing migration steps.',
        ];
      }
      case 'refactor': {
        return [
          base,
          '',
          'This is a REFACTOR task. Follow this workflow strictly:',
          '1. UNDERSTAND CURRENT STRUCTURE: Read the target code thoroughly.',
          '2. SPLIT / EXTRACT: Apply structural improvements (split functions, extract classes, move logic to new files).',
          '3. PRESERVE BEHAVIOR: Do NOT change external behavior; keep public signatures stable.',
          '4. VERIFY: Ensure the code still compiles and tests pass.',
          '5. Provide a final_answer summarizing what was refactored.',
        ];
      }
      case 'create': {
        return [
          base,
          '',
          'This is a CREATE task. Follow this workflow strictly:',
          '1. RESEARCH CONVENTIONS: Look at existing files to match style, patterns, and module structure.',
          '2. CREATE FILES: Implement the new feature in the appropriate location.',
          '3. WIRE UP: Update any necessary imports, configs, or entry points.',
          '4. VERIFY: Ensure the new code compiles and integrates correctly.',
          '5. Provide a final_answer summarizing what was created.',
        ];
      }
      case 'modify': {
        return [
          base,
          '',
          'This is a MODIFY task. Follow this workflow strictly:',
          '1. LOCATE TARGET: Find the exact code to change.',
          '2. APPLY CHANGES: Make the minimal, focused edits required.',
          '3. VERIFY: Ensure the changes compile and tests pass.',
          '4. Provide a final_answer summarizing what was modified.',
        ];
      }
      case 'analyze': {
        return [
          'Analyze the codebase and provide a clear, structured answer.',
          'Use tools to read files and search code as needed.',
          'Provide a final_answer with your findings.',
        ];
      }
      default:
        return [base];
    }
  }

  private buildRepairPrompt(
    originalTask: string,
    verificationResults: VerificationResult[],
    modifiedFiles: string[],
    attempt: number
  ): string {
    const parts: string[] = [];
    parts.push(`## Repair Request (Attempt ${attempt + 1})`);
    parts.push('');
    parts.push('Original task:');
    parts.push(originalTask);
    parts.push('');
    parts.push('The previous attempt produced changes in these files:');
    for (const f of modifiedFiles) {
      parts.push(`- ${f}`);
    }
    parts.push('');
    parts.push('However, verification FAILED with the following issues:');
    parts.push('');

    for (const r of verificationResults) {
      if (r.passed || r.skipped) continue;
      parts.push(`### ${r.type.toUpperCase()}: ${r.command}`);
      parts.push(`Exit code: ${r.exitCode}, Duration: ${r.durationMs}ms`);
      if (r.diagnostics.length > 0) {
        for (const d of r.diagnostics.slice(0, 10)) {
          const loc = d.file ? `${d.file}:${d.line || 0}` : 'global';
          parts.push(`- [${d.severity.toUpperCase()}] ${loc} — ${d.message}`);
        }
      }
      if (r.stdout) {
        parts.push('Output:');
        parts.push('```');
        parts.push(r.stdout.split('\n').slice(0, 20).join('\n'));
        parts.push('```');
      }
      parts.push('');
    }

    parts.push('## Instructions');
    parts.push('Please fix the issues identified above. Use tools to inspect, modify, or revert files as needed.');

    return parts.join('\n');
  }

  private normalizeToolParams(tool: string, params: Record<string, any>): Record<string, any> {
    const normalized = { ...params };

    // Common LLM param aliases → registered param names
    if (tool === 'read_file' || tool === 'write_file' || tool === 'git_blame' || tool === 'git_file_history' ||
        tool === 'replace_text' || tool === 'insert_before' || tool === 'insert_after' || tool === 'append_text') {
      if (normalized.path !== undefined && normalized.filePath === undefined) {
        normalized.filePath = normalized.path;
        delete normalized.path;
      }
    }

    if (tool === 'search_code' || tool === 'search_symbols') {
      if (normalized.query !== undefined && normalized.keyword === undefined) {
        normalized.keyword = normalized.query;
        delete normalized.query;
      }
    }

    if (tool === 'get_definition' || tool === 'get_references') {
      if (normalized.path !== undefined && normalized.filePath === undefined) {
        normalized.filePath = normalized.path;
        delete normalized.path;
      }
      if (normalized.symbol !== undefined && normalized.symbolName === undefined) {
        normalized.symbolName = normalized.symbol;
        delete normalized.symbol;
      }
    }

    if (tool === 'run_terminal') {
      if (normalized.cmd !== undefined && normalized.command === undefined) {
        normalized.command = normalized.cmd;
        delete normalized.cmd;
      }
    }

    return normalized;
  }

  // ── Parsing ──────────────────────────────────────────────────────────────

  private parseAction(responseText: string): AgentAction | null {
    // Try to extract JSON from the response
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.action === 'tool_call' || parsed.action === 'final_answer') {
        return parsed as AgentAction;
      }
      return null;
    } catch {
      return null;
    }
  }

  // ── Reflection Input Builder ───────────────────────────────────────────

  private buildReflectionInput(
    userRequest: string,
    currentPlan: ExecutionPlan,
    executionResult: string,
    iterations: ToolIteration[],
    verificationResults: VerificationResult[],
    previousReflections: ReflectionRecord[]
  ): ReflectionInput {
    const toolResults: ToolResult[] = iterations
      .filter(it => it.role === 'tool' && it.toolName)
      .map(it => ({
        toolName: it.toolName!,
        params: {}, // params are not stored in ToolIteration; we infer success from content
        result: it.toolResult || it.content,
        success: !it.content.startsWith('Error:'),
      }));

    return {
      userRequest,
      currentPlan,
      executionResult,
      toolResults,
      verificationResults,
      previousReflections,
    };
  }

  // ── Formatting ───────────────────────────────────────────────────────────

  formatResultForPrompt(result: LoopResult): string {
    const lines: string[] = [];
    lines.push(`## Execution Result: ${result.state}`);
    lines.push(`- Attempts: ${result.metrics.attempts}/${result.metrics.maxAttempts}`);
    lines.push(`- Total duration: ${result.metrics.totalDurationMs}ms`);
    lines.push(`- Tool calls: ${result.metrics.toolCalls}`);
    lines.push('');

    for (const h of result.history) {
      lines.push(`### Attempt ${h.attempt} (${h.state})`);
      if (h.plan) {
        lines.push(`Plan: ${h.plan.intent} — ${h.plan.steps.length} steps`);
      }
      if (h.reflectionOutput) {
        lines.push(`Reflection: ${h.reflectionOutput.rootCause} (confidence: ${Math.round(h.reflectionOutput.confidence * 100)}%)`);
      }
      if (h.repairPrompt) {
        lines.push('(Repair retry after verification failure)');
      }
      for (const v of h.verificationResults) {
        const icon = v.passed ? '✅' : v.skipped ? '⏭️' : '❌';
        lines.push(`- ${icon} ${v.type}: ${v.command || 'N/A'} (exit ${v.exitCode}, ${v.durationMs}ms)`);
      }
      lines.push('');
    }

    if (result.state === 'FAILED' && result.history.length > 0) {
      const last = result.history[result.history.length - 1];
      lines.push('### Final Verification Failures');
      for (const v of last.verificationResults) {
        if (v.passed || v.skipped) continue;
        for (const d of v.diagnostics.slice(0, 5)) {
          const loc = d.file ? `${d.file}:${d.line || 0}` : 'global';
          lines.push(`- [${d.severity.toUpperCase()}] ${loc} — ${d.message}`);
        }
      }
    }

    lines.push('');
    lines.push('### Final Answer');
    lines.push(result.finalAnswer);

    return lines.join('\n');
  }
}

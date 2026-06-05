import { LLMProvider, Message } from '../llm/llm-provider';
import { ToolRegistry } from '../tools/tool-registry';
import { Planner, ExecutionPlan, IncrementalContext, PlanStep } from '../planner/planner';
import { RuntimeVerifier, VerificationResult } from '../verifier/runtime-verifier';
import { ContextManager } from '../context/context-manager';
import { GitAnalyzer } from '../git/git-analyzer';
import { ToolUsageAnalyzer } from '../debug/tool-usage-analyzer';

export type LoopState = 'PLAN' | 'EXECUTE' | 'VERIFY' | 'REPAIR' | 'COMPLETE' | 'FAILED';

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
  private readonly MAX_TOOL_ITERATIONS = 15;

  constructor(
    private readonly llmProvider: LLMProvider,
    private readonly planner: Planner,
    private readonly tools: ToolRegistry,
    private readonly verifier: RuntimeVerifier,
    private readonly contextManager: ContextManager,
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

    for (let attempt = 1; attempt <= this.MAX_RETRIES; attempt++) {
      const attemptStart = Date.now();
      console.log(`[AgentLoop] Attempt ${attempt}/${this.MAX_RETRIES} for task: ${task.slice(0, 60)}`);

      // ── PLAN ─────────────────────────────────────────────────────────────
      const plan = this.planner.create(currentTask, `loop-${Date.now()}`);
      const context = plan.context;

      // Execute planner steps (context building)
      for (const step of plan.steps) {
        await this.planner.executeStep(step, currentTask, `loop-${Date.now()}`, context);
      }

      // ── EXECUTE ──────────────────────────────────────────────────────────
      const { output, toolCalls, modifiedFiles, iterations, terminatedCorrectly } = await this.runExecutionLoop(
        currentTask,
        context,
        attempt
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
            maxAttempts: this.MAX_RETRIES,
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

      // ── REPAIR ───────────────────────────────────────────────────────────
      if (attempt >= this.MAX_RETRIES) {
        console.log(`[AgentLoop] Max retries exceeded`);
        break;
      }

      const repairPrompt = this.buildRepairPrompt(currentTask, verificationResults, modifiedFiles, attempt);
      currentTask = repairPrompt;

      history[history.length - 1].state = 'REPAIR';
      history[history.length - 1].repairPrompt = repairPrompt;

      console.log(`[AgentLoop] Repair prompt generated, retrying...`);
    }

    const result: LoopResult = {
      state: 'FAILED',
      finalAnswer,
      metrics: {
        attempts: history.length,
        maxAttempts: this.MAX_RETRIES,
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
    attempt: number
  ): Promise<{ output: string; toolCalls: number; modifiedFiles: string[]; iterations: ToolIteration[]; terminatedCorrectly: boolean }> {
    const modifiedFiles: string[] = [];
    const iterations: ToolIteration[] = [];
    let toolCalls = 0;
    const messages: Message[] = [
      { role: 'system', content: this.buildSystemPrompt() },
      { role: 'user', content: this.buildExecutionPrompt(task, plannerContext, attempt) },
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

  private buildExecutionPrompt(task: string, context: IncrementalContext, attempt: number): string {
    const parts: string[] = [];
    parts.push(`## Task (Attempt ${attempt})`);
    parts.push(task);
    parts.push('');

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
    parts.push('Analyze the task, use tools to make necessary changes, then provide a final_answer.');

    return parts.join('\n');
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

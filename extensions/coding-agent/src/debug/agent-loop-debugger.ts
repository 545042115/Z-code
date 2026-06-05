import * as vscode from 'vscode';
import { AgentLoop, LoopResult, LoopAttempt } from '../agent/agent-loop';

export class AgentLoopDebugger {
  constructor(private readonly agentLoop: AgentLoop) {}

  async runDebug(): Promise<void> {
    const task = await vscode.window.showInputBox({
      prompt: 'Enter a task to debug the Agent Loop',
      placeHolder: 'e.g., fix the authentication bug in src/auth.ts',
    });

    if (!task) return;

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Running Agent Loop for: ${task.slice(0, 40)}...`,
        cancellable: false,
      },
      async () => {
        const result = await this.agentLoop.executeTask(task);
        const report = this.buildDebugReport(result);
        const doc = await vscode.workspace.openTextDocument({
          content: report,
          language: 'markdown',
        });
        await vscode.window.showTextDocument(doc, { preview: true });
      }
    );
  }

  private buildDebugReport(result: LoopResult): string {
    const lines: string[] = [];
    lines.push('# Agent Loop Debug Report');
    lines.push('');
    lines.push(`**Final State:** \`${result.state}\``);
    lines.push(`**Attempts:** ${result.metrics.attempts}/${result.metrics.maxAttempts}`);
    lines.push(`**Total Duration:** ${result.metrics.totalDurationMs}ms`);
    lines.push(`**Total Tool Calls:** ${result.metrics.toolCalls}`);
    lines.push('');

    for (const attempt of result.history) {
      lines.push(this.formatAttempt(attempt));
    }

    lines.push('## Final Answer');
    lines.push('');
    lines.push('```');
    lines.push(result.finalAnswer || '(no answer)');
    lines.push('```');

    return lines.join('\n');
  }

  private formatAttempt(attempt: LoopAttempt): string {
    const lines: string[] = [];
    lines.push(`## Attempt ${attempt.attempt} — State: \`${attempt.state}\``);
    lines.push('');

    if (attempt.plan) {
      lines.push('### Plan');
      lines.push(`- **Intent:** ${attempt.plan.intent}`);
      lines.push(`- **Summary:** ${attempt.plan.summary}`);
      lines.push(`- **Steps:** ${attempt.plan.steps.length}`);
      for (const step of attempt.plan.steps) {
        lines.push(`  - [${step.status}] \`${step.action}\` — ${step.description}`);
      }
      lines.push('');
    }

    // Execution Iterations (ReAct loop)
    if (attempt.iterations && attempt.iterations.length > 0) {
      lines.push('### Execution Iterations');
      let currentIteration = 0;
      for (const it of attempt.iterations) {
        if (it.role === 'llm') {
          currentIteration++;
          const action = this.tryParseAction(it.content);
          if (action && action.action === 'tool_call' && action.tool) {
            lines.push(`**Iteration ${currentIteration} — Tool Call**`);
            lines.push(`- Tool: \`${action.tool}\``);
            lines.push(`- Params: \`${JSON.stringify(action.params || {})}\``);
          } else if (action && action.action === 'final_answer') {
            lines.push(`**Iteration ${currentIteration} — Final Answer**`);
          } else {
            lines.push(`**Iteration ${currentIteration} — LLM Response**`);
          }
          lines.push('```json');
          lines.push(it.content.length > 800 ? it.content.slice(0, 800) + '...' : it.content);
          lines.push('```');
        } else if (it.role === 'tool') {
          lines.push(`**Tool Result**`);
          lines.push('```');
          lines.push((it.toolResult || it.content).length > 500 ? (it.toolResult || it.content).slice(0, 500) + '...' : (it.toolResult || it.content));
          lines.push('```');
        }
        lines.push('');
      }
      lines.push(`*Terminated correctly: ${attempt.terminatedCorrectly ? 'Yes' : 'No'}*`);
      lines.push('');
    } else {
      lines.push('### Execution Output');
      lines.push('```');
      lines.push(attempt.executionOutput || '(no output)');
      lines.push('```');
      lines.push('');
    }

    if (attempt.modifiedFiles.length > 0) {
      lines.push('### Modified Files');
      for (const f of attempt.modifiedFiles) {
        lines.push(`- ${f}`);
      }
      lines.push('');
    }

    lines.push('### Verification Results');
    if (attempt.verificationResults.length === 0) {
      lines.push('No verification results.');
    } else {
      for (const v of attempt.verificationResults) {
        const icon = v.passed ? '✅' : v.skipped ? '⏭️' : '❌';
        lines.push(`- ${icon} **${v.type.toUpperCase()}**: \`${v.command || 'N/A'}\``);
        lines.push(`  - Exit code: ${v.exitCode}, Duration: ${v.durationMs}ms`);
        if (v.diagnostics.length > 0) {
          lines.push(`  - Diagnostics:`);
          for (const d of v.diagnostics.slice(0, 5)) {
            const loc = d.file ? `${d.file}:${d.line || 0}` : 'global';
            lines.push(`    - [${d.severity.toUpperCase()}] ${loc} — ${d.message}`);
          }
          if (v.diagnostics.length > 5) {
            lines.push(`    - ... and ${v.diagnostics.length - 5} more`);
          }
        }
      }
    }
    lines.push('');

    if (attempt.repairPrompt) {
      lines.push('### Repair Prompt (for next attempt)');
      lines.push('```');
      lines.push(attempt.repairPrompt.slice(0, 1000));
      lines.push('```');
      lines.push('');
    }

    return lines.join('\n');
  }

  private tryParseAction(content: string): { action: string; tool?: string; params?: Record<string, any>; answer?: string } | null {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.action === 'tool_call' || parsed.action === 'final_answer') {
        return parsed;
      }
      return null;
    } catch {
      return null;
    }
  }
}

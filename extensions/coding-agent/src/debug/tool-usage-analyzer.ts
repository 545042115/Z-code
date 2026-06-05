import * as vscode from 'vscode';
import { LoopResult, ToolIteration, LoopAttempt } from '../agent/agent-loop';
import { ToolRegistry } from '../tools/tool-registry';

export interface ToolUsageRecord {
  /** 用户原始请求 */
  task: string;
  /** 记录时间戳 */
  timestamp: number;
  /** Planner 生成的步骤 action 列表 */
  plannedSteps: string[];
  /** 实际调用的工具及次数 */
  actualToolCalls: { toolName: string; count: number }[];
  /** 工具调用序列（按顺序） */
  toolSequence: string[];
  /** 每次工具调用的结果 */
  toolResults: { toolName: string; result: string; success: boolean }[];
  /** 最终状态 */
  finalState: string;
  /** 是否成功 */
  success: boolean;
  /** 总耗时 ms */
  durationMs: number;
  /** 尝试次数 */
  attempts: number;
  /** 总工具调用次数 */
  totalToolCalls: number;
}

export interface ToolUsageReport {
  task: string;
  plannedSteps: string[];
  actualToolCalls: { toolName: string; count: number }[];
  toolSequence: string[];
  toolCoverage: number;
  unusedPlannedTools: string[];
  finalState: string;
  success: boolean;
  durationMs: number;
  attempts: number;
}

export interface AggregateReport {
  totalRecords: number;
  successRate: number;
  avgDurationMs: number;
  avgToolCalls: number;
  mostUsedTools: { toolName: string; count: number }[];
  rarelyUsedTools: { toolName: string; count: number }[];
  neverUsedTools: string[];
  toolCoverageTrend: { task: string; coverage: number }[];
}

/**
 * Agent Tool Usage Analyzer
 *
 * 记录每次 Agent 执行的工具使用数据，生成单任务报告和聚合报告。
 * 用于发现：
 * - 哪些工具从未被 Agent 调用
 * - 哪些 Planner 步骤没有转化为 Tool Call
 * - 哪些工具值得删除
 * - 哪些工具需要增强 Prompt 引导
 */
export class ToolUsageAnalyzer {
  private records: ToolUsageRecord[] = [];
  private readonly MAX_RECORDS = 100;

  constructor(private readonly tools: ToolRegistry) {}

  /**
   * 记录一次 Agent 执行的工具使用数据
   */
  recordExecution(task: string, result: LoopResult): void {
    const plannedSteps: string[] = [];
    const toolCallMap = new Map<string, number>();
    const toolSequence: string[] = [];
    const toolResults: { toolName: string; result: string; success: boolean }[] = [];

    for (const attempt of result.history) {
      // 收集 planned steps
      if (attempt.plan && attempt.plan.steps) {
        for (const step of attempt.plan.steps) {
          if (step.action && !plannedSteps.includes(step.action)) {
            plannedSteps.push(step.action);
          }
        }
      }

      // 收集实际工具调用
      if (attempt.iterations) {
        for (const it of attempt.iterations) {
          if (it.role === 'tool' && it.toolName) {
            toolCallMap.set(it.toolName, (toolCallMap.get(it.toolName) || 0) + 1);
            toolSequence.push(it.toolName);
            toolResults.push({
              toolName: it.toolName,
              result: (it.toolResult || it.content || '').slice(0, 500),
              success: !(it.toolResult || it.content || '').startsWith('Error:'),
            });
          }
        }
      }
    }

    const actualToolCalls = Array.from(toolCallMap.entries())
      .map(([toolName, count]) => ({ toolName, count }))
      .sort((a, b) => b.count - a.count);

    const record: ToolUsageRecord = {
      task,
      timestamp: Date.now(),
      plannedSteps,
      actualToolCalls,
      toolSequence,
      toolResults,
      finalState: result.state,
      success: result.state === 'COMPLETE',
      durationMs: result.metrics.totalDurationMs,
      attempts: result.metrics.attempts,
      totalToolCalls: result.metrics.toolCalls,
    };

    this.records.push(record);
    if (this.records.length > this.MAX_RECORDS) {
      this.records.shift();
    }

    console.log(`[ToolUsageAnalyzer] Recorded execution: task="${task.slice(0, 40)}" state=${record.finalState} tools=${record.totalToolCalls}`);
  }

  /**
   * 生成最近一次执行的单任务报告
   */
  generateLastReport(): string {
    if (this.records.length === 0) {
      return '# Tool Usage Report\n\nNo execution records yet.';
    }
    return this.generateReportForRecord(this.records[this.records.length - 1]);
  }

  /**
   * 生成指定任务的报告
   */
  generateReportForTask(taskQuery: string): string {
    const record = this.records
      .slice()
      .reverse()
      .find(r => r.task.includes(taskQuery));
    if (!record) {
      return `# Tool Usage Report\n\nNo record found for task: "${taskQuery}"`;
    }
    return this.generateReportForRecord(record);
  }

  private generateReportForRecord(record: ToolUsageRecord): string {
    const allTools = this.tools.getAll().map(t => t.name);
    const usedTools = new Set(record.actualToolCalls.map(t => t.toolName));
    const unusedTools = allTools.filter(t => !usedTools.has(t));

    // Tool Coverage: 实际使用的工具数 / 所有可用工具数
    const toolCoverage = allTools.length > 0 ? Math.round((usedTools.size / allTools.length) * 100) : 0;

    // Planner steps vs actual tool calls 的映射分析
    const plannedToolSet = new Set(record.plannedSteps);
    const unusedPlannedTools = record.plannedSteps.filter(s => !usedTools.has(s));

    const lines: string[] = [];
    lines.push('# Tool Usage Report');
    lines.push('');
    lines.push(`## Task`);
    lines.push(`"${record.task}"`);
    lines.push('');

    lines.push(`## Planned Steps`);
    if (record.plannedSteps.length === 0) {
      lines.push('*(No planned steps recorded)*');
    } else {
      for (const step of record.plannedSteps) {
        const used = usedTools.has(step) ? ' [used]' : ' [NOT used]';
        lines.push(`- \`${step}\`${used}`);
      }
    }
    lines.push('');

    lines.push(`## Actual Tool Calls`);
    if (record.actualToolCalls.length === 0) {
      lines.push('*(No tool calls recorded)*');
    } else {
      let seqIdx = 1;
      for (const tc of record.actualToolCalls) {
        lines.push(`${seqIdx}. \`${tc.toolName}\` — called ${tc.count} time(s)`);
        seqIdx++;
      }
    }
    lines.push('');

    lines.push(`## Tool Call Sequence`);
    if (record.toolSequence.length === 0) {
      lines.push('*(No tool calls)*');
    } else {
      lines.push(record.toolSequence.map((t, i) => `${i + 1}. \`${t}\``).join(' → '));
    }
    lines.push('');

    lines.push(`## Tool Coverage`);
    lines.push(`${toolCoverage}% (${usedTools.size} / ${allTools.length})`);
    lines.push('');

    lines.push(`## Unused Planned Tools`);
    if (unusedPlannedTools.length === 0) {
      lines.push('*(All planned tools were used)*');
    } else {
      for (const t of unusedPlannedTools) {
        lines.push(`- \`${t}\``);
      }
    }
    lines.push('');

    lines.push(`## Unused Available Tools`);
    if (unusedTools.length === 0) {
      lines.push('*(All available tools were used)*');
    } else {
      for (const t of unusedTools) {
        lines.push(`- \`${t}\``);
      }
    }
    lines.push('');

    lines.push(`## Tool Results Summary`);
    if (record.toolResults.length === 0) {
      lines.push('*(No tool results)*');
    } else {
      const successCount = record.toolResults.filter(r => r.success).length;
      const failCount = record.toolResults.length - successCount;
      lines.push(`- Success: ${successCount}`);
      lines.push(`- Failed: ${failCount}`);
      for (const r of record.toolResults.slice(0, 10)) {
        const icon = r.success ? '✅' : '❌';
        lines.push(`  ${icon} \`${r.toolName}\`: ${r.result.slice(0, 80)}${r.result.length > 80 ? '...' : ''}`);
      }
      if (record.toolResults.length > 10) {
        lines.push(`  ... and ${record.toolResults.length - 10} more`);
      }
    }
    lines.push('');

    lines.push(`## Execution Summary`);
    lines.push(`- Final State: \`${record.finalState}\``);
    lines.push(`- Success: ${record.success ? 'Yes' : 'No'}`);
    lines.push(`- Duration: ${record.durationMs}ms`);
    lines.push(`- Attempts: ${record.attempts}`);
    lines.push(`- Total Tool Calls: ${record.totalToolCalls}`);
    lines.push('');

    return lines.join('\n');
  }

  /**
   * 生成聚合报告（最近 N 次执行）
   */
  generateAggregateReport(limit: number = 100): string {
    const records = this.records.slice(-limit);
    if (records.length === 0) {
      return '# Agent Tool Usage Aggregate Report\n\nNo execution records yet.';
    }

    const allTools = this.tools.getAll().map(t => t.name);
    const totalRecords = records.length;
    const successCount = records.filter(r => r.success).length;
    const successRate = totalRecords > 0 ? Math.round((successCount / totalRecords) * 100) : 0;
    const avgDuration = totalRecords > 0 ? Math.round(records.reduce((s, r) => s + r.durationMs, 0) / totalRecords) : 0;
    const avgToolCalls = totalRecords > 0 ? Math.round(records.reduce((s, r) => s + r.totalToolCalls, 0) / totalRecords * 10) / 10 : 0;

    // 聚合工具使用次数
    const toolUsageMap = new Map<string, number>();
    for (const record of records) {
      for (const tc of record.actualToolCalls) {
        toolUsageMap.set(tc.toolName, (toolUsageMap.get(tc.toolName) || 0) + tc.count);
      }
    }

    const mostUsedTools = Array.from(toolUsageMap.entries())
      .map(([toolName, count]) => ({ toolName, count }))
      .sort((a, b) => b.count - a.count);

    const neverUsedTools = allTools.filter(t => !toolUsageMap.has(t));
    const rarelyUsedThreshold = Math.max(1, Math.floor(totalRecords * 0.05));
    const rarelyUsedTools = mostUsedTools.filter(t => t.count <= rarelyUsedThreshold);

    const coverageTrend = records.map(r => {
      const used = new Set(r.actualToolCalls.map(t => t.toolName));
      const coverage = allTools.length > 0 ? Math.round((used.size / allTools.length) * 100) : 0;
      return { task: r.task.slice(0, 50), coverage };
    });

    const lines: string[] = [];
    lines.push('# Agent Tool Usage Aggregate Report');
    lines.push('');
    lines.push(`## Overview`);
    lines.push(`- Total Executions: ${totalRecords}`);
    lines.push(`- Success Rate: ${successRate}%`);
    lines.push(`- Avg Duration: ${avgDuration}ms`);
    lines.push(`- Avg Tool Calls: ${avgToolCalls}`);
    lines.push('');

    lines.push(`## Most Used Tools`);
    if (mostUsedTools.length === 0) {
      lines.push('*(No tool usage recorded)*');
    } else {
      for (const t of mostUsedTools) {
        lines.push(`- \`${t.toolName}\`: ${t.count}`);
      }
    }
    lines.push('');

    lines.push(`## Rarely Used Tools (<= ${rarelyUsedThreshold} calls)`);
    if (rarelyUsedTools.length === 0) {
      lines.push('*(No rarely used tools)*');
    } else {
      for (const t of rarelyUsedTools) {
        lines.push(`- \`${t.toolName}\`: ${t.count}`);
      }
    }
    lines.push('');

    lines.push(`## Never Used Tools`);
    if (neverUsedTools.length === 0) {
      lines.push('*(All tools have been used)*');
    } else {
      for (const t of neverUsedTools) {
        lines.push(`- \`${t}\``);
      }
    }
    lines.push('');

    lines.push(`## Tool Coverage Trend (last ${Math.min(20, coverageTrend.length)} tasks)`);
    for (const t of coverageTrend.slice(-20)) {
      const bar = '█'.repeat(Math.round(t.coverage / 5)) + '░'.repeat(20 - Math.round(t.coverage / 5));
      lines.push(`- ${t.task.padEnd(40)} ${bar} ${t.coverage}%`);
    }
    lines.push('');

    lines.push(`## Insights`);
    if (neverUsedTools.length > allTools.length * 0.5) {
      lines.push(`- **Warning**: ${neverUsedTools.length}/${allTools.length} tools have NEVER been used. Consider removing or improving prompt guidance.`);
    }
    if (mostUsedTools.length > 0 && mostUsedTools[0].count > totalRecords * 3) {
      lines.push(`- **Observation**: \`${mostUsedTools[0].toolName}\` is heavily overused (${mostUsedTools[0].count} calls). The Agent may be underutilizing other tools.`);
    }
    if (successRate < 50) {
      lines.push(`- **Warning**: Success rate is only ${successRate}%. Tool usage may be ineffective or verification is too strict.`);
    }
    lines.push('');

    return lines.join('\n');
  }

  /**
   * 清空所有记录
   */
  clearRecords(): void {
    this.records = [];
    console.log('[ToolUsageAnalyzer] All records cleared');
  }

  /**
   * 获取记录数量
   */
  getRecordCount(): number {
    return this.records.length;
  }
}

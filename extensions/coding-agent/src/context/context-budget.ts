// Context Budget Manager - Unified budget control for all Prompt injection sources.
//
// Prevents Prompt bloat by enforcing character limits per source type.
// Every context chunk has a source, priority, and estimated size.
// The BudgetManager allocates space and trims low-priority chunks when over budget.

// ── Types ─────────────────────────────────────────────────────────────

export type ContextSource = 'file' | 'symbol' | 'memory' | 'skill' | 'diagnostic' | 'git' | 'repoKnowledge' | 'architecture' | 'projectInfo' | 'keyCode' | 'guidance' | 'embedding' | 'contextPackage' | 'plan' | 'other';

export interface ContextBudget {
  maxTotalChars: number;
  maxFileChars: number;
  maxSkillChars: number;
  maxMemoryChars: number;
  maxDiagnostics: number;
  maxRepoKnowledgeChars: number;
  maxArchitectureChars: number;
  maxKeyCodeChars: number;
  maxGuidanceChars: number;
  maxContextPackageChars: number;
}

export interface ContextChunk {
  source: ContextSource;
  title: string;
  content: string;
  priority: number;  // 0-100, higher = more important
  estimatedChars: number;
  trimmable: boolean; // whether content can be truncated
}

export interface BudgetAllocationResult {
  included: ContextChunk[];
  excluded: ContextChunk[];
  totalChars: number;
  budget: ContextBudget;
  trimLog: BudgetTrimEntry[];
}

export interface BudgetTrimEntry {
  source: ContextSource;
  title: string;
  originalChars: number;
  finalChars: number;
  reason: string;
}

// ── Default Budget ────────────────────────────────────────────────────

export const DEFAULT_BUDGET: ContextBudget = {
  maxTotalChars: 24000,
  maxFileChars: 6000,
  maxSkillChars: 5000,
  maxMemoryChars: 2000,
  maxDiagnostics: 800,
  maxRepoKnowledgeChars: 3000,
  maxArchitectureChars: 2000,
  maxKeyCodeChars: 4000,
  maxGuidanceChars: 2000,
  maxContextPackageChars: 4000,
};

// Source-level default priorities (higher = more important)
const SOURCE_PRIORITIES: Record<ContextSource, number> = {
  keyCode: 90,
  contextPackage: 80,
  skill: 75,
  diagnostic: 70,
  file: 65,
  symbol: 60,
  repoKnowledge: 55,
  architecture: 50,
  memory: 45,
  git: 40,
  projectInfo: 35,
  guidance: 30,
  embedding: 25,
  plan: 20,
  other: 10,
};

// ── BudgetManager ─────────────────────────────────────────────────────

export class BudgetManager {
  private budget: ContextBudget;
  private chunks: ContextChunk[] = [];

  constructor(budget: ContextBudget = DEFAULT_BUDGET) {
    this.budget = budget;
  }

  /**
   * Reset the manager for a new allocation cycle.
   */
  reset(budget?: ContextBudget): void {
    if (budget) this.budget = budget;
    this.chunks = [];
  }

  /**
   * Register a context chunk for budget allocation.
   */
  addChunk(source: ContextSource, title: string, content: string, options?: { priority?: number; trimmable?: boolean }): void {
    const priority = options?.priority ?? SOURCE_PRIORITIES[source] ?? 50;
    const trimmable = options?.trimmable ?? true;
    this.chunks.push({
      source,
      title,
      content,
      priority,
      estimatedChars: content.length,
      trimmable,
    });
  }

  /**
   * Convenience: add a chunk only if content is non-empty.
   */
  addIfNonEmpty(source: ContextSource, title: string, content: string | undefined | null, options?: { priority?: number; trimmable?: boolean }): void {
    if (content && content.trim().length > 0) {
      this.addChunk(source, title, content, options);
    }
  }

  /**
   * Allocate budget across all registered chunks.
   *
   * Strategy:
   * 1. Apply per-source caps (e.g., skill <= maxSkillChars)
   * 2. Sort by priority (descending)
   * 3. Fill from highest priority until total budget exhausted
   * 4. Trimmable chunks get truncated; non-trimmable chunks are excluded if over cap
   */
  allocate(): BudgetAllocationResult {
    const trimLog: BudgetTrimEntry[] = [];
    const included: ContextChunk[] = [];
    const excluded: ContextChunk[] = [];

    // Step 1: Apply per-source caps
    const capped = this.applySourceCaps(this.chunks, trimLog);

    // Step 2: Sort by priority descending, then by estimatedChars ascending (prefer smaller when same priority)
    capped.sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return a.estimatedChars - b.estimatedChars;
    });

    // Step 3: Fill within total budget
    let totalChars = 0;
    for (const chunk of capped) {
      if (totalChars + chunk.estimatedChars <= this.budget.maxTotalChars) {
        included.push(chunk);
        totalChars += chunk.estimatedChars;
      } else if (chunk.trimmable) {
        // Try to fit a truncated version
        const remaining = this.budget.maxTotalChars - totalChars;
        if (remaining > 100) {
          const truncated = this.truncateContent(chunk.content, remaining);
          included.push({
            ...chunk,
            content: truncated,
            estimatedChars: truncated.length,
          });
          trimLog.push({
            source: chunk.source,
            title: chunk.title,
            originalChars: chunk.content.length,
            finalChars: truncated.length,
            reason: `total budget exceeded, truncated to ${remaining} chars`,
          });
          totalChars += truncated.length;
        } else {
          excluded.push(chunk);
          trimLog.push({
            source: chunk.source,
            title: chunk.title,
            originalChars: chunk.content.length,
            finalChars: 0,
            reason: 'total budget exceeded, not enough remaining space',
          });
        }
      } else {
        excluded.push(chunk);
        trimLog.push({
          source: chunk.source,
          title: chunk.title,
          originalChars: chunk.content.length,
          finalChars: 0,
          reason: 'total budget exceeded, non-trimmable chunk excluded',
        });
      }
    }

    return { included, excluded, totalChars, budget: this.budget, trimLog };
  }

  /**
   * Apply per-source character caps.
   */
  private applySourceCaps(chunks: ContextChunk[], trimLog: BudgetTrimEntry[]): ContextChunk[] {
    const sourceCapMap: Partial<Record<ContextSource, number>> = {
      skill: this.budget.maxSkillChars,
      memory: this.budget.maxMemoryChars,
      diagnostic: this.budget.maxDiagnostics,
      repoKnowledge: this.budget.maxRepoKnowledgeChars,
      architecture: this.budget.maxArchitectureChars,
      keyCode: this.budget.maxKeyCodeChars,
      guidance: this.budget.maxGuidanceChars,
      contextPackage: this.budget.maxContextPackageChars,
      file: this.budget.maxFileChars,
    };

    // Group chunks by source
    const bySource = new Map<ContextSource, ContextChunk[]>();
    for (const chunk of chunks) {
      const list = bySource.get(chunk.source) || [];
      list.push(chunk);
      bySource.set(chunk.source, list);
    }

    const result: ContextChunk[] = [];
    for (const [source, sourceChunks] of bySource) {
      const cap = sourceCapMap[source];
      if (cap === undefined) {
        // No cap for this source
        result.push(...sourceChunks);
        continue;
      }

      // Merge all chunks of the same source, then apply cap
      const totalChars = sourceChunks.reduce((sum, c) => sum + c.estimatedChars, 0);
      if (totalChars <= cap) {
        result.push(...sourceChunks);
        continue;
      }

      // Need to trim: sort by priority within source, keep highest priority first
      const sorted = [...sourceChunks].sort((a, b) => b.priority - a.priority);
      let usedChars = 0;
      for (const chunk of sorted) {
        if (usedChars + chunk.estimatedChars <= cap) {
          result.push(chunk);
          usedChars += chunk.estimatedChars;
        } else if (chunk.trimmable) {
          const remaining = cap - usedChars;
          if (remaining > 50) {
            const truncated = this.truncateContent(chunk.content, remaining);
            result.push({ ...chunk, content: truncated, estimatedChars: truncated.length });
            trimLog.push({
              source: chunk.source,
              title: chunk.title,
              originalChars: chunk.content.length,
              finalChars: truncated.length,
              reason: `source cap ${cap} exceeded, truncated`,
            });
            usedChars += truncated.length;
          } else {
            trimLog.push({
              source: chunk.source,
              title: chunk.title,
              originalChars: chunk.content.length,
              finalChars: 0,
              reason: `source cap ${cap} exceeded, dropped`,
            });
          }
        }
      }
    }

    return result;
  }

  /**
   * Truncate content to a maximum character count, preferring to break at line boundaries.
   */
  private truncateContent(content: string, maxChars: number): string {
    if (content.length <= maxChars) return content;
    const truncated = content.slice(0, maxChars);
    const lastNewline = truncated.lastIndexOf('\n');
    const cutoff = lastNewline > maxChars * 0.5 ? lastNewline : maxChars;
    return truncated.slice(0, cutoff) + '\n... [trimmed by context budget]';
  }

  /**
   * Format the allocation result into a summary string for debugging.
   */
  formatAllocationSummary(result: BudgetAllocationResult): string {
    const lines: string[] = [];
    lines.push(`Context Budget: ${result.totalChars}/${result.budget.maxTotalChars} chars used`);
    lines.push('');

    if (result.included.length > 0) {
      lines.push('Included:');
      for (const chunk of result.included) {
        lines.push(`  [${chunk.source}] ${chunk.title} (${chunk.estimatedChars} chars, priority ${chunk.priority})`);
      }
    }

    if (result.excluded.length > 0) {
      lines.push('');
      lines.push('Excluded:');
      for (const chunk of result.excluded) {
        lines.push(`  [${chunk.source}] ${chunk.title} (${chunk.estimatedChars} chars, priority ${chunk.priority})`);
      }
    }

    if (result.trimLog.length > 0) {
      lines.push('');
      lines.push('Trim Log:');
      for (const entry of result.trimLog) {
        lines.push(`  [${entry.source}] ${entry.title}: ${entry.originalChars} -> ${entry.finalChars} chars (${entry.reason})`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Build the final Prompt string from allocated chunks.
   * Chunks are grouped by source and output in priority order.
   */
  buildPromptFromResult(result: BudgetAllocationResult): string {
    // Re-sort included chunks: group by source, maintain priority order
    const sorted = [...result.included].sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return a.source.localeCompare(b.source);
    });

    const parts: string[] = [];
    let currentSource: ContextSource | null = null;

    for (const chunk of sorted) {
      if (chunk.source !== currentSource) {
        currentSource = chunk.source;
      }
      parts.push(chunk.content);
    }

    return parts.join('\n\n');
  }

  /**
   * Get the current budget configuration.
   */
  getBudget(): ContextBudget {
    return { ...this.budget };
  }

  /**
   * Update budget configuration.
   */
  updateBudget(partial: Partial<ContextBudget>): void {
    this.budget = { ...this.budget, ...partial };
  }
}

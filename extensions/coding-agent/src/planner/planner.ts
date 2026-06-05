// Planner module - builds and executes multi-step execution plans for the coding agent.
// Uses memory, embedding search, repo graph, and git analysis to gather context.

import { MemoryManager, MemoryEntry } from '../memory/memoryManager';
import { RepoGraph } from '../context/repoGraph';
import { ContextBuilder, ContextPackage } from '../context/contextBuilder';
import { HybridRetrieval, HybridSearchResult } from '../context/hybrid-retrieval';
import { GitAnalyzer } from '../git/git-analyzer';

export type IntentType = 'project_understanding' | 'bug_fix' | 'feature_add' | 'refactor' | 'testing' | 'documentation' | 'removal' | 'other';

export type PlanAction =
  | 'classify_intent'
  | 'retrieve_memory'
  | 'search_embedding'
  | 'query_repograph'
  | 'build_context'
  | 'generate_answer'
  | 'git_recent_commits'
  | 'git_changed_files'
  | 'git_file_history'
  | 'git_diff_between';

export interface PlanStep {
  id: string;
  description: string;
  action: PlanAction;
  status: 'pending' | 'completed';
  result?: any;
}

export interface ExecutionPlan {
  intent: IntentType;
  steps: PlanStep[];
  context: IncrementalContext;
  summary: string;
  searchTerms?: string[];
}

export interface IncrementalContext {
  memoryFragment: string;
  embeddingResults: HybridSearchResult[];
  repoGraphOverview: string;
  contextPackage?: ContextPackage;
  selectedFiles: string[];
  accumulated: string;
  currentFile?: string;
  gitRecentCommits?: string;
  gitChangedFiles?: string;
  gitFileHistories?: string;
  gitDiff?: string;
}

export class Planner {
  constructor(
    private readonly memoryManager: MemoryManager,
    private readonly hybridRetrieval: HybridRetrieval,
    private readonly repoGraph: RepoGraph,
    private readonly contextBuilder: ContextBuilder,
    private readonly gitAnalyzer?: GitAnalyzer
  ) {}

  create(request: string, sessionId: string): ExecutionPlan {
    const intent = this.classifyIntent(request);
    const steps: PlanStep[] = this.buildSteps(intent, request, sessionId);

    return {
      intent,
      steps,
      context: {
        memoryFragment: '',
        embeddingResults: [],
        repoGraphOverview: '',
        selectedFiles: [],
        accumulated: '',
        currentFile: undefined,
      },
      summary: `Plan for [${intent}]: ${request.slice(0, 80)}`,
    };
  }

  async executeStep(step: PlanStep, request: string, sessionId: string, context: IncrementalContext, searchTerms?: string[]): Promise<PlanStep> {
    switch (step.action) {
      case 'classify_intent': {
        const intent = this.classifyIntent(request);
        return { ...step, status: 'completed', result: intent };
      }

      case 'retrieve_memory': {
        const intent = this.classifyIntent(request);
        const recentHistory = this.memoryManager.getContextForPrompt(sessionId, 8);
        const intentHistory = this.memoryManager.findByIntent(sessionId, intent);
        const memoryFragment = this.formatMemoryFragment(recentHistory, intentHistory);
        context.memoryFragment = memoryFragment;
        return { ...step, status: 'completed', result: { recentHistory, intentHistory } };
      }

      case 'search_embedding': {
        const searchQuery = searchTerms && searchTerms.length > 0 ? searchTerms.join(' ') : request;
        console.log(`[Planner] search_embedding using searchTerms=${JSON.stringify(searchTerms)}`);
        console.log(`[Planner] effective search query="${searchQuery}"`);
        const results = await this.hybridRetrieval.search(searchQuery, { topK: 8, searchTerms });
        context.embeddingResults = results;
        context.selectedFiles.push(...results.map(r => r.filePath));
        return { ...step, status: 'completed', result: results };
      }

      case 'query_repograph': {
        const overview = this.repoGraph.getDependencyOverview();
        const intent = this.classifyIntent(request);
        let focusedOverview = overview;

        if (intent === 'project_understanding') {
          focusedOverview = this.repoGraph.formatForPrompt();
        } else if (intent === 'bug_fix') {
          const relevantModules = this.getModulesFromEmbedding(context.embeddingResults);
          focusedOverview = `### Focused Modules: ${relevantModules.join(', ') || 'all'}\n\n${overview}`;
        } else if (intent === 'feature_add') {
          const relevantModules = this.getModulesFromEmbedding(context.embeddingResults);
          focusedOverview = `### Target Modules: ${relevantModules.join(', ') || 'all'}\n\n${overview}`;
        }

        context.repoGraphOverview = focusedOverview;
        return { ...step, status: 'completed', result: focusedOverview };
      }

      case 'build_context': {
        const gitContext = this.buildGitContextString(context);
        const pkg = await this.contextBuilder.build(request, context.currentFile, gitContext);
        context.contextPackage = pkg;

        const embeddingPaths = new Set(context.embeddingResults.map(r => r.filePath));
        for (const f of pkg.selectedFiles) {
          if (!context.selectedFiles.includes(f)) {
            context.selectedFiles.push(f);
          }
        }

        context.accumulated = this.accumulateContext(context);
        return { ...step, status: 'completed', result: pkg };
      }

      case 'generate_answer': {
        context.accumulated = this.accumulateContext(context);
        return { ...step, status: 'completed', result: context };
      }

      case 'git_recent_commits': {
        if (!this.gitAnalyzer || !this.gitAnalyzer.isInitialized) {
          return { ...step, status: 'completed', result: 'Git not available' };
        }
        const commits = await this.gitAnalyzer.getRecentCommits(10);
        const formatted = this.gitAnalyzer.formatCommitsForPrompt(commits);
        context.gitRecentCommits = formatted;
        return { ...step, status: 'completed', result: formatted };
      }

      case 'git_changed_files': {
        if (!this.gitAnalyzer || !this.gitAnalyzer.isInitialized) {
          return { ...step, status: 'completed', result: 'Git not available' };
        }
        const files = await this.gitAnalyzer.getChangedFiles();
        if (files.length === 0) {
          context.gitChangedFiles = 'No changes in working tree.';
        } else {
          context.gitChangedFiles = files
            .map(f => `${f.status.toUpperCase()}: ${f.path} (+${f.additions}/-${f.deletions})`)
            .join('\n');
        }
        return { ...step, status: 'completed', result: context.gitChangedFiles };
      }

      case 'git_file_history': {
        if (!this.gitAnalyzer || !this.gitAnalyzer.isInitialized) {
          return { ...step, status: 'completed', result: 'Git not available' };
        }
        const histories: string[] = [];
        const targetFiles = context.selectedFiles.slice(0, 3);
        for (const file of targetFiles) {
          const history = await this.gitAnalyzer.getFileHistory(file, 5);
          if (history.length > 0) {
            histories.push(`### ${file}\n` + history.map(h => `  ${h.hash.slice(0, 7)} ${h.message} — ${h.author} (${h.date})`).join('\n'));
          }
        }
        context.gitFileHistories = histories.join('\n\n') || 'No file histories available.';
        return { ...step, status: 'completed', result: context.gitFileHistories };
      }

      case 'git_diff_between': {
        if (!this.gitAnalyzer || !this.gitAnalyzer.isInitialized) {
          return { ...step, status: 'completed', result: 'Git not available' };
        }
        const diff = await this.gitAnalyzer.getDiffBetween('HEAD~5', 'HEAD');
        const formatted = this.gitAnalyzer.formatDiffForPrompt(diff, 50);
        context.gitDiff = formatted;
        return { ...step, status: 'completed', result: formatted };
      }

      default:
        return { ...step, status: 'completed', result: undefined };
    }
  }

  private classifyIntent(request: string): IntentType {
    const lower = request.toLowerCase();

    // NOTE: 此逻辑与 contextBuilder.classifyIntent() 保持同步
    // 如需修改，请同步更新 contextBuilder 中的对应方法
    const intentChecks: [RegExp, IntentType][] = [
      [/这个项目是干什么|项目是干什么|项目是做什么|介绍项目|项目简介|项目介绍|解释项目|about this project|项目功能|项目模块|项目作用|项目说明|项目用途/i, 'project_understanding'],
      [/介绍.*项目|解释.*项目|这个项目.*作用|这个项目.*功能|这个项目.*用途/i, 'project_understanding'],
      [/查看.*项目.*作用|查看.*项目.*功能|查看.*项目.*用途|当前项目.*作用|当前项目.*功能|当前项目.*用途|项目概述|项目概况/i, 'project_understanding'],
      [/项目结构|目录结构|项目架构|分析项目|分析架构|项目组织/i, 'project_understanding'],
      [/修复|fix|bug|error|issue|crash|fail|not work|wrong|broken/i, 'bug_fix'],
      [/添加|增加|新增|new|add|create|implement|feature/i, 'feature_add'],
      [/重构|refactor|clean|improve|optimize|restruct/i, 'refactor'],
      [/删除|remove|delete|drop/i, 'removal'],
      [/测试|test|spec|unit|integration/i, 'testing'],
      [/文档|doc|readme|comment|documentation|explain/i, 'documentation'],
    ];

    for (const [pattern, intent] of intentChecks) {
      if (pattern.test(lower)) {
        return intent;
      }
    }

    return 'other';
  }

  private hasGitIntent(request: string): boolean {
    const lower = request.toLowerCase();
    const gitKeywords = [
      'regression', 'recently broken', 'commit', 'history', 'changed',
      'after refactor', 'introduced bug', 'blame', 'who changed',
      'recent change', 'what changed', 'last modified', 'git log',
      'who wrote', 'who removed', 'when was',
    ];
    return gitKeywords.some(kw => lower.includes(kw));
  }

  private buildSteps(intent: IntentType, request: string, sessionId: string): PlanStep[] {
    const steps: PlanStep[] = [];

    // 所有意图都需要分类和记忆检索
    steps.push(
      { id: 'step-1', description: 'Classify user intent', action: 'classify_intent', status: 'pending' },
      { id: 'step-2', description: 'Relevant memory retrieval', action: 'retrieve_memory', status: 'pending' },
    );

    // 只有需要深度理解项目的意图才执行 embedding + repo graph + context
    const needsDeepContext = intent === 'project_understanding' || intent === 'refactor';
    const needsTargetedContext = intent === 'bug_fix' || intent === 'feature_add' || intent === 'removal' || intent === 'testing';

    if (needsDeepContext) {
      steps.push(
        { id: 'step-3', description: 'Embedding search for architecture docs', action: 'search_embedding', status: 'pending' },
        { id: 'step-4', description: 'Query repo graph for module overview', action: 'query_repograph', status: 'pending' },
        { id: 'step-5', description: 'Build comprehensive project context', action: 'build_context', status: 'pending' },
      );
    } else if (needsTargetedContext) {
      steps.push(
        { id: 'step-3', description: 'Search relevant files', action: 'search_embedding', status: 'pending' },
        { id: 'step-4', description: 'Build focused context', action: 'build_context', status: 'pending' },
      );
    }
    // documentation / other 等简单意图只做分类+记忆，其余由 ReAct 循环中的工具调用完成

    // Git context steps when history-related intent detected
    if (this.hasGitIntent(request)) {
      steps.push(
        { id: 'git-1', description: 'Collect recent commits', action: 'git_recent_commits', status: 'pending' },
        { id: 'git-2', description: 'Collect changed files', action: 'git_changed_files', status: 'pending' },
        { id: 'git-3', description: 'Collect file histories', action: 'git_file_history', status: 'pending' },
        { id: 'git-4', description: 'Collect recent diff', action: 'git_diff_between', status: 'pending' },
      );
    }

    return steps;
  }

  private formatMemoryFragment(recentHistory: string, intentHistory: MemoryEntry[]): string {
    const parts: string[] = [];

    if (recentHistory) {
      parts.push(recentHistory);
    }

    if (intentHistory.length > 0) {
      const relatedEntries = intentHistory.slice(-4).map(e =>
        `[${e.role}] ${e.content.slice(0, 200)}`
      ).join('\n');
      parts.push(`\n### Related History (same intent)\n${relatedEntries}`);
    }

    return parts.join('\n\n');
  }

  private getModulesFromEmbedding(results: HybridSearchResult[]): string[] {
    const moduleSet = new Set<string>();
    for (const r of results) {
      const lower = r.filePath.replace(/\\/g, '/').toLowerCase();
      if (/server|api|route/.test(lower)) moduleSet.add('server');
      else if (/core|util|common|lib/.test(lower)) moduleSet.add('core');
      else if (/ui|component|view|page/.test(lower)) moduleSet.add('ui');
      else if (/config|setting/.test(lower)) moduleSet.add('config');
      else if (/test|spec/.test(lower)) moduleSet.add('test');
      else moduleSet.add('other');
    }
    return Array.from(moduleSet);
  }

  private buildGitContextString(context: IncrementalContext): string {
    const parts: string[] = [];
    if (context.gitRecentCommits) {
      parts.push('## Recent Commits\n' + context.gitRecentCommits);
    }
    if (context.gitChangedFiles) {
      parts.push('## Changed Files in Working Tree\n' + context.gitChangedFiles);
    }
    if (context.gitFileHistories) {
      parts.push('## File Histories\n' + context.gitFileHistories);
    }
    if (context.gitDiff) {
      parts.push('## Recent Changes (HEAD~5..HEAD)\n' + context.gitDiff);
    }
    return parts.join('\n\n');
  }

  private accumulateContext(context: IncrementalContext): string {
    const parts: string[] = [];

    if (context.memoryFragment) {
      parts.push(context.memoryFragment);
    }

    if (context.embeddingResults.length > 0) {
      parts.push('\n### Semantically Relevant Files\n');
      for (const r of context.embeddingResults.slice(0, 8)) {
        parts.push(`  [score: ${r.score}] ${r.filePath}`);
        if (r.summary) {
          parts.push(`    ${r.summary.slice(0, 100)}`);
        }
      }
    }

    if (context.repoGraphOverview) {
      parts.push('\n' + context.repoGraphOverview);
    }

    if (context.contextPackage) {
      parts.push('\n### Context Package\n');
      const pkg = context.contextPackage;
      parts.push(`Reason: ${pkg.reason}`);
      if (pkg.selectedFiles.length > 0) {
        parts.push('Selected Files:');
        for (const f of pkg.selectedFiles) {
          parts.push(`  - ${f}`);
        }
      }
    }

    return parts.join('\n');
  }

  formatPlanForPrompt(plan: ExecutionPlan): string {
    const parts: string[] = [];

    parts.push(`## Execution Plan\n`);
    parts.push(`Intent: ${plan.intent}`);
    parts.push(`Summary: ${plan.summary}\n`);
    parts.push('### Steps\n');

    for (const step of plan.steps) {
      const status = step.status === 'completed' ? '✅' : '⏳';
      parts.push(`  ${status} ${step.id}: ${step.description}`);
    }

    if (plan.context.accumulated) {
      parts.push('\n### Incremental Context\n');
      parts.push(plan.context.accumulated);
    }

    return parts.join('\n');
  }

  getContextForAnswer(context: IncrementalContext): string {
    const parts: string[] = [];

    if (context.memoryFragment) {
      parts.push('## Conversation History\n');
      parts.push(context.memoryFragment);
    }

    if (context.embeddingResults.length > 0) {
      parts.push('\n## Relevant Files (from semantic search)\n');
      for (const r of context.embeddingResults.slice(0, 5)) {
        const pathParts = r.filePath.replace(/\\/g, '/').split('/');
        const shortPath = pathParts.slice(-3).join('/');
        parts.push(`- ${shortPath} (relevance: ${r.score})`);
      }
    }

    if (context.repoGraphOverview) {
      parts.push('\n' + context.repoGraphOverview);
    }

    if (context.contextPackage) {
      const pkg = context.contextPackage;
      parts.push('\n## Focused File Context\n');
      parts.push(`Reason: ${pkg.reason}`);
      parts.push(`Selected ${pkg.selectedFiles.length} files for context.`);
      if (pkg.selectedFiles.length > 0) {
        parts.push('\nFiles to consider:');
        for (const f of pkg.selectedFiles.slice(0, 10)) {
          parts.push(`- ${f}`);
        }
        if (pkg.selectedFiles.length > 10) {
          parts.push(`... and ${pkg.selectedFiles.length - 10} more`);
        }
      }
    }

    return parts.join('\n');
  }
}

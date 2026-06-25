// @z-assistant/agent-research — Research Agent implementation.
//
// Enhanced loop: plan queries → cached parallel search → parallel fetch →
// source scoring/deduplication → recursive expansion → cited report → mind map.

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  IAgent,
  ILLMProvider,
  LLMMessage,
  ModelSpec,
  TaskContext,
  AgentResult,
  AgentMetrics,
} from '@z-assistant/contracts';
import type { TraceManager } from '@z-assistant/trace';
import { requestDelegation, waitForDelegation } from '@z-assistant/runtime';

export interface ResearchAgentOptions {
  llmProvider: ILLMProvider;
  model: ModelSpec;
  /** Search provider: (query, maxResults) => array of {title, url, snippet} */
  searchProvider: (query: string, maxResults: number) => Promise<Array<{ title: string; url: string; snippet?: string }>>;
  /** Fetch provider: (url, maxLength) => text content */
  fetchProvider: (url: string, maxLength: number) => Promise<string>;
  /**
   * Optional browser-based fetch provider. When set, URLs that are likely
   * to require JavaScript (SPA, login, dynamic pricing) will be fetched
   * via the browser instead of the simple fetchProvider. Also used as
   * fallback when fetchProvider returns empty content.
   * Signature: (url: string) => Promise<{ title: string; content: string }>
   */
  browserFetchProvider?: (url: string) => Promise<{ title: string; content: string }>;
  maxQueries?: number;
  maxResultsPerQuery?: number;
  maxPagesToFetch?: number;
  maxReportTokens?: number;
  /** Max research iterations (query → fetch → reflect). Default 1. */
  maxIterations?: number;
  /** Directory for persistent search-result cache. If omitted, caching is disabled. */
  cacheDir?: string;
  /** Cache TTL in ms. Default 24 hours. */
  cacheTtlMs?: number;
  /** Optional trace manager for emitting spans. */
  traceManager?: TraceManager;
  /**
   * Optional progress callback. Called with a status message at key points
   * during the research loop so the host can display intermediate progress.
   */
  onProgress?: (phase: string, detail: string) => void;
}

export interface SearchResult {
  query: string;
  title: string;
  url: string;
  snippet?: string;
}

export interface FetchedPage {
  url: string;
  title: string;
  content: string;
  score: number;
}

export interface ResearchReport {
  /** Markdown report with inline citation markers like [1], [2]. */
  markdown: string;
  /** Numbered source list matching the citation markers. */
  sources: { index: number; title: string; url: string }[];
  /** Queries that were executed across all iterations. */
  queries: string[];
  /** Whether the agent judged the collected information sufficient. */
  satisfied: boolean;
  /** Mermaid mindmap diagram (text) generated from the report. */
  mindMap?: string;
  /** Plain-text hierarchical mind map (fallback / preview). */
  mindMapText?: string;
}

interface SearchCacheEntry {
  query: string;
  fetchedAt: number;
  lastAccessed: number;
  results: SearchResult[];
  ttlMs: number;
}

// Keyword buckets are weighted separately so price/lookup intents score
// higher than a passing mention of "分析".
const RESEARCH_KEYWORDS: { kw: string; weight: number }[] = [
  // Strong research intents (full-sentence-style in EN / CN)
  { kw: 'research', weight: 0.25 },
  { kw: 'investigate', weight: 0.25 },
  { kw: 'survey', weight: 0.20 },
  { kw: 'study', weight: 0.15 },
  { kw: 'analyze', weight: 0.18 },
  { kw: '调研', weight: 0.25 },
  { kw: '研究', weight: 0.20 },
  { kw: '综述', weight: 0.20 },
  { kw: '调查', weight: 0.22 },

  // Look-up / discovery intents (very common in CN — were missing!)
  { kw: 'search for', weight: 0.20 },
  { kw: 'find out', weight: 0.18 },
  { kw: 'look up', weight: 0.18 },
  { kw: 'gather information', weight: 0.20 },
  { kw: '搜索', weight: 0.22 },
  { kw: '查找', weight: 0.18 },
  { kw: '查找资料', weight: 0.20 },
  { kw: '收集资料', weight: 0.20 },
  { kw: '搜集', weight: 0.18 },
  { kw: '查询', weight: 0.20 },
  { kw: '查一下', weight: 0.18 },
  { kw: '查一查', weight: 0.18 },
  { kw: '了解', weight: 0.10 },
  { kw: '看看', weight: 0.08 },
  { kw: '有哪些', weight: 0.18 },
  { kw: '哪家', weight: 0.15 },
  { kw: '哪个', weight: 0.10 },
  { kw: '怎么', weight: 0.08 },
  { kw: '如何', weight: 0.08 },
  { kw: '怎么样', weight: 0.10 },

  // Pricing / comparison intents (also missing — was a major blind spot)
  { kw: '价格', weight: 0.22 },
  { kw: '费用', weight: 0.22 },
  { kw: '多少钱', weight: 0.20 },
  { kw: '划算', weight: 0.20 },
  { kw: '便宜', weight: 0.15 },
  { kw: '贵', weight: 0.10 },
  { kw: '套餐', weight: 0.15 },
  { kw: '比价', weight: 0.22 },
  { kw: '比较', weight: 0.18 },
  { kw: '对比', weight: 0.18 },
  { kw: '汇总', weight: 0.15 },
  { kw: '排行', weight: 0.18 },
  { kw: '推荐', weight: 0.12 },
  { kw: '优惠', weight: 0.18 },
  { kw: '折扣', weight: 0.18 },
  { kw: 'price', weight: 0.22 },
  { kw: 'pricing', weight: 0.22 },
  { kw: 'cost', weight: 0.18 },
  { kw: 'fee', weight: 0.18 },
  { kw: 'compare', weight: 0.20 },
  { kw: 'comparison', weight: 0.20 },
  { kw: 'cheap', weight: 0.15 },
  { kw: 'best price', weight: 0.20 },
  { kw: 'deal', weight: 0.15 },
  { kw: 'discount', weight: 0.15 },
  { kw: 'plan', weight: 0.05 }, // "coding plan" / "token plan" — weak alone

  // Report-style output
  { kw: 'report on', weight: 0.20 },
  { kw: 'write a report', weight: 0.22 },
  { kw: 'summary of', weight: 0.18 },
  { kw: 'overview of', weight: 0.18 },
  { kw: '报告', weight: 0.22 },
  { kw: '总结', weight: 0.15 },
  { kw: '概述', weight: 0.15 },
];

/**
 * Signals that suggest a *product / commercial plan* term (like "GLM
 * coding plan") rather than a coding task. When such a token co-occurs
 * with research-y terms, we *don't* penalise the research agent — but
 * the coding agent must NOT benefit from these tokens.
 */
const COMMERCIAL_PLAN_TOKENS = [
  'coding plan', 'code plan', 'token plan', 'subscription plan',
  'coding套餐', 'token套餐', '订阅套餐', '价格表', 'pricing page',
];

/**
 * Compensate for "plan" being in RESEARCH_KEYWORDS at low weight: when a
 * "plan" hit is clearly a commercial offering (not a research request),
 * we strip that contribution so the routing is not biased.
 */
function isCommercialPlanContext(task: string): boolean {
  const t = task.toLowerCase();
  return COMMERCIAL_PLAN_TOKENS.some((tok) => t.includes(tok));
}

/** URL patterns that typically require JavaScript rendering. */
const JS_REQUIRED_PATTERNS = [
  // Travel & e-commerce SPAs
  '.hotel', '.booking', '.airbnb', '.trip.com', '.ctrip', '.fliggy',
  '.meituan', '.dianping', '.taobao', '.tmall', '.jd.com',
  // Map widgets
  '.google.com/maps', '.amap.com', '.gaode.com',
  'maps.', 'map.',
  // Auth & search URLs (dynamic content)
  'login', 'signin', 'auth', '/sign-in', '/sign-up',
  '/search?', '/s?',
  // LLM / cloud-vendor pricing pages (heavily JS-rendered)
  '/pricing', '/price', '/plans', '/plan', '/subscription',
  'open.bigmodel.cn', 'bigmodel.cn',
  'volcengine.com', 'volces.com',
  'openai.com', 'anthropic.com', 'claude.com',
  'dashscope.aliyun.com', 'aliyun.com',
  'deepseek.com', 'moonshot.cn', 'kimi.com',
  'qwen.ai', 'tongyi.aliyun.com',
  'baichuan-ai.com', 'yiyan.baidu.com', 'wenxin.baidu.com',
  'minimax.com', 'minimaxi.com',
  'zhipuai.cn', 'zhipu.cn',
  'sparkapi.cn', 'xinghuo.xfyun.cn',
  // Dashboard / console / app pages
  'console.', '/dashboard', '/app/', '/workspace',
  // Notion, GitHub blob (raw)
  'notion.so', 'feishu.cn', 'larksuite.com',
];

const MIN_CONTENT_LENGTH = 200;
const HIGH_QUALITY_DOMAINS = new Set([
  'wikipedia.org',
  'github.com',
  'arxiv.org',
  'medium.com',
  'substack.com',
  'nytimes.com',
  'reuters.com',
  'bloomberg.com',
  'theguardian.com',
  'bbc.com',
  'apnews.com',
  'techcrunch.com',
  'theverge.com',
  'cnbc.com',
  'forbes.com',
  'zhihu.com',
  'jianshu.com',
  'csdn.net',
  'csdn.com',
  'baidu.com',
]);

export function createResearchAgent(opts: ResearchAgentOptions): ResearchAgent {
  return new ResearchAgent(opts);
}

export class ResearchAgent implements IAgent {
  name = 'research';
  role = 'Deep Research Agent';
  capabilities = [
    'web.search',
    'web.fetch',
    'research.synthesize',
    'report.write',
    'information.gather',
    'source.rank',
    'recursive.research',
    'cache.search',
    'mindmap.generate',
  ];
  dependencies: string[] = [];
  modelPreference?: ModelSpec;

  private llm: ILLMProvider;
  private model: ModelSpec;
  private searchProvider: ResearchAgentOptions['searchProvider'];
  private fetchProvider: ResearchAgentOptions['fetchProvider'];
  private browserFetchProvider?: ResearchAgentOptions['browserFetchProvider'];
  private maxQueries: number;
  private maxResultsPerQuery: number;
  private maxPagesToFetch: number;
  private maxReportTokens: number;
  private maxIterations: number;
  private cache?: SearchCache;
  private traceManager?: TraceManager;
  private onProgress: (phase: string, detail: string) => void;

  constructor(opts: ResearchAgentOptions) {
    this.llm = opts.llmProvider;
    this.model = opts.model;
    this.searchProvider = opts.searchProvider;
    this.fetchProvider = opts.fetchProvider;
    this.browserFetchProvider = opts.browserFetchProvider;
    this.maxQueries = opts.maxQueries ?? 3;
    this.maxResultsPerQuery = opts.maxResultsPerQuery ?? 5;
    this.maxPagesToFetch = opts.maxPagesToFetch ?? 5;
    this.maxReportTokens = opts.maxReportTokens ?? 2048;
    this.maxIterations = opts.maxIterations ?? 1;
    this.modelPreference = opts.model;
    this.traceManager = opts.traceManager;
    this.onProgress = opts.onProgress ?? (() => {});
    if (opts.cacheDir) {
      this.cache = new SearchCache(opts.cacheDir, opts.cacheTtlMs);
    }
  }

  canHandle(ctx: TaskContext): number {
    const taskLower = ctx.task.toLowerCase();
    const commercial = isCommercialPlanContext(ctx.task);

    // Sum weights of all matching keywords. The new keyword set covers
    // Chinese look-up intents ("查询/查一下/看看") and pricing/comparison
    // terms ("价格/费用/划算/套餐/比价") that the previous version missed.
    let weightedHits = 0;
    for (const { kw, weight } of RESEARCH_KEYWORDS) {
      if (taskLower.includes(kw.toLowerCase())) {
        // "plan" alone is too generic — strip it when in a commercial
        // offering context, otherwise a single word inflates the score.
        if (kw.toLowerCase() === 'plan' && commercial) continue;
        weightedHits += weight;
      }
    }

    // Base 0.45 so the research agent beats coding (default 0.2) on any
    // task with at least one strong research signal. Cap at 0.95 so the
    // router still has headroom to add a secondary agent if needed.
    const score = Math.min(0.95, 0.45 + weightedHits);

    // If the task clearly mentions a commercial plan (e.g. "GLM coding
    // plan pricing") we still want research to win over coding, so we
    // boost slightly. This is a soft signal — embedding will confirm.
    return commercial ? Math.max(score, 0.55) : score;
  }

  async execute(ctx: TaskContext): Promise<AgentResult> {
    const startTime = Date.now();
    const metrics: AgentMetrics = {
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      durationMs: 0,
      llmCalls: 0,
      toolCalls: 0,
    };

    const tracker = this.traceManager?.active();
    const span = tracker?.startSpan({
      name: 'agent:research',
      type: 'agent',
      input: { task: ctx.task, maxIterations: this.maxIterations },
    });

    try {
      const allQueries: string[] = [];
      const allResults: SearchResult[] = [];
      const allPages: FetchedPage[] = [];

      // Initial query plan.
      this.onProgress('plan', 'Generating search query plan...');
      const queryPlan = await this.planQueries(ctx.task, metrics, ctx.signal);
      let queries = queryPlan.queries.slice(0, this.maxQueries);

      for (let iteration = 0; iteration < this.maxIterations; iteration++) {
        if (ctx.signal?.aborted) break;
        if (queries.length === 0) break;

        this.onProgress('search', `Iteration ${iteration + 1}/${this.maxIterations}: searching for ${queries.length} queries...`);
        allQueries.push(...queries);

        // Parallel search across all queries (with cache fallback).
        const searchBatches = await Promise.all(
          queries.map((q) => this.search(q, metrics, ctx.signal)),
        );
        for (const batch of searchBatches) {
          allResults.push(...batch.slice(0, this.maxResultsPerQuery));
        }

        // Deduplicate by URL and select top pages by score.
        const seenUrls = new Set(allPages.map((p) => p.url));
        const newResults = allResults.filter((r) => !seenUrls.has(r.url));
        const rankedUrls = this.rankAndDeduplicateUrls(newResults, ctx.task).slice(0, this.maxPagesToFetch);

        this.onProgress('fetch', `Iteration ${iteration + 1}/${this.maxIterations}: fetching ${rankedUrls.length} pages...`);
        // Parallel fetch.
        const fetched = (
          await Promise.all(
            rankedUrls.map((url) => this.fetchPage(url, allResults, metrics, ctx.signal, ctx.sharedState)),
          )
        ).filter((p): p is FetchedPage => p !== null);

        for (const page of fetched) {
          if (!seenUrls.has(page.url)) {
            allPages.push(page);
            seenUrls.add(page.url);
          }
        }

        // On intermediate iterations, ask the model whether we need more queries.
        if (iteration < this.maxIterations - 1 && allPages.length > 0) {
          this.onProgress('reflect', `Iteration ${iteration + 1}/${this.maxIterations}: reflecting on coverage...`);
          const reflection = await this.reflectOnCoverage(
            ctx.task,
            allQueries,
            allPages,
            metrics,
            ctx.signal,
          );
          queries = reflection.followUpQueries.slice(0, this.maxQueries);
          if (reflection.satisfied) break;
        } else {
          break;
        }
      }

      this.onProgress('synthesize', 'Generating structured report...');
      // Generate structured report with citations.
      const report = await this.synthesizeReport(ctx.task, allQueries, allPages, metrics, ctx.signal);

      // Generate mind map from the report.
      const { mindMap, mindMapText } = await this.generateMindMap(ctx.task, report, metrics, ctx.signal);
      report.mindMap = mindMap;
      report.mindMapText = mindMapText;

      // Publish artifacts to shared state for downstream agents.
      ctx.sharedState.set('research.queries', allQueries, this.name);
      ctx.sharedState.set('research.results', allResults, this.name);
      ctx.sharedState.set(
        'research.pages',
        allPages.map((p) => ({ url: p.url, title: p.title, score: p.score })),
        this.name,
      );
      ctx.sharedState.set('research.report', report, this.name);
      if (mindMap) {
        ctx.sharedState.set('research.mindMap', mindMap, this.name);
      }

      span?.setOutput({
        ok: true,
        queries: allQueries.length,
        pages: allPages.length,
        satisfied: report.satisfied,
      });
      span?.end();

      metrics.durationMs = Date.now() - startTime;
      return {
        ok: true,
        output: report.markdown,
        artifacts: {
          'research.report': report.markdown,
          'research.reportJson': report,
          'research.sources': report.sources,
          'research.queries': allQueries,
          'research.mindMap': mindMap,
          'research.mindMapText': mindMapText,
        },
        metrics,
      };
    } catch (err: unknown) {
      span?.fail({ code: 'RESEARCH_ERROR', message: err instanceof Error ? err.message : String(err) });
      span?.end();
      metrics.durationMs = Date.now() - startTime;
      return {
        ok: false,
        error: {
          code: 'RESEARCH_ERROR',
          message: err instanceof Error ? err.message : String(err),
        },
        metrics,
      };
    }
  }

  private async planQueries(
    task: string,
    metrics: AgentMetrics,
    signal?: AbortSignal,
  ): Promise<{ queries: string[] }> {
    // Inject today's date so the LLM doesn't guess a year based on its
    // training cutoff (e.g. it would add "2025" when "最新优惠" is the
    // user's intent and the actual year is 2026).
    const today = new Date();
    const dateStr = today.toISOString().slice(0, 10);
    const year = today.getFullYear();
    const messages: LLMMessage[] = [
      {
        role: 'system',
        content:
          `You are a research planner. Today is ${dateStr} (year ${year}). ` +
          `Given a user request, produce up to 5 concise web search queries that will gather the most relevant information. ` +
          `CRITICAL RULES:\n` +
          `1. If the user says "最新/最近/this year" (or doesn't specify a year), use the CURRENT year (${year}). Do NOT default to past years from your training data.\n` +
          `2. If the user specifies a year, respect it exactly.\n` +
          `3. Strip filler words like "帮我" / "请" / "我想" from queries — keep only the search-worthy terms.\n` +
          `4. For pricing/comparison tasks, include the current year to avoid stale data.\n` +
          `Respond with a JSON object: {"queries": ["...", "..."]}.`,
      },
      { role: 'user', content: task },
    ];

    const res = await this.llm.generate({
      model: this.model,
      messages,
      jsonMode: true,
      maxTokens: 512,
      signal,
    });
    metrics.llmCalls += 1;
    metrics.tokensIn += res.usage.tokensIn;
    metrics.tokensOut += res.usage.tokensOut;
    metrics.costUsd += res.costUsd ?? 0;

    try {
      const parsed = JSON.parse(res.message.content ?? '{}');
      const queries = Array.isArray(parsed.queries)
        ? parsed.queries.filter((q: unknown) => typeof q === 'string')
        : [];
      return { queries };
    } catch {
      return { queries: [task] };
    }
  }

  private async reflectOnCoverage(
    task: string,
    queries: string[],
    pages: FetchedPage[],
    metrics: AgentMetrics,
    signal?: AbortSignal,
  ): Promise<{ satisfied: boolean; followUpQueries: string[] }> {
    const summary = pages
      .map((p, i) => `[${i + 1}] ${p.title} (${p.url})\n${p.content.slice(0, 600)}`)
      .join('\n\n');

    const messages: LLMMessage[] = [
      {
        role: 'system',
        content:
          'You are a research critic. Given the original task and the sources collected so far, decide whether the information is sufficient and what follow-up search queries would fill remaining gaps. Respond with JSON: {"satisfied": true|false, "followUpQueries": ["..."]}.',
      },
      {
        role: 'user',
        content: `Task: ${task}\n\nQueries already run: ${queries.join('; ')}\n\nSources collected:\n\n${summary}`,
      },
    ];

    const res = await this.llm.generate({
      model: this.model,
      messages,
      jsonMode: true,
      maxTokens: 512,
      signal,
    });
    metrics.llmCalls += 1;
    metrics.tokensIn += res.usage.tokensIn;
    metrics.tokensOut += res.usage.tokensOut;
    metrics.costUsd += res.costUsd ?? 0;

    try {
      const parsed = JSON.parse(res.message.content ?? '{}');
      return {
        satisfied: parsed.satisfied === true,
        followUpQueries: Array.isArray(parsed.followUpQueries)
          ? parsed.followUpQueries.filter((q: unknown) => typeof q === 'string')
          : [],
      };
    } catch {
      return { satisfied: true, followUpQueries: [] };
    }
  }

  private async search(
    query: string,
    metrics: AgentMetrics,
    signal?: AbortSignal,
  ): Promise<SearchResult[]> {
    if (signal?.aborted) return [];

    // Try cache first.
    const cached = await this.cache?.get(query);
    if (cached) {
      return cached;
    }

    const results = await this.searchProvider(query, this.maxResultsPerQuery);
    metrics.toolCalls += 1;
    const normalized = results.map((r) => ({ query, ...r }));
    await this.cache?.set(query, normalized);
    return normalized;
  }

  private rankAndDeduplicateUrls(results: SearchResult[], task: string): string[] {
    const byUrl = new Map<string, SearchResult>();
    for (const r of results) {
      // Keep the first (highest-ranked) result for each URL.
      if (!byUrl.has(r.url)) byUrl.set(r.url, r);
    }

    const scored = Array.from(byUrl.values()).map((r) => ({
      url: r.url,
      score: this.scoreSource(r.url, r.snippet ?? r.title, task),
    }));

    scored.sort((a, b) => b.score - a.score);
    return scored.map((s) => s.url);
  }

  private scoreSource(url: string, content: string, task: string): number {
    let score = 0.2; // baseline

    // Domain authority.
    try {
      const host = new URL(url).hostname.toLowerCase();
      if (host.endsWith('.gov') || host.endsWith('.edu') || host.endsWith('.ac.uk') || host.endsWith('.ac.cn')) {
        score += 0.25;
      }
      for (const domain of HIGH_QUALITY_DOMAINS) {
        if (host === domain || host.endsWith(`.${domain}`)) {
          score += 0.15;
          break;
        }
      }
    } catch {
      // malformed URL, keep baseline
    }

    // Content coverage (length and keyword match).
    const text = `${content} ${url}`.toLowerCase();
    const taskWords = task.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    const matches = taskWords.filter((w) => text.includes(w)).length;
    score += (matches / Math.max(1, taskWords.length)) * 0.35;
    score += Math.min(0.2, content.length / 15000);

    return Math.min(1, score);
  }

  private async fetchPage(
    url: string,
    results: SearchResult[],
    metrics: AgentMetrics,
    signal?: AbortSignal,
    sharedState?: import('@z-assistant/contracts').SharedState,
  ): Promise<FetchedPage | null> {
    if (signal?.aborted) return null;

    const title = results.find((r) => r.url === url)?.title ?? url;
    const needsBrowser = this.browserFetchProvider != null && this.needsBrowserForUrl(url);

    // If the URL likely requires JS, try delegation to browser agent first.
    if (needsBrowser && sharedState) {
      try {
        requestDelegation(sharedState, 'browser', `Navigate to ${url} and extract the main content. Return the visible text content of the page.`, this.name, { url });
        const delegateResp = await waitForDelegation(sharedState, 'browser', 60_000);
        if (delegateResp.result && delegateResp.result.length > 100) {
          metrics.toolCalls += 1;
          return { url, title: (delegateResp.data?.title as string) || title, content: delegateResp.result, score: 0 };
        }
      } catch {
        // Delegation failed or timed out; fall through to browserFetchProvider.
      }
    }

    // Fallback to browserFetchProvider if available.
    if (needsBrowser) {
      try {
        const page = await this.browserFetchProvider!(url);
        if (signal?.aborted) return null;
        metrics.toolCalls += 1;
        return { url, title: page.title || title, content: page.content, score: 0 };
      } catch {
        // Fall through to simple fetch as fallback.
      }
    }

    // Simple fetch (no JS).
    try {
      const content = await this.fetchProvider(url, 8000);
      if (signal?.aborted) return null;
      metrics.toolCalls += 1;

      // If content is empty/too short and we have a browser provider, try that.
      if (content.length < MIN_CONTENT_LENGTH && this.browserFetchProvider != null) {
        try {
          const page = await this.browserFetchProvider(url);
          if (signal?.aborted) return null;
          metrics.toolCalls += 1;
          this.onProgress(
            'fetch',
            `Simple fetch returned ${content.length} chars; browser retry succeeded for ${url.slice(0, 60)}`,
          );
          return { url, title: page.title || title, content: page.content, score: 0 };
        } catch {
          // Return the original (short) content.
        }
      }

      return { url, title, content, score: 0 };
    } catch {
      // If simple fetch fails and we have a browser provider, try that.
      if (this.browserFetchProvider != null) {
        try {
          const page = await this.browserFetchProvider(url);
          if (signal?.aborted) return null;
          metrics.toolCalls += 1;
          return { url, title: page.title || title, content: page.content, score: 0 };
        } catch {
          return null;
        }
      }
      return null;
    }
  }

  /** Determine whether a URL likely requires JavaScript rendering. */
  private needsBrowserForUrl(url: string): boolean {
    const lower = url.toLowerCase();
    return JS_REQUIRED_PATTERNS.some((pattern) => lower.includes(pattern));
  }

  private async synthesizeReport(
    task: string,
    queries: string[],
    pages: FetchedPage[],
    metrics: AgentMetrics,
    signal?: AbortSignal,
  ): Promise<ResearchReport> {
    if (pages.length === 0) {
      return {
        markdown: 'No sources could be fetched for this research task.',
        sources: [],
        queries,
        satisfied: false,
      };
    }

    // Re-score full content and sort.
    const scoredPages = pages.map((p) => ({ ...p, score: this.scoreSource(p.url, p.content, task) }));
    scoredPages.sort((a, b) => b.score - a.score);

    // Build sources list; the LLM prompt maps [index] to these sources.
    const sourcesText = scoredPages
      .map((p, i) => `[${i + 1}] ${p.title}\nURL: ${p.url}\n${p.content.slice(0, 3500)}`)
      .join('\n\n---\n\n');

    const today = new Date();
    const dateStr = today.toISOString().slice(0, 10);
    const year = today.getFullYear();
    const messages: LLMMessage[] = [
      {
        role: 'system',
        content:
          `You are a research synthesizer. Today is ${dateStr} (year ${year}). ` +
          `Read the collected sources and produce a well-structured Markdown report. Every factual claim must be supported by an inline citation like [1], [2], etc. ` +
          `For recency-sensitive topics (e.g. pricing, plans, discounts), flag any data that is clearly from a prior year (${year - 1} or earlier) as potentially stale. ` +
          `Include an executive summary, key findings, and a Sources section. ` +
          `Return a JSON object: {"markdown": "...", "satisfied": true|false, "sources": [{"index": 1, "title": "...", "url": "..."}]}.`,
      },
      {
        role: 'user',
        content: `Task: ${task}\n\nQueries used: ${queries.join('; ')}\n\nCollected sources:\n\n${sourcesText}`,
      },
    ];

    const res = await this.llm.generate({
      model: this.model,
      messages,
      jsonMode: true,
      maxTokens: this.maxReportTokens,
      signal,
    });
    metrics.llmCalls += 1;
    metrics.tokensIn += res.usage.tokensIn;
    metrics.tokensOut += res.usage.tokensOut;
    metrics.costUsd += res.costUsd ?? 0;

    try {
      const parsed = JSON.parse(res.message.content ?? '{}');
      const markdown = typeof parsed.markdown === 'string' ? parsed.markdown : '(no report generated)';
      const satisfied = parsed.satisfied === true;
      const sources = Array.isArray(parsed.sources)
        ? parsed.sources
            .filter((s: unknown) => s && typeof (s as any).url === 'string')
            .map((s: any, idx: number) => ({
              index: typeof s.index === 'number' ? s.index : idx + 1,
              title: String(s.title ?? 'Source'),
              url: String(s.url),
            }))
        : scoredPages.map((p, i) => ({ index: i + 1, title: p.title, url: p.url }));

      return { markdown, sources, queries, satisfied };
    } catch {
      // Fallback: plain markdown with auto-generated sources.
      const fallbackSources = scoredPages.map((p, i) => ({ index: i + 1, title: p.title, url: p.url }));
      return {
        markdown: res.message.content ?? '(no report generated)',
        sources: fallbackSources,
        queries,
        satisfied: false,
      };
    }
  }

  private async generateMindMap(
    task: string,
    report: ResearchReport,
    metrics: AgentMetrics,
    signal?: AbortSignal,
  ): Promise<{ mindMap?: string; mindMapText?: string }> {
    const messages: LLMMessage[] = [
      {
        role: 'system',
        content:
          'You are a mind-map generator. Given a research task and its report, produce a Mermaid mindmap diagram. Use syntax:\n' +
          'mindmap\n  root((Topic))\n    Branch A\n      Sub-branch A1\n      Sub-branch A2\n    Branch B\n' +
          'Keep it concise (max 6 branches, 3 levels deep). Output only the Mermaid code block.',
      },
      {
        role: 'user',
        content: `Task: ${task}\n\nReport:\n${report.markdown.slice(0, 3000)}`,
      },
    ];

    const res = await this.llm.generate({
      model: this.model,
      messages,
      maxTokens: 1024,
      signal,
    });
    metrics.llmCalls += 1;
    metrics.tokensIn += res.usage.tokensIn;
    metrics.tokensOut += res.usage.tokensOut;
    metrics.costUsd += res.costUsd ?? 0;

    const mindMap = res.message.content?.trim() ?? '';
    const mindMapText = this.mermaidToText(mindMap);
    return { mindMap, mindMapText };
  }

  /** Convert a simple Mermaid mindmap to a plain-text tree for quick preview. */
  private mermaidToText(mermaid: string): string | undefined {
    const lines = mermaid
      .replace(/^```mermaid\s*/i, '')
      .replace(/```\s*$/i, '')
      .split('\n')
      .map((l) => l.replace(/\t/g, '  '))
      .filter((l) => l.trim().length > 0);

    if (lines.length === 0 || !lines[0].toLowerCase().includes('mindmap')) {
      return undefined;
    }

    const out: string[] = [];
    for (let i = 1; i < lines.length; i++) {
      const raw = lines[i];
      const indent = raw.search(/\S/);
      const label = raw.trim().replace(/\(\(|\)\)/g, '').replace(/^\(?(.*?)\)?$/, '$1');
      const depth = Math.max(0, Math.floor(indent / 2) - 1);
      const prefix = depth === 0 ? '' : '│  '.repeat(depth - 1) + (i === lines.length - 1 || lines[i + 1]?.search(/\S/) <= indent ? '└─ ' : '├─ ');
      out.push(prefix + label);
    }
    return out.length > 0 ? out.join('\n') : undefined;
  }
}

class SearchCache {
  private readonly dir: string;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly maxBytes: number;

  constructor(
    dir: string,
    ttlMs = 24 * 60 * 60 * 1000,
    maxEntries = 100,
    maxBytes = 50 * 1024 * 1024,
  ) {
    this.dir = dir;
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
  }

  async get(query: string): Promise<SearchResult[] | undefined> {
    const file = path.join(this.dir, `${this.key(query)}.json`);
    try {
      const raw = fs.readFileSync(file, 'utf-8');
      const entry = JSON.parse(raw) as SearchCacheEntry;
      if (Date.now() - entry.fetchedAt > this.ttlMs) {
        fs.unlinkSync(file);
        return undefined;
      }
      // Update last-accessed for LRU ordering.
      entry.lastAccessed = Date.now();
      fs.writeFileSync(file, JSON.stringify(entry, null, 2), 'utf-8');
      return entry.results;
    } catch {
      return undefined;
    }
  }

  async set(query: string, results: SearchResult[]): Promise<void> {
    const file = path.join(this.dir, `${this.key(query)}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const now = Date.now();
    const entry: SearchCacheEntry = {
      query,
      fetchedAt: now,
      lastAccessed: now,
      results,
      ttlMs: this.ttlMs,
    };
    fs.writeFileSync(file, JSON.stringify(entry, null, 2), 'utf-8');
    await this.enforceLimits();
  }

  private async enforceLimits(): Promise<void> {
    try {
      const files = fs.readdirSync(this.dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => {
          const p = path.join(this.dir, f);
          try {
            const stat = fs.statSync(p);
            const raw = fs.readFileSync(p, 'utf-8');
            const entry = JSON.parse(raw) as SearchCacheEntry;
            return {
              path: p,
              size: stat.size,
              lastAccessed: entry.lastAccessed ?? entry.fetchedAt,
            };
          } catch {
            return null;
          }
        })
        .filter((x): x is NonNullable<typeof x> => x !== null);

      // Sort oldest-first by lastAccessed.
      files.sort((a, b) => a.lastAccessed - b.lastAccessed);

      let totalBytes = files.reduce((sum, f) => sum + f.size, 0);

      // Enforce max entries.
      while (files.length > this.maxEntries) {
        const oldest = files.shift();
        if (!oldest) break;
        try { fs.unlinkSync(oldest.path); totalBytes -= oldest.size; } catch { /* ignore */ }
      }

      // Enforce max bytes by dropping oldest LRU entries.
      while (totalBytes > this.maxBytes && files.length > 0) {
        const oldest = files.shift();
        if (!oldest) break;
        try { fs.unlinkSync(oldest.path); totalBytes -= oldest.size; } catch { /* ignore */ }
      }
    } catch {
      // ignore cleanup errors
    }
  }

  private key(query: string): string {
    return crypto.createHash('sha256').update(query).digest('hex').slice(0, 16);
  }
}

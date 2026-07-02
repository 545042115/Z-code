// @ziner/agent-research — Research Agent implementation.
//
// Enhanced loop: plan queries → cached parallel search → parallel fetch →
// source scoring/deduplication → recursive expansion → cited report → mind map.

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

const MCP_KEYWORD_SYNONYMS: Record<string, string[]> = {
  麦当劳: ['mcdonald', 'mcd', 'mcdonalds', 'burger', '汉堡'],
  肯德基: ['kfc', 'kentucky'],
  星巴克: ['starbucks'],
  必胜客: ['pizzahut', 'pizza'],
  美团: ['meituan'],
  饿了么: ['eleme', 'ele'],
  滴滴: ['didi'],
  高德: ['amap', 'gaode', 'autonavi'],
  百度: ['baidu'],
  淘宝: ['taobao'],
  京东: ['jd', 'jingdong'],
  外卖: ['delivery', 'takeout', 'order', 'food', 'waimai'],
  点餐: ['order', 'menu', '点单', 'order_food'],
  点单: ['order', 'menu', 'order_food'],
  酒店: ['hotel', 'inn', 'jiudian'],
  民宿: ['homestay', 'bnb', 'minsu'],
  餐厅: ['restaurant', 'dining', 'canting'],
  美食: ['food', 'restaurant', 'cuisine', 'meishi'],
  导航: ['navigation', 'route', 'direction', 'daohang'],
  路线: ['route', 'direction', 'luxian'],
  充电: ['charging', 'ev_charge', 'charger', 'chongdian'],
  高速: ['highway', 'expressway', 'gaosu'],
  停车: ['parking', 'tignche', 'park'],
  天气: ['weather', 'tianqi'],
  咖啡: ['coffee', 'kafei'],
  奶茶: ['milktea', 'bubble_tea', 'naicha'],
};

// Tools with these name / description fragments are transactional
// (place order, pay, cancel, etc.) and have no useful text-search
// payload. Research's `tryMcpSearch` skips them so it never accidentally
// invokes an action tool with raw query text and treats the
// tool's own prompt as "search results".
const MCP_ACTION_TOOL_RE =
  /(order|orders|create|create[_-]?order|place[_-]?order|submit|pay|payment|book|booking|reserve|cancel|refund|delete|update|add[_-]?item|remove[_-]?item|addtocart|add[_-]?to[_-]?cart|cart[_-]?add|cart[_-]?remove|checkout|sign[_-]?in|sign[_-]?out|login|logout|register|transfer|send|reply|subscribe|unsubscribe)/i;

function isMcpActionTool(tool: ITool): boolean {
  const hay = `${tool.name} ${tool.description ?? ''}`;
  return MCP_ACTION_TOOL_RE.test(hay);
}

const TRANSACTIONAL_TASK_RE =
  /(点[一份个]|来[一]?[份个]?|想要|我想要|想[要吃]?个?|请帮我点|给我来|帮我[来买做]|来[杯碗]?|点[杯碗盘]?|下[一]?[个份]?单|叫[一]?[份个]?|外卖|订[一]?[份个张位]?|预[购订]|订[票房]|点[餐饭]?|支付|付款|买单|结账|place[ _-]?order|order[ _-]?food|waimai|叫车|打车|网约车|叫[一]?辆[车]|收银|加好友|发[一]?[条个]?消息?|转账|登录|login|sign[ _-]?in|登出|logout|sign[ _-]?out|注册|register|高德|amap|gaode|麦当劳|mcdonald|kfc|肯德基|starbucks|星巴克|必胜客|pizzahut|meituan|美团|eleme|饿了么|滴滴|didi|京东|taobao|淘宝|baidu|百度|subscribe|订阅|unsubscribe|取[消]|cancel|refund|退款|加[入]?购物车|add[ _-]?to[ _-]?cart|check[ _-]?out)/i;

function isTransactionalTask(task: string): boolean {
  return TRANSACTIONAL_TASK_RE.test(task);
}
import type {
  IAgent,
  ILLMProvider,
  ITool,
  LLMMessage,
  ModelSpec,
  TaskContext,
  AgentResult,
  AgentMetrics,
} from '@ziner/contracts';
import { parseJsonObject, BaseAgent } from '@ziner/contracts';
import type { TraceManager } from '@ziner/trace';
import { requestDelegation, waitForDelegation } from '@ziner/runtime';

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
  /**
   * Hard time budget for the simple `fetchProvider` per URL, in ms.
   * Default 12_000. Pages that hang on the network are abandoned
   * at this point so one slow server can't stretch the whole run
   * to TCP-level timeouts (~75s on Linux).
   */
  fetchTimeoutMs?: number;
  /**
   * Hard time budget for the `browserFetchProvider` per URL, in ms.
   * Default 25_000 (JS-rendered pages can be slow but usually
   * finish in <10s on a healthy connection).
   */
  browserTimeoutMs?: number;
  /**
   * Hard time budget for delegating a JS-heavy URL to the Browser
   * agent, in ms. Default 20_000. The previous default of 60s
   * produced very long tails in the worst case; pricing pages
   * like bigmodel.cn / volcengine typically render in 5-8s.
   */
  delegationTimeoutMs?: number;
  /**
   * Hard time budget for the `searchProvider` per query, in ms.
   * Default 10_000.
   */
  searchTimeoutMs?: number;
  /** Optional trace manager for emitting spans. */
  traceManager?: TraceManager;
  /**
   * Optional progress callback. Called with a status message at key points
   * during the research loop so the host can display intermediate progress.
   */
  onProgress?: (phase: string, detail: string) => void;
  /**
   * Optional external tools (e.g. from MCP servers) that can answer
   * structured queries directly (maps, restaurants, navigation). When a
   * query matches one of these tools, it is invoked and the result is
   * treated like web search results — bypassing web search and fetch for
   * that query. This lets map/hotel/food subtasks get structured data
   * without leaving the Research pipeline.
   */
  mcpTools?: ITool[];
  /** Timeout per MCP tool call in ms. Default 15_000. */
  mcpTimeoutMs?: number;
}

/**
 * Race a promise against a timeout, with cooperative cancellation via
 * an optional AbortSignal. Used to bound `fetchProvider`,
 * `browserFetchProvider`, `searchProvider`, and delegation waits —
 * previously these could stretch the run to TCP-level timeouts when
 * a server hung. The error has a `code === 'TIMEOUT'` property so
 * callers can distinguish it from network/auth failures.
 */
class OperationTimeoutError extends Error {
  code = 'TIMEOUT';
  constructor(label: string, timeoutMs: number) {
    super(`${label} timed out after ${timeoutMs}ms`);
    this.name = 'OperationTimeoutError';
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  label: string,
): Promise<T> {
  // Fast path: the caller already cancelled.
  if (signal?.aborted) {
    throw new Error(`${label} cancelled before start`);
  }

  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new OperationTimeoutError(label, timeoutMs)), timeoutMs);
    // Don't keep the Node process alive just for this timer.
    if (typeof (timer as { unref?: () => void }).unref === 'function') {
      (timer as { unref: () => void }).unref();
    }
  });

  let onAbort: (() => void) | undefined;
  if (signal) {
    onAbort = () => {
      if (timer) clearTimeout(timer);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  }
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

export class ResearchAgent extends BaseAgent implements IAgent {
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

  private searchProvider: ResearchAgentOptions['searchProvider'];
  private fetchProvider: ResearchAgentOptions['fetchProvider'];
  private browserFetchProvider?: ResearchAgentOptions['browserFetchProvider'];
  private maxQueries: number;
  private maxResultsPerQuery: number;
  private maxPagesToFetch: number;
  private maxReportTokens: number;
  private maxIterations: number;
  private fetchTimeoutMs: number;
  private browserTimeoutMs: number;
  private delegationTimeoutMs: number;
  private searchTimeoutMs: number;
  private cache?: SearchCache;
  private traceManager?: TraceManager;
  private onProgress: (phase: string, detail: string) => void;
  private mcpTools: ITool[];
  private mcpTimeoutMs: number;

  constructor(opts: ResearchAgentOptions) {
    super({
      llm: opts.llmProvider,
      model: opts.model,
      systemPrompt: '',
    });
    this.searchProvider = opts.searchProvider;
    this.fetchProvider = opts.fetchProvider;
    this.browserFetchProvider = opts.browserFetchProvider;
    this.maxQueries = opts.maxQueries ?? 3;
    this.maxResultsPerQuery = opts.maxResultsPerQuery ?? 5;
    this.maxPagesToFetch = opts.maxPagesToFetch ?? 5;
    this.maxReportTokens = opts.maxReportTokens ?? 2048;
    this.maxIterations = opts.maxIterations ?? 1;
    this.fetchTimeoutMs = opts.fetchTimeoutMs ?? 12_000;
    this.browserTimeoutMs = opts.browserTimeoutMs ?? 25_000;
    this.delegationTimeoutMs = opts.delegationTimeoutMs ?? 20_000;
    this.searchTimeoutMs = opts.searchTimeoutMs ?? 10_000;
    this.modelPreference = opts.model;
    this.traceManager = opts.traceManager;
    this.onProgress = opts.onProgress ?? (() => {});
    this.mcpTools = opts.mcpTools ?? [];
    this.mcpTimeoutMs = opts.mcpTimeoutMs ?? 15_000;
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

    // Base 0.0 — research should only win routing when the task has
    // strong research signals (web lookup, comparison, pricing, etc.).
    // Previously the base was 0.45 which made research outrank chat on
    // every default task (chat's base was 0.1) — so any short
    // conversational reply ("我在上海虹桥", "OK", "继续") got routed to
    // research, which then did a meaningless web search.
    const score = Math.min(0.95, 0.0 + weightedHits);

    // If the task is clearly transactional (ordering, paying, booking,
    // sending messages, calling a configured MCP service) the research
    // agent is the wrong worker — it would just do a meaningless web
    // search and produce a fake "report". Force a low score so chat
    // (which has the ReAct + MCP tool loop) wins the routing.
    if (isTransactionalTask(ctx.task)) {
      return 0.05;
    }

    // If the task clearly mentions a commercial plan (e.g. "GLM coding
    // plan pricing") we still want research to win over coding, so we
    // boost slightly. This is a soft signal — embedding will confirm.
    return commercial ? Math.max(score, 0.55) : score;
  }

  async execute(ctx: TaskContext): Promise<AgentResult> {
    const startTime = Date.now();
    this.resetMetrics();

    // Defensive: if the router somehow dispatched a transactional task
    // here, refuse and ask the user to retry. We check the *original*
    // task (the user's current turn) rather than `ctx.task` because the
    // Orchestrator prepends recent-session context to `ctx.task` for
    // multi-turn coherence — that recent context can legitimately
    // contain prior transactional intents ("帮我点个麦当劳") even when
    // the current turn is a short clarifying reply ("我在上海虹桥").
    // Mis-firing here would bounce the user with a confusing "please
    // use chat agent" prompt.
    const originalTask = typeof ctx.metadata?.['original.task'] === 'string'
      ? (ctx.metadata['original.task'] as string)
      : ctx.task;
    if (isTransactionalTask(originalTask)) {
      const reply = '这是一个需要实际操作的任务（如下单/支付/订餐），请改用 chat agent（它有完整的 ReAct + MCP 工具循环），或在 chat 视图中重试。';
      return {
        ok: true,
        output: reply,
        metrics: this.metrics,
        artifacts: { redirected: true, reason: 'transactional_task' },
      };
    }

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
      const queryPlan = await this.planQueries(ctx.task, ctx.signal);
      let queries = queryPlan.queries.slice(0, this.maxQueries);

      for (let iteration = 0; iteration < this.maxIterations; iteration++) {
        if (ctx.signal?.aborted) break;
        if (queries.length === 0) break;

        this.onProgress('search', `Iteration ${iteration + 1}/${this.maxIterations}: searching for ${queries.length} queries...`);
        allQueries.push(...queries);

        // Parallel search across all queries (with cache fallback).
        // MCP-backed queries (e.g. amap text search) are answered
        // in-line without making a web search call.
        const searchBatches = await Promise.all(
          queries.map(async (q) => {
            const mcp = await this.tryMcpSearch(q, ctx.signal);
            if (mcp && mcp.length > 0) {
              this.addToolCall();
              return mcp;
            }
            return this.search(q, ctx.signal);
          }),
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
            rankedUrls.map((url) => this.fetchPage(url, allResults, ctx.signal, ctx.sharedState)),
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
      const report = await this.synthesizeReport(ctx.task, allQueries, allPages, ctx.signal);

      // Generate mind map from the report.
      const { mindMap, mindMapText } = await this.generateMindMap(ctx.task, report, ctx.signal);
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

      return this.okResult(report.markdown, {
        artifacts: {
          'research.report': report.markdown,
          'research.reportJson': report,
          'research.sources': report.sources,
          'research.queries': allQueries,
          'research.mindMap': mindMap,
          'research.mindMapText': mindMapText,
        },
        durationMs: Date.now() - startTime,
      });
    } catch (err: unknown) {
      span?.fail({ code: 'RESEARCH_ERROR', message: err instanceof Error ? err.message : String(err) });
      span?.end();
      return this.failResult('RESEARCH_ERROR', err instanceof Error ? err.message : String(err));
    }
  }

  private async planQueries(
    task: string,
    signal?: AbortSignal,
  ): Promise<{ queries: string[] }> {
    const today = new Date();
    const dateStr = today.toISOString().slice(0, 10);
    const year = today.getFullYear();
    const messages: LLMMessage[] = [
      {
        role: 'system',
        content:
          `你是一位研究规划助手。今天是 ${dateStr}（${year}年）。` +
          `请根据用户的需求，生成最多 5 个简洁的网页搜索关键词，用于收集最相关的信息。\n` +
          `重要规则：\n` +
          `1. 如果用户说"最新/最近/今年"（或没有指定年份），请使用当前年份（${year}），不要使用训练数据中的旧年份。\n` +
          `2. 如果用户指定了年份，请严格使用。\n` +
          `3. 去掉"帮我/请/我想"等客套话，只保留搜索关键词。\n` +
          `4. 对于价格/比价类任务，加入当前年份避免数据过期。\n` +
          `用 JSON 响应：{"queries": ["...", "..."]}.`,
      },
      { role: 'user', content: task },
    ];

    const content = await this.callLLm(messages, { jsonMode: true, maxTokens: 512, signal });

    const parsed = parseJsonObject<{ queries?: unknown[] }>(content);
    if (parsed.ok && Array.isArray(parsed.value.queries)) {
      const rawQueries = parsed.value.queries.filter((q) => typeof q === 'string') as string[];
      return { queries: this._normalizeQueryYears(rawQueries, task) };
    }
    return { queries: this._normalizeQueryYears([task], task) };
  }

  /**
   * Rewrite any LLM-added 4-digit year in the 2020-2030 range to the
   * current year, so a query like "GLM pricing 2025" becomes
   * "GLM pricing 2026" without trusting the LLM to follow the
   * "use current year" instruction in the prompt.
   *
   * Why post-process instead of just fixing the prompt:
   *   - Models trained before 2026 still default to 2024/2025 even
   *     when told "today is 2026-XX-XX", because the training data
   *     weight dominates.
   *   - For recency-sensitive tasks ("最新消息", "this week") the
   *     stale-year suffix actually *hurts* — search engines treat it
   *     as a literal date filter and return only that year.
   *
   * User-specified years (e.g. "查询 2023 年的数据") are excluded
   * from rewriting via a whitelist built from the original task.
   * This avoids the case where the user asks for historical data
   * and the agent silently rewrites 2023 to the current year.
   *
   * We only touch a narrow year range (2020-2030) so we never rewrite
   * legitimate content like a historical date in the query (e.g.
   * "Bitcoin 2017 price" or "v20250901" both survive because the
   * regex requires the year to be in 2020-2030 *and* the surrounding
   * tokens to be word boundaries).
   */
  private _normalizeQueryYears(queries: string[], task: string): string[] {
    const currentYear = new Date().getFullYear();
    // Whitelist: years the user wrote in their request. These are
    // intentional and must not be rewritten, even when they're in
    // the 2020-2030 range and not the current year.
    const userYears = new Set<string>();
    for (const m of task.matchAll(/\b(202[0-9]|2030)\b/g)) {
      userYears.add(m[0]);
    }
    return queries.map((q) =>
      q.replace(/\b(202[0-9]|2030)\b/g, (m) => {
        if (userYears.has(m)) return m;            // user-specified, keep
        if (Number(m) === currentYear) return m;   // already correct
        return String(currentYear);
      }),
    );
  }

  private async reflectOnCoverage(
    task: string,
    queries: string[],
    pages: FetchedPage[],
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

    const content = await this.callLLm(messages, { jsonMode: true, maxTokens: 512, signal });

    const parsed = parseJsonObject<{ satisfied?: unknown; followUpQueries?: unknown[] }>(content);
    if (parsed.ok) {
      return {
        satisfied: parsed.value.satisfied === true,
        followUpQueries: this._normalizeQueryYears(
          Array.isArray(parsed.value.followUpQueries)
            ? parsed.value.followUpQueries.filter((q) => typeof q === 'string') as string[]
            : [],
          task,
        ),
      };
    }
    return { satisfied: true, followUpQueries: [] };
  }

  private async search(
    query: string,
    signal?: AbortSignal,
  ): Promise<SearchResult[]> {
    if (signal?.aborted) return [];

    // Try cache first.
    const cached = await this.cache?.get(query);
    if (cached) {
      return cached;
    }

    const results = await withTimeout(
      this.searchProvider(query, this.maxResultsPerQuery),
      this.searchTimeoutMs,
      signal,
      `search "${query.slice(0, 40)}"`,
    ).catch((err) => {
      // Don't let one slow query kill the parallel `Promise.all` in
      // the caller. Return an empty result set so the loop can
      // continue with the remaining queries.
      this.onProgress(
        'search',
        `Search for "${query.slice(0, 40)}" failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [] as SearchResult[];
    });
    this.addToolCall();
    const normalized = results.map((r) => ({ query, ...r }));
    await this.cache?.set(query, normalized);
    return normalized;
  }

  /**
   * Best-effort invocation of a configured MCP tool for a search query.
   * Picks the tool whose name/description best matches the query, builds
   * simple argument candidates from the query string, and converts the
   * result into a `SearchResult[]` that the rest of the pipeline can
   * consume. Returns null when nothing matched or the tool failed.
   */
  private async tryMcpSearch(
    query: string,
    signal?: AbortSignal,
  ): Promise<SearchResult[] | null> {
    if (this.mcpTools.length === 0) return null;
    if (signal?.aborted) return null;

    const q = query.toLowerCase();
    const queryTokens = new Set(
      query.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1).map((w) => w.toLowerCase()),
    );
    // Expand with bilingual synonyms so e.g. "麦当劳" can match an
    // English tool name "mcp__mcdonalds__*". Without this, a Chinese
    // query against an English-named MCP server scores 0 and the tool
    // is never tried.
    for (const tok of [...queryTokens]) {
      const syns = MCP_KEYWORD_SYNONYMS[tok];
      if (syns) for (const s of syns) queryTokens.add(s);
    }

    const candidates = this.mcpTools
      .filter((tool) => !isMcpActionTool(tool))
      .map((tool) => {
        const hay = `${tool.name} ${tool.description}`.toLowerCase();
        let score = 0;
        for (const tok of queryTokens) {
          if (hay.includes(tok)) score += 1;
          if (tool.name.toLowerCase().includes(tok)) score += 2;
        }
        return { tool, score };
      })
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score);

    const top = candidates[0];
    if (!top) return null;

    const args = this._buildMcpArgs(top.tool, query);
    if (!args) return null;

    try {
      const inv = {
        id: `mcp_${Date.now()}`,
        toolName: top.tool.name,
        args,
      };
      this.onProgress('search', `MCP ${top.tool.name} for "${query.slice(0, 40)}"`);
      const result = await withTimeout(
        top.tool.invoke(inv),
        this.mcpTimeoutMs,
        signal,
        `mcp ${top.tool.name}`,
      );
      if (!result.ok) return null;
      const text = typeof result.output === 'string'
        ? result.output
        : result.output != null ? JSON.stringify(result.output) : '';
      if (!text) return null;
      const results = this._parseMcpOutput(text, query);
      return results.length > 0 ? results : null;
    } catch {
      return null;
    }
  }

  /**
   * Build minimal argument candidates from the query string. We try
   * common search-arg names first (`keywords`, `query`, `q`, `text`,
   * `address`, `location`, `name`) so amap-style text search tools get
   * the raw query. If the schema has only one required argument, we
   * use that regardless of its name. Returns null when no fillable
   * property is found.
   */
  private _buildMcpArgs(tool: ITool, query: string): Record<string, unknown> | null {
    const schema = tool.argsSchema as
      | { properties?: Record<string, unknown>; required?: string[] }
      | undefined;
    if (!schema) {
      return { keywords: query };
    }
    const props = schema.properties ?? {};
    const propNames = Object.keys(props);
    if (propNames.length === 0) return { keywords: query };

    const textKeys = ['keywords', 'query', 'q', 'text', 'address', 'location', 'name', 'input'];
    const textKey = propNames.find((n) => textKeys.includes(n.toLowerCase()));
    const required = Array.isArray(schema.required) ? schema.required : [];

    if (required.length === 1 && !textKey) {
      return { [required[0]]: query };
    }
    if (textKey) {
      const args: Record<string, unknown> = { [textKey]: query };
      const cityProp = propNames.find((n) => /^city|province|region$/i.test(n));
      if (cityProp) {
        const city = this._extractCity(query);
        if (city) args[cityProp] = city;
      }
      return args;
    }
    return { keywords: query };
  }

  private _extractCity(text: string): string | undefined {
    const m = text.match(/(北京|上海|天津|重庆|广州|深圳|杭州|南京|苏州|成都|武汉|西安|厦门|青岛|济南|长沙|郑州|合肥|福州|昆明|哈尔滨|沈阳|大连|太原|石家庄|南昌|贵阳|南宁|海口|三亚|宁波|温州|无锡|佛山|东莞|珠海|香港|澳门|台北)/);
    return m?.[0];
  }

  /**
   * Parse MCP tool output into SearchResult[]. We try to extract a list
   * of items with `name`/`title` and `address`/`location`/`snippet`
   * properties. As a fallback, the whole output becomes a single result.
   */
  private _parseMcpOutput(text: string, query: string): SearchResult[] {
    const results: SearchResult[] = [];
    try {
      const parsed = JSON.parse(text);
      const list = Array.isArray(parsed) ? parsed
        : Array.isArray(parsed?.pois) ? parsed.pois
        : Array.isArray(parsed?.results) ? parsed.results
        : Array.isArray(parsed?.data) ? parsed.data
        : Array.isArray(parsed?.items) ? parsed.items
        : null;
      if (list) {
        for (const item of list.slice(0, this.maxResultsPerQuery)) {
          if (!item || typeof item !== 'object') continue;
          const name = (item as { name?: unknown; title?: unknown }).name
            ?? (item as { title?: unknown }).title;
          if (typeof name !== 'string' || name.trim().length === 0) continue;
          const address = (item as { address?: unknown }).address
            ?? (item as { location?: unknown }).location
            ?? (item as { pname?: unknown }).pname;
          const snippet = typeof address === 'string'
            ? address
            : Array.isArray(address) ? address.filter((x) => typeof x === 'string').join(' · ') : undefined;
          results.push({
            query,
            title: name,
            url: typeof (item as { url?: unknown }).url === 'string'
              ? (item as { url: string }).url
              : `mcp://${name}`,
            snippet,
          });
        }
      }
    } catch {
      // fall through to single-result
    }
    if (results.length === 0) {
      const snippet = text.length > 600 ? text.slice(0, 600) + '…' : text;
      results.push({
        query,
        title: `${query} (MCP result)`,
        url: `mcp://${query}`,
        snippet,
      });
    }
    return results;
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
    signal?: AbortSignal,
    sharedState?: import('@ziner/contracts').SharedState,
  ): Promise<FetchedPage | null> {
    if (signal?.aborted) return null;

    const title = results.find((r) => r.url === url)?.title ?? url;
    const needsBrowser = this.browserFetchProvider != null && this.needsBrowserForUrl(url);

    // If the URL likely requires JS, try delegation to browser agent first.
    if (needsBrowser && sharedState) {
      try {
        requestDelegation(sharedState, 'browser', `Navigate to ${url} and extract the main content. Return the visible text content of the page.`, this.name, { url });
        const delegateResp = await waitForDelegation(sharedState, 'browser', this.delegationTimeoutMs);
        if (delegateResp.result && delegateResp.result.length > 100) {
          this.addToolCall();
          return { url, title: (delegateResp.data?.title as string) || title, content: delegateResp.result, score: 0 };
        }
      } catch {
        // Delegation failed or timed out; fall through to browserFetchProvider.
      }
    }

    // Fallback to browserFetchProvider if available.
    if (needsBrowser) {
      try {
        const page = await withTimeout(
          this.browserFetchProvider!(url),
          this.browserTimeoutMs,
          signal,
          `browser-fetch ${url.slice(0, 60)}`,
        );
        if (signal?.aborted) return null;
        this.addToolCall();
        return { url, title: page.title || title, content: page.content, score: 0 };
      } catch {
        // Fall through to simple fetch as fallback.
      }
    }

    // Simple fetch (no JS).
    try {
      const content = await withTimeout(
        this.fetchProvider(url, 8000),
        this.fetchTimeoutMs,
        signal,
        `fetch ${url.slice(0, 60)}`,
      );
      if (signal?.aborted) return null;
      this.addToolCall();

      // If content is empty/too short and we have a browser provider, try that.
      if (content.length < MIN_CONTENT_LENGTH && this.browserFetchProvider != null) {
        try {
          const page = await withTimeout(
            this.browserFetchProvider(url),
            this.browserTimeoutMs,
            signal,
            `browser-retry ${url.slice(0, 60)}`,
          );
          if (signal?.aborted) return null;
          this.addToolCall();
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
          const page = await withTimeout(
            this.browserFetchProvider(url),
            this.browserTimeoutMs,
            signal,
            `browser-fallback ${url.slice(0, 60)}`,
          );
          if (signal?.aborted) return null;
          this.addToolCall();
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
          `你是一位研究综合员。今天是 ${dateStr}（${year}年）。` +
          `请阅读收集到的资料，撰写一份结构清晰的 Markdown 报告（中文）。` +
          `要求：\n` +
          `1. 每个事实声明必须有内联引用，例如 [1]、[2]。\n` +
          `2. 对于时效性强的内容（价格、套餐、折扣），若数据明显来自 ${year - 1} 年或更早，请标注"数据可能已过期"。\n` +
          `3. 包含：摘要、关键发现、信息来源（Sources）。\n` +
          `用 JSON 响应：{"markdown": "...", "satisfied": true|false, "sources": [{"index": 1, "title": "...", "url": "..."}]}。`,
      },
      {
        role: 'user',
        content: `任务：${task}\n\n使用的查询：${queries.join('；')}\n\n收集到的资料：\n\n${sourcesText}`,
      },
    ];

    const content = await this.callLLm(messages, { jsonMode: true, maxTokens: this.maxReportTokens, signal });

    const parsed = parseJsonObject<{
      markdown?: unknown;
      satisfied?: unknown;
      sources?: Array<{ index?: unknown; title?: unknown; url?: unknown }>;
    }>(content);

    if (parsed.ok) {
      const p = parsed.value;
      const markdown = typeof p.markdown === 'string' ? p.markdown : '(no report generated)';
      const satisfied = p.satisfied === true;
      const sources = Array.isArray(p.sources)
        ? p.sources
            .filter((s) => s && typeof s.url === 'string')
            .map((s, idx) => ({
              index: typeof s.index === 'number' ? s.index : idx + 1,
              title: String(s.title ?? 'Source'),
              url: String(s.url),
            }))
        : scoredPages.map((p, i) => ({ index: i + 1, title: p.title, url: p.url }));

      return { markdown, sources, queries, satisfied };
    }

    const fallbackSources = scoredPages.map((p, i) => ({ index: i + 1, title: p.title, url: p.url }));
    return {
      markdown: content,
      sources: fallbackSources,
      queries,
      satisfied: false,
    };
  }

  private async generateMindMap(
    task: string,
    report: ResearchReport,
    signal?: AbortSignal,
  ): Promise<{ mindMap?: string; mindMapText?: string }> {
    const messages: LLMMessage[] = [
      {
        role: 'system',
        content:
          '你是一位思维导图生成助手。根据给定的研究任务和报告，生成 Mermaid 思维导图。语法：\n' +
          'mindmap\n  root((主题))\n    分支 A\n      子分支 A1\n      子分支 A2\n    分支 B\n' +
          '保持简洁（最多 6 个分支，3 层深度）。只输出 Mermaid 代码块。',
      },
      {
        role: 'user',
        content: `任务：${task}\n\n报告：\n${report.markdown.slice(0, 3000)}`,
      },
    ];

    const content = await this.callLLm(messages, { maxTokens: 1024, signal });

    const mindMap = content.trim();
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

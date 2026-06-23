// @z-assistant/agent-research — Research Agent (P2-1).
//
// Performs iterative web research for a user question and synthesizes a
// structured markdown report. Search / fetch capabilities are injected by
// the host so this package stays dependency-light.

import type {
  IAgent,
  ILLMProvider,
  ModelSpec,
  TaskContext,
  AgentResult,
} from '@z-assistant/contracts';
import { ok as okResult, fail as failResult } from '@z-assistant/contracts';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

class TtlCache<T> {
  private readonly store = new Map<string, { value: T; expires: number }>();
  constructor(private readonly ttlMs: number) {}
  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expires) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }
  set(key: string, value: T): void {
    this.store.set(key, { value, expires: Date.now() + this.ttlMs });
  }
}

export interface ResearchAgentConfig {
  llmProvider: ILLMProvider;
  model: ModelSpec;
  /** Optional: perform live web search. */
  searchProvider?: (query: string, maxResults: number) => Promise<SearchResult[]>;
  /** Optional: fetch full page text from a URL. */
  fetchProvider?: (url: string, maxLength: number) => Promise<string>;
  /** Max search queries to issue per round. Default 3. */
  maxQueries?: number;
  /** Max results per query. Default 5. */
  maxResultsPerQuery?: number;
  /** Max pages to fetch for detailed reading. Default 3. */
  maxPagesToFetch?: number;
  /** Max concurrent page fetches. Default 3. */
  fetchConcurrency?: number;
  /** Max output tokens for the final report. Default 2048. */
  maxReportTokens?: number;
  /** Cache TTL for search/fetch results in ms. Default 10 minutes. Set 0 to disable. */
  cacheTtlMs?: number;
  /** Max research rounds (1 = single pass). Default 1. */
  maxRounds?: number;
  /** Whether to extract key paragraphs from fetched pages before synthesis. Default true. */
  extractKeyParagraphs?: boolean;
}

export interface ResearchReport {
  queries: string[];
  sources: SearchResult[];
  report: string;
}

const RESEARCH_KEYWORDS = [
  'research', '调研', '研究', '报告', 'report', 'compare', '对比', '分析', 'analyze',
  'summarize', '总结', 'latest', '最新', 'news', '新闻', '价格', 'price', '评测', 'review',
];

const QUERY_GENERATION_PROMPT = `You are a research assistant. Given a user's request, generate up to {maxQueries} precise web search queries that will gather the information needed to answer it thoroughly.

Respond with a single JSON object:
{
  "queries": ["query 1", "query 2", ...]
}

Rules:
- Each query should be specific and likely to return high-quality sources.
- Prefer authoritative sources (official docs, major news, reviews).
- Do not wrap the JSON in markdown.`;

const EVALUATION_PROMPT = `You are evaluating research progress. Given the original user request and a summary of information gathered so far, decide whether the research is sufficient to write a high-quality report.

Respond with a single JSON object:
{
  "sufficient": true,
  "followUpQueries": []
}

If the information is insufficient, set "sufficient": false and provide 1-3 follow-up search queries in "followUpQueries".

Rules:
- Be honest about gaps.
- Do not wrap the JSON in markdown.`;

const KEY_PARAGRAPHS_PROMPT = `Extract the 3-5 most relevant paragraphs from the web page below that help answer the user's research question. Ignore navigation, ads, footers, and boilerplate.

Respond with a single JSON object:
{
  "paragraphs": ["paragraph 1", "paragraph 2", ...]
}

Rules:
- Each paragraph should be concise (1-3 sentences).
- Do not wrap the JSON in markdown.`;

const REPORT_PROMPT = `You are a senior research analyst. Using the provided search results, write a structured markdown report answering the user's request.

Requirements:
- Start with a concise executive summary.
- Include sections as appropriate (Background, Findings, Comparison, Risks, Recommendations, Sources).
- Cite sources inline with [^n] markers and list the URLs at the end under "## Sources".
- If information is missing or uncertain, state that explicitly.
- Be factual; do not invent data not present in the sources.
- Keep the report focused and well-organized.`;

export function createResearchAgent(config: ResearchAgentConfig): IAgent {
  const {
    llmProvider,
    model,
    searchProvider,
    fetchProvider,
    maxQueries = 3,
    maxResultsPerQuery = 5,
    maxPagesToFetch = 3,
    fetchConcurrency = 3,
    maxReportTokens = 2048,
    cacheTtlMs = 10 * 60 * 1000,
    maxRounds = 1,
    extractKeyParagraphs = true,
  } = config;

  const searchCache = searchProvider && cacheTtlMs > 0 ? new TtlCache<SearchResult[]>(cacheTtlMs) : null;
  const fetchCache = fetchProvider && cacheTtlMs > 0 ? new TtlCache<string>(cacheTtlMs) : null;

  return {
    name: 'research',
    role: 'Deep Research & Report Generation',
    capabilities: ['research', 'web.search', 'report', 'summarize', 'compare'],
    dependencies: [],
    modelPreference: model,

    canHandle(ctx: TaskContext): number {
      const t = ctx.task.toLowerCase();
      let score = 0;
      for (const k of RESEARCH_KEYWORDS) {
        if (t.includes(k.toLowerCase())) score += 0.2;
      }
      return Math.min(score, 0.95);
    },

    async execute(ctx: TaskContext): Promise<AgentResult> {
      const t0 = Date.now();
      try {
        let queries = searchProvider ? await generateQueries(ctx.task, maxQueries) : [];
        const sources: SearchResult[] = [];
        const fetchedContents: string[] = [];
        let llmCalls = 1; // query generation

        const executeRound = async (roundQueries: string[]): Promise<boolean> => {
          if (!searchProvider || roundQueries.length === 0) return true;

          const searchResults = await Promise.all(
            roundQueries.map((q) => cachedSearch(q, maxResultsPerQuery)),
          );
          for (const results of searchResults) {
            for (const r of results) {
              if (!sources.some((s) => s.url === r.url)) {
                sources.push(r);
              }
            }
          }

          if (fetchProvider) {
            const toFetch = sources.slice(0, maxPagesToFetch);
            const batches: SearchResult[][] = [];
            for (let i = 0; i < toFetch.length; i += fetchConcurrency) {
              batches.push(toFetch.slice(i, i + fetchConcurrency));
            }
            for (const batch of batches) {
              const texts = await Promise.all(
                batch.map(async (r) => {
                  try {
                    const text = await cachedFetch(r.url, 8000);
                    if (!text || text.startsWith('web_fetch error')) return null;
                    const refined = extractKeyParagraphs
                      ? await extractKeyParagraphsFromPage(text, ctx.task)
                      : truncateForContext(text, 4000);
                    return { url: r.url, title: r.title, text: refined };
                  } catch {
                    return null;
                  }
                }),
              );
              for (const item of texts) {
                if (item) {
                  fetchedContents.push(`Source: ${item.url}\nTitle: ${item.title}\n${item.text}\n---`);
                }
              }
            }
          }

          // On the final round, do not ask for follow-ups.
          return true;
        };

        for (let round = 0; round < maxRounds; round++) {
          await executeRound(queries);

          if (round < maxRounds - 1 && sources.length > 0) {
            const evaluation = await evaluateProgress(ctx.task, sources, fetchedContents);
            llmCalls++;
            if (evaluation.sufficient || evaluation.followUpQueries.length === 0) {
              break;
            }
            queries = evaluation.followUpQueries.slice(0, maxQueries);
          } else {
            break;
          }
        }

        const report = await generateReport(ctx.task, queries, sources, fetchedContents);
        llmCalls++;

        const output: ResearchReport = { queries, sources, report };
        return okResult(output, {
          metrics: {
            tokensIn: 0,
            tokensOut: 0,
            costUsd: 0,
            durationMs: Date.now() - t0,
            llmCalls,
            toolCalls: sources.length + fetchedContents.length,
          },
        });
      } catch (err: unknown) {
        return failResult('RESEARCH_ERROR', err instanceof Error ? err.message : String(err));
      }
    },
  };

  async function cachedSearch(query: string, limit: number): Promise<SearchResult[]> {
    const key = `${query}::${limit}`;
    if (searchCache) {
      const cached = searchCache.get(key);
      if (cached) return cached;
    }
    const results = await searchProvider!(query, limit);
    if (searchCache) searchCache.set(key, results);
    return results;
  }

  async function cachedFetch(url: string, maxLength: number): Promise<string> {
    const key = `${url}::${maxLength}`;
    if (fetchCache) {
      const cached = fetchCache.get(key);
      if (cached) return cached;
    }
    const text = await fetchProvider!(url, maxLength);
    if (fetchCache) fetchCache.set(key, text);
    return text;
  }

  async function generateQueries(task: string, limit: number): Promise<string[]> {
    const prompt = QUERY_GENERATION_PROMPT.replace('{maxQueries}', String(limit));
    const res = await llmProvider.generate({
      model,
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: task },
      ],
      jsonMode: true,
      temperature: 0.3,
      maxTokens: 512,
    });
    const text = res.message.content ?? '{}';
    try {
      const parsed = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/gi, '')) as { queries?: string[] };
      return (parsed.queries ?? []).filter((q) => q.trim().length > 0);
    } catch {
      return [];
    }
  }

  async function evaluateProgress(
    task: string,
    sources: SearchResult[],
    fetchedContents: string[],
  ): Promise<{ sufficient: boolean; followUpQueries: string[] }> {
    const sourceSummary = sources.map((s, i) => `[${i + 1}] ${s.title} — ${s.snippet}`).join('\n');
    const contentSummary = fetchedContents.join('\n').slice(0, 4000);
    const res = await llmProvider.generate({
      model,
      messages: [
        { role: 'system', content: EVALUATION_PROMPT },
        {
          role: 'user',
          content: `User request: ${task}\n\nSources found:\n${sourceSummary}\n\nFetched content:\n${contentSummary}`,
        },
      ],
      jsonMode: true,
      temperature: 0.3,
      maxTokens: 512,
    });
    const text = res.message.content ?? '{}';
    try {
      const parsed = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/gi, '')) as {
        sufficient?: boolean;
        followUpQueries?: string[];
      };
      return {
        sufficient: !!parsed.sufficient,
        followUpQueries: (parsed.followUpQueries ?? []).filter((q) => q.trim().length > 0),
      };
    } catch {
      return { sufficient: true, followUpQueries: [] };
    }
  }

  async function extractKeyParagraphsFromPage(pageText: string, task: string): Promise<string> {
    if (pageText.length <= 4000) return pageText;
    const res = await llmProvider.generate({
      model,
      messages: [
        { role: 'system', content: KEY_PARAGRAPHS_PROMPT },
        { role: 'user', content: `Research question: ${task}\n\nPage content:\n${pageText.slice(0, 6000)}` },
      ],
      jsonMode: true,
      temperature: 0.3,
      maxTokens: 1024,
    });
    const text = res.message.content ?? '{}';
    try {
      const parsed = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/gi, '')) as { paragraphs?: string[] };
      const paragraphs = parsed.paragraphs ?? [];
      if (paragraphs.length === 0) return truncateForContext(pageText, 4000);
      return paragraphs.join('\n\n');
    } catch {
      return truncateForContext(pageText, 4000);
    }
  }

  async function generateReport(
    task: string,
    queries: string[],
    sources: SearchResult[],
    fetchedContents: string[],
  ): Promise<string> {
    let context = '';
    if (sources.length > 0) {
      context += `## Search results\n\n`;
      sources.forEach((s, i) => {
        context += `[${i + 1}] ${s.title}\nURL: ${s.url}\n${s.snippet}\n\n`;
      });
    }
    if (fetchedContents.length > 0) {
      context += `## Fetched page contents\n\n${fetchedContents.join('\n\n')}\n\n`;
    }
    if (!context) {
      context = 'No live search provider is configured. Produce a report based on your knowledge, and clearly note any uncertainty.';
    }

    const res = await llmProvider.generate({
      model,
      messages: [
        { role: 'system', content: REPORT_PROMPT },
        {
          role: 'user',
          content: `User request: ${task}\n\n${context}`,
        },
      ],
      temperature: 0.4,
      maxTokens: maxReportTokens,
    });
    return res.message.content ?? '';
  }
}

function truncateForContext(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + '\n...[truncated]';
}

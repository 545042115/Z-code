// @ziner/app-desktop — Research Agent bridge (P1-1 / P2-1).
//
// Wires the Research Agent to the desktop's live web search / fetch tools
// and the browser-based fetch provider for JS-heavy pages.
// Uses the shared Playwright backend (from browser-agent-bridge) so the
// Browser Agent and Research Agent share a single browser instance.

import { createResearchAgent } from '@ziner/agent-research';
import type { IAgent, ILLMProvider, ITool, ModelSpec } from '@ziner/contracts';
import { webSearchResults, webFetch } from '@ziner/app-vscode-connector';
import { pageToText } from '@ziner/agent-browser';
import { getSharedBackend } from './browser-agent-bridge';
import { emitAgentActivity } from './agent-activity-bus';

export interface DesktopResearchAgentOptions {
  llmProvider: ILLMProvider;
  model: ModelSpec;
  /** Desktop storage directory for search cache. */
  storageDir: string;
  /**
   * Optional MCP tools (e.g. amap maps_text_search). The research agent
   * uses them as a fast path for structured map/food/route queries so it
   * does not have to round-trip through web search for things that have
   * a dedicated MCP service.
   */
  mcpTools?: ITool[];
}

export function createResearchAgentBridge(options: DesktopResearchAgentOptions): IAgent {
  return createResearchAgent({
    llmProvider: options.llmProvider,
    model: options.model,
    searchProvider: async (query: string, maxResults: number) => {
      emitAgentActivity({
        agent: 'research',
        icon: '\u{1F50D}',
        message: `Searching: ${query.slice(0, 80)}`,
        detail: `maxResults: ${maxResults}`,
      });
      return webSearchResults(query, maxResults);
    },
    fetchProvider: async (url: string, maxLength: number) => {
      emitAgentActivity({
        agent: 'research',
        icon: '\u{1F4E1}',
        message: `Fetching page: ${url.slice(0, 80)}`,
        detail: `maxLength: ${maxLength}`,
      });
      return webFetch(url, maxLength);
    },
    browserFetchProvider: async (url: string) => {
      emitAgentActivity({
        agent: 'research',
        icon: '\u{1F310}',
        message: `Opening in browser: ${url.slice(0, 80)}`,
      });
      // Use the shared Playwright backend (same instance as Browser Agent).
      const backend = await getSharedBackend();
      // Navigate to the target URL (renders JS, executes SPA).
      await backend.act({ type: 'navigate', url });
      // Wait a moment for dynamic content to load.
      await new Promise((r) => setTimeout(r, 1500));
      // Take a full DOM snapshot and convert to structured text.
      const snapshot = await backend.snapshot({ includeScreenshot: false });
      const content = pageToText(snapshot, 500);
      emitAgentActivity({
        agent: 'research',
        icon: '\u{2705}',
        message: `Browser fetch complete: ${snapshot.title?.slice(0, 60) || url.slice(0, 60)}`,
      });
      return { title: snapshot.title || url, content };
    },
    // Progress callback: emit activity events during long operations
    onProgress: (phase: string, detail: string) => {
      const icons: Record<string, string> = {
        plan: '\u{1F4CB}',
        search: '\u{1F50D}',
        fetch: '\u{1F4E1}',
        reflect: '\u{1F9E0}',
        synthesize: '\u{270D}',
      };
      emitAgentActivity({
        agent: 'research',
        icon: icons[phase] || '\u{1F4BB}',
        message: detail.slice(0, 100),
      });
    },
    // Plan subtasks are narrow (search hotels, food, route). Lower the
    // default depth so each subtask returns in ~10-20s instead of ~60s.
    maxQueries: 2,
    maxResultsPerQuery: 3,
    maxPagesToFetch: 3,
    maxReportTokens: 1536,
    maxIterations: 1,
    cacheDir: `${options.storageDir}/search-cache`,
    cacheTtlMs: 24 * 60 * 60 * 1000, // 24h
    ...(options.mcpTools ? { mcpTools: options.mcpTools } : {}),
  });
}

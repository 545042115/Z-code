// @z-assistant/app-desktop — Research Agent bridge (P1-1 / P2-1).
//
// Wires the Research Agent to the desktop's live web search / fetch tools
// and the browser-based fetch provider for JS-heavy pages.

import { createResearchAgent } from '@z-assistant/agent-research';
import type { IAgent, ILLMProvider, ModelSpec } from '@z-assistant/contracts';
import { webSearchResults, webFetch, browserNavigate, browserScreenshot, browserClose } from '@z-assistant/app-vscode-connector';

export interface DesktopResearchAgentOptions {
  llmProvider: ILLMProvider;
  model: ModelSpec;
  /** Desktop storage directory for search cache. */
  storageDir: string;
}

export function createResearchAgentBridge(options: DesktopResearchAgentOptions): IAgent {
  return createResearchAgent({
    llmProvider: options.llmProvider,
    model: options.model,
    searchProvider: async (query: string, maxResults: number) =>
      webSearchResults(query, maxResults),
    fetchProvider: async (url: string, maxLength: number) =>
      webFetch(url, maxLength),
    browserFetchProvider: async (url: string) => {
      // Navigate to the page in a real browser (renders JS).
      await browserNavigate(url);
      // Take a screenshot to extract visible text and interactive elements.
      const snapshot = await browserScreenshot();
      // Close the browser to free resources.
      await browserClose();
      // The snapshot description includes visible text; use it as content.
      return { title: url, content: snapshot };
    },
    maxQueries: 3,
    maxResultsPerQuery: 5,
    maxPagesToFetch: 5,
    maxReportTokens: 2048,
    maxIterations: 2,
    cacheDir: `${options.storageDir}/search-cache`,
    cacheTtlMs: 24 * 60 * 60 * 1000, // 24h
  });
}

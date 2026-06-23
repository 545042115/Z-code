// @z-assistant/app-desktop — Research Agent bridge (P2-1).
//
// Injects the desktop's live web search / fetch capabilities into the
// Research Agent so it can perform real deep research.

import { createResearchAgent as createResearchAgentImpl } from '@z-assistant/agent-research';
import type { IAgent, ILLMProvider, ModelSpec } from '@z-assistant/contracts';
import { webSearchResults, webFetch } from '@z-assistant/app-vscode-connector';

export interface DesktopResearchAgentOptions {
  llmProvider: ILLMProvider;
  model: ModelSpec;
}

export function createResearchAgent(options: DesktopResearchAgentOptions): IAgent {
  return createResearchAgentImpl({
    llmProvider: options.llmProvider,
    model: options.model,
    searchProvider: async (query: string, maxResults: number) =>
      webSearchResults(query, maxResults),
    fetchProvider: async (url: string, maxLength: number) =>
      webFetch(url, maxLength),
    maxQueries: 3,
    maxResultsPerQuery: 5,
    maxPagesToFetch: 3,
    maxReportTokens: 2048,
  });
}

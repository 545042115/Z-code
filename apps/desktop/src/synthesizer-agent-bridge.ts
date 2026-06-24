// @z-assistant/app-desktop — Synthesizer Agent bridge (P2 multi-agent).
//
// Creates a Synthesizer instance with the live `LLMProvider` so the
// Orchestrator's `plan` mode (and the multi-output aggregator in
// `runMultiAgentTask`) can merge multiple sub-task outputs into a
// single user-facing answer.

import { createSynthesizerAgent } from '@z-assistant/agent-synthesizer';
import type { IAgent, ILLMProvider, ModelSpec } from '@z-assistant/contracts';

export interface DesktopSynthesizerAgentOptions {
  llmProvider: ILLMProvider;
  model: ModelSpec;
}

export function createDesktopSynthesizerAgent(options: DesktopSynthesizerAgentOptions): IAgent {
  return createSynthesizerAgent({
    llmProvider: options.llmProvider,
    model: options.model,
  });
}

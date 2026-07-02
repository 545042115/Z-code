// @ziner/app-desktop — Planner Agent bridge (P2 multi-agent).
//
// Creates a Planner instance with the live `LLMProvider` so the
// Orchestrator's `plan` mode can decompose a user task into a DAG of
// sub-tasks.
//
// The Planner's `availableAgents` list is derived from the agents the
// connector actually registered (browser / research / office + the
// chat loop). The desktop supplies them as a parameter so the prompt
// always matches the registry.

import { createPlannerAgent } from '@ziner/agent-planner';
import type { IAgent, ILLMProvider, ModelSpec } from '@ziner/contracts';

export interface DesktopPlannerAgentOptions {
  llmProvider: ILLMProvider;
  model: ModelSpec;
  /** Names of agents the Planner may assign sub-tasks to. */
  availableAgents: string[];
  /** Override max sub-tasks (default 5). */
  maxSubTasks?: number;
}

export function createDesktopPlannerAgent(options: DesktopPlannerAgentOptions): IAgent {
  return createPlannerAgent({
    llmProvider: options.llmProvider,
    model: options.model,
    availableAgents: options.availableAgents,
    maxSubTasks: options.maxSubTasks,
  });
}

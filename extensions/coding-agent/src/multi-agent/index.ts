// Multi-Agent module — single import surface.

export { SharedState, type SharedStateOptions } from './shared-state';
export {
  AgentRegistry,
  AgentConflictError,
  AgentNotFoundError,
  DependencyCycleError,
} from './agent-registry';
export {
  Orchestrator,
  NoopAgent,
  type OrchestratorOptions,
  type OrchestratorResult,
  type OrchestratorMode,
} from './orchestrator';
export {
  AgentLoopAdapter,
  type AgentLoopAdapterOptions,
} from './agent-loop-adapter';
export {
  PromptedAgent,
  PROMPT_METADATA_KEYS,
  type PromptedAgentOptions,
} from './prompted-agent';
export {
  ResearcherAgent,
  CoderAgent,
  ReviewerAgent,
  registerExampleAgents,
} from './example-agents';

// V1 Multi-Agent Connector — single import surface.
//
// Phase 6A: the V2 generic multi-agent runtime
// (`@ziner/runtime/orchestrator`) is the canonical source. The
// pure-Node primitives (AgentRegistry, Orchestrator, SharedState,
// NoopAgent, example agents) re-exported from V2. The V1-specific
// adapters (AgentLoopAdapter, PromptedAgent) stay in this directory
// because they depend on V1 modules (`agent/agent-loop`,
// `trace-ui/query-service`).

export {
  SharedState,
  AgentRegistry,
  AgentConflictError,
  AgentNotFoundError,
  DependencyCycleError,
  Orchestrator,
  NoopAgent,
  ResearcherAgent,
  CoderAgent,
  ReviewerAgent,
  registerExampleAgents,
  type SharedStateOptions,
  type OrchestratorOptions,
  type OrchestratorResult,
  type OrchestratorMode,
} from '@ziner/runtime';

export {
  AgentLoopAdapter,
  type AgentLoopAdapterOptions,
} from './agent-loop-adapter';

export {
  PromptedAgent,
  PROMPT_METADATA_KEYS,
  type PromptedAgentOptions,
} from './prompted-agent';

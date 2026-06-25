// @z-assistant/runtime — orchestrator
//
// Multi-agent dispatcher / scheduler. Pure Node, no vscode.
//
//   - `AgentRegistry`    holds + routes IAgent instances
//   - `SharedState`      the multi-agent blackboard
//   - `Orchestrator`     sequential / parallel / dag execution
//   - `NoopAgent`        for tests and stubbing
//   - `Researcher/Coder/Reviewer`  reference LLM-free agents
//
// V1-specific adapters (AgentLoopAdapter / PromptedAgent) stay in V1
// because they depend on the V1 `agent/agent-loop` and V1 QueryService.

export {
  SharedState,
  type SharedStateOptions,
} from './shared-state';
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
  ResearcherAgent,
  CoderAgent,
  ReviewerAgent,
  registerExampleAgents,
} from './example-agents';
export {
  requestDelegation,
  getDelegationRequest,
  markDelegationRunning,
  completeDelegation,
  failDelegation,
  waitForDelegation,
  type DelegationRequest,
  type DelegationResponse,
  type DelegationStatus,
} from './delegation';

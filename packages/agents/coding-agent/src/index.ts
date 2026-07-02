// @ziner/agent-coding — adapter layer
//
// V2 Coding Agent adapter layer. Provides thin implementations of the
// V2 interfaces (IAgent / IPlanner / IReflectionEngine /
// IContextProvider / ISkillRegistry / IToolRegistry / IVerifier) by
// delegating to V1's `extensions/coding-agent/src/` modules.
//
// Architecture (per ADR-001 §六):
//
//   ┌──────────────────────────────────────────────────────┐
//   │  V2 Orchestrator                                     │
//   │  (packages/runtime/src/orchestrator/)                │
//   └────────────────────┬─────────────────────────────────┘
//                        │ IAgent
//                        ▼
//   ┌──────────────────────────────────────────────────────┐
//   │  CodingAgentLoop (agent-loop-adapter.ts)              │
//   │  ─────────────────────────────────────                │
//   │  CodingAgent / CodingPlanner / CodingReflectionEng    │
//   │  CodingContextProvider / CodingSkillRegistry         │
//   │  CodingToolRegistry / CodingVerifier                  │
//   │  (all in packages/agents/coding-agent/src/)           │
//   └────────────────────┬─────────────────────────────────┘
//                        │ implements V2 interface
//                        ▼
//   ┌──────────────────────────────────────────────────────┐
//   │  V1 Coding Agent (extensions/coding-agent/src/agent) │
//   │  ─ Plan → Execute → Verify → Reflect → Replan ─      │
//   └──────────────────────────────────────────────────────┘
//
// Phase 6A: skeleton. Each sub-adapter has a stub `impl` that
// returns a `3001` "not wired" failure (R7 wires V1). R7 will:
//   1. Implement `CodingAgent.execute` by composing:
//      CodingPlanner.buildPlan → CodingToolRegistry.invoke →
//      CodingVerifier.verify → CodingReflectionEngine.reflect
//   2. Wire each sub-adapter's `impl` to the corresponding V1
//      module (Planner, ToolRegistry, Verifier, ReflectionEngine,
//      Context providers, SkillManager).

export {
  CodingAgent,
  type CodingAgentOptions,
} from './agent-core';

export {
  CodingPlanner,
  type CodingPlannerOptions,
} from './planner';

export {
  CodingReflectionEngine,
  type CodingReflectionOptions,
} from './reflection';

export {
  CodingContextProvider,
  type CodingContextOptions,
} from './context';

export {
  CodingSkillRegistry,
  type CodingSkillOptions,
} from './skills';

export {
  CodingToolRegistry,
  type CodingToolOptions,
} from './tools';

export {
  CodingVerifier,
  type CodingVerifierOptions,
} from './verifier';

export {
  CodingAgentLoop,
  createCodingAgentLoop,
  type CodingAgentLoopOptions,
} from './agent-loop-adapter';

// Version constant.
export const CODING_AGENT_ADAPTER_VERSION = '0.1.0';

// @z-assistant/runtime — planning
//
// Generic Plan / Step framework with two executors:
//   - sequential-executor: runs steps in order
//   - dag-executor:        runs steps respecting `dependsOn` edges
//
// Agent-specific planners (Coding / Browser / Research) implement
// `IPlanner` from `@z-assistant/contracts` and use these executors
// to run their `Plan`s.
//
// Phase 6A: minimal framework. Per ADR 4.2 the Coding Planner
// template / actions stay in V1 (`extensions/coding-agent/src/planner/`).

export {
  executeSequential,
  type StepHandler,
  type SequentialExecutorOptions,
} from './sequential-executor';

export {
  executeDag,
  buildWaves,
  type DagExecutorOptions,
} from './dag-executor';

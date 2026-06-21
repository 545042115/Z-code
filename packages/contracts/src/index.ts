// @z-assistant/contracts
//
// Cross-package type contracts for the V2 Assistant Runtime.
//
// Consumers should import from this file rather than individual modules:
//
//   import { AgentRun, IAgent, Benchmark, ConfigSpec } from '@z-assistant/contracts';
//
// This makes the contract boundary explicit and lets us refactor internal
// modules without touching call sites.

export * from './run';
export * from './agent';
export * from './config';
export * from './eval';
export * from './planner';
export * from './tool';
export * from './verifier';
export * from './llm';
export * from './reflection';
export * from './context';
export * from './skill';
export * from './budget';
export * from './memory';
export * from './confirmation';

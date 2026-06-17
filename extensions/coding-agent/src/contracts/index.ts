// Contracts barrel — the single import surface for V2's shared types.
//
// Consumers should import from this file rather than individual modules:
//
//   import { AgentRun, IAgent, Benchmark, ConfigSpec } from '../contracts';
//
// This makes the contract boundary explicit and lets us refactor internal
// modules without touching call sites.

export * from './run';
export * from './agent';
export * from './eval';
export * from './config';

// @ziner/runtime
//
// V2 Assistant Runtime platform. Provides:
//
//   Mechanism layer (no business logic):
//     trace        — Span / Run / Metric
//     storage      — JSONL / SQLite / Vector Store
//     cost         — token cost computation
//     errors       — error classification
//     permission   — tool / fs / net guards
//     config       — config center
//     budget       — budget guard
//     orchestrator — multi-agent coordination
//
//   Framework layer (registers, no business logic):
//     planning     — Plan / Step / DAG model + dispatcher
//     reflection   — reflection engine framework
//     context      — context framework (budget + provider registry)
//     skills       — loader / selector / validator
//     evaluation   — EvalRunner + Benchmark interface
//     evolution    — Evolution engine framework
//     memory       — Long-Term Memory (Phase 7)
//
//   Placeholders (future phases):
//     workflow     — future Workflow Engine
//
// Phase 8: Computer Use (browser agent, GUI action, screen perception,
// computer-use permission) is wired in. Workflow remains a placeholder
// for future phases.

export const RUNTIME_VERSION = '0.1.0';

// Subpackage re-exports — single import surface for V2 consumers.
//
// V1 shims import from the *root* (`@ziner/runtime`) when they
// need framework bits. V2 Apps should prefer the subpackage paths
// (e.g. `@ziner/runtime/evaluation`) for clarity.

// Mechanism layer
export * from './orchestrator';
export * from './permission';
export * from './audit';

// Framework layer
export * from './action';
export * from './context';
export * from './evaluation';
export * from './evolution';
export * from './knowledge';
export * from './memory';
export * from './perception';
export * from './planning';
export * from './reflection';
export * from './skills';
export * from './api';


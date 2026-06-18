// @z-assistant/runtime
//
// V2 Assistant Runtime platform. Provides:
//
//   Mechanism layer (no business logic):
//     trace        — Span / Run / Metric
//     storage      — JSONL / SQLite
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
//
//   Placeholders (future phases):
//     workflow     — future Workflow Engine
//     memory       — future Long-Term Memory
//
// Phase 6A: the orchestrator subpackage is wired in. Other subpackages
// (planning / reflection / context / skills / evaluation / evolution)
// are wired in as of R5. Workflow and memory remain placeholders for
// future phases.

export const RUNTIME_VERSION = '0.1.0';

// Subpackage re-exports — single import surface for V2 consumers.
//
// V1 shims import from the *root* (`@z-assistant/runtime`) when they
// need framework bits. V2 Apps should prefer the subpackage paths
// (e.g. `@z-assistant/runtime/evaluation`) for clarity.

// Mechanism layer
export * from './orchestrator';

// Framework layer
export * from './context';
export * from './evaluation';
export * from './evolution';
export * from './planning';
export * from './reflection';
export * from './skills';

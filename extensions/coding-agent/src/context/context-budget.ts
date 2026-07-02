// V1 shim for context-budget — re-exports the V2 generic BudgetManager
// from @ziner/runtime. Per ADR 4.2, the framework part of the
// context module is owned by V2; Coding-specific context providers
// (retrieval / repo-map / context-builder / etc.) stay in V1.
export {
  BudgetManager,
  DEFAULT_BUDGET,
  type ContextSource,
  type ContextBudget,
  type ContextChunk,
  type BudgetAllocationResult,
  type BudgetTrimEntry,
} from '@ziner/runtime';

// @ziner/runtime — context
//
// Context budget framework (mechanism layer). Pure Node, no vscode.
//
// Future: register Coding/Browser/Research IContextProvider implementations
// here. For Phase 6A, only the BudgetManager + types are exported.

export {
  BudgetManager,
  DEFAULT_BUDGET,
  type ContextSource,
  type ContextBudget,
  type ContextChunk,
  type BudgetAllocationResult,
  type BudgetTrimEntry,
} from './context-budget';

export {
  MemoryContextProvider,
  type MemoryContextProviderOptions,
} from './memory-provider';

export {
  ContextCompressor,
  type CompressionOptions,
  type CompressionResult,
  type CompressionStrategy,
} from './compressor';

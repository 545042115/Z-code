// @z-assistant/infra-errors
//
// Cross-package error code registry + heuristic classifier. Used by
// `trace` (recording `ErrorRef` on failed Spans) and `evaluation`
// (aggregating failures by category).
//
// Consumers should import from this package rather than individual
// modules so the public surface stays centralized.

export * from './error-codes';
export * from './classifier';

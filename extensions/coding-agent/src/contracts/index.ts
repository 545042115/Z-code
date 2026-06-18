// V1 contracts shim — re-exports from V2 @z-assistant/contracts.
//
// MIGRATION (Phase 6A R3): V1 used to define its own contracts/ files.
// Those files have been moved to `packages/contracts/src/` (V2).
// This shim keeps the old `from '../contracts'` imports in V1 working.
//
// Once V1 stops using the barrel, this file can be deleted in R10.
export * from '@z-assistant/contracts';

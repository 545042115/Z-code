// @ziner/infra-storage
//
// Storage facade — single import surface for V2's persistence layer.
//
// Consumers should import from this file:
//
//   import { createFileStore, type Store } from '@ziner/infra-storage';
//
// Currently only `createFileStore` is exported. A future `createSqliteStore`
// will live alongside it without changing call sites.

export * from './types';
export { createFileStore, type FileStoreOptions, type Store } from './jsonl-store';

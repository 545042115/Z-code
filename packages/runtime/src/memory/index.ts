// @z-assistant/runtime — memory
//
// Cross-session Long-Term Memory framework. Provides:
//   - contracts-compliant `IMemoryProvider` (JsonlMemoryProvider)
//   - pluggable embedding provider + local fallback
//   - pluggable vector store + in-memory default
//   - six memory subsystems: short-term, long-term, episodic, semantic,
//     procedural, preferences
//   - recall, policy, shared-memory, and privacy helpers
//
// This replaces the Phase 6A placeholder. Agents create a `MemoryManager`
// at Run start and use the typed subsystems to remember/recall.

export type {
  IMemoryProvider,
  IEmbeddingProvider,
  MemoryRecord,
  MemoryKind,
  MemoryScope,
  MemoryQuery,
  MemoryHit,
  MemoryHitReason,
  MemoryListFilter,
  MemoryPurgeFilter,
  MemoryWritePolicy,
} from '@z-assistant/contracts';

export { createLocalEmbeddingProvider, type LocalEmbeddingOptions } from '../embedding';
export {
  createInMemoryVectorStore,
  InMemoryVectorStore,
  type IVectorStore,
  type VectorRecord,
  type VectorQuery,
  type VectorHit,
  type VectorPurgeFilter,
} from '../storage/vector-store';

export {
  JsonlMemoryProvider,
  createJsonlMemoryProvider,
  type JsonlMemoryProviderOptions,
} from './provider';

export { MemoryManager, type MemoryManagerOptions } from './memory-manager';

export { ShortTermMemory, type ShortTermTurn } from './short-term';
export { LongTermMemory, type LongTermFact } from './long-term';
export { EpisodicMemory, type Episode } from './episodic';
export { SemanticMemory, type SemanticConcept } from './semantic';
export { ProceduralMemory, type Procedure } from './procedural';
export { PreferencesMemory, type UserPreference } from './preferences';

export { recall, type RecallOptions } from './recall';
export { MemoryPolicy } from './policy';
export { SharedMemory, type SharedMemoryOptions } from './shared';
export { PrivacyManager, type PrivacyExport } from './privacy';

export {
  extractFacts,
  heuristicFactExtract,
  type FactType,
  type ExtractedFact,
  type FactExtractorOptions,
  type LLMFactExtractor,
} from './fact-extractor';

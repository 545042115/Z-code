// @z-assistant/runtime — semantic memory
//
// Concept-level "I know X" knowledge. Used for project glossaries,
// architecture facts, API behavior, and other structured knowledge
// that agents should retrieve by meaning rather than exact keyword.

import type { MemoryRecord, MemoryHit } from '@z-assistant/contracts';
import type { MemoryManager } from './memory-manager';

export interface SemanticConcept {
  /** Concept name / title. */
  concept: string;
  /** Description / definition. */
  description: string;
  /** Related concepts for graph-style traversal. */
  related?: string[];
  /** Optional source (file, url, doc id). */
  source?: string;
  runId?: string;
}

export class SemanticMemory {
  constructor(private readonly manager: MemoryManager) {}

  /** Store a concept in semantic memory. */
  async learn(concept: SemanticConcept, scope: 'project' | 'user' | 'global' = 'project'): Promise<MemoryRecord> {
    const content = `${concept.concept}: ${concept.description}`;
    return this.manager.remember(
      content,
      'semantic',
      scope,
      {
        payload: {
          concept: concept.concept,
          related: concept.related ?? [],
          source: concept.source,
        },
        importance: 0.8,
        runId: concept.runId,
      },
    );
  }

  /** Recall concepts related to the query. */
  async recall(query: string, limit = 10): Promise<MemoryHit[]> {
    return this.manager.recall(query, { kind: 'semantic', limit });
  }

  /** Find a concept by exact name. */
  async find(concept: string): Promise<MemoryRecord | undefined> {
    const all = await this.manager.list({ kind: 'semantic', limit: 1000 });
    return all.find((r) => (r.payload as { concept?: string })?.concept === concept);
  }
}

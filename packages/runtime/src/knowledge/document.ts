// @z-assistant/runtime — Document Knowledge
//
// Stores parsed / extracted information from documents (PDFs, specs,
// READMEs, API references). Each document is stored as a set of
// knowledge chunks with metadata about source, page, section, etc.
//
// Builds on IMemoryProvider (long-term, project- or user-scoped records).

import type { IMemoryProvider, MemoryQuery } from '@z-assistant/contracts';

export interface DocumentChunk {
  /** Chunk ID within the document. */
  chunkId: string;
  /** Document identifier (e.g. filename, URL, DOI). */
  documentId: string;
  /** Human-readable document title. */
  title: string;
  /** Content of this chunk. */
  content: string;
  /** Section or page reference. */
  section?: string;
  /** Start line / page number. */
  startOffset?: number;
  /** End line / page number. */
  endOffset?: number;
  /** Timestamp. */
  indexedAt: number;
}

export interface DocumentKnowledge {
  /** Document identifier. */
  documentId: string;
  /** Aggregated document-level metadata. */
  title: string;
  source: string;
  language?: string;
  /** Number of chunks. */
  chunkCount: number;
  /** When the document was first indexed. */
  indexedAt: number;
}

const DOC_PREFIX = 'knowledge:doc:';

export class DocumentKnowledgeBase {
  constructor(private readonly memory: IMemoryProvider) {}

  /** Index a document chunk. */
  async indexChunk(
    projectId: string,
    chunk: Omit<DocumentChunk, 'indexedAt'>,
  ): Promise<string> {
    const id = `${DOC_PREFIX}${chunk.documentId}:${chunk.chunkId}`;
    const record: DocumentChunk = { ...chunk, indexedAt: Date.now() };
    await this.memory.store({
      id,
      content: chunk.content,
      kind: 'semantic',
      scope: 'project',
      userId: '',
      sessionId: '',
      agentName: '',
      projectId,
      payload: { docChunk: record } as unknown as Record<string, unknown>,
      createdAt: Date.now(),
    });
    return id;
  }

  /** Search document chunks by query. */
  async search(
    projectId: string,
    query: string,
    documentId?: string,
  ): Promise<DocumentChunk[]> {
    const q: MemoryQuery = {
      query,
      kind: 'semantic',
      scope: 'project',
      projectId,
      limit: 30,
    };
    const hits = await this.memory.recall(q);
    let results = hits
      .map((h) => (h.memory.payload as { docChunk?: DocumentChunk })?.docChunk)
      .filter((c): c is DocumentChunk => !!c);
    if (documentId) results = results.filter((c) => c.documentId === documentId);
    return results;
  }

  /** Get all chunks for a document. */
  async getDocument(projectId: string, documentId: string): Promise<DocumentChunk[]> {
    const records = await this.memory.list({
      kind: 'semantic',
      scope: 'project',
      projectId,
      limit: 1000,
    });
    return records
      .map((r) => (r.payload as { docChunk?: DocumentChunk })?.docChunk)
      .filter((c): c is DocumentChunk => !!c && c.documentId === documentId)
      .sort((a, b) => (a.startOffset ?? 0) - (b.startOffset ?? 0));
  }

  /** Remove a document (all its chunks). */
  async removeDocument(projectId: string, documentId: string): Promise<number> {
    const chunks = await this.getDocument(projectId, documentId);
    let removed = 0;
    for (const c of chunks) {
      const id = `${DOC_PREFIX}${c.documentId}:${c.chunkId}`;
      const ok = await this.memory.delete(id);
      if (ok) removed++;
    }
    return removed;
  }
}

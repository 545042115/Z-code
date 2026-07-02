// @ziner/runtime — Project Knowledge
//
// Stores and retrieves project-level knowledge: repo structure,
// coding conventions, dependency patterns, build rules, and
// domain-specific context.
//
// Builds on IMemoryProvider (long-term, project-scoped records).

import type { IMemoryProvider, MemoryQuery } from '@ziner/contracts';

export interface ProjectKnowledge {
  /** Unique key within the project (e.g. "build-system", "testing-convention"). */
  key: string;
  /** Natural-language description of the knowledge. */
  description: string;
  /** Structured payload. */
  payload: Record<string, unknown>;
  /** Tags for categorization. */
  tags: string[];
  /** When this knowledge was collected. */
  learnedAt: number;
  /** Confidence 0-1. Higher = more trusted. */
  confidence: number;
}

const KNOWLEDGE_PREFIX = 'knowledge:project:';

export class ProjectKnowledgeBase {
  constructor(private readonly memory: IMemoryProvider) {}

  /** Learn a piece of project knowledge. */
  async learn(projectId: string, knowledge: Omit<ProjectKnowledge, 'learnedAt'>): Promise<string> {
    const id = `${KNOWLEDGE_PREFIX}${projectId}:${knowledge.key}`;
    const record: ProjectKnowledge = { ...knowledge, learnedAt: Date.now() };
    await this.memory.store({
      id,
      content: `[${knowledge.key}] ${knowledge.description}`,
      kind: 'semantic',
      scope: 'project',
      userId: '',
      sessionId: '',
      agentName: '',
      projectId,
      payload: { knowledge: record } as unknown as Record<string, unknown>,
      createdAt: Date.now(),
    });
    return id;
  }

  /** Retrieve project knowledge by key. */
  async get(projectId: string, key: string): Promise<ProjectKnowledge | undefined> {
    const id = `${KNOWLEDGE_PREFIX}${projectId}:${key}`;
    const record = await this.memory.get(id);
    if (!record) return undefined;
    return (record.payload as { knowledge?: ProjectKnowledge })?.knowledge;
  }

  /** Search project knowledge by query text. */
  async search(projectId: string, query: string): Promise<ProjectKnowledge[]> {
    const q: MemoryQuery = {
      query,
      kind: 'semantic',
      scope: 'project',
      projectId,
      limit: 20,
    };
    const hits = await this.memory.recall(q);
    return hits
      .map((h) => (h.memory.payload as { knowledge?: ProjectKnowledge })?.knowledge)
      .filter((k): k is ProjectKnowledge => !!k);
  }

  /** List all knowledge for a project. */
  async list(projectId: string): Promise<ProjectKnowledge[]> {
    const records = await this.memory.list({
      kind: 'semantic',
      scope: 'project',
      projectId,
      limit: 500,
    });
    return records
      .map((r) => (r.payload as { knowledge?: ProjectKnowledge })?.knowledge)
      .filter((k): k is ProjectKnowledge => !!k);
  }

  /** Remove a specific knowledge entry. */
  async forget(projectId: string, key: string): Promise<boolean> {
    const id = `${KNOWLEDGE_PREFIX}${projectId}:${key}`;
    return this.memory.delete(id);
  }
}

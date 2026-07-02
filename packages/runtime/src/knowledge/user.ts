// @ziner/runtime — User Knowledge
//
// Stores user-level knowledge: expertise, preferences, skill level,
// common workflows, and personal conventions.
//
// Builds on IMemoryProvider (long-term, user-scoped records).

import type { IMemoryProvider, MemoryQuery } from '@ziner/contracts';

export interface UserKnowledge {
  /** Knowledge key (e.g. "preferred-language", "expertise-area"). */
  key: string;
  /** Natural-language description. */
  description: string;
  /** Structured payload. */
  payload: Record<string, unknown>;
  /** Category for organization. */
  category: 'expertise' | 'preference' | 'workflow' | 'convention' | 'history';
  /** Confidence 0-1. */
  confidence: number;
  /** When learned. */
  learnedAt: number;
}

const KNOWLEDGE_PREFIX = 'knowledge:user:';

export class UserKnowledgeBase {
  constructor(private readonly memory: IMemoryProvider) {}

  /** Learn a piece of user knowledge. */
  async learn(
    userId: string,
    knowledge: Omit<UserKnowledge, 'learnedAt'>,
  ): Promise<string> {
    const id = `${KNOWLEDGE_PREFIX}${userId}:${knowledge.category}:${knowledge.key}`;
    const record: UserKnowledge = { ...knowledge, learnedAt: Date.now() };
    await this.memory.store({
      id,
      content: `[${knowledge.category}] ${knowledge.key}: ${knowledge.description}`,
      kind: 'preference',
      scope: 'user',
      userId,
      sessionId: '',
      agentName: '',
      projectId: '',
      payload: { userKnowledge: record } as unknown as Record<string, unknown>,
      createdAt: Date.now(),
    });
    return id;
  }

  /** Retrieve user knowledge by key and category. */
  async get(userId: string, category: string, key: string): Promise<UserKnowledge | undefined> {
    const id = `${KNOWLEDGE_PREFIX}${userId}:${category}:${key}`;
    const record = await this.memory.get(id);
    if (!record) return undefined;
    return (record.payload as { userKnowledge?: UserKnowledge })?.userKnowledge;
  }

  /** Search user knowledge by query. */
  async search(userId: string, query: string, category?: string): Promise<UserKnowledge[]> {
    const q: MemoryQuery = {
      query,
      kind: 'preference',
      scope: 'user',
      userId,
      limit: 20,
    };
    const hits = await this.memory.recall(q);
    let results = hits
      .map((h) => (h.memory.payload as { userKnowledge?: UserKnowledge })?.userKnowledge)
      .filter((k): k is UserKnowledge => !!k);
    if (category) results = results.filter((k) => k.category === category);
    return results;
  }

  /** List all knowledge for a user, optionally filtered by category. */
  async list(userId: string, category?: string): Promise<UserKnowledge[]> {
    const records = await this.memory.list({
      kind: 'preference',
      scope: 'user',
      userId,
      limit: 500,
    });
    let results = records
      .map((r) => (r.payload as { userKnowledge?: UserKnowledge })?.userKnowledge)
      .filter((k): k is UserKnowledge => !!k);
    if (category) results = results.filter((k) => k.category === category);
    return results.sort((a, b) => b.confidence - a.confidence);
  }

  /** Remove user knowledge. */
  async forget(userId: string, category: string, key: string): Promise<boolean> {
    const id = `${KNOWLEDGE_PREFIX}${userId}:${category}:${key}`;
    return this.memory.delete(id);
  }
}

// @z-assistant/runtime — episodic memory
//
// Task-level "I did X on project Y" memories. Episodes are great for
// few-shot retrieval: when the user asks something similar to a past
// task, recall the episode and use it as an example.

import type { MemoryRecord, MemoryHit } from '@z-assistant/contracts';
import type { MemoryManager } from './memory-manager';

export interface Episode {
  /** One-line summary of the task. */
  task: string;
  /** Detailed description of what happened. */
  story: string;
  /** Outcome: success, failure, partial. */
  outcome?: 'success' | 'failure' | 'partial';
  /** Tags for filtering. */
  tags?: string[];
  runId?: string;
}

export class EpisodicMemory {
  constructor(private readonly manager: MemoryManager) {}

  /** Record a completed task as an episode. */
  async record(episode: Episode): Promise<MemoryRecord> {
    const content = `${episode.task}\n${episode.story}`;
    return this.manager.remember(
      content,
      'episodic',
      'user',
      {
        payload: {
          task: episode.task,
          outcome: episode.outcome ?? 'success',
          tags: episode.tags ?? [],
        },
        importance: episode.outcome === 'failure' ? 0.9 : 0.7,
        runId: episode.runId,
      },
    );
  }

  /** Retrieve similar past episodes for few-shot prompting. */
  async recallSimilar(task: string, limit = 5): Promise<MemoryHit[]> {
    return this.manager.recall(task, { kind: 'episodic', limit });
  }

  /** List recent episodes, optionally filtered by outcome. */
  async list(outcome?: 'success' | 'failure' | 'partial', limit = 50): Promise<MemoryRecord[]> {
    const all = await this.manager.list({ kind: 'episodic', limit });
    if (!outcome) return all;
    return all.filter((r) => (r.payload as { outcome?: string })?.outcome === outcome);
  }
}

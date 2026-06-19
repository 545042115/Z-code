// @z-assistant/runtime — short-term memory
//
// Current-session conversation history. Agents call `addTurn` after each
// user / assistant exchange so downstream reasoning has access to the
// recent conversation. Short-term memories are scoped to the session by
// default and are typically pruned after the session ends.

import type { MemoryRecord, MemoryHit } from '@z-assistant/contracts';
import type { MemoryManager } from './memory-manager';

export interface ShortTermTurn {
  role: 'user' | 'assistant' | 'system';
  content: string;
  /** Optional run id for provenance. */
  runId?: string;
}

export class ShortTermMemory {
  constructor(private readonly manager: MemoryManager) {}

  /** Record a single conversation turn. */
  async addTurn(turn: ShortTermTurn): Promise<MemoryRecord> {
    return this.manager.remember(
      `[${turn.role}] ${turn.content}`,
      'short-term',
      'session',
      { runId: turn.runId },
    );
  }

  /** Record both user and assistant messages at once. */
  async addExchange(user: string, assistant: string, runId?: string): Promise<MemoryRecord[]> {
    const u = await this.addTurn({ role: 'user', content: user, runId });
    const a = await this.addTurn({ role: 'assistant', content: assistant, runId });
    return [u, a];
  }

  /** Retrieve the most recent N turns of the current session. */
  async recent(limit = 20): Promise<MemoryRecord[]> {
    return this.manager.list({
      kind: 'short-term',
      scope: 'session',
      sessionId: this.manager.sessionId,
      limit,
    });
  }

  /** Search conversation history for relevant turns. */
  async recall(query: string, limit = 10): Promise<MemoryHit[]> {
    return this.manager.recall(query, {
      kind: 'short-term',
      scope: 'session',
      sessionId: this.manager.sessionId,
      limit,
    });
  }
}

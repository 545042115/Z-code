// @ziner/runtime — short-term memory
//
// Current-session conversation history. Agents call `addTurn` after each
// user / assistant exchange so downstream reasoning has access to the
// recent conversation. Short-term memories are scoped to the session by
// default and are typically pruned after the session ends.
//
// Sliding-window compression: when the conversation grows beyond a
// threshold, older turns can be summarised into a single "summary"
// memory, freeing token budget for recent exchanges while preserving
// the gist of earlier context.

import type { MemoryRecord, MemoryHit } from '@ziner/contracts';
import type { MemoryManager } from './memory-manager';

export interface ShortTermTurn {
  role: 'user' | 'assistant' | 'system';
  content: string;
  /** Optional run id for provenance. */
  runId?: string;
}

export interface ShortTermCompressionResult {
  /** Number of turns that were summarised. */
  summarisedTurns: number;
  /** The newly created summary record. */
  summary: MemoryRecord;
  /** Records that were removed (archived) from short-term. */
  removed: MemoryRecord[];
}

/**
 * Function that produces a summary from a list of conversation turns.
 * Typically implemented by an LLM call, but can be stubbed for tests.
 */
export type ConversationSummarizer = (turns: ShortTermTurn[]) => Promise<string>;

export class ShortTermMemory {
  /** Threshold (in turns) before compression is considered. Default 40. */
  compressionThreshold = 40;
  /** Fraction of old turns to compress each time. Default 0.5. */
  compressionRatio = 0.5;

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
    // Ensure a strictly increasing createdAt so list() (sorted desc by
    // createdAt) reliably returns the assistant turn first. Without
    // this, two addTurn calls in the same millisecond would tie and
    // the sort order would depend on Map iteration semantics.
    const a = await this.addTurn({ role: 'assistant', content: assistant, runId });
    if (a.createdAt <= u.createdAt) {
      a.createdAt = u.createdAt + 1;
    }
    return [u, a];
  }

  /**
   * Retrieve the most recent N turns of the current session.
   * Includes the rolling summary (if any) as the oldest entry.
   */
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

  /**
   * Compress older turns into a rolling summary.
   * Only runs if the turn count exceeds `compressionThreshold`.
   *
   * Algorithm:
   * 1. Fetch all short-term turns
   * 2. If count < threshold, do nothing
   * 3. Take the oldest `compressionRatio` turns (excluding existing
   *    summary entries)
   * 4. Pass them to the summarizer
   * 5. Replace the old summary (if any) with a new combined one
   * 6. Delete (or mark archived) the compressed raw turns
   *
   * @returns CompressionResult if compression happened, null otherwise.
   */
  async compress(summarizer: ConversationSummarizer): Promise<ShortTermCompressionResult | null> {
    const allTurns = await this.manager.list({
      kind: 'short-term',
      scope: 'session',
      sessionId: this.manager.sessionId,
      limit: 500,
    });

    if (allTurns.length < this.compressionThreshold) return null;

    // Separate existing summary from raw turns
    const existingSummaries: MemoryRecord[] = [];
    const rawTurns: MemoryRecord[] = [];
    for (const rec of allTurns) {
      const payloadTags = (rec.payload as Record<string, unknown> | undefined)?.tags;
      const tags = Array.isArray(payloadTags) ? payloadTags : [];
      if (tags.includes('summary')) {
        existingSummaries.push(rec);
      } else {
        rawTurns.push(rec);
      }
    }

    if (rawTurns.length === 0) return null;

    // Sort ascending (oldest first) to pick the oldest for compression
    const sorted = [...rawTurns].sort((a, b) => a.createdAt - b.createdAt);

    // Determine how many to compress
    const toCompressCount = Math.max(
      2,
      Math.floor(sorted.length * this.compressionRatio),
    );
    const toCompress = sorted.slice(0, toCompressCount);

    // Convert to ShortTermTurn format for the summarizer
    const turnsForSummary: ShortTermTurn[] = [];
    for (const rec of toCompress) {
      const match = rec.content.match(/^\[(user|assistant|system)\]\s*(.*)$/s);
      if (match) {
        turnsForSummary.push({
          role: match[1] as 'user' | 'assistant' | 'system',
          content: match[2],
        });
      } else {
        turnsForSummary.push({ role: 'system', content: rec.content });
      }
    }

    // If there's an existing summary, prepend it to the context
    if (existingSummaries.length > 0) {
      const prevSummary = existingSummaries[0].content;
      turnsForSummary.unshift({
        role: 'system',
        content: `Previous conversation summary: ${prevSummary}`,
      });
    }

    // Generate summary
    const summaryText = await summarizer(turnsForSummary);

    // Delete old summaries and compressed turns
    const toDelete = [...existingSummaries, ...toCompress];
    for (const rec of toDelete) {
      try {
        await this.manager.forget(rec.id);
      } catch {
        // best-effort
      }
    }

    // Store new summary
    const summaryRecord = await this.manager.remember(
      summaryText,
      'short-term',
      'session',
      {
        importance: 0.6,
        payload: {
          tags: ['summary', 'compressed'],
          summarisedTurns: toCompress.length,
          previousSummaryCount: existingSummaries.length,
        },
      },
    );

    return {
      summarisedTurns: toCompress.length,
      summary: summaryRecord,
      removed: toDelete,
    };
  }
}

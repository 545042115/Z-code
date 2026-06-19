// @z-assistant/runtime — privacy
//
// User data control: view, delete, and export memories. Implements the
// GDPR-style "right to be forgotten" on top of `IMemoryProvider.purge`.

import type { MemoryRecord, MemoryKind, MemoryScope } from '@z-assistant/contracts';
import type { MemoryManager } from './memory-manager';

export interface PrivacyExport {
  userId: string;
  exportedAt: number;
  memories: MemoryRecord[];
}

export class PrivacyManager {
  constructor(private readonly manager: MemoryManager) {}

  /** List all memories visible to the current user (excluding deleted). */
  async view(userId: string, opts?: { kind?: MemoryKind; scope?: MemoryScope; limit?: number }): Promise<MemoryRecord[]> {
    return this.manager.list({
      userId,
      kind: opts?.kind,
      scope: opts?.scope,
      limit: opts?.limit ?? 1000,
    });
  }

  /** Delete a single memory by id. */
  async deleteMemory(id: string): Promise<boolean> {
    return this.manager.forget(id);
  }

  /**
   * Purge all memories for a user. This is the "forget me" operation.
   * Returns the number of memories purged.
   */
  async purgeUser(userId: string): Promise<number> {
    return this.manager.purge({ userId });
  }

  /** Purge memories for a specific session. */
  async purgeSession(userId: string, sessionId: string): Promise<number> {
    return this.manager.purge({ userId, sessionId });
  }

  /** Export all memories for a user as a portable JSON object. */
  async exportUser(userId: string): Promise<PrivacyExport> {
    const memories = await this.view(userId, { limit: 10000 });
    return { userId, exportedAt: Date.now(), memories };
  }
}

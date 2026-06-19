// @z-assistant/runtime — preferences memory
//
// User preference learning: language style, framework choices, review
// habits, output format, etc. Preferences are scoped to the user by
// default and retrieved at the start of a session to personalize behavior.

import type { MemoryRecord, MemoryHit } from '@z-assistant/contracts';
import type { MemoryManager } from './memory-manager';

export interface UserPreference {
  /** Preference key, e.g. "language" or "testFramework". */
  key: string;
  /** Preference value, e.g. "TypeScript" or "vitest". */
  value: string;
  /** Human-readable sentence describing the preference. */
  statement: string;
  /** Confidence in [0, 1]. */
  confidence?: number;
  runId?: string;
}

export class PreferencesMemory {
  constructor(private readonly manager: MemoryManager) {}

  /** Record a user preference. */
  async learn(pref: UserPreference): Promise<MemoryRecord> {
    return this.manager.remember(
      pref.statement,
      'preference',
      'user',
      {
        payload: {
          key: pref.key,
          value: pref.value,
          confidence: pref.confidence ?? 0.8,
        },
        importance: pref.confidence ?? 0.8,
        runId: pref.runId,
      },
    );
  }

  /** Get preference by key. */
  async get(key: string): Promise<MemoryRecord | undefined> {
    const all = await this.manager.list({ kind: 'preference', scope: 'user', limit: 1000 });
    return all.find((r) => (r.payload as { key?: string })?.key === key);
  }

  /** Recall preferences relevant to the current task. */
  async recall(query: string, limit = 10): Promise<MemoryHit[]> {
    return this.manager.recall(query, { kind: 'preference', scope: 'user', limit });
  }

  /** Export all preferences for the current user. */
  async export(): Promise<MemoryRecord[]> {
    return this.manager.list({ kind: 'preference', scope: 'user', limit: 1000 });
  }
}

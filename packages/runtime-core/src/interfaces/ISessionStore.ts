// ISessionStore — chat session storage abstraction.
// Desktop: backed by JSON file (session-manager.ts).
// Mobile: backed by IndexedDB.

import type { ChatMessage, SessionSummary, SessionDetail, SessionSearchOptions } from '@ziner/contracts';

export interface ISessionStore {
  /** Create a new session. */
  create(title?: string): Promise<SessionDetail>;
  /** Save (update) a session. */
  save(session: SessionDetail): Promise<void>;
  /** Load a session by id. */
  load(id: string): Promise<SessionDetail | undefined>;
  /** List all sessions (as summaries). */
  list(options?: SessionSearchOptions): Promise<SessionSummary[]>;
  /** Delete a session by id. */
  delete(id: string): Promise<boolean>;
  /** Append a message to a session. */
  appendMessage(sessionId: string, message: ChatMessage): Promise<void>;
  /** Close the store. */
  close(): Promise<void>;
}

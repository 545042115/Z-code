// @z-assistant/agent-browser — Browser Session persistence
//
// Cookie / session management. Stores and restores browser sessions
// so the agent can maintain login state across runs.

import type { Cookie, PageSnapshot } from './backend';
import type { IMemoryProvider } from '@z-assistant/contracts';

export interface BrowserSession {
  id: string;
  /** Human-readable label for the session. */
  label: string;
  /** Current URL when the session was saved. */
  url: string;
  /** Cookies to restore. */
  cookies: Cookie[];
  /** LocalStorage key/value pairs. */
  localStorage: Record<string, string>;
  /** Timestamp. */
  savedAt: number;
  /** Tags for search. */
  tags: string[];
}

const SESSION_PREFIX = 'browser-session:';

/**
 * Save the current browser page state (cookies + localStorage + URL)
 * to a memory-backed session record.
 */
export async function saveSession(
  memory: IMemoryProvider,
  snapshot: PageSnapshot,
  cookies: Cookie[],
  label: string,
  tags: string[] = [],
): Promise<BrowserSession> {
  const session: BrowserSession = {
    id: `${SESSION_PREFIX}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    label,
    url: snapshot.url,
    cookies,
    localStorage: {}, // extracted during snapshot if available
    savedAt: Date.now(),
    tags,
  };

  // Store in memory as a long-term, agent-scoped record
  await memory.store({
    id: session.id,
    content: `Browser session: ${label}\nURL: ${snapshot.url}\nCookies: ${cookies.length}`,
    kind: 'long-term',
    scope: 'agent',
    userId: '',
    agentName: 'browser-agent',
    payload: { session } as unknown as Record<string, unknown>,
    createdAt: Date.now(),
  });

  return session;
}

/**
 * Load a previously saved browser session from memory.
 */
export async function loadSession(
  memory: IMemoryProvider,
  sessionId: string,
): Promise<BrowserSession | undefined> {
  const record = await memory.get(sessionId);
  if (!record) return undefined;
  return (record.payload as { session?: BrowserSession })?.session;
}

/**
 * List all saved browser sessions.
 */
export async function listSessions(memory: IMemoryProvider): Promise<BrowserSession[]> {
  const records = await memory.list({ kind: 'long-term', agentName: 'browser-agent', limit: 100 });
  const sessions: BrowserSession[] = [];
  for (const r of records) {
    if (r.id.startsWith(SESSION_PREFIX)) {
      const s = (r.payload as { session?: BrowserSession })?.session;
      if (s) sessions.push(s);
    }
  }
  return sessions.sort((a, b) => b.savedAt - a.savedAt);
}

/**
 * Delete a saved browser session.
 */
export async function deleteSession(memory: IMemoryProvider, sessionId: string): Promise<boolean> {
  return memory.delete(sessionId);
}

// @ziner/app-desktop — Session Manager
//
// Manages chat sessions on disk. Each session stores its full
// conversation history so the user can switch between multiple
// conversations without losing context.
//
// Features:
//   - CRUD operations
//   - Full-text search across sessions
//   - Archive / unarchive
//   - Rename
//   - Tagging
//   - Auto-title from first message

import * as fs from 'fs';
import * as path from 'path';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export interface ChatSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
  /** Optional tags for categorising sessions. */
  tags?: string[];
  /** True if the session is archived (hidden from default list). */
  archived?: boolean;
  /** Number of times this session was opened. */
  accessCount?: number;
  /** Optional short summary for search previews. */
  summary?: string;
}

export interface SessionSearchOptions {
  /** Search query (matches title, messages, tags). */
  query?: string;
  /** Include archived sessions. Default false. */
  includeArchived?: boolean;
  /** Only return sessions with these tags. */
  tags?: string[];
  /** Max results. Default 50. */
  limit?: number;
  /** Sort order. Default 'recent'. */
  sort?: 'recent' | 'oldest' | 'alphabetical';
}

export class SessionManager {
  private filePath: string;
  private sessions: ChatSession[] = [];
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly SAVE_DEBOUNCE_MS = 200;

  constructor(sessionsDir: string) {
    this.filePath = path.join(sessionsDir, 'sessions.json');
    this.load();
  }

  // ── Persistence ──────────────────────────────────────────────────────

  private load(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        this.sessions = JSON.parse(raw);
      }
    } catch {
      this.sessions = [];
    }
    if (!Array.isArray(this.sessions)) this.sessions = [];
  }

  private save(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => {
      this.flushSave();
    }, SessionManager.SAVE_DEBOUNCE_MS);
  }

  private flushSave(): void {
    this.saveTimer = null;
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.sessions, null, 2), 'utf-8');
    } catch (e) {
      console.error('[SessionManager] save error:', e);
    }
  }

  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.flushSave();
    }
  }

  // ── CRUD ─────────────────────────────────────────────────────────────

  /** List all sessions (most recent first), excluding archived by default. */
  list(opts?: { includeArchived?: boolean }): ChatSession[] {
    let result = [...this.sessions];
    if (!opts?.includeArchived) {
      result = result.filter((s) => !s.archived);
    }
    return result.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Get a session by id. */
  get(id: string): ChatSession | undefined {
    const session = this.sessions.find((s) => s.id === id);
    if (session) {
      session.accessCount = (session.accessCount ?? 0) + 1;
      this.save();
    }
    return session;
  }

  /** Create a new empty session. */
  create(opts?: { title?: string; tags?: string[] }): ChatSession {
    const now = Date.now();
    const session: ChatSession = {
      id: `session_${now}_${Math.random().toString(36).slice(2, 8)}`,
      title: opts?.title?.trim() || 'New Chat',
      createdAt: now,
      updatedAt: now,
      messages: [],
      tags: opts?.tags,
      accessCount: 0,
    };
    this.sessions.push(session);
    this.save();
    return session;
  }

  /** Delete a session by id. */
  delete(id: string): boolean {
    const idx = this.sessions.findIndex((s) => s.id === id);
    if (idx === -1) return false;
    this.sessions.splice(idx, 1);
    this.save();
    return true;
  }

  /** Rename a session. */
  rename(id: string, title: string): ChatSession | undefined {
    const session = this.sessions.find((s) => s.id === id);
    if (!session) return undefined;
    session.title = title.trim() || 'Untitled';
    session.updatedAt = Date.now();
    this.save();
    return session;
  }

  /** Archive a session (hides it from the default list). */
  archive(id: string): ChatSession | undefined {
    return this._setArchived(id, true);
  }

  /** Unarchive a session. */
  unarchive(id: string): ChatSession | undefined {
    return this._setArchived(id, false);
  }

  private _setArchived(id: string, archived: boolean): ChatSession | undefined {
    const session = this.sessions.find((s) => s.id === id);
    if (!session) return undefined;
    session.archived = archived;
    session.updatedAt = Date.now();
    this.save();
    return session;
  }

  /** Add or remove tags on a session. */
  setTags(id: string, tags: string[]): ChatSession | undefined {
    const session = this.sessions.find((s) => s.id === id);
    if (!session) return undefined;
    session.tags = [...new Set(tags.map((t) => t.trim()).filter((t) => t.length > 0))];
    session.updatedAt = Date.now();
    this.save();
    return session;
  }

  /** Append a message to a session and update its title if it's the first user message. */
  appendMessage(sessionId: string, msg: ChatMessage): ChatSession | undefined {
    const session = this.sessions.find((s) => s.id === sessionId);
    if (!session) return undefined;

    session.messages.push(msg);
    session.updatedAt = Date.now();

    // Auto-title: use the first user message as the title
    if (msg.role === 'user' && session.title === 'New Chat') {
      session.title = msg.content.slice(0, 60) + (msg.content.length > 60 ? '…' : '');
    }

    // Auto-summary: update a short preview from the last few messages
    if (session.messages.length % 10 === 0) {
      const lastMsgs = session.messages.slice(-5).map((m) => m.content.slice(0, 100));
      session.summary = lastMsgs.join(' | ');
    }

    this.save();
    return session;
  }

  // ── Search ───────────────────────────────────────────────────────────

  /**
   * Search sessions by query, tags, and other filters.
   * Returns sessions ranked by relevance.
   */
  search(opts: SessionSearchOptions = {}): ChatSession[] {
    const {
      query,
      includeArchived = false,
      tags,
      limit = 50,
      sort = 'recent',
    } = opts;

    let results = [...this.sessions];

    // Filter by archived
    if (!includeArchived) {
      results = results.filter((s) => !s.archived);
    }

    // Filter by tags
    if (tags && tags.length > 0) {
      results = results.filter((s) =>
        s.tags?.some((t) => tags.includes(t)),
      );
    }

    // Full-text search
    if (query && query.trim().length > 0) {
      const q = query.toLowerCase().trim();
      const scored = results.map((s) => ({
        session: s,
        score: this._relevanceScore(s, q),
      }));
      results = scored
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score)
        .map((r) => r.session);
    } else if (sort === 'recent') {
      results.sort((a, b) => b.updatedAt - a.updatedAt);
    } else if (sort === 'oldest') {
      results.sort((a, b) => a.createdAt - b.createdAt);
    } else if (sort === 'alphabetical') {
      results.sort((a, b) => a.title.localeCompare(b.title));
    }

    return results.slice(0, limit);
  }

  private _relevanceScore(session: ChatSession, query: string): number {
    let score = 0;
    const q = query.toLowerCase();

    // Title match (highest weight)
    const titleLower = session.title.toLowerCase();
    if (titleLower.includes(q)) {
      score += 10;
      // Bonus for exact title match
      if (titleLower === q) score += 5;
    }

    // Tag match
    if (session.tags?.some((t) => t.toLowerCase().includes(q))) {
      score += 5;
    }

    // Message content match
    const msgMatches = session.messages.filter((m) =>
      m.content.toLowerCase().includes(q),
    ).length;
    score += Math.min(msgMatches, 5);

    // Bonus for recency
    const ageDays = (Date.now() - session.updatedAt) / (1000 * 60 * 60 * 24);
    if (ageDays < 1) score += 2;
    else if (ageDays < 7) score += 1;

    return score;
  }

  // ── Stats ────────────────────────────────────────────────────────────

  /** Get total session count. */
  count(opts?: { includeArchived?: boolean }): number {
    if (opts?.includeArchived) return this.sessions.length;
    return this.sessions.filter((s) => !s.archived).length;
  }

  /** Get total message count across all sessions. */
  totalMessages(): number {
    return this.sessions.reduce((sum, s) => sum + s.messages.length, 0);
  }

  /** Get all unique tags used across sessions. */
  allTags(): string[] {
    const tags = new Set<string>();
    for (const s of this.sessions) {
      s.tags?.forEach((t) => tags.add(t));
    }
    return [...tags].sort();
  }
}

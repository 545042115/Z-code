export interface MobileChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export interface MobileChatSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: MobileChatMessage[];
  tags?: string[];
  archived?: boolean;
  accessCount?: number;
  summary?: string;
}

export interface MobileSessionSearchOptions {
  query?: string;
  includeArchived?: boolean;
  tags?: string[];
  limit?: number;
  sort?: 'recent' | 'oldest' | 'alphabetical';
}

export interface MobileSessionManagerOptions {
  storageKey?: string;
}

const DEFAULT_STORAGE_KEY = 'ziner.sessions.v1';

export class MobileSessionManager {
  private storageKey: string;
  private sessions: MobileChatSession[] = [];
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly SAVE_DEBOUNCE_MS = 200;

  constructor(options: MobileSessionManagerOptions = {}) {
    this.storageKey = options.storageKey ?? DEFAULT_STORAGE_KEY;
    this.load();
  }

  private load(): void {
    if (typeof localStorage === 'undefined') return;
    try {
      const raw = localStorage.getItem(this.storageKey);
      if (raw) {
        const parsed = JSON.parse(raw);
        this.sessions = Array.isArray(parsed) ? parsed : [];
      }
    } catch {
      this.sessions = [];
    }
  }

  private save(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => {
      this.flushSave();
    }, MobileSessionManager.SAVE_DEBOUNCE_MS);
  }

  private flushSave(): void {
    this.saveTimer = null;
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(this.sessions));
    } catch (e) {
      console.error('[MobileSessionManager] save error:', e);
    }
  }

  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.flushSave();
    }
  }

  list(opts?: { includeArchived?: boolean }): MobileChatSession[] {
    let result = [...this.sessions];
    if (!opts?.includeArchived) {
      result = result.filter((s) => !s.archived);
    }
    return result.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string): MobileChatSession | undefined {
    const session = this.sessions.find((s) => s.id === id);
    if (session) {
      session.accessCount = (session.accessCount ?? 0) + 1;
      this.save();
    }
    return session;
  }

  create(opts?: { title?: string; tags?: string[] }): MobileChatSession {
    const now = Date.now();
    const session: MobileChatSession = {
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

  delete(id: string): boolean {
    const idx = this.sessions.findIndex((s) => s.id === id);
    if (idx === -1) return false;
    this.sessions.splice(idx, 1);
    this.save();
    return true;
  }

  rename(id: string, title: string): MobileChatSession | undefined {
    const session = this.sessions.find((s) => s.id === id);
    if (!session) return undefined;
    session.title = title.trim() || 'Untitled';
    session.updatedAt = Date.now();
    this.save();
    return session;
  }

  archive(id: string): MobileChatSession | undefined {
    return this.setArchived(id, true);
  }

  unarchive(id: string): MobileChatSession | undefined {
    return this.setArchived(id, false);
  }

  private setArchived(id: string, archived: boolean): MobileChatSession | undefined {
    const session = this.sessions.find((s) => s.id === id);
    if (!session) return undefined;
    session.archived = archived;
    session.updatedAt = Date.now();
    this.save();
    return session;
  }

  setTags(id: string, tags: string[]): MobileChatSession | undefined {
    const session = this.sessions.find((s) => s.id === id);
    if (!session) return undefined;
    session.tags = [...new Set(tags.map((t) => t.trim()).filter((t) => t.length > 0))];
    session.updatedAt = Date.now();
    this.save();
    return session;
  }

  appendMessage(sessionId: string, msg: MobileChatMessage): MobileChatSession | undefined {
    const session = this.sessions.find((s) => s.id === sessionId);
    if (!session) return undefined;

    session.messages.push(msg);
    session.updatedAt = Date.now();

    if (msg.role === 'user' && session.title === 'New Chat') {
      session.title = msg.content.slice(0, 60) + (msg.content.length > 60 ? '…' : '');
    }

    if (session.messages.length % 10 === 0) {
      const lastMsgs = session.messages.slice(-5).map((m) => m.content.slice(0, 100));
      session.summary = lastMsgs.join(' | ');
    }

    this.save();
    return session;
  }

  search(opts: MobileSessionSearchOptions = {}): MobileChatSession[] {
    const { query, includeArchived = false, tags, limit = 50, sort = 'recent' } = opts;
    let results = [...this.sessions];

    if (!includeArchived) {
      results = results.filter((s) => !s.archived);
    }

    if (tags && tags.length > 0) {
      results = results.filter((s) => s.tags?.some((t) => tags.includes(t)));
    }

    if (query && query.trim().length > 0) {
      const q = query.toLowerCase().trim();
      const scored = results.map((s) => ({ session: s, score: this.relevanceScore(s, q) }));
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

  private relevanceScore(session: MobileChatSession, query: string): number {
    let score = 0;
    const titleLower = session.title.toLowerCase();
    if (titleLower.includes(query)) {
      score += 10;
      if (titleLower === query) score += 5;
    }
    if (session.tags?.some((t) => t.toLowerCase().includes(query))) {
      score += 5;
    }
    const msgMatches = session.messages.filter((m) => m.content.toLowerCase().includes(query)).length;
    score += Math.min(msgMatches, 5);
    const ageDays = (Date.now() - session.updatedAt) / (1000 * 60 * 60 * 24);
    if (ageDays < 1) score += 2;
    else if (ageDays < 7) score += 1;
    return score;
  }

  count(opts?: { includeArchived?: boolean }): number {
    if (opts?.includeArchived) return this.sessions.length;
    return this.sessions.filter((s) => !s.archived).length;
  }

  totalMessages(): number {
    return this.sessions.reduce((sum, s) => sum + s.messages.length, 0);
  }

  allTags(): string[] {
    const tags = new Set<string>();
    for (const s of this.sessions) {
      s.tags?.forEach((t) => tags.add(t));
    }
    return [...tags].sort();
  }
}

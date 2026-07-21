import type { ChatMessage, SessionDetail, SessionSearchOptions, SessionSummary } from '@ziner/contracts';
import type { ISessionStore } from '@ziner/runtime-core';

interface DesktopChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

interface DesktopChatSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: DesktopChatMessage[];
  tags?: string[];
  archived?: boolean;
  accessCount?: number;
  summary?: string;
}

export interface FileSessionStoreOptions {
  sessionsDir: string;
}

export class FileSessionStore implements ISessionStore {
  private sessions: DesktopChatSession[] = [];
  private loaded = false;
  private filePathPromise: Promise<string>;

  constructor(options: FileSessionStoreOptions) {
    this.filePathPromise = import('path').then((path) => path.join(options.sessionsDir, 'sessions.json'));
  }

  async create(title?: string): Promise<SessionDetail> {
    await this.loadFromDisk();
    const now = Date.now();
    const session: DesktopChatSession = {
      id: `session_${now}_${Math.random().toString(36).slice(2, 8)}`,
      title: title?.trim() || 'New Chat',
      createdAt: now,
      updatedAt: now,
      messages: [],
      accessCount: 0,
    };
    this.sessions.push(session);
    await this.saveToDisk();
    return this.toDetail(session);
  }

  async save(session: SessionDetail): Promise<void> {
    await this.loadFromDisk();
    const desktop = this.fromDetail(session);
    const index = this.sessions.findIndex((item) => item.id === session.id);
    if (index >= 0) {
      this.sessions[index] = desktop;
    } else {
      this.sessions.push(desktop);
    }
    await this.saveToDisk();
  }

  async load(id: string): Promise<SessionDetail | undefined> {
    await this.loadFromDisk();
    const session = this.sessions.find((item) => item.id === id);
    if (!session) return undefined;
    session.accessCount = (session.accessCount ?? 0) + 1;
    await this.saveToDisk();
    return this.toDetail(session);
  }

  async list(options?: SessionSearchOptions): Promise<SessionSummary[]> {
    await this.loadFromDisk();
    return this.search(options).map((session) => this.toSummary(session));
  }

  async delete(id: string): Promise<boolean> {
    await this.loadFromDisk();
    const index = this.sessions.findIndex((item) => item.id === id);
    if (index < 0) return false;
    this.sessions.splice(index, 1);
    await this.saveToDisk();
    return true;
  }

  async appendMessage(sessionId: string, message: ChatMessage): Promise<void> {
    await this.loadFromDisk();
    const session = this.sessions.find((item) => item.id === sessionId);
    if (!session) return;
    const desktop = this.fromMessage(message);
    if (!desktop) return;
    session.messages.push(desktop);
    session.updatedAt = Date.now();
    if (desktop.role === 'user' && session.title === 'New Chat') {
      session.title = desktop.content.slice(0, 60) + (desktop.content.length > 60 ? '…' : '');
    }
    if (session.messages.length % 10 === 0) {
      session.summary = session.messages.slice(-5).map((item) => item.content.slice(0, 100)).join(' | ');
    }
    await this.saveToDisk();
  }

  async close(): Promise<void> {
    if (this.loaded) {
      await this.saveToDisk();
    }
  }

  private async loadFromDisk(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const fs = await import('fs/promises');
      const raw = await fs.readFile(await this.filePathPromise, 'utf-8');
      const parsed = JSON.parse(raw);
      this.sessions = Array.isArray(parsed) ? parsed : [];
    } catch {
      this.sessions = [];
    }
  }

  private async saveToDisk(): Promise<void> {
    const fs = await import('fs/promises');
    const path = await import('path');
    const filePath = await this.filePathPromise;
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(this.sessions, null, 2), 'utf-8');
  }

  private search(options: SessionSearchOptions = {}): DesktopChatSession[] {
    const { query, includeArchived = false, tags, limit = 50, sort = 'recent' } = options;
    let results = [...this.sessions];
    if (!includeArchived) {
      results = results.filter((session) => !session.archived);
    }
    if (tags && tags.length > 0) {
      results = results.filter((session) => session.tags?.some((tag) => tags.includes(tag)));
    }
    if (query && query.trim().length > 0) {
      const q = query.toLowerCase().trim();
      results = results
        .map((session) => ({ session, score: this.relevanceScore(session, q) }))
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score)
        .map((item) => item.session);
    } else if (sort === 'recent') {
      results.sort((a, b) => b.updatedAt - a.updatedAt);
    } else if (sort === 'oldest') {
      results.sort((a, b) => a.createdAt - b.createdAt);
    } else if (sort === 'alphabetical') {
      results.sort((a, b) => a.title.localeCompare(b.title));
    }
    return results.slice(0, limit);
  }

  private relevanceScore(session: DesktopChatSession, query: string): number {
    let score = 0;
    const title = session.title.toLowerCase();
    if (title.includes(query)) {
      score += 10;
      if (title === query) score += 5;
    }
    if (session.tags?.some((tag) => tag.toLowerCase().includes(query))) {
      score += 5;
    }
    score += Math.min(session.messages.filter((message) => message.content.toLowerCase().includes(query)).length, 5);
    const ageDays = (Date.now() - session.updatedAt) / (1000 * 60 * 60 * 24);
    if (ageDays < 1) score += 2;
    else if (ageDays < 7) score += 1;
    return score;
  }

  private toSummary(session: DesktopChatSession): SessionSummary {
    const lastMessage = session.messages[session.messages.length - 1];
    return {
      id: session.id,
      title: session.title,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      messageCount: session.messages.length,
      preview: lastMessage?.content.slice(0, 160),
      tags: session.tags,
      archived: session.archived,
    };
  }

  private toDetail(session: DesktopChatSession): SessionDetail {
    return {
      ...this.toSummary(session),
      messages: session.messages.map((message, index) => this.toMessage(session.id, message, index)),
      accessCount: session.accessCount,
      summary: session.summary,
    };
  }

  private fromDetail(session: SessionDetail): DesktopChatSession {
    return {
      id: session.id,
      title: session.title,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      messages: session.messages.map((message) => this.fromMessage(message)).filter((message): message is DesktopChatMessage => Boolean(message)),
      tags: session.tags,
      archived: session.archived,
      accessCount: session.accessCount,
      summary: session.summary,
    };
  }

  private toMessage(sessionId: string, message: DesktopChatMessage, index: number): ChatMessage {
    return {
      id: `${sessionId}_${message.timestamp}_${index}`,
      role: message.role,
      content: message.content,
      createdAt: message.timestamp,
    };
  }

  private fromMessage(message: ChatMessage): DesktopChatMessage | undefined {
    if (message.role === 'system') return undefined;
    return {
      role: message.role,
      content: message.content,
      timestamp: message.createdAt,
    };
  }
}

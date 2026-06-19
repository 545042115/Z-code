// @z-assistant/app-desktop — Session Manager
//
// Manages chat sessions on disk. Each session stores its full
// conversation history so the user can switch between multiple
// conversations without losing context.

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
}

export class SessionManager {
  private filePath: string;
  private sessions: ChatSession[] = [];

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
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.sessions, null, 2), 'utf-8');
    } catch (e) {
      console.error('[SessionManager] save error:', e);
    }
  }

  // ── CRUD ─────────────────────────────────────────────────────────────

  /** List all sessions (most recent first). */
  list(): ChatSession[] {
    return [...this.sessions].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Get a session by id. */
  get(id: string): ChatSession | undefined {
    return this.sessions.find((s) => s.id === id);
  }

  /** Create a new empty session. */
  create(title?: string): ChatSession {
    const now = Date.now();
    const session: ChatSession = {
      id: `session_${now}_${Math.random().toString(36).slice(2, 8)}`,
      title: title?.trim() || 'New Chat',
      createdAt: now,
      updatedAt: now,
      messages: [],
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

    this.save();
    return session;
  }
}

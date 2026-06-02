import * as vscode from 'vscode';

export interface MemoryEntry {
  role: 'user' | 'assistant' | 'context';
  content: string;
  timestamp: number;
  intent?: string;
  sessionId: string;
}

export interface SessionMemory {
  sessionId: string;
  repoPath: string;
  entries: MemoryEntry[];
  createdAt: number;
  updatedAt: number;
  lastIntent?: string;
}

export class MemoryManager {
  private sessions: Map<string, SessionMemory> = new Map();
  private readonly MAX_ENTRIES_PER_SESSION = 50;

  private getRepoPath(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || 'unknown';
  }

  private getSessionKey(sessionId: string, repoPath?: string): string {
    const repo = repoPath || this.getRepoPath();
    return `${repo}::${sessionId}`;
  }

  getOrCreateSession(sessionId: string): SessionMemory {
    const key = this.getSessionKey(sessionId);
    if (!this.sessions.has(key)) {
      this.sessions.set(key, {
        sessionId,
        repoPath: this.getRepoPath(),
        entries: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
    return this.sessions.get(key)!;
  }

  addEntry(sessionId: string, role: MemoryEntry['role'], content: string, intent?: string): void {
    const session = this.getOrCreateSession(sessionId);
    const entry: MemoryEntry = {
      role,
      content,
      timestamp: Date.now(),
      intent,
      sessionId,
    };
    session.entries.push(entry);
    if (session.entries.length > this.MAX_ENTRIES_PER_SESSION) {
      session.entries = session.entries.slice(-this.MAX_ENTRIES_PER_SESSION);
    }
    session.updatedAt = Date.now();
    if (intent) session.lastIntent = intent;
  }

  getRecentContext(sessionId: string, n: number = 10): MemoryEntry[] {
    const session = this.getOrCreateSession(sessionId);
    return session.entries.slice(-n);
  }

  getContextForPrompt(sessionId: string, recentN: number = 10): string {
    const entries = this.getRecentContext(sessionId, recentN);
    if (entries.length === 0) return '';

    const parts: string[] = ['## Conversation History\n'];
    for (const entry of entries) {
      const roleLabel = entry.role === 'user' ? 'User' : entry.role === 'assistant' ? 'Assistant' : 'Context';
      parts.push(`[${roleLabel}]: ${entry.content.slice(0, 500)}`);
    }
    return parts.join('\n');
  }

  getSessionSummary(sessionId: string): string {
    const session = this.getOrCreateSession(sessionId);
    const userCount = session.entries.filter(e => e.role === 'user').length;
    const assistantCount = session.entries.filter(e => e.role === 'assistant').length;
    return `Session: ${sessionId} | ${userCount} user msgs, ${assistantCount} assistant msgs | intent: ${session.lastIntent || 'unknown'}`;
  }

  getAllSessions(): SessionMemory[] {
    return Array.from(this.sessions.values());
  }

  clearSession(sessionId: string): void {
    const key = this.getSessionKey(sessionId);
    this.sessions.delete(key);
  }

  findByIntent(sessionId: string, intent: string): MemoryEntry[] {
    const session = this.getOrCreateSession(sessionId);
    return session.entries.filter(e => e.intent === intent);
  }
}
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
  private storage: vscode.Memento | null = null;
  private readonly STORAGE_KEY = 'codingAgent.sessions';
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  init(context: vscode.ExtensionContext): void {
    this.storage = context.globalState;
    this.loadFromStorage();
  }

  private loadFromStorage(): void {
    if (!this.storage) return;
    const data = this.storage.get<Record<string, SessionMemory>>(this.STORAGE_KEY, {});
    for (const [key, session] of Object.entries(data)) {
      this.sessions.set(key, session);
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    // 防抖：500ms 内多次修改只保存一次
    this.saveTimer = setTimeout(() => {
      this.saveToStorage();
    }, 500);
  }

  private async saveToStorage(): Promise<void> {
    if (!this.storage) return;
    const data: Record<string, SessionMemory> = {};
    for (const [key, session] of this.sessions) {
      data[key] = session;
    }
    await this.storage.update(this.STORAGE_KEY, data);
  }

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
    this.scheduleSave();
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

  getContextForPromptWithBudget(sessionId: string, maxTotalChars: number = 3000): string {
    const entries = this.getRecentContext(sessionId, 20);
    if (entries.length === 0) return '';

    // 按相关性排序：有 intent 匹配的优先
    const sorted = [...entries].sort((a, b) => {
      if (a.intent && !b.intent) return -1;
      if (!a.intent && b.intent) return 1;
      return b.timestamp - a.timestamp;
    });

    const parts: string[] = ['## Conversation History\n'];
    let totalChars = 0;

    for (const entry of sorted) {
      const roleLabel = entry.role === 'user' ? 'User' : entry.role === 'assistant' ? 'Assistant' : 'Context';
      const line = `[${roleLabel}]: ${entry.content.slice(0, 300)}`;
      if (totalChars + line.length > maxTotalChars) break;
      parts.push(line);
      totalChars += line.length;
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
    this.scheduleSave();
  }

  findByIntent(sessionId: string, intent: string): MemoryEntry[] {
    const session = this.getOrCreateSession(sessionId);
    return session.entries.filter(e => e.intent === intent);
  }

  /**
   * 跨会话搜索：在所有会话中按 intent 检索
   */
  findByIntentAcrossSessions(intent: string, limit: number = 10): MemoryEntry[] {
    const results: MemoryEntry[] = [];
    for (const session of this.sessions.values()) {
      for (const entry of session.entries) {
        if (entry.intent === intent) {
          results.push(entry);
        }
        if (results.length >= limit) return results;
      }
    }
    return results;
  }
}

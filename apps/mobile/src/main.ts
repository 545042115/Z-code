// Z Code Mobile - Main Application
//
// Integrates the MobileRuntimeBridge with the mobile UI.
// Features:
//   - Bottom navigation (Chat / Memory / Settings)
//   - Chat interface with streaming support
//   - Memory listing and search
//   - Settings persistence with bridge mode selection

import { createRuntimeBridge } from './bridge';
import type { AppSettings, MobileRuntimeBridge, ChatMessage, MemoryRecord, ChatRunOptions, TraceRunSummary } from './bridge/types';
import { getNativeCapabilities, type NativeCapabilities } from './native';

// ── Session persistence (IndexedDB) ───────────────────────────────
//
// A lightweight IndexedDB-backed store for chat sessions. Keeps the
// mobile app's conversation history reliable (no longer rebuilt from
// trace logs). All operations swallow errors so a storage failure
// never crashes the UI.

interface SessionRecord {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  messages: ChatMessage[];
}

interface SessionMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

const SESSION_DB_NAME = 'ziner-mobile';
const SESSION_DB_VERSION = 1;
const SESSION_STORE = 'sessions';

class SessionStore {
  private dbPromise: Promise<IDBDatabase> | null = null;

  private open(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('IndexedDB unavailable'));
        return;
      }
      const req = indexedDB.open(SESSION_DB_NAME, SESSION_DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(SESSION_STORE)) {
          db.createObjectStore(SESSION_STORE, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
    });
    return this.dbPromise;
  }

  async createSession(sessionId: string, title: string): Promise<void> {
    try {
      const db = await this.open();
      await new Promise<void>((resolve, reject) => {
        const now = Date.now();
        const record: SessionRecord = {
          id: sessionId,
          title,
          createdAt: now,
          updatedAt: now,
          messageCount: 0,
          messages: [],
        };
        const store = db.transaction(SESSION_STORE, 'readwrite').objectStore(SESSION_STORE);
        const req = store.put(record);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    } catch (e) {
      console.warn('[SessionStore] createSession failed:', e);
    }
  }

  async saveSession(sessionId: string, messages: ChatMessage[]): Promise<void> {
    try {
      const db = await this.open();
      await new Promise<void>((resolve, reject) => {
        const store = db.transaction(SESSION_STORE, 'readwrite').objectStore(SESSION_STORE);
        const getReq = store.get(sessionId);
        getReq.onsuccess = () => {
          const existing = getReq.result as SessionRecord | undefined;
          const now = Date.now();
          const title = existing?.title
            ?? messages.find((m) => m.role === 'user')?.content?.slice(0, 30)
            ?? '新对话';
          const record: SessionRecord = {
            id: sessionId,
            title,
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
            messageCount: messages.length,
            messages,
          };
          const putReq = store.put(record);
          putReq.onsuccess = () => resolve();
          putReq.onerror = () => reject(putReq.error);
        };
        getReq.onerror = () => reject(getReq.error);
      });
    } catch (e) {
      console.warn('[SessionStore] saveSession failed:', e);
    }
  }

  async loadSession(sessionId: string): Promise<ChatMessage[] | null> {
    try {
      const db = await this.open();
      return await new Promise<ChatMessage[] | null>((resolve, reject) => {
        const store = db.transaction(SESSION_STORE, 'readonly').objectStore(SESSION_STORE);
        const req = store.get(sessionId);
        req.onsuccess = () => {
          const record = req.result as SessionRecord | undefined;
          resolve(record?.messages ?? null);
        };
        req.onerror = () => reject(req.error);
      });
    } catch (e) {
      console.warn('[SessionStore] loadSession failed:', e);
      return null;
    }
  }

  async listSessions(): Promise<SessionMeta[]> {
    try {
      const db = await this.open();
      return await new Promise<SessionMeta[]>((resolve, reject) => {
        const store = db.transaction(SESSION_STORE, 'readonly').objectStore(SESSION_STORE);
        const req = store.getAll();
        req.onsuccess = () => {
          const records = (req.result as SessionRecord[]) ?? [];
          const metas = records
            .map((r) => ({
              id: r.id,
              title: r.title,
              createdAt: r.createdAt,
              updatedAt: r.updatedAt,
              messageCount: r.messageCount,
            }))
            .sort((a, b) => b.updatedAt - a.updatedAt);
          resolve(metas);
        };
        req.onerror = () => reject(req.error);
      });
    } catch (e) {
      console.warn('[SessionStore] listSessions failed:', e);
      return [];
    }
  }

  async deleteSession(sessionId: string): Promise<void> {
    try {
      const db = await this.open();
      await new Promise<void>((resolve, reject) => {
        const store = db.transaction(SESSION_STORE, 'readwrite').objectStore(SESSION_STORE);
        const req = store.delete(sessionId);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    } catch (e) {
      console.warn('[SessionStore] deleteSession failed:', e);
    }
  }

  /** Update just the title (e.g. when the first user message arrives). */
  async renameSession(sessionId: string, title: string): Promise<void> {
    try {
      const db = await this.open();
      await new Promise<void>((resolve, reject) => {
        const store = db.transaction(SESSION_STORE, 'readwrite').objectStore(SESSION_STORE);
        const getReq = store.get(sessionId);
        getReq.onsuccess = () => {
          const existing = getReq.result as SessionRecord | undefined;
          if (!existing) {
            resolve();
            return;
          }
          existing.title = title;
          existing.updatedAt = Date.now();
          const putReq = store.put(existing);
          putReq.onsuccess = () => resolve();
          putReq.onerror = () => reject(putReq.error);
        };
        getReq.onerror = () => reject(getReq.error);
      });
    } catch (e) {
      console.warn('[SessionStore] renameSession failed:', e);
    }
  }
}

const DEFAULT_SETTINGS: AppSettings = {
  language: 'zh-CN',
  memoryEnabled: true,
  storageBackend: 'sqlite',
  defaultModel: { provider: 'sglang', name: 'default' },
  apiKey: '',
  apiEndpoint: '',
  mcdMcpToken: '',
  amapApiKey: '',
  toolPolicy: {
    allow: [],
    deny: [],
    requireConfirm: [],
  },
  bridgeMode: 'local',
  planMode: 'auto',
  runtimeServerUrl: '',
  runtimeApiKey: '',
};

class MobileApp {
  private settings: AppSettings;
  private bridge: MobileRuntimeBridge;
  private native: NativeCapabilities;
  private sessionStore = new SessionStore();
  private currentPage = 'chat';
  private currentConversation = 'default';
  private currentMessages: ChatMessage[] = [];
  private isSending = false;
  private abortController: AbortController | null = null;
  private pendingResumeRunId: string | null = null;
  private memoryFilterKind: MemoryRecord['kind'] | 'all' = 'all';
  private memorySearchQuery = '';
  private memoryCache: MemoryRecord[] = [];

  private traceStatusFilter: 'all' | 'running' | 'ok' | 'error' = 'all';
  private traceSearchQuery = '';
  private traceCache: TraceRunSummary[] = [];

  constructor() {
    this.settings = this.loadSettings();
    this.bridge = createRuntimeBridge(this.settings.bridgeMode);
    this.native = getNativeCapabilities();
    this.init();
  }

  private loadSettings(): AppSettings {
    try {
      const saved = localStorage.getItem('zcode-settings');
      if (saved) {
        const parsed = JSON.parse(saved);
        // Migrate deprecated bridgeMode values
        if (parsed.bridgeMode === 'mock' || parsed.bridgeMode === 'direct') {
          parsed.bridgeMode = 'local';
        }
        // Default tool policy for older settings
        if (!parsed.toolPolicy) {
          parsed.toolPolicy = { allow: [], deny: [] };
        }
        // Migrate from old multi-API config to single model config (desktop-aligned)
        if (!parsed.defaultModel && Array.isArray(parsed.apis) && parsed.apis.length > 0) {
          const selected = parsed.apis.find((a: any) => a.id === parsed.selectedApiId)
            ?? parsed.apis.find((a: any) => a.enabled)
            ?? parsed.apis[0];
          if (selected) {
            parsed.defaultModel = {
              provider: parsed.provider || 'custom',
              name: selected.model || 'default',
            };
            parsed.apiKey = selected.apiKey || '';
            parsed.apiEndpoint = selected.endpoint || '';
          }
        }
        // Ensure defaultModel exists
        if (!parsed.defaultModel) {
          parsed.defaultModel = { provider: 'sglang', name: 'default' };
        }
        if (parsed.apiKey === undefined) parsed.apiKey = '';
        if (parsed.apiEndpoint === undefined) parsed.apiEndpoint = '';
        // Migrate MCP: if old mcpServers had MCD or AMAP, extract tokens
        if (!parsed.mcdMcpToken && Array.isArray(parsed.mcpServers)) {
          const mcd = parsed.mcpServers.find((m: any) => m.name?.toLowerCase().includes('mcd') || m.name?.toLowerCase().includes('mcdonald'));
          if (mcd?.headers?.Authorization) {
            parsed.mcdMcpToken = mcd.headers.Authorization.replace(/^Bearer\s+/i, '');
          }
        }
        if (!parsed.amapApiKey && Array.isArray(parsed.mcpServers)) {
          const amap = parsed.mcpServers.find((m: any) => m.name?.toLowerCase().includes('amap') || m.name?.toLowerCase().includes('gaode') || m.name?.toLowerCase().includes('高德'));
          if (amap?.headers?.['amap-key'] || amap?.headers?.['AMAP_KEY']) {
            parsed.amapApiKey = amap.headers['amap-key'] || amap.headers['AMAP_KEY'];
          }
        }
        return { ...DEFAULT_SETTINGS, ...parsed };
      }
    } catch {
      // ignore
    }
    return { ...DEFAULT_SETTINGS };
  }

  private saveSettings(): void {
    try {
      localStorage.setItem('zcode-settings', JSON.stringify(this.settings));
    } catch {
      // ignore
    }
  }

  private async init(): Promise<void> {
    this.setupNavigation();
    this.setupChat();
    this.setupSettings();
    this.setupCheckpoints();
    this.setupTracePanel();
    this.setupNativeCapabilities();
    this.setupMemory();
    this.applySettings();
    this.setupBridgeEvents();

    // Ensure the default conversation record exists in IndexedDB so the
    // sidebar / session list shows something on first launch.
    await this.sessionStore.createSession(this.currentConversation, '新对话');

    try {
      await this.bridge.init(this.settings);
      this.updateStatusDot();
    } catch (e) {
      console.warn('Bridge init failed:', e);
      this.updateStatusDot();
    }
  }

  private showToast(message: string): void {
    let toast = document.getElementById('app-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'app-toast';
      toast.className = 'toast';
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.add('show');
    setTimeout(() => toast?.classList.remove('show'), 2000);
  }

  private downloadFile(filename: string, content: string, mimeType = 'text/plain;charset=utf-8'): void {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  private async handleExportSession(id: string): Promise<void> {
    const useMd = confirm('导出为 Markdown？\n\n点击"确定"导出为 Markdown\n点击"取消"导出为 JSON');
    const format: 'markdown' | 'json' = useMd ? 'markdown' : 'json';
    try {
      const content = await this.bridge.exportSession?.(id, format);
      if (!content) {
        this.showToast('导出失败：会话不存在');
        return;
      }
      const ext = format === 'json' ? 'json' : 'md';
      const sessions = await this.sessionStore.listSessions?.();
      const session = sessions?.find((s) => s.id === id);
      const safeTitle = (session?.title || 'chat').replace(/[\\/:*?"<>|]/g, '_');
      const filename = `${safeTitle}_${id.slice(-8)}.${ext}`;
      this.downloadFile(filename, content, format === 'json' ? 'application/json' : 'text/markdown');
      this.showToast(`已导出为 ${format.toUpperCase()}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.showToast(`导出失败：${msg}`);
    }
  }

  private async handleExportMemories(): Promise<void> {
    try {
      const content = await this.bridge.exportMemories?.();
      if (!content) {
        this.showToast('导出失败');
        return;
      }
      const date = new Date().toISOString().slice(0, 10);
      const filename = `ziner-memories-${date}.json`;
      this.downloadFile(filename, content, 'application/json');
      this.showToast('记忆已导出');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.showToast(`导出失败：${msg}`);
    }
  }

  // ── Bridge Events ─────────────────────────────────────────────────

  private setupBridgeEvents(): void {
    this.bridge.addEventListener('status', () => {
      this.updateStatusDot();
    });

    this.bridge.addEventListener('memoryUpdated', () => {
      if (this.currentPage === 'memory') {
        this.refreshMemoryList();
      }
    });
  }

  private updateStatusDot(): void {
    const dot = document.getElementById('status-dot');
    if (!dot) return;

    dot.style.background = this.bridge.status.connected
      ? 'var(--success)'
      : 'var(--danger)';
    dot.style.boxShadow = this.bridge.status.connected
      ? '0 0 8px var(--success)'
      : '0 0 8px var(--danger)';
  }

  // ── Navigation ────────────────────────────────────────────────────

  private setupNavigation(): void {
    const navItems = document.querySelectorAll('.nav-item');
    navItems.forEach((item) => {
      item.addEventListener('click', () => {
        const page = (item as HTMLElement).dataset.page;
        if (page) this.switchPage(page);
      });
    });
  }

  private switchPage(pageName: string): void {
    if (this.currentPage === pageName) return;

    document.querySelectorAll('.nav-item').forEach((item) => {
      item.classList.toggle('nav-active', (item as HTMLElement).dataset.page === pageName);
    });

    document.querySelectorAll('.page').forEach((page) => {
      page.classList.toggle('page-active', page.id === `page-${pageName}`);
    });

    this.currentPage = pageName;

    if (pageName === 'memory') {
      this.refreshMemoryList();
    } else if (pageName === 'trace') {
      this.refreshTraceList();
    }
  }

  // ── Chat ──────────────────────────────────────────────────────────

  private setupChat(): void {
    const input = document.getElementById('chat-input') as HTMLTextAreaElement;
    const sendBtn = document.getElementById('send-btn') as HTMLButtonElement;
    const menuBtn = document.getElementById('btn-menu');
    const closeSidebarBtn = document.getElementById('btn-close-sidebar');
    const sidebarOverlay = document.getElementById('sidebar-overlay');
    const newSessionBtn = document.getElementById('btn-new-session');

    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.sendMessage();
      }
    });

    sendBtn.addEventListener('click', () => {
      // While streaming, the button acts as a stop button.
      if (this.isSending) {
        this.abortController?.abort();
        this.bridge.cancelRun();
        return;
      }
      this.sendMessage();
    });

    menuBtn?.addEventListener('click', () => this.toggleSidebar(true));
    closeSidebarBtn?.addEventListener('click', () => this.toggleSidebar(false));
    sidebarOverlay?.addEventListener('click', () => this.toggleSidebar(false));
    newSessionBtn?.addEventListener('click', () => {
      this.toggleSidebar(false);
      this.newConversation();
    });
  }

  private toggleSidebar(open: boolean): void {
    const sidebar = document.getElementById('session-sidebar');
    const overlay = document.getElementById('sidebar-overlay');
    if (open) {
      this.refreshSessionList();
    }
    sidebar?.classList.toggle('open', open);
    overlay?.classList.toggle('show', open);
  }

  private async refreshSessionList(): Promise<void> {
    const listEl = document.getElementById('session-list');
    if (!listEl) return;

    try {
      const sessions = await this.sessionStore.listSessions();
      if (sessions.length === 0) {
        listEl.innerHTML = '<div class="session-empty">暂无对话记录</div>';
        return;
      }

      listEl.innerHTML = sessions
        .map((s) => {
          const title = s.title || '新对话';
          const time = this.formatTime(s.updatedAt);
          const active = s.id === this.currentConversation ? 'active' : '';
          return `
            <div class="session-item ${active}" data-id="${this.escapeHtml(s.id)}">
              <div class="session-item-title">${this.escapeHtml(title)}</div>
              <div class="session-item-meta">
                <span>${time}</span>
                <span>${s.messageCount} 条</span>
              </div>
              <div class="session-item-actions">
                <button class="session-export-btn" data-export-id="${this.escapeHtml(s.id)}" aria-label="导出会话" title="导出">
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                    <polyline points="7 10 12 15 17 10"/>
                    <line x1="12" y1="15" x2="12" y2="3"/>
                  </svg>
                </button>
                <button class="session-delete-btn" data-delete-id="${this.escapeHtml(s.id)}" aria-label="删除会话" title="删除">
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="3 6 5 6 21 6"/>
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                  </svg>
                </button>
              </div>
            </div>
          `;
        })
        .join('');

      listEl.querySelectorAll('.session-item').forEach((item) => {
        item.addEventListener('click', (e) => {
          // Ignore clicks on action buttons.
          if ((e.target as HTMLElement).closest('.session-item-actions')) return;
          const id = item.getAttribute('data-id');
          if (id) this.switchConversation(id);
        });
      });

      listEl.querySelectorAll('.session-export-btn').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const id = (btn as HTMLElement).getAttribute('data-export-id');
          if (id) await this.handleExportSession(id);
        });
      });

      listEl.querySelectorAll('.session-delete-btn').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const id = (btn as HTMLElement).getAttribute('data-delete-id');
          if (!id) return;
          if (!confirm('删除该会话？此操作不可恢复。')) return;
          await this.sessionStore.deleteSession(id);
          if (id === this.currentConversation) {
            this.newConversation();
          }
          this.refreshSessionList();
        });
      });
    } catch {
      listEl.innerHTML = '<div class="session-empty">加载失败</div>';
    }
  }

  private async switchConversation(id: string): Promise<void> {
    if (this.isSending) {
      this.showToast('请等待当前回复完成');
      return;
    }
    this.currentConversation = id;
    this.toggleSidebar(false);
    await this.loadConversation(id);
  }

  private async loadConversation(id: string): Promise<void> {
    const container = document.getElementById('chat-messages') as HTMLElement;
    if (!container) return;

    container.innerHTML = '<div class="session-empty">加载中...</div>';

    try {
      const messages = await this.sessionStore.loadSession(id);
      this.currentMessages = messages ?? [];

      if (!messages || messages.length === 0) {
        container.innerHTML = `
          <div class="message message-assistant">
            <div class="message-avatar">Z</div>
            <div class="message-bubble">
              <p>你好，我是 Ziner。</p>
            </div>
          </div>
        `;
        return;
      }

      container.innerHTML = '';
      for (const msg of messages) {
        this.addMessage(msg);
      }
      container.scrollTop = container.scrollHeight;
    } catch {
      container.innerHTML = '<div class="session-empty">加载失败</div>';
    }
  }

  private newConversation(): void {
    if (this.isSending) return;
    this.currentConversation = `conv-${Date.now()}`;
    this.currentMessages = [];
    const container = document.getElementById('chat-messages') as HTMLElement;
    if (container) {
      container.innerHTML = `
        <div class="message message-assistant">
          <div class="message-avatar">Z</div>
          <div class="message-bubble">
            <p>你好，我是 Ziner。</p>
          </div>
        </div>
      `;
    }
    const input = document.getElementById('chat-input') as HTMLTextAreaElement;
    input?.focus();
    this.showToast('新对话已开始');
    // Persist the new (empty) session record so it appears in the sidebar.
    void this.sessionStore.createSession(this.currentConversation, '新对话');
  }

  private async handleSlashCommand(text: string): Promise<boolean> {
    const parts = text.slice(1).split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const arg = parts.slice(1).join(' ');

    switch (cmd) {
      case 'help':
        this.addSystemMessage(
          '可用命令：\n' +
          '  /new        新建会话\n' +
          '  /clear      清空当前会话\n' +
          '  /simple     切换到直接对话模式\n' +
          '  /plan       切换到多步 Plan 模式\n' +
          '  /auto       切换到自动选择模式\n' +
          '  /forget all 清空所有记忆\n' +
          '  /help       显示此帮助',
        );
        return true;

      case 'new':
        this.newConversation();
        this.showToast('已新建会话');
        return true;

      case 'clear':
        if (!confirm('清空当前会话？')) return true;
        this.currentMessages = [];
        await this.sessionStore.saveSession(this.currentConversation, []);
        const messagesEl = document.getElementById('chat-messages');
        if (messagesEl) messagesEl.innerHTML = '';
        await this.refreshSessionList();
        this.showToast('已清空会话');
        return true;

      case 'simple':
        this.settings.planMode = 'chat';
        this.saveSettings();
        this.addSystemMessage('已切换到直接对话模式');
        return true;

      case 'plan':
        this.settings.planMode = 'plan';
        this.saveSettings();
        this.addSystemMessage('已切换到多步 Plan 模式');
        return true;

      case 'auto':
        this.settings.planMode = 'auto';
        this.saveSettings();
        this.addSystemMessage('已切换到自动选择模式');
        return true;

      case 'forget': {
        if (arg === 'all') {
          if (!confirm('清空所有记忆？此操作不可恢复。')) return true;
          try {
            const memories = await this.bridge.listMemories({ limit: 1000 });
            for (const m of memories) {
              await this.bridge.deleteMemory(m.id);
            }
            this.memoryCache = [];
            this.showToast('已清空所有记忆');
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            this.showToast(`清空失败：${msg}`);
          }
        } else {
          this.showToast('用法：/forget all');
        }
        return true;
      }

      default:
        return false;
    }
  }

  private addSystemMessage(content: string): void {
    const msg: ChatMessage = {
      id: `sys-${Date.now()}`,
      role: 'assistant',
      content,
      createdAt: Date.now(),
    };
    this.addMessage(msg);
    this.currentMessages.push(msg);
    void this.sessionStore.saveSession(this.currentConversation, this.currentMessages);
  }

  private async sendMessage(): Promise<void> {
    if (this.isSending) return;

    const input = document.getElementById('chat-input') as HTMLTextAreaElement;
    const text = input.value.trim();
    if (!text) return;

    if (text.startsWith('/')) {
      const handled = await this.handleSlashCommand(text);
      if (handled) {
        input.value = '';
        input.style.height = 'auto';
        return;
      }
    }

    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: text,
      createdAt: Date.now(),
    };
    this.addMessage(userMsg);
    this.currentMessages.push(userMsg);

    input.value = '';
    input.style.height = 'auto';
    this.isSending = true;

    // Persist the user message immediately so it survives a refresh / crash.
    await this.sessionStore.saveSession(this.currentConversation, this.currentMessages);

    // Switch the send button into stop mode for the duration of the request.
    this.abortController = new AbortController();
    this.setSendButtonState('stop');

    // Show typing indicator
    const assistantMsgId = `assistant-${Date.now()}`;
    const assistantMsg: ChatMessage = {
      id: assistantMsgId,
      role: 'assistant',
      content: '',
      createdAt: Date.now(),
      streaming: true,
    };
    this.addMessage(assistantMsg);
    this.currentMessages.push(assistantMsg);

    const runOptions: ChatRunOptions = {};
    if (this.pendingResumeRunId) {
      runOptions.resumeFromRunId = this.pendingResumeRunId;
      this.pendingResumeRunId = null;
    }

    let aborted = false;
    try {
      if (this.bridge.streamChat) {
        await this.bridge.streamChat(
          text,
          this.currentConversation,
          (_delta, fullMessage) => {
            this.currentMessages = this.currentMessages.map((m) =>
              m.id === assistantMsgId ? { ...m, content: fullMessage } : m,
            );
            this.updateMessageContent(assistantMsgId, fullMessage);
          },
          this.abortController.signal,
          runOptions,
        );
      } else {
        const response = await this.bridge.sendChat(text, this.currentConversation, runOptions);
        this.currentMessages = this.currentMessages.map((m) =>
          m.id === assistantMsgId ? { ...m, content: response.content } : m,
        );
        this.updateMessageContent(assistantMsgId, response.content);
      }
    } catch (e) {
      aborted = e instanceof DOMException && e.name === 'AbortError';
      const errorMsg = aborted
        ? '（已停止）'
        : (e instanceof Error ? e.message : String(e));
      const display = aborted ? `⚠️ ${errorMsg}` : `⚠️ 出错了：${errorMsg}`;
      this.currentMessages = this.currentMessages.map((m) =>
        m.id === assistantMsgId ? { ...m, content: display } : m,
      );
      this.updateMessageContent(assistantMsgId, display);
    } finally {
      this.removeStreamingFlag(assistantMsgId);
      this.isSending = false;
      this.abortController = null;
      this.setSendButtonState('send');
      // Persist the final assistant message (or error/abort marker).
      await this.sessionStore.saveSession(this.currentConversation, this.currentMessages);
      input.focus();
    }
  }

  private addMessage(msg: ChatMessage): void {
    const container = document.getElementById('chat-messages') as HTMLElement;
    const msgDiv = document.createElement('div');
    msgDiv.className = `message message-${msg.role}`;
    msgDiv.id = `msg-${msg.id}`;

    const avatar = document.createElement('div');
    avatar.className = 'message-avatar';
    avatar.textContent = msg.role === 'user' ? '我' : 'Z';

    const bubble = document.createElement('div');
    bubble.className = 'message-bubble';
    if (msg.streaming) {
      bubble.innerHTML = '<div class="typing-indicator"><span></span><span></span><span></span></div>';
    } else {
      bubble.innerHTML = this.formatMessageContent(msg.content);
    }

    bubble.addEventListener('click', () => {
      if (msg.content?.trim()) {
        this.native.copyToClipboard(msg.content).then(() => {
          this.showToast('已复制到剪贴板');
        }).catch(() => {
          // ignore
        });
      }
    });

    msgDiv.appendChild(avatar);
    msgDiv.appendChild(bubble);
    container.appendChild(msgDiv);
    container.scrollTop = container.scrollHeight;
  }

  private updateMessageContent(msgId: string, content: string): void {
    const msgEl = document.getElementById(`msg-${msgId}`);
    if (!msgEl) return;

    const bubble = msgEl.querySelector('.message-bubble');
    if (!bubble) return;

    if (content.trim()) {
      bubble.innerHTML = this.formatMessageContent(content);
    } else {
      bubble.innerHTML = '<div class="typing-indicator"><span></span><span></span><span></span></div>';
    }

    const container = document.getElementById('chat-messages');
    if (container) {
      container.scrollTop = container.scrollHeight;
    }
  }

  private removeStreamingFlag(msgId: string): void {
    const msgEl = document.getElementById(`msg-${msgId}`);
    if (msgEl) {
      msgEl.classList.remove('streaming');
    }
  }

  private setSendButtonState(state: 'send' | 'stop' | 'disabled'): void {
    const btn = document.getElementById('send-btn') as HTMLButtonElement | null;
    if (!btn) return;
    const sendIcon = btn.querySelector('.send-icon') as SVGElement | null;
    const stopIcon = btn.querySelector('.stop-icon') as SVGElement | null;
    const isStop = state === 'stop';
    btn.disabled = state === 'disabled';
    btn.classList.toggle('is-stop', isStop);
    btn.setAttribute('aria-label', isStop ? '停止生成' : '发送');
    if (sendIcon) sendIcon.style.display = isStop ? 'none' : '';
    if (stopIcon) stopIcon.style.display = isStop ? '' : 'none';
  }

  /**
   * Lightweight Markdown renderer (no external deps).
   *
   * Pipeline: escape HTML first → extract fenced code blocks → apply
   * inline/block Markdown replacements → restore code blocks. Escaping
   * first prevents XSS from raw model output.
   */
  private formatMessageContent(text: string): string {
    if (!text) return '';

    // 1. Extract fenced code blocks so their contents are not touched
    //    by inline Markdown processing. Use placeholders.
    const codeBlocks: string[] = [];
    const fenced = text.replace(/```(\w+)?\n?([\s\S]*?)```/g, (_m, lang, code) => {
      const langClass = lang ? ` class="language-${this.escapeHtml(lang)}"` : '';
      const idx = codeBlocks.length;
      codeBlocks.push(`<pre><code${langClass}>${this.escapeHtml(code.replace(/\n$/, ''))}</code></pre>`);
      return `\u0000CODEBLOCK_${idx}\u0000`;
    });

    // 2. Escape the remaining text.
    let html = this.escapeHtml(fenced);

    // 3. Process line by line for block-level constructs (headings, lists).
    const lines = html.split('\n');
    const out: string[] = [];
    let listType: 'ul' | 'ol' | null = null;
    let paragraphBuffer: string[] = [];

    const flushParagraph = () => {
      if (paragraphBuffer.length > 0) {
        const content = paragraphBuffer.join('<br/>');
        if (content.trim()) out.push(`<p>${content}</p>`);
        paragraphBuffer = [];
      }
    };
    const closeList = () => {
      if (listType) {
        out.push(`</${listType}>`);
        listType = null;
      }
    };

    for (const rawLine of lines) {
      const line = rawLine;

      // Fenced code block placeholder on its own line — emit as-is.
      const codeBlockMatch = line.match(/^\u0000CODEBLOCK_(\d+)\u0000$/);
      if (codeBlockMatch) {
        flushParagraph();
        closeList();
        out.push(codeBlocks[Number(codeBlockMatch[1])]);
        continue;
      }

      // Heading: #, ##, ###
      const heading = line.match(/^(#{1,3})\s+(.*)$/);
      if (heading) {
        flushParagraph();
        closeList();
        const level = heading[1].length + 2; // # → h3, ## → h4, ### → h5
        out.push(`<h${level}>${this.applyInlineMarkdown(heading[2])}</h${level}>`);
        continue;
      }

      // Ordered list item: 1. ...
      const ol = line.match(/^\s*\d+\.\s+(.*)$/);
      if (ol) {
        flushParagraph();
        if (listType !== 'ol') {
          closeList();
          out.push('<ol>');
          listType = 'ol';
        }
        out.push(`<li>${this.applyInlineMarkdown(ol[1])}</li>`);
        continue;
      }

      // Unordered list item: - or * ...
      const ul = line.match(/^\s*[-*]\s+(.*)$/);
      if (ul) {
        flushParagraph();
        if (listType !== 'ul') {
          closeList();
          out.push('<ul>');
          listType = 'ul';
        }
        out.push(`<li>${this.applyInlineMarkdown(ul[1])}</li>`);
        continue;
      }

      // Blank line → paragraph break.
      if (line.trim() === '') {
        flushParagraph();
        closeList();
        continue;
      }

      // Default: accumulate as a paragraph line. Inline code block
      // placeholders (when embedded mid-paragraph) are restored here too.
      closeList();
      paragraphBuffer.push(this.applyInlineMarkdown(line));
    }
    flushParagraph();
    closeList();

    html = out.join('\n');

    // 4. Restore any code block placeholders that ended up inline.
    html = html.replace(/\u0000CODEBLOCK_(\d+)\u0000/g, (_m, idx) => codeBlocks[Number(idx)] ?? '');

    return html;
  }

  /** Apply inline Markdown (bold, italic, inline code, links) to a string. */
  private applyInlineMarkdown(text: string): string {
    let result = text;
    // Inline code (do first to protect its contents from other replacements).
    const inlineCodes: string[] = [];
    result = result.replace(/`([^`\n]+)`/g, (_m, code) => {
      const idx = inlineCodes.length;
      inlineCodes.push(`<code>${this.escapeHtml(code)}</code>`);
      return `\u0001INLINE_${idx}\u0001`;
    });

    // Bold: **...**
    result = result.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    // Italic: *...* (avoid matching bold leftovers)
    result = result.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
    // Links: [text](url)
    result = result.replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
    );

    // Restore inline code.
    result = result.replace(/\u0001INLINE_(\d+)\u0001/g, (_m, idx) => inlineCodes[Number(idx)] ?? '');
    return result;
  }

  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // ── Memory ────────────────────────────────────────────────────────

  private setupMemory(): void {
    const tabs = document.getElementById('memory-filter-tabs');
    if (tabs) {
      tabs.querySelectorAll('.memory-tab').forEach((tab) => {
        tab.addEventListener('click', () => {
          const kind = (tab as HTMLElement).dataset.kind as MemoryRecord['kind'] | 'all';
          this.memoryFilterKind = kind;
          tabs.querySelectorAll('.memory-tab').forEach((t) => t.classList.remove('active'));
          tab.classList.add('active');
          this.renderMemoryList();
        });
      });
    }

    const searchInput = document.getElementById('memory-search') as HTMLInputElement | null;
    if (searchInput) {
      searchInput.addEventListener('input', () => {
        this.memorySearchQuery = searchInput.value.trim().toLowerCase();
        this.renderMemoryList();
      });
    }

    const clearBtn = document.getElementById('btn-clear-memory');
    if (clearBtn) {
      clearBtn.addEventListener('click', async () => {
        if (!confirm('清空所有记忆？此操作不可恢复。')) return;
        try {
          // Best-effort: delete every cached memory. Memory IDs are stable.
          const ids = this.memoryCache.map((m) => m.id);
          for (const id of ids) {
            await this.bridge.deleteMemory(id);
          }
          this.memoryCache = [];
          await this.refreshMemoryList();
          this.showToast('已清空所有记忆');
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          this.showToast(`清空失败：${msg}`);
        }
      });
    }

    const exportBtn = document.getElementById('btn-export-memory');
    if (exportBtn) {
      exportBtn.addEventListener('click', () => this.handleExportMemories());
    }
  }

  private async refreshMemoryList(): Promise<void> {
    const countEl = document.getElementById('memory-count');
    const listEl = document.getElementById('memory-list');

    if (!countEl || !listEl) return;

    listEl.innerHTML = '<div class="empty-state"><p>加载中...</p></div>';

    try {
      const memories = await this.bridge.listMemories({ limit: 100 });
      this.memoryCache = memories;
      this.updateMemoryStats();
      this.renderMemoryList();
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      this.memoryCache = [];
      listEl.innerHTML = `
        <div class="empty-state">
          <p>加载失败</p>
          <p class="muted">${this.escapeHtml(errorMsg)}</p>
        </div>
      `;
    }
  }

  /** Render the memory list from the cache, applying filter + search. */
  private renderMemoryList(): void {
    const listEl = document.getElementById('memory-list');
    if (!listEl) return;

    let memories = this.memoryCache;
    if (this.memoryFilterKind !== 'all') {
      memories = memories.filter((m) => m.kind === this.memoryFilterKind);
    }
    if (this.memorySearchQuery) {
      memories = memories.filter((m) => m.content.toLowerCase().includes(this.memorySearchQuery));
    }

    if (memories.length === 0) {
      listEl.innerHTML = `
        <div class="empty-state">
          <p>${this.memoryCache.length === 0 ? '还没有记忆' : '没有匹配的记忆'}</p>
          <p class="muted">${this.memoryCache.length === 0 ? '和我聊天，我会记住重要的信息' : '尝试更换筛选或搜索关键词'}</p>
        </div>
      `;
      return;
    }

    listEl.innerHTML = memories.map((m) => {
        const meta = m.metadata && typeof m.metadata === 'object' ? m.metadata as Record<string, unknown> : {};
        const metaEntries = Object.entries(meta).filter(([k]) => k !== 'embedding' && k !== 'vector');
        const hasDetails = m.scope || metaEntries.length > 0 || m.updatedAt;
        return `
      <div class="memory-item" data-id="${this.escapeHtml(m.id)}">
        <div class="memory-item-header">
          <span class="memory-tag">${this.memoryKindLabel(m.kind)}</span>
          <div class="memory-item-header-right">
            <span class="memory-time">${this.formatTime(m.createdAt)}</span>
            ${hasDetails ? `<button class="memory-expand-btn" data-expand-id="${this.escapeHtml(m.id)}" aria-label="展开详情">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="6 9 12 15 18 9"/>
              </svg>
            </button>` : ''}
          </div>
        </div>
        <div class="memory-content">${this.escapeHtml(m.content)}</div>
        ${hasDetails ? `
        <div class="memory-details" data-details-id="${this.escapeHtml(m.id)}" style="display:none">
          <div class="memory-details-grid">
            ${m.scope ? `<div class="detail-item"><span class="detail-label">Scope</span><span class="detail-value">${this.escapeHtml(m.scope)}</span></div>` : ''}
            ${m.updatedAt ? `<div class="detail-item"><span class="detail-label">更新时间</span><span class="detail-value">${this.formatTime(m.updatedAt)}</span></div>` : ''}
            ${metaEntries.map(([k, v]) => `<div class="detail-item"><span class="detail-label">${this.escapeHtml(k)}</span><span class="detail-value">${this.escapeHtml(typeof v === 'object' ? JSON.stringify(v) : String(v))}</span></div>`).join('')}
          </div>
        </div>` : ''}
        <div class="memory-item-actions">
          <button class="memory-delete-btn" data-delete-id="${this.escapeHtml(m.id)}" aria-label="删除记忆">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="3 6 5 6 21 6"/>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
            </svg>
          </button>
        </div>
      </div>
    `}).join('');

    listEl.querySelectorAll('.memory-delete-btn').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = (btn as HTMLElement).getAttribute('data-delete-id');
        if (!id) return;
        try {
          await this.bridge.deleteMemory(id);
          this.memoryCache = this.memoryCache.filter((m) => m.id !== id);
          this.updateMemoryStats();
          this.renderMemoryList();
          this.showToast('已删除');
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.showToast(`删除失败：${msg}`);
        }
      });
    });

    listEl.querySelectorAll('.memory-expand-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = (btn as HTMLElement).getAttribute('data-expand-id');
        if (!id) return;
        const details = listEl.querySelector(`[data-details-id="${id}"]`);
        const item = (btn as HTMLElement).closest('.memory-item');
        if (details && item) {
          const isOpen = details.getAttribute('style')?.includes('block');
          details.setAttribute('style', isOpen ? 'display:none' : 'display:block');
          item.classList.toggle('expanded', !isOpen);
        }
      });
    });
  }

  private updateMemoryStats(): void {
    const total = this.memoryCache.length;
    const factCount = this.memoryCache.filter((m) => m.kind === 'fact').length;
    const prefCount = this.memoryCache.filter((m) => m.kind === 'preference').length;
    const epCount = this.memoryCache.filter((m) => m.kind === 'episodic').length;

    const totalEl = document.getElementById('memory-count');
    const factEl = document.getElementById('memory-fact-count');
    const prefEl = document.getElementById('memory-pref-count');
    const epEl = document.getElementById('memory-ep-count');

    if (totalEl) totalEl.textContent = String(total);
    if (factEl) factEl.textContent = String(factCount);
    if (prefEl) prefEl.textContent = String(prefCount);
    if (epEl) epEl.textContent = String(epCount);
  }

  private memoryKindLabel(kind: MemoryRecord['kind']): string {
    const labels: Record<MemoryRecord['kind'], string> = {
      fact: '事实',
      preference: '偏好',
      episodic: '情景',
      procedural: '程序',
      'long-term': '长期',
      'short-term': '短期',
      working: '工作',
    };
    return labels[kind] || kind;
  }

  private formatTime(timestamp: number): string {
    const now = Date.now();
    const diff = now - timestamp;

    if (diff < 60_000) return '刚刚';
    if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3600_000)} 小时前`;
    if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;

    const d = new Date(timestamp);
    return `${d.getMonth() + 1}/${d.getDate()}`;
  }

  // ── Settings ──────────────────────────────────────────────────────

  private setupCheckpoints(): void {
    const manageBtn = document.getElementById('btn-manage-checkpoints');
    const closeBtn = document.getElementById('btn-close-checkpoint');
    const overlay = document.getElementById('checkpoint-overlay');

    manageBtn?.addEventListener('click', () => this.toggleCheckpointPanel(true));
    closeBtn?.addEventListener('click', () => this.toggleCheckpointPanel(false));
    overlay?.addEventListener('click', () => this.toggleCheckpointPanel(false));
  }

  private toggleCheckpointPanel(open: boolean): void {
    const panel = document.getElementById('checkpoint-panel');
    const overlay = document.getElementById('checkpoint-overlay');
    if (open) {
      void this.refreshCheckpointList();
    }
    panel?.classList.toggle('open', open);
    overlay?.classList.toggle('show', open);
  }

  private async refreshCheckpointList(): Promise<void> {
    const listEl = document.getElementById('checkpoint-list');
    if (!listEl) return;

    try {
      const checkpoints = this.bridge.listCheckpoints
        ? await this.bridge.listCheckpoints({ limit: 50 })
        : [];

      if (checkpoints.length === 0) {
        listEl.innerHTML = `
          <div class="empty-state">
            <p>没有检查点</p>
            <p class="muted">使用多步 Plan 模式时，中断的任务会出现在这里</p>
          </div>
        `;
        return;
      }

      listEl.innerHTML = checkpoints
        .map((ck) => {
          const progress = ck.totalCount > 0 ? Math.round((ck.completedCount / ck.totalCount) * 100) : 0;
          const statusLabel = this.checkpointStatusLabel(ck.status);
          const time = this.formatTime(ck.updatedAt);
          return `
            <div class="checkpoint-item" data-runid="${this.escapeHtml(ck.runId)}">
              <div class="checkpoint-item-header">
                <div class="checkpoint-item-title">${this.escapeHtml(ck.task || '未命名任务')}</div>
                <span class="checkpoint-status ${ck.status}">${statusLabel}</span>
              </div>
              <div class="checkpoint-item-meta">
                <span>${ck.completedCount}/${ck.totalCount} 子任务</span>
                <span>${time}</span>
              </div>
              <div class="checkpoint-progress">
                <div class="checkpoint-progress-bar" style="width:${progress}%"></div>
              </div>
              <div class="checkpoint-actions">
                ${ck.status === 'in_progress' || ck.status === 'cancelled' || ck.status === 'failed'
                  ? `<button class="btn-secondary btn-resume-checkpoint" data-runid="${this.escapeHtml(ck.runId)}" data-task="${this.escapeHtml(ck.task || '')}">继续</button>`
                  : ''}
                <button class="btn-secondary btn-delete-checkpoint" data-runid="${this.escapeHtml(ck.runId)}">删除</button>
              </div>
            </div>
          `;
        })
        .join('');

      listEl.querySelectorAll('.btn-resume-checkpoint').forEach((btn) => {
        btn.addEventListener('click', () => {
          const runId = (btn as HTMLElement).getAttribute('data-runid');
          const task = (btn as HTMLElement).getAttribute('data-task');
          if (!runId) return;
          this.pendingResumeRunId = runId;
          const input = document.getElementById('chat-input') as HTMLTextAreaElement | null;
          if (input && task) {
            input.value = task;
            input.style.height = 'auto';
            input.style.height = Math.min(input.scrollHeight, 120) + 'px';
          }
          this.toggleCheckpointPanel(false);
          this.switchPage('chat');
          this.showToast('已加载检查点，点击发送继续');
        });
      });

      listEl.querySelectorAll('.btn-delete-checkpoint').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const runId = (btn as HTMLElement).getAttribute('data-runid');
          if (!runId) return;
          if (!confirm('删除该检查点？')) return;
          try {
            await this.bridge.deleteCheckpoint?.(runId);
            await this.refreshCheckpointList();
            this.showToast('已删除');
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.showToast(`删除失败：${msg}`);
          }
        });
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      listEl.innerHTML = `
        <div class="empty-state">
          <p>加载失败</p>
          <p class="muted">${this.escapeHtml(msg)}</p>
        </div>
      `;
    }
  }

  private checkpointStatusLabel(status: string): string {
    const labels: Record<string, string> = {
      in_progress: '进行中',
      completed: '已完成',
      cancelled: '已中断',
      failed: '失败',
    };
    return labels[status] || status;
  }

  private setupSettings(): void {
    const saveBtn = document.getElementById('save-settings-btn');
    if (saveBtn) {
      saveBtn.addEventListener('click', () => this.handleSaveSettings());
    }

    // Bridge mode toggle: show/hide relevant sections
    const bridgeModeSelect = document.getElementById('setting-bridge-mode') as HTMLSelectElement | null;
    if (bridgeModeSelect) {
      bridgeModeSelect.addEventListener('change', () => {
        const mode = bridgeModeSelect.value as 'local' | 'remote';
        const serverUrlGroup = document.getElementById('setting-runtime-server-group');
        const serverApiKeyGroup = document.getElementById('setting-runtime-apikey-group');
        const modelGroup = document.getElementById('setting-model-group');
        const mcpGroup = document.getElementById('setting-mcp-group');
        if (serverUrlGroup) serverUrlGroup.style.display = mode === 'remote' ? '' : 'none';
        if (serverApiKeyGroup) serverApiKeyGroup.style.display = mode === 'remote' ? '' : 'none';
        if (modelGroup) modelGroup.style.display = mode === 'local' ? '' : 'none';
        if (mcpGroup) mcpGroup.style.display = mode === 'local' ? '' : 'none';
      });
    }

    // MCP token visibility toggles
    const mcdToggle = document.getElementById('btn-mcd-toggle');
    const mcdInput = document.getElementById('setting-mcd-token') as HTMLInputElement | null;
    if (mcdToggle && mcdInput) {
      mcdToggle.addEventListener('click', () => {
        const secured = mcdInput.classList.toggle('secured');
        mcdToggle.textContent = secured ? '显示' : '隐藏';
      });
    }

    const amapToggle = document.getElementById('btn-amap-toggle');
    const amapInput = document.getElementById('setting-amap-key') as HTMLInputElement | null;
    if (amapToggle && amapInput) {
      amapToggle.addEventListener('click', () => {
        const secured = amapInput.classList.toggle('secured');
        amapToggle.textContent = secured ? '显示' : '隐藏';
      });
    }
  }

  private setupNativeCapabilities(): void {
    // Update platform info
    const platformInfo = document.getElementById('platform-info');
    if (platformInfo) {
      platformInfo.textContent = `${this.native.platform} ${this.native.isNative ? '(原生)' : '(Web)'}`;
    }

    // Notifications
    const requestNotificationsBtn = document.getElementById('btn-request-notifications');
    if (requestNotificationsBtn) {
      requestNotificationsBtn.addEventListener('click', async () => {
        const granted = await this.native.requestNotificationPermission();
        this.showToast(granted ? '通知权限已授予' : '通知权限被拒绝');
      });
    }

    const testNotificationBtn = document.getElementById('btn-test-notification');
    if (testNotificationBtn) {
      testNotificationBtn.addEventListener('click', async () => {
        await this.native.scheduleNotification({
          id: Date.now(),
          title: 'Ziner',
          body: '这是一条来自 Ziner 的测试通知',
        });
        this.showToast('测试通知已发送');
      });
    }

    // Vibration
    const vibrateBtn = document.getElementById('btn-vibrate');
    if (vibrateBtn) {
      vibrateBtn.addEventListener('click', async () => {
        await this.native.vibrate({ style: 'medium' });
        this.showToast('振动反馈已触发');
      });
    }

    // Clipboard
    const copyTestBtn = document.getElementById('btn-copy-test');
    if (copyTestBtn) {
      copyTestBtn.addEventListener('click', async () => {
        await this.native.copyToClipboard('Hello from Ziner!');
        this.showToast('已复制到剪贴板');
      });
    }

    // Share
    const shareBtn = document.getElementById('btn-share');
    if (shareBtn) {
      shareBtn.addEventListener('click', async () => {
        const ok = await this.native.share({
          title: 'Ziner',
          text: 'Ziner — 你的 AI 助手',
          url: 'https://github.com/zcode',
        });
        this.showToast(ok ? '分享面板已打开' : '分享不可用');
      });
    }

    // Export / Import settings
    const exportBtn = document.getElementById('btn-export-settings');
    const importBtn = document.getElementById('btn-import-settings');
    const importFileInput = document.getElementById('import-file-input') as HTMLInputElement | null;

    if (exportBtn) {
      exportBtn.addEventListener('click', () => this.exportSettings());
    }
    if (importBtn && importFileInput) {
      importBtn.addEventListener('click', () => importFileInput.click());
      importFileInput.addEventListener('change', (e) => this.handleImportFile(e));
    }

    // Memory quick actions
    const openMemBtn = document.getElementById('btn-open-memory');
    const exportMemBtn = document.getElementById('btn-export-mem-settings');
    const clearMemBtn = document.getElementById('btn-clear-mem-settings');

    openMemBtn?.addEventListener('click', () => {
      this.switchPage('memory');
    });

    exportMemBtn?.addEventListener('click', () => {
      this.handleExportMemories();
    });

    clearMemBtn?.addEventListener('click', async () => {
      if (!confirm('清空所有记忆？此操作不可恢复。')) return;
      try {
        const memories = await this.bridge.listMemories({ limit: 1000 });
        for (const m of memories) {
          await this.bridge.deleteMemory(m.id);
        }
        this.memoryCache = [];
        this.showToast('已清空所有记忆');
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.showToast(`清空失败：${msg}`);
      }
    });
  }

  // ── Settings Export / Import ──────────────────────────────────────

  private async exportSettings(): Promise<void> {
    try {
      const exportData = {
        app: 'ziner',
        version: 1,
        exportedAt: new Date().toISOString(),
        platform: 'mobile',
        settings: this.settings,
      };
      const json = JSON.stringify(exportData, null, 2);
      const fileName = `ziner-settings-${new Date().toISOString().slice(0, 10)}.json`;

      if (this.native.isNative) {
        await this.native.writeFile({
          path: fileName,
          data: json,
          directory: 'Cache',
          recursive: true,
        });
        const ok = await this.native.share({
          title: 'Ziner 配置',
          text: 'Ziner 配置导出文件',
          dialogTitle: '导出配置',
        });
        if (!ok) {
          await this.native.copyToClipboard(json);
          this.showToast('已复制配置到剪贴板');
        } else {
          this.showToast('配置已导出');
        }
      } else {
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        a.click();
        URL.revokeObjectURL(url);
        this.showToast('配置已导出');
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.showToast(`导出失败：${msg}`);
    }
  }

  private handleImportFile(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      try {
        const text = reader.result as string;
        this.importSettings(text);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.showToast(`读取文件失败：${msg}`);
      } finally {
        input.value = '';
      }
    };
    reader.onerror = () => {
      this.showToast('读取文件失败');
      input.value = '';
    };
    reader.readAsText(file);
  }

  private async importSettings(jsonText: string): Promise<void> {
    try {
      const data = JSON.parse(jsonText);

      if (!data || typeof data !== 'object') {
        throw new Error('无效的配置文件格式');
      }
      if (data.app !== 'ziner') {
        throw new Error('不是有效的 Ziner 配置文件');
      }
      if (!data.settings || typeof data.settings !== 'object') {
        throw new Error('配置文件中没有设置数据');
      }

      const imported = data.settings;
      const confirmed = confirm(
        '确定要导入配置吗？\n\n这将覆盖当前的 API 设置、工具策略等所有配置。',
      );
      if (!confirmed) return;

      if (typeof imported.language === 'string') this.settings.language = imported.language;
      if (typeof imported.memoryEnabled === 'boolean') this.settings.memoryEnabled = imported.memoryEnabled;
      if (imported.storageBackend === 'sqlite' || imported.storageBackend === 'jsonl') {
        this.settings.storageBackend = imported.storageBackend;
      }
      if (imported.defaultModel && typeof imported.defaultModel === 'object') {
        this.settings.defaultModel = {
          provider: String(imported.defaultModel.provider ?? 'sglang'),
          name: String(imported.defaultModel.name ?? 'default'),
        };
      }
      if (typeof imported.apiKey === 'string') this.settings.apiKey = imported.apiKey;
      if (typeof imported.apiEndpoint === 'string') this.settings.apiEndpoint = imported.apiEndpoint;
      if (imported.mcdMcpToken !== undefined) this.settings.mcdMcpToken = imported.mcdMcpToken;
      if (imported.amapApiKey !== undefined) this.settings.amapApiKey = imported.amapApiKey;
      if (imported.runtimeServerUrl !== undefined) this.settings.runtimeServerUrl = imported.runtimeServerUrl;
      if (imported.runtimeApiKey !== undefined) this.settings.runtimeApiKey = imported.runtimeApiKey;
      if (imported.bridgeMode === 'local' || imported.bridgeMode === 'remote') {
        this.settings.bridgeMode = imported.bridgeMode;
      }
      if (imported.planMode === 'chat' || imported.planMode === 'plan' || imported.planMode === 'auto') {
        this.settings.planMode = imported.planMode;
      }
      if (imported.toolPolicy && typeof imported.toolPolicy === 'object') {
        this.settings.toolPolicy = {
          allow: Array.isArray(imported.toolPolicy.allow) ? imported.toolPolicy.allow.map(String) : [],
          deny: Array.isArray(imported.toolPolicy.deny) ? imported.toolPolicy.deny.map(String) : [],
          requireConfirm: Array.isArray(imported.toolPolicy.requireConfirm)
            ? imported.toolPolicy.requireConfirm.map(String)
            : undefined,
        };
      }

      this.saveSettings();
      this.applySettings();

      try {
        await this.bridge.close();
        this.bridge = createRuntimeBridge(this.settings.bridgeMode);
        await this.bridge.init(this.settings);
        this.setupBridgeEvents();
        this.updateStatusDot();
      } catch (e) {
        console.warn('Bridge re-init after import failed:', e);
      }

      this.showToast('配置导入成功');
      this.native.vibrateSuccess?.();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.showToast(`导入失败：${msg}`);
      this.native.vibrateError?.();
    }
  }

  private applySettings(): void {
    const memoryEnabledInput = document.getElementById('setting-memory-enabled') as HTMLInputElement | null;
    const storageBackendSelect = document.getElementById('setting-storage-backend') as HTMLSelectElement | null;
    const bridgeModeSelect = document.getElementById('setting-bridge-mode') as HTMLSelectElement | null;
    const planModeSelect = document.getElementById('setting-plan-mode') as HTMLSelectElement | null;
    const runtimeServerUrlInput = document.getElementById('setting-runtime-server-url') as HTMLInputElement | null;
    const runtimeApiKeyInput = document.getElementById('setting-runtime-apikey') as HTMLInputElement | null;
    const serverUrlGroup = document.getElementById('setting-runtime-server-group');
    const serverApiKeyGroup = document.getElementById('setting-runtime-apikey-group');
    const modelGroup = document.getElementById('setting-model-group');
    const mcpGroup = document.getElementById('setting-mcp-group');
    const toolAllowInput = document.getElementById('setting-tool-allow') as HTMLTextAreaElement | null;
    const toolDenyInput = document.getElementById('setting-tool-deny') as HTMLTextAreaElement | null;
    const toolConfirmInput = document.getElementById('setting-tool-confirm') as HTMLTextAreaElement | null;
    const providerSelect = document.getElementById('setting-provider') as HTMLSelectElement | null;
    const modelInput = document.getElementById('setting-model') as HTMLInputElement | null;
    const apiKeyInput = document.getElementById('setting-apikey') as HTMLInputElement | null;
    const endpointInput = document.getElementById('setting-endpoint') as HTMLInputElement | null;
    const mcdTokenInput = document.getElementById('setting-mcd-token') as HTMLInputElement | null;
    const amapKeyInput = document.getElementById('setting-amap-key') as HTMLInputElement | null;

    if (memoryEnabledInput) memoryEnabledInput.checked = this.settings.memoryEnabled;
    if (toolAllowInput) toolAllowInput.value = (this.settings.toolPolicy?.allow ?? []).join('\n');
    if (toolDenyInput) toolDenyInput.value = (this.settings.toolPolicy?.deny ?? []).join('\n');
    if (toolConfirmInput) toolConfirmInput.value = (this.settings.toolPolicy?.requireConfirm ?? []).join('\n');
    if (storageBackendSelect) storageBackendSelect.value = this.settings.storageBackend;
    if (bridgeModeSelect) bridgeModeSelect.value = this.settings.bridgeMode;
    if (planModeSelect) planModeSelect.value = this.settings.planMode ?? 'auto';
    if (runtimeServerUrlInput) runtimeServerUrlInput.value = this.settings.runtimeServerUrl ?? '';
    if (runtimeApiKeyInput) runtimeApiKeyInput.value = this.settings.runtimeApiKey ?? '';
    if (providerSelect) providerSelect.value = this.settings.defaultModel?.provider ?? 'sglang';
    if (modelInput) modelInput.value = this.settings.defaultModel?.name ?? '';
    if (apiKeyInput) apiKeyInput.value = this.settings.apiKey ?? '';
    if (endpointInput) endpointInput.value = this.settings.apiEndpoint ?? '';
    if (mcdTokenInput) mcdTokenInput.value = this.settings.mcdMcpToken ?? '';
    if (amapKeyInput) amapKeyInput.value = this.settings.amapApiKey ?? '';

    const isRemote = this.settings.bridgeMode === 'remote';
    const isLocal = this.settings.bridgeMode === 'local';

    if (serverUrlGroup) serverUrlGroup.style.display = isRemote ? '' : 'none';
    if (serverApiKeyGroup) serverApiKeyGroup.style.display = isRemote ? '' : 'none';
    if (modelGroup) modelGroup.style.display = isLocal ? '' : 'none';
    if (mcpGroup) mcpGroup.style.display = isLocal ? '' : 'none';
  }

  private async handleSaveSettings(): Promise<void> {
    const statusEl = document.getElementById('settings-status');

    try {
      const memoryEnabledInput = document.getElementById('setting-memory-enabled') as HTMLInputElement | null;
      const storageBackendSelect = document.getElementById('setting-storage-backend') as HTMLSelectElement | null;
      const bridgeModeSelect = document.getElementById('setting-bridge-mode') as HTMLSelectElement | null;
      const planModeSelect = document.getElementById('setting-plan-mode') as HTMLSelectElement | null;
      const runtimeServerUrlInput = document.getElementById('setting-runtime-server-url') as HTMLInputElement | null;
      const runtimeApiKeyInput = document.getElementById('setting-runtime-apikey') as HTMLInputElement | null;
      const providerSelect = document.getElementById('setting-provider') as HTMLSelectElement | null;
      const modelInput = document.getElementById('setting-model') as HTMLInputElement | null;
      const apiKeyInput = document.getElementById('setting-apikey') as HTMLInputElement | null;
      const endpointInput = document.getElementById('setting-endpoint') as HTMLInputElement | null;
      const mcdTokenInput = document.getElementById('setting-mcd-token') as HTMLInputElement | null;
      const amapKeyInput = document.getElementById('setting-amap-key') as HTMLInputElement | null;

      const oldBridgeMode = this.settings.bridgeMode;
      const oldPlanMode = this.settings.planMode;
      const oldServerUrl = this.settings.runtimeServerUrl;
      const oldApiKey = this.settings.apiKey;
      const oldApiEndpoint = this.settings.apiEndpoint;
      const oldModel = JSON.stringify(this.settings.defaultModel);
      const oldMcdToken = this.settings.mcdMcpToken;
      const oldAmapKey = this.settings.amapApiKey;
      const oldToolPolicy = JSON.stringify(this.settings.toolPolicy);

      this.settings.memoryEnabled = memoryEnabledInput?.checked ?? true;
      this.settings.storageBackend = (storageBackendSelect?.value as 'sqlite' | 'jsonl') ?? 'sqlite';
      this.settings.bridgeMode = (bridgeModeSelect?.value as 'local' | 'remote') ?? 'local';
      this.settings.planMode = (planModeSelect?.value as 'chat' | 'plan' | 'auto') ?? 'auto';
      this.settings.runtimeServerUrl = runtimeServerUrlInput?.value || undefined;
      this.settings.runtimeApiKey = runtimeApiKeyInput?.value || undefined;
      this.settings.defaultModel = {
        provider: providerSelect?.value ?? 'sglang',
        name: modelInput?.value.trim() ?? 'default',
      };
      this.settings.apiKey = apiKeyInput?.value ?? '';
      this.settings.apiEndpoint = endpointInput?.value ?? '';
      this.settings.mcdMcpToken = mcdTokenInput?.value.trim() || undefined;
      this.settings.amapApiKey = amapKeyInput?.value.trim() || undefined;

      // Read tool policy
      const toolAllowInput = document.getElementById('setting-tool-allow') as HTMLTextAreaElement | null;
      const toolDenyInput = document.getElementById('setting-tool-deny') as HTMLTextAreaElement | null;
      const toolConfirmInput = document.getElementById('setting-tool-confirm') as HTMLTextAreaElement | null;
      this.settings.toolPolicy = {
        allow: this.parsePolicyList(toolAllowInput?.value),
        deny: this.parsePolicyList(toolDenyInput?.value),
        requireConfirm: this.parsePolicyList(toolConfirmInput?.value),
      };

      this.saveSettings();
      this.applySettings();

      // If bridge mode, API config, or MCP config changed, re-initialize the bridge
      const bridgeChanged =
        oldBridgeMode !== this.settings.bridgeMode ||
        oldPlanMode !== this.settings.planMode ||
        oldServerUrl !== this.settings.runtimeServerUrl ||
        oldApiKey !== this.settings.apiKey ||
        oldApiEndpoint !== this.settings.apiEndpoint ||
        oldModel !== JSON.stringify(this.settings.defaultModel) ||
        oldMcdToken !== this.settings.mcdMcpToken ||
        oldAmapKey !== this.settings.amapApiKey ||
        oldToolPolicy !== JSON.stringify(this.settings.toolPolicy);

      if (bridgeChanged) {
        try {
          await this.bridge.close();
          this.bridge = createRuntimeBridge(this.settings.bridgeMode);
          await this.bridge.init(this.settings);
          this.setupBridgeEvents();
          this.updateStatusDot();
        } catch (e) {
          console.warn('Bridge re-init failed:', e);
        }
      }

      // Show feedback
      const saveBtn = document.getElementById('save-settings-btn');
      if (saveBtn) {
        const originalText = saveBtn.textContent;
        saveBtn.textContent = '已保存 ✓';
        setTimeout(() => {
          saveBtn.textContent = originalText;
        }, 1500);
      }
      if (statusEl) {
        statusEl.textContent = '设置已保存';
        statusEl.style.color = 'var(--success)';
        setTimeout(() => {
          statusEl.textContent = '';
        }, 2000);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('Save settings error:', err);
      if (statusEl) {
        statusEl.textContent = `保存失败: ${msg}`;
        statusEl.style.color = 'var(--danger)';
      }
    }
  }

  // ── Trace panel ───────────────────────────────────────────────────

  private async refreshTraceList(): Promise<void> {
    if (!this.bridge) return;
    const list = document.getElementById('trace-list');
    const detail = document.getElementById('trace-detail');
    if (!list || !detail) return;
    detail.innerHTML = '<p class="muted">选择左侧 run 查看详情</p>';

    try {
      const runs = await this.bridge.listTraceRuns(100);
      this.traceCache = runs;
      this.renderTraceList();
    } catch (e) {
      list.innerHTML = `<p class="muted">加载失败：${this.escapeHtml(String(e))}</p>`;
    }
  }

  private renderTraceList(): void {
    const list = document.getElementById('trace-list');
    if (!list) return;

    let runs = this.traceCache;

    if (this.traceStatusFilter !== 'all') {
      runs = runs.filter((r) => r.status === this.traceStatusFilter);
    }

    if (this.traceSearchQuery) {
      const q = this.traceSearchQuery.toLowerCase();
      runs = runs.filter((r) =>
        r.userMessage.toLowerCase().includes(q) ||
        r.assistantMessage?.toLowerCase().includes(q) ||
        r.skills?.some((s) => s.toLowerCase().includes(q)) ||
        r.mcpServers?.some((s) => s.toLowerCase().includes(q)),
      );
    }

    if (runs.length === 0) {
      list.innerHTML = '<p class="muted">没有匹配的 trace 记录</p>';
      return;
    }

    list.innerHTML = runs
      .map((r) => {
        const time = new Date(r.startTime).toLocaleTimeString();
        const dur = r.durationMs ? `${(r.durationMs / 1000).toFixed(1)}s` : '—';
        const tokens = r.totalTokens ? `${r.totalTokens} tok` : '';
        const skills = r.skills && r.skills.length > 0 ? `🎯 ${r.skills.join(', ')}` : '';
        const mcp = r.mcpServers && r.mcpServers.length > 0 ? `🔌 ${r.mcpServers.join(', ')}` : '';
        return `
          <div class="trace-item" data-runid="${this.escapeHtml(r.id)}">
            <div class="trace-item-msg">${this.escapeHtml(r.userMessage)}</div>
            <div class="trace-item-meta">
              <span class="trace-item-status ${r.status}">${r.status}</span>
              <span>${time}</span>
              <span>${dur}</span>
              <span>${r.llmCalls} LLM · ${r.toolCalls} tool</span>
              ${tokens ? `<span>${tokens}</span>` : ''}
              ${skills ? `<span>${this.escapeHtml(skills)}</span>` : ''}
              ${mcp ? `<span>${this.escapeHtml(mcp)}</span>` : ''}
            </div>
          </div>
        `;
      })
      .join('');

    list.querySelectorAll('.trace-item').forEach((el) => {
      el.addEventListener('click', () => {
        const runId = (el as HTMLElement).dataset.runid;
        if (runId) this.showTraceRun(runId);
        list.querySelectorAll('.trace-item').forEach((x) => x.classList.remove('active'));
        el.classList.add('active');
      });
    });
  }

  private async showTraceRun(runId: string): Promise<void> {
    if (!this.bridge) return;
    const detail = document.getElementById('trace-detail');
    if (!detail) return;
    detail.innerHTML = '<p class="muted">加载中...</p>';
    try {
      const r = await this.bridge.getTraceRun(runId);
      if (!r) {
        detail.innerHTML = '<p class="muted">未找到该 run。</p>';
        return;
      }
      const dur = r.durationMs ? `${(r.durationMs / 1000).toFixed(2)}s` : '—';
      const skills = r.skills && r.skills.length > 0 ? r.skills.join(', ') : '—';
      const mcp = r.mcpServers && r.mcpServers.length > 0 ? r.mcpServers.join(', ') : '—';
      const startTime = new Date(r.startTime).toLocaleString();

      const spanHtml = r.spans
        .map((s) => {
          const offset = s.startTime - r.startTime;
          const dur = s.durationMs ? `${s.durationMs}ms` : '—';
          const errLabel = s.error ? ` <span style="color:#f87171">${this.escapeHtml(s.error)}</span>` : '';
          const input = s.input ? JSON.stringify(s.input, null, 2).slice(0, 600) : '';
          const output = s.output
            ? typeof s.output === 'string'
              ? s.output.slice(0, 600)
              : JSON.stringify(s.output, null, 2).slice(0, 600)
            : '';
          return `
            <div class="trace-span">
              <div class="trace-span-time">
                +${offset}ms<br/>
                <span class="duration">${dur}</span>
              </div>
              <div class="trace-span-body">
                <div>
                  <span class="name">${this.escapeHtml(s.name)}</span>
                  <span class="type">${s.type}</span>
                  <span class="trace-item-status ${s.status}">${s.status}</span>
                </div>
                ${errLabel}
                ${input ? `<details><summary>输入</summary><pre>${this.escapeHtml(input)}</pre></details>` : ''}
                ${output ? `<details><summary>输出</summary><pre>${this.escapeHtml(output)}</pre></details>` : ''}
              </div>
            </div>
          `;
        })
        .join('');

      detail.innerHTML = `
        <div class="trace-detail-header">
          <h3>${this.escapeHtml(r.userMessage)}</h3>
          <div class="meta">开始：${startTime} · 时长：${dur} · LLM: ${r.llmCalls} · Tool: ${r.toolCalls}${r.totalTokens ? ' · ' + r.totalTokens + ' tok' : ''}</div>
          <div class="meta">状态：<span class="trace-item-status ${r.status}">${r.status}</span></div>
          <div class="meta">技能：${this.escapeHtml(skills)} · MCP：${this.escapeHtml(mcp)}</div>
          ${r.error ? `<div class="meta" style="color:#f87171">错误：${this.escapeHtml(r.error)}</div>` : ''}
          <div style="margin-top:8px"><button class="btn-secondary" id="trace-delete-btn" style="font-size:0.8em;padding:4px 10px">删除</button></div>
        </div>
        <h4 style="font-size:13px;margin:0 0 8px">Spans</h4>
        ${spanHtml || '<p class="muted">无 span</p>'}
      `;

      const delBtn = document.getElementById('trace-delete-btn');
      delBtn?.addEventListener('click', async () => {
        if (confirm('删除该 run？')) {
          await this.bridge!.deleteTraceRun(runId);
          this.refreshTraceList();
        }
      });
    } catch (e) {
      detail.innerHTML = `<p class="muted">加载失败：${this.escapeHtml(String(e))}</p>`;
    }
  }

  private async setupTracePanel(): Promise<void> {
    const clearBtn = document.getElementById('btn-clear-trace');
    clearBtn?.addEventListener('click', async () => {
      if (!this.bridge) return;
      if (!confirm('清空所有 trace 记录？此操作不可恢复。')) return;
      await this.bridge.clearTrace();
      this.traceCache = [];
      this.renderTraceList();
    });

    const statusTabs = document.getElementById('trace-status-tabs');
    if (statusTabs) {
      statusTabs.querySelectorAll('.trace-tab').forEach((tab) => {
        tab.addEventListener('click', () => {
          const status = (tab as HTMLElement).dataset.status as 'all' | 'running' | 'ok' | 'error';
          if (!status) return;
          this.traceStatusFilter = status;
          statusTabs.querySelectorAll('.trace-tab').forEach((t) => t.classList.remove('active'));
          tab.classList.add('active');
          this.renderTraceList();
        });
      });
    }

    const searchInput = document.getElementById('trace-search') as HTMLInputElement | null;
    if (searchInput) {
      searchInput.addEventListener('input', () => {
        this.traceSearchQuery = searchInput.value.trim();
        this.renderTraceList();
      });
    }
  }

  // ── Tool Policy settings UI ──────────────────────────────────────

  private parsePolicyList(text: string | undefined): string[] {
    if (!text) return [];
    return text
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
}

// Initialize app
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => new MobileApp());
} else {
  new MobileApp();
}

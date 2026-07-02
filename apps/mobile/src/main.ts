// Z Code Mobile - Main Application
//
// Integrates the MobileRuntimeBridge with the mobile UI.
// Features:
//   - Bottom navigation (Chat / Memory / Settings)
//   - Chat interface with streaming support
//   - Memory listing and search
//   - Settings persistence with bridge mode selection

import { createRuntimeBridge } from './bridge';
import type { AppSettings, MobileRuntimeBridge, ChatMessage, MemoryRecord } from './bridge/types';
import { getNativeCapabilities, type NativeCapabilities } from './native';

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
  runtimeServerUrl: '',
  runtimeApiKey: '',
};

class MobileApp {
  private settings: AppSettings;
  private bridge: MobileRuntimeBridge;
  private native: NativeCapabilities;
  private currentPage = 'chat';
  private currentConversation = 'default';
  private isSending = false;

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
    this.setupTracePanel();
    this.setupNativeCapabilities();
    this.applySettings();
    this.setupBridgeEvents();

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

    sendBtn.addEventListener('click', () => this.sendMessage());

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
      const sessions = await this.bridge.listTraceSessions?.(50);
      if (!sessions || sessions.length === 0) {
        listEl.innerHTML = '<div class="session-empty">暂无对话记录</div>';
        return;
      }

      listEl.innerHTML = sessions
        .map((s) => {
          const title = s.title || '新对话';
          const time = this.formatTime(s.updatedAt);
          const active = s.id === this.currentConversation ? 'active' : '';
          return `
            <div class="session-item ${active}" data-id="${s.id}">
              <div class="session-item-title">${this.escapeHtml(title)}</div>
              <div class="session-item-meta">
                <span>${time}</span>
                <span>${s.messageCount} 条</span>
              </div>
            </div>
          `;
        })
        .join('');

      listEl.querySelectorAll('.session-item').forEach((item) => {
        item.addEventListener('click', () => {
          const id = item.getAttribute('data-id');
          if (id) this.switchConversation(id);
        });
      });
    } catch (e) {
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
      const runs = await this.bridge.listTraceRuns?.(20, id);
      if (!runs || runs.length === 0) {
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
      for (const run of runs) {
        if (run.userMessage) {
          this.addMessage({
            id: `user-${run.id}`,
            role: 'user',
            content: run.userMessage,
            createdAt: run.startTime,
          });
        }
        if (run.assistantMessage) {
          this.addMessage({
            id: `assistant-${run.id}`,
            role: 'assistant',
            content: run.assistantMessage,
            createdAt: run.startTime + (run.durationMs || 0),
          });
        }
      }
      container.scrollTop = container.scrollHeight;
    } catch (e) {
      container.innerHTML = '<div class="session-empty">加载失败</div>';
    }
  }

  private newConversation(): void {
    if (this.isSending) return;
    this.currentConversation = `conv-${Date.now()}`;
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
  }

  private async sendMessage(): Promise<void> {
    if (this.isSending) return;

    const input = document.getElementById('chat-input') as HTMLTextAreaElement;
    const text = input.value.trim();
    if (!text) return;

    this.addMessage({
      id: `user-${Date.now()}`,
      role: 'user',
      content: text,
      createdAt: Date.now(),
    });

    input.value = '';
    input.style.height = 'auto';
    this.isSending = true;
    this.setSendButtonEnabled(false);

    // Show typing indicator
    const assistantMsgId = `assistant-${Date.now()}`;
    this.addMessage({
      id: assistantMsgId,
      role: 'assistant',
      content: '',
      createdAt: Date.now(),
      streaming: true,
    });

    try {
      if (this.bridge.streamChat) {
        await this.bridge.streamChat(
          text,
          this.currentConversation,
          (_delta, fullMessage) => {
            this.updateMessageContent(assistantMsgId, fullMessage);
          },
        );
      } else {
        const response = await this.bridge.sendChat(text, this.currentConversation);
        this.updateMessageContent(assistantMsgId, response.content);
      }
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      this.updateMessageContent(assistantMsgId, `⚠️ 出错了：${errorMsg}`);
    } finally {
      this.removeStreamingFlag(assistantMsgId);
      this.isSending = false;
      this.setSendButtonEnabled(true);
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

  private setSendButtonEnabled(enabled: boolean): void {
    const btn = document.getElementById('send-btn') as HTMLButtonElement;
    if (btn) btn.disabled = !enabled;
  }

  private formatMessageContent(text: string): string {
    return text
      .split('\n')
      .map((p) => p.trim() ? `<p>${this.escapeHtml(p)}</p>` : '')
      .filter(Boolean)
      .join('');
  }

  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // ── Memory ────────────────────────────────────────────────────────

  private async refreshMemoryList(): Promise<void> {
    const countEl = document.getElementById('memory-count');
    const listEl = document.getElementById('memory-list');

    if (!countEl || !listEl) return;

    listEl.innerHTML = '<div class="empty-state"><p>加载中...</p></div>';

    try {
      const memories = await this.bridge.listMemories({ limit: 50 });
      countEl.textContent = String(memories.length);

      if (memories.length === 0) {
        listEl.innerHTML = `
          <div class="empty-state">
            <p>还没有记忆</p>
            <p class="muted">和我聊天，我会记住重要的信息</p>
          </div>
        `;
        return;
      }

      listEl.innerHTML = memories.map((m) => `
        <div class="memory-item" data-id="${m.id}">
          <div class="memory-item-header">
            <span class="memory-tag">${this.memoryKindLabel(m.kind)}</span>
            <span class="memory-time">${this.formatTime(m.createdAt)}</span>
          </div>
          <div class="memory-content">${this.escapeHtml(m.content)}</div>
        </div>
      `).join('');
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      listEl.innerHTML = `
        <div class="empty-state">
          <p>加载失败</p>
          <p class="muted">${this.escapeHtml(errorMsg)}</p>
        </div>
      `;
    }
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
      const runtimeServerUrlInput = document.getElementById('setting-runtime-server-url') as HTMLInputElement | null;
      const runtimeApiKeyInput = document.getElementById('setting-runtime-apikey') as HTMLInputElement | null;
      const providerSelect = document.getElementById('setting-provider') as HTMLSelectElement | null;
      const modelInput = document.getElementById('setting-model') as HTMLInputElement | null;
      const apiKeyInput = document.getElementById('setting-apikey') as HTMLInputElement | null;
      const endpointInput = document.getElementById('setting-endpoint') as HTMLInputElement | null;
      const mcdTokenInput = document.getElementById('setting-mcd-token') as HTMLInputElement | null;
      const amapKeyInput = document.getElementById('setting-amap-key') as HTMLInputElement | null;

      const oldBridgeMode = this.settings.bridgeMode;
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
      const runs = await this.bridge.listTraceRuns(50);
      if (runs.length === 0) {
        list.innerHTML = '<p class="muted">还没有 trace 数据，发起一次对话后会出现。</p>';
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
    } catch (e) {
      list.innerHTML = `<p class="muted">加载失败：${this.escapeHtml(String(e))}</p>`;
    }
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
      this.refreshTraceList();
    });
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

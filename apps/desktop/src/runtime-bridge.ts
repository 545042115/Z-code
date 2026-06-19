// @z-assistant/app-desktop — runtime bridge

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import {
  VSCodeConnector,
  type VSCodeConnectorConfig,
  type ConnectorEvent,
} from '@z-assistant/app-vscode-connector';
import type { AgentRun, AgentSpan, MemoryHit } from '@z-assistant/contracts';
import { SessionManager } from './session-manager';

export interface DesktopSettings {
  defaultModel: { provider: string; name: string };
  memoryEnabled: boolean;
  storageDir: string;
  language: string;
  apiKey: string;
  apiEndpoint: string;
  projectDir: string;
  /** WeChat Hook configuration (WeChatFerry DLL injection) */
  wechatHook: { enabled: boolean };
  /** QQ OneBot configuration (NapCat + OneBot protocol) */
  qq: { enabled: boolean; wsUrl?: string };
}

const DEFAULT_SETTINGS: DesktopSettings = {
  defaultModel: { provider: 'sglang', name: 'default' },
  memoryEnabled: true,
  storageDir: path.join(os.homedir(), '.z-assistant', 'desktop'),
  language: 'zh-CN',
  apiKey: '',
  apiEndpoint: '',
  projectDir: process.cwd(),
  wechatHook: { enabled: false },
  qq: { enabled: false },
};

export class RuntimeBridge {
  private connector: VSCodeConnector | null = null;
  private settings: DesktopSettings;
  private eventListeners = new Set<(e: ConnectorEvent) => void>();
  private wechatHookStatusListeners = new Set<(s: { online: boolean; nickname: string; wxid: string; messageCount: number }) => void>();
  private qqStatusListeners = new Set<(s: { online: boolean; nickname: string; userId: string; messageCount: number; lastEvent: string }) => void>();
  private settingsPath: string;
  private _sessions: SessionManager;

  constructor(settings?: Partial<DesktopSettings>) {
    this.settings = { ...DEFAULT_SETTINGS, ...settings };
    this.settingsPath = path.join(this.settings.storageDir, 'settings.json');
    this.loadSettings();
    this._sessions = new SessionManager(this.settings.storageDir);
  }

  get sessions(): SessionManager { return this._sessions; }

  private loadSettings(): void {
    try {
      if (fs.existsSync(this.settingsPath)) {
        const raw = fs.readFileSync(this.settingsPath, 'utf-8');
        const saved = JSON.parse(raw);
        this.settings = { ...DEFAULT_SETTINGS, ...saved };
      }
    } catch { /* ignore */ }
  }

  private saveSettings(): void {
    try {
      const dir = path.dirname(this.settingsPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.settingsPath, JSON.stringify(this.settings, null, 2), 'utf-8');
    } catch (e) {
      console.error('[RuntimeBridge] save settings error:', e);
    }
  }

  get storageDir(): string { return this.settings.storageDir; }

  async start(): Promise<void> {
    if (this.connector) return;
    const config: VSCodeConnectorConfig = {
      storageDir: this.settings.storageDir,
      projectKey: 'desktop',
      defaultModel: this.settings.defaultModel,
      apiKey: this.settings.apiKey || undefined,
      apiEndpoint: this.settings.apiEndpoint || undefined,
      projectDir: this.settings.projectDir,
    };
    this.connector = new VSCodeConnector(config);
    this.connector.onEvent((e) => {
      for (const l of this.eventListeners) l(e);
    });
    await this.connector.start();
  }

  async stop(): Promise<void> {
    await this.connector?.stop();
    this.connector = null;
  }

  isReady(): boolean { return this.connector?.isReady() ?? false; }

  async runTask(task: string, sessionId?: string): Promise<{ runId: string; result?: string }> {
    if (!this.connector) throw new Error('Runtime not started');
    return this.connector.runTask(task, 'desktop', sessionId);
  }

  async listRuns(limit = 50, sessionId?: string): Promise<AgentRun[]> {
    const store = this.connector?.store();
    if (!store) return [];
    return store.runs.list(sessionId ? { limit, sessionId } : { limit });
  }

  async getRun(runId: string): Promise<AgentRun | undefined> {
    return this.connector?.store()?.runs.get(runId);
  }

  async getSpans(runId: string): Promise<AgentSpan[]> {
    const store = this.connector?.store();
    if (!store) return [];
    return store.spans.listByRun(runId, { limit: 1000 });
  }

  onEvent(fn: (e: ConnectorEvent) => void): () => void {
    this.eventListeners.add(fn);
    return () => this.eventListeners.delete(fn);
  }

  onWeChatHookStatus(fn: (s: { online: boolean; nickname: string; wxid: string; messageCount: number }) => void): () => void {
    this.wechatHookStatusListeners.add(fn);
    return () => this.wechatHookStatusListeners.delete(fn);
  }

  onQQStatus(fn: (s: { online: boolean; nickname: string; userId: string; messageCount: number; lastEvent: string }) => void): () => void {
    this.qqStatusListeners.add(fn);
    return () => this.qqStatusListeners.delete(fn);
  }

  getSettings(): DesktopSettings { return { ...this.settings }; }

  updateSettings(patch: Partial<DesktopSettings>): DesktopSettings {
    this.settings = { ...this.settings, ...patch };
    this.saveSettings();
    if (this.connector) {
      this.connector.config.defaultModel = this.settings.defaultModel;
      this.connector.config.apiKey = this.settings.apiKey || undefined;
      this.connector.config.apiEndpoint = this.settings.apiEndpoint || undefined;
      this.connector.config.projectDir = this.settings.projectDir;
    }
    return this.getSettings();
  }

  async recallMemory(query: string, limit = 10): Promise<MemoryHit[]> {
    void query; void limit;
    return [];
  }

  // ── WeChat Hook (WeChatFerry DLL injection) ───────────────────

  async startWeChatHook(config?: { nickname?: string }): Promise<void> {
    if (!this.connector) throw new Error('Runtime not started');
    this.connector.onWeChatHookStatus((s) => {
      for (const fn of this.wechatHookStatusListeners) fn(s);
    });
    await this.connector.startWeChatHook({ enabled: true, nickname: config?.nickname });
  }

  async stopWeChatHook(): Promise<void> {
    await this.connector?.stopWeChatHook();
  }

  getWeChatHookStatus(): { online: boolean; nickname: string; wxid: string; messageCount: number } {
    if (!this.connector) return { online: false, nickname: '', wxid: '', messageCount: 0 };
    return this.connector.wechatHook.status;
  }

  // ── QQ OneBot (NapCat + OneBot protocol) ────────────────────

  async startQQ(config?: { wsUrl?: string; accessToken?: string; nickname?: string }): Promise<void> {
    if (!this.connector) throw new Error('Runtime not started');
    this.connector.onQQStatus((s) => {
      for (const fn of this.qqStatusListeners) fn(s);
    });
    await this.connector.startQQ({
      wsUrl: config?.wsUrl || 'ws://localhost:3001',
      accessToken: config?.accessToken,
      nickname: config?.nickname,
    });
  }

  async stopQQ(): Promise<void> {
    await this.connector?.stopQQ();
  }

  getQQStatus(): { online: boolean; nickname: string; userId: string; messageCount: number; lastEvent: string } {
    if (!this.connector) return { online: false, nickname: '', userId: '', messageCount: 0, lastEvent: '' };
    return this.connector.qq.status;
  }

  // ── Chat Profile ──────────────────────────────────────────────

  getProfile(): { count: number; description: string | null; enabled: boolean } {
    if (!this.connector) return { count: 0, description: null, enabled: true };
    return {
      count: this.connector.profile.count,
      description: this.connector.profile.profile?.description ?? null,
      enabled: this.connector.profileEnabled,
    };
  }

  rebuildProfile(): void { if (this.connector) this.connector.profile.rebuild(); }
  setProfileEnabled(enabled: boolean): void { if (this.connector) this.connector.profileEnabled = enabled; }
  clearProfile(): void { if (this.connector) this.connector.profile.clear(); }
}

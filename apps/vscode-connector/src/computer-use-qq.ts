// Computer-Use QQ Service — controls QQ via UIAutomation
//
// Uses Windows Automation API to read chat messages and send replies
// directly from the QQ UI tree. No OCR, no screenshots, no protocol login.

import { ComputerUseService } from './computer-use-service';

export interface CUQQConfig {
  enabled: boolean;
  windowTitle?: string;
  pollInterval?: number;
}

export interface CUQQStatus {
  online: boolean;
  nickname: string;
  messageCount: number;
}

export type CUQQMessageHandler = (msg: {
  sender: string;
  text: string;
  isGroup: boolean;
  groupName?: string;
}) => void;

export class ComputerUseQQService {
  private cu: ComputerUseService;
  private _config: CUQQConfig | null = null;
  private _running = false;
  private _pollTimer: ReturnType<typeof setInterval> | null = null;
  private _messageHandler: CUQQMessageHandler | null = null;
  private _knownTexts = new Set<string>();
  private _status: CUQQStatus = { online: false, nickname: '', messageCount: 0 };

  constructor(cu: ComputerUseService) {
    this.cu = cu;
  }

  get status(): CUQQStatus { return { ...this._status }; }
  get config(): CUQQConfig | null { return this._config; }

  onMessage(handler: CUQQMessageHandler): void {
    this._messageHandler = handler;
  }

  async connect(config: CUQQConfig): Promise<void> {
    this._config = config;
    if (!this.cu.ready) await this.cu.init();

    const windows = await this.cu.findWindows(config.windowTitle ?? 'QQ');
    if (windows.length === 0) {
      throw new Error('QQ窗口未找到，请先打开QQ');
    }

    this._status.online = true;
    this._status.nickname = 'QQ (UIA)';
    this._running = true;

    // Seed known texts
    await this.sleep(500);
    const existing = await this.cu.readWindowText(config.windowTitle ?? 'QQ');
    for (const item of existing) {
      if (item.text) this._knownTexts.add(item.text);
    }

    const interval = config.pollInterval ?? 2000;
    this._pollTimer = setInterval(() => this._poll(), interval);

    console.log('[CU-QQ] Connected via UIAutomation');
  }

  async disconnect(): Promise<void> {
    this._running = false;
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
    this._status.online = false;
    console.log('[CU-QQ] Disconnected');
  }

  /** Send a text message to a contact or group. */
  async sendMessage(targetName: string, text: string): Promise<void> {
    if (!this._running) throw new Error('QQ not connected');
    const title = this._config?.windowTitle ?? 'QQ';

    await this.cu.focusWindow(title);
    await this.sleep(300);

    // QQ typically has a search bar
    await this.cu.clickElement(title, '搜索');
    await this.sleep(300);

    await this.cu.typeText(targetName);
    await this.sleep(500);
    await this.cu.pressKey('Enter');
    await this.sleep(500);

    await this.cu.typeText(text);
    await this.sleep(200);
    await this.cu.pressKey('Enter');
    await this.sleep(300);

    this._status.messageCount++;
    console.log(`[CU-QQ] Sent to ${targetName}: ${text}`);
  }

  // ── Private ────────────────────────────────────────────────────

  private async _poll(): Promise<void> {
    if (!this._running || !this._messageHandler) return;

    try {
      const items = await this.cu.readWindowText(this._config?.windowTitle ?? 'QQ');
      const newTexts: Array<{ text: string; controlType: string; name: string }> = [];

      for (const item of items) {
        if (item.text && !this._knownTexts.has(item.text)) {
          this._knownTexts.add(item.text);
          newTexts.push(item);
        }
      }

      if (newTexts.length > 0) {
        console.log(`[CU-QQ] Detected ${newTexts.length} new text items`);

        for (const item of newTexts) {
          const sender = item.name || 'unknown';
          this._messageHandler({
            sender,
            text: item.text,
            isGroup: false,
          });
        }
      }
    } catch (e: any) {
      console.error('[CU-QQ] Poll error:', e.message);
    }
  }

  private async sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}

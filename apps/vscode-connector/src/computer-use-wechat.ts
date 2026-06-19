// Computer-Use WeChat Service — controls WeChat via UIAutomation
//
// Uses Windows Automation API to read chat messages and send replies
// directly from the WeChat UI tree. No OCR, no screenshots, no DLL injection.

import { ComputerUseService } from './computer-use-service';

export interface CUWeChatConfig {
  enabled: boolean;
  windowTitle?: string;
  pollInterval?: number;
}

export interface CUWeChatStatus {
  online: boolean;
  nickname: string;
  messageCount: number;
}

export type CUWeChatMessageHandler = (msg: {
  sender: string;
  text: string;
  isGroup: boolean;
  groupName?: string;
}) => void;

export class ComputerUseWeChatService {
  private cu: ComputerUseService;
  private _config: CUWeChatConfig | null = null;
  private _running = false;
  private _pollTimer: ReturnType<typeof setInterval> | null = null;
  private _messageHandler: CUWeChatMessageHandler | null = null;
  private _knownTexts = new Set<string>();
  private _status: CUWeChatStatus = { online: false, nickname: '', messageCount: 0 };

  constructor(cu: ComputerUseService) {
    this.cu = cu;
  }

  get status(): CUWeChatStatus { return { ...this._status }; }
  get config(): CUWeChatConfig | null { return this._config; }

  onMessage(handler: CUWeChatMessageHandler): void {
    this._messageHandler = handler;
  }

  async connect(config: CUWeChatConfig): Promise<void> {
    this._config = config;
    if (!this.cu.ready) await this.cu.init();

    const windows = await this.cu.findWindows(config.windowTitle ?? '微信');
    if (windows.length === 0) {
      throw new Error('微信窗口未找到，请先打开微信');
    }

    this._status.online = true;
    this._status.nickname = 'WeChat (UIA)';
    this._running = true;

    // Seed known texts to avoid treating existing messages as new
    await this.sleep(500);
    const existing = await this.cu.readWindowText(config.windowTitle ?? '微信');
    for (const item of existing) {
      if (item.text) this._knownTexts.add(item.text);
    }

    const interval = config.pollInterval ?? 2000;
    this._pollTimer = setInterval(() => this._poll(), interval);

    console.log('[CU-WeChat] Connected via UIAutomation');
  }

  async disconnect(): Promise<void> {
    this._running = false;
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
    this._status.online = false;
    console.log('[CU-WeChat] Disconnected');
  }

  /** Send a text message to a contact or group. */
  async sendMessage(targetName: string, text: string): Promise<void> {
    if (!this._running) throw new Error('WeChat not connected');
    const title = this._config?.windowTitle ?? '微信';

    // Focus WeChat window
    await this.cu.focusWindow(title);
    await this.sleep(300);

    // Try to find and click the search box, then type the contact name
    const searchClicked = await this.cu.clickElement(title, '搜索');
    if (searchClicked) {
      await this.sleep(300);
    }

    // Type contact name and press Enter
    await this.cu.typeText(targetName);
    await this.sleep(500);
    await this.cu.pressKey('Enter');
    await this.sleep(500);

    // Type message and send
    await this.cu.typeText(text);
    await this.sleep(200);
    await this.cu.pressKey('Enter');
    await this.sleep(300);

    this._status.messageCount++;
    console.log(`[CU-WeChat] Sent to ${targetName}: ${text}`);
  }

  // ── Private ────────────────────────────────────────────────────

  private async _poll(): Promise<void> {
    if (!this._running || !this._messageHandler) return;

    try {
      const items = await this.cu.readWindowText(this._config?.windowTitle ?? '微信');
      const newTexts: Array<{ text: string; controlType: string; name: string }> = [];

      for (const item of items) {
        if (item.text && !this._knownTexts.has(item.text)) {
          this._knownTexts.add(item.text);
          newTexts.push(item);
        }
      }

      if (newTexts.length > 0) {
        console.log(`[CU-WeChat] Detected ${newTexts.length} new text items`);

        for (const item of newTexts) {
          // Try to identify the sender from the element name or context
          const sender = item.name || 'unknown';
          this._messageHandler({
            sender,
            text: item.text,
            isGroup: false,
          });
        }
      }
    } catch (e: any) {
      console.error('[CU-WeChat] Poll error:', e.message);
    }
  }

  private async sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}

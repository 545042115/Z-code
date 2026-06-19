// WeChat Hook Service — uses WeChatFerry (DLL injection) to intercept all WeChat messages
// Requires: Windows 64-bit, WeChat installed and logged in
//
// NOTE: wechatferry is an ESM package that also ships a CJS build (dist/index.cjs).
// We use createRequire + direct .cjs path to bypass the "exports" field restriction,
// which prevents require('wechatferry/dist/index.cjs'). This approach also handles
// Electron's asar packaging correctly via require.resolve().
import type { Wechatferry as WechatferryType } from 'wechatferry';
import { createRequire } from 'module';
import * as path from 'path';

// We'll store the constructor here
let WechatferryCtor: typeof WechatferryType | null = null;

function ensureWechatferry(): typeof WechatferryType {
  if (!WechatferryCtor) {
    // 1. Resolve the main entry to get the package location (works with asar)
    const mainPath = require.resolve('wechatferry');
    // 2. Go up from dist/index.mjs to the package root
    const pkgRoot = path.dirname(path.dirname(mainPath));
    // 3. Create a require function scoped to the package root
    const req = createRequire(path.join(pkgRoot, 'noop.js'));
    // 4. Load the CJS build directly (bypasses exports field)
    const mod = req('./dist/index.cjs');
    WechatferryCtor = mod.Wechatferry;
  }
  return WechatferryCtor!;
}

export interface WeChatHookConfig {
  enabled: boolean;
  /** WeChat nickname — used for @-mention detection in group chats */
  nickname?: string;
}

export interface WeChatHookStatus {
  online: boolean;
  nickname: string;
  wxid: string;
  messageCount: number;
  lastPollInfo: string;
}

export type WeChatHookMessageHandler = (msg: {
  fromWxid: string;
  fromName: string;
  text: string;
  isGroup: boolean;
  roomId?: string;
  msgId: string;
}) => void;

/** Handler for messages sent by the user themselves (for style profiling). */
export type WeChatHookSelfMessageHandler = (msg: {
  text: string;
  timestamp: number;
}) => void;

export class WeChatHookService {
  private _wcf: WechatferryType | null = null;
  private _running = false;
  private _messageHandler: WeChatHookMessageHandler | null = null;
  private _selfMessageHandler: WeChatHookSelfMessageHandler | null = null;
  private _status: WeChatHookStatus = {
    online: false,
    nickname: '',
    wxid: '',
    messageCount: 0,
    lastPollInfo: '',
  };
  private _loginCheckTimer: ReturnType<typeof setInterval> | null = null;
  /** Callback fired when status changes */
  onStatusChange: ((s: WeChatHookStatus) => void) | null = null;

  get status(): WeChatHookStatus {
    return { ...this._status };
  }

  onMessage(handler: WeChatHookMessageHandler): void {
    this._messageHandler = handler;
  }

  /** Register a handler for messages sent by the user themselves (for style profiling). */
  onSelfMessage(handler: WeChatHookSelfMessageHandler): void {
    this._selfMessageHandler = handler;
  }

  async connect(_config: WeChatHookConfig): Promise<void> {
    if (this._running) return;

    this._status.lastPollInfo = '正在启动 WeChatFerry...';
    this._emitStatus();

    try {
      const Wechatferry = ensureWechatferry();
      this._wcf = new Wechatferry();
    } catch (e: any) {
      this._status.lastPollInfo = `WeChatFerry 加载失败: ${e?.message || '未知错误'}`;
      this._emitStatus();
      throw new Error(`WeChatFerry 加载失败: ${e?.message || '请确保微信已安装且版本为 3.9.12.17'}`);
    }

    // Listen for messages from WeChat
    this._wcf.on('message', (rawMsg: any) => {
      try {
        // The message from @wechatferry/core is a protobuf object with toObject()
        const obj = typeof rawMsg.toObject === 'function' ? rawMsg.toObject() : rawMsg;
        const msg = obj as {
          id: string;
          type: number;
          is_self: boolean;
          is_group: boolean;
          sender: string;
          roomid: string;
          content: string;
          sign?: string;
        };

        // Only handle text messages (type 1)
        if (msg.type !== 1) return;

        const text = msg.content || '';
        if (!text) return;

        // Self-sent messages → route to style profile
        if (msg.is_self) {
          this._selfMessageHandler?.({ text, timestamp: Date.now() });
          return;
        }

        const isGroup = msg.is_group || !!msg.roomid;
        const fromWxid = msg.sender || '';
        const fromName = msg.sign || '';

        this._status.messageCount++;
        this._status.lastPollInfo = `收到消息: ${text.slice(0, 30)}`;
        this._emitStatus();

        this._messageHandler?.({
          fromWxid,
          fromName,
          text,
          isGroup,
          roomId: msg.roomid || undefined,
          msgId: String(msg.id),
        });
      } catch (e) {
        console.error('[WeChat-Hook] Error handling message:', e);
      }
    });

    // Start the WeChatFerry SDK (injects sdk.dll into WeChat)
    try {
      this._wcf.start();
    } catch (e: any) {
      this._status.lastPollInfo = `启动失败: ${e.message}`;
      this._emitStatus();
      throw new Error(`WeChatFerry 启动失败: ${e.message}`);
    }

    this._status.lastPollInfo = '正在检测微信登录状态...';
    this._emitStatus();

    // Start polling for login status
    this._startLoginCheck();
  }

  private _startLoginCheck(): void {
    let attempts = 0;
    this._loginCheckTimer = setInterval(() => {
      if (!this._wcf) return;
      attempts++;
      try {
        const loggedIn = this._wcf.isLogin();
        if (loggedIn && !this._status.online) {
          const userInfo = this._wcf.getUserInfo();
          this._status.online = true;
          this._status.nickname = userInfo.name || 'WeChat (Hook)';
          this._status.wxid = userInfo.wxid || '';
          this._status.lastPollInfo = '已连接';
          this._running = true;
          this._emitStatus();
          // Stop login check once connected
          if (this._loginCheckTimer) {
            clearInterval(this._loginCheckTimer);
            this._loginCheckTimer = null;
          }
          console.log('[WeChat-Hook] Connected:', userInfo.name);
        } else if (!loggedIn && attempts > 5) {
          this._status.lastPollInfo = '等待微信登录... 请在微信客户端扫码登录';
          this._emitStatus();
        }
      } catch (e) {
        console.error('[WeChat-Hook] Login check error:', e);
        if (attempts > 10) {
          this._status.lastPollInfo = '登录检测失败，请确保微信已打开并登录';
          this._emitStatus();
        }
      }
    }, 2000);
  }

  async disconnect(): Promise<void> {
    this._running = false;
    if (this._loginCheckTimer) {
      clearInterval(this._loginCheckTimer);
      this._loginCheckTimer = null;
    }
    if (this._wcf) {
      try {
        this._wcf.stop();
      } catch (e) {
        console.error('[WeChat-Hook] Stop error:', e);
      }
      this._wcf = null;
    }
    this._status.online = false;
    this._status.lastPollInfo = '已断开';
    this._emitStatus();
  }

  async sendMessage(toWxid: string, text: string, mentions?: string[]): Promise<boolean> {
    if (!this._wcf || !this._running) {
      console.error('[WeChat-Hook] Cannot send: not connected');
      return false;
    }
    try {
      const result = this._wcf.sendTxt(text, toWxid, mentions);
      return result === 0;
    } catch (e: any) {
      console.error('[WeChat-Hook] Send error:', e.message);
      return false;
    }
  }

  private _emitStatus(): void {
    this.onStatusChange?.(this.status);
  }
}

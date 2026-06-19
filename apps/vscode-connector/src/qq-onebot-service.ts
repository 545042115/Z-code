// QQ OneBot Service — connects to NapCat via OneBot WebSocket protocol
// NapCat exposes a WebSocket server that speaks the OneBot v11 protocol.
// This service connects as a client and listens for messages.

import WebSocket from 'ws';

export interface QQOneBotConfig {
  /** WebSocket URL of NapCat (e.g. ws://localhost:3001) */
  wsUrl: string;
  /** Access token if NapCat WebSocket server requires one */
  accessToken?: string;
  /** QQ nickname — used for @-mention detection in group chats */
  nickname?: string;
}

export interface QQOneBotStatus {
  online: boolean;
  nickname: string;
  userId: string;
  messageCount: number;
  lastEvent: string;
}

export type QQOneBotMessageHandler = (msg: {
  fromId: string;
  fromName: string;
  text: string;
  isGroup: boolean;
  groupId?: string;
  msgId: string;
}) => void;

/** Handler for messages sent by the user themselves (for style profiling). */
export type QQOneBotSelfMessageHandler = (msg: {
  text: string;
  timestamp: number;
}) => void;

export class QQOneBotService {
  private _ws: WebSocket | null = null;
  private _running = false;
  private _selfId: string = '';
  private _messageHandler: QQOneBotMessageHandler | null = null;
  private _selfMessageHandler: QQOneBotSelfMessageHandler | null = null;
  private _heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private _status: QQOneBotStatus = {
    online: false,
    nickname: '',
    userId: '',
    messageCount: 0,
    lastEvent: '',
  };
  private _config: QQOneBotConfig = { wsUrl: 'ws://localhost:3001' };
  /** Callback fired when status changes */
  onStatusChange: ((s: QQOneBotStatus) => void) | null = null;

  get status(): QQOneBotStatus {
    return { ...this._status };
  }

  onMessage(handler: QQOneBotMessageHandler): void {
    this._messageHandler = handler;
  }

  /** Register a handler for messages sent by the user themselves (for style profiling). */
  onSelfMessage(handler: QQOneBotSelfMessageHandler): void {
    this._selfMessageHandler = handler;
  }

  async connect(config: QQOneBotConfig): Promise<void> {
    // Clean up any previous connection first
    await this.disconnect().catch(() => {});
    this._config = config;

    this._status.lastEvent = '正在连接 NapCat...';
    this._emitStatus();

    return new Promise((resolve, reject) => {
      let settled = false;
      try {
        // Build URL with optional access_token query parameter (OneBot v11 standard)
        let wsUrl = config.wsUrl;
        if (config.accessToken) {
          const separator = wsUrl.includes('?') ? '&' : '?';
          wsUrl = `${wsUrl}${separator}access_token=${encodeURIComponent(config.accessToken)}`;
        }
        this._ws = new WebSocket(wsUrl);

        // Set a connection timeout
        const timeout = setTimeout(() => {
          if (!settled) {
            settled = true;
            this._ws?.close();
            this._ws = null;
            reject(new Error(`NapCat 连接超时 (${config.wsUrl})`));
          }
        }, 10000);

        this._ws.on('open', () => {
          clearTimeout(timeout);
          settled = true;
          this._running = true;
          this._status.online = true;
          this._status.lastEvent = '已连接 NapCat';
          this._emitStatus();
          console.log('[QQ-OneBot] Connected to NapCat:', config.wsUrl);
          this._startHeartbeat();
          resolve();
        });

        this._ws.on('message', (data: WebSocket.Data) => {
          try {
            const raw = JSON.parse(data.toString());
            this._handleOneBotMessage(raw);
          } catch (e) {
            console.error('[QQ-OneBot] Parse error:', e);
          }
        });

        this._ws.on('close', () => {
          clearTimeout(timeout);
          this._running = false;
          this._status.online = false;
          this._status.lastEvent = '连接已断开';
          this._emitStatus();
          this._stopHeartbeat();
        });

        this._ws.on('error', (err: Error) => {
          clearTimeout(timeout);
          this._status.lastEvent = `连接错误: ${err.message}`;
          this._emitStatus();
          if (!settled) {
            settled = true;
            reject(new Error(`NapCat 连接失败: ${err.message || 'WebSocket 连接错误，请检查 NapCat 是否已启动且地址正确'}`));
          }
        });
      } catch (e: any) {
        if (!settled) {
          settled = true;
          reject(new Error(`NapCat 连接失败: ${e?.message || '未知错误'}`));
        }
      }
    });
  }

  private _handleOneBotMessage(raw: any): void {
    // OneBot v11 protocol messages
    // post_type: message, notice, request, meta_event
    const postType = raw.post_type;

    // Capture self_id from any event (the QQ number of the logged-in account)
    if (raw.self_id) this._selfId = String(raw.self_id);

    if (postType === 'meta_event') {
      // Heartbeat response or lifecycle event
      if (raw.meta_event_type === 'lifecycle') {
        this._status.lastEvent = 'NapCat 已就绪';
        this._emitStatus();
      }
      return;
    }

    if (postType === 'message') {
      const messageType = raw.message_type; // 'private' or 'group'
      const text = this._extractText(raw.message);
      if (!text) return;

      // Detect self-sent messages (user_id matches self_id)
      const userId = String(raw.user_id);
      if (this._selfId && userId === this._selfId) {
        this._selfMessageHandler?.({ text, timestamp: Date.now() });
        return;
      }

      const fromId = messageType === 'group' ? String(raw.group_id) : userId;
      const fromName = raw.sender?.nickname || userId;
      const isGroup = messageType === 'group';

      this._status.messageCount++;
      this._status.lastEvent = `收到消息: ${text.slice(0, 30)}`;
      this._emitStatus();

      this._messageHandler?.({
        fromId,
        fromName,
        text,
        isGroup,
        groupId: isGroup ? String(raw.group_id) : undefined,
        msgId: String(raw.message_id),
      });
    }
  }

  private _extractText(message: any): string {
    // OneBot v11 message can be string or array of segments
    if (typeof message === 'string') return message;
    if (Array.isArray(message)) {
      return message
        .filter((seg: any) => seg.type === 'text')
        .map((seg: any) => seg.data?.text || '')
        .join('')
        .trim();
    }
    return '';
  }

  private _startHeartbeat(): void {
    // NapCat sends heartbeats automatically, we just track connection
  }

  private _stopHeartbeat(): void {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  async disconnect(): Promise<void> {
    this._running = false;
    this._stopHeartbeat();
    if (this._ws) {
      try {
        this._ws.close();
      } catch { /* ignore */ }
      this._ws = null;
    }
    this._status.online = false;
    this._status.lastEvent = '已断开';
    this._emitStatus();
  }

  async sendMessage(targetId: string, text: string, isGroup: boolean): Promise<boolean> {
    if (!this._ws || !this._running) {
      console.error('[QQ-OneBot] Cannot send: not connected');
      return false;
    }

    const action = isGroup ? 'send_group_msg' : 'send_private_msg';
    const params = isGroup ? { group_id: Number(targetId) } : { user_id: Number(targetId) };
    const payload = {
      action,
      params: { ...params, message: text },
      echo: `send_${Date.now()}`,
    };

    try {
      this._ws.send(JSON.stringify(payload));
      return true;
    } catch (e: any) {
      console.error('[QQ-OneBot] Send error:', e.message);
      return false;
    }
  }

  private _emitStatus(): void {
    this.onStatusChange?.(this.status);
  }
}

// QQ Bot Service — Tencent official QQ Bot API
//
// Uses the official QQ Bot API (WebSocket gateway).
// Requires AppID and AppSecret from https://q.qq.com
//
// Auth:    POST https://api.sgroup.qq.com/app/auth/token
// Gateway: GET  https://api.sgroup.qq.com/gateway/bot
// Events:  WebSocket to gateway URL

import WebSocket from 'ws';

export interface QQBotConfig {
  enabled: boolean;
  appId?: string;
  appSecret?: string;
}

export interface QQBotStatus {
  online: boolean;
  nickname: string;
  messageCount: number;
  /** 诊断信息：WS 事件数和最近事件 */
  lastEvent: string;
}

export type QQBotMessageHandler = (msg: {
  fromId: string;
  fromName: string;
  text: string;
  isGroup: boolean;
  groupId?: string;
  msgId: string;
}) => void;

interface QQBotCredentials {
  accessToken: string;
  expiresIn: number;
  acquiredAt: number;
}

interface QQGatewayInfo {
  url: string;
  shards: number;
  sessionStartLimit: { total: number; remaining: number; resetAfter: number; maxConcurrency: number };
}

export class QQBotService {
  private _config: QQBotConfig | null = null;
  private _running = false;
  private _messageHandler: QQBotMessageHandler | null = null;
  private _status: QQBotStatus = { online: false, nickname: '', messageCount: 0, lastEvent: '' };
  private _credentials: QQBotCredentials | null = null;
  private _ws: WebSocket | null = null;
  private _heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _sessionId: string | null = null;
  private _lastSeq: number | null = null;
  private _baseUrl = 'https://api.sgroup.qq.com';
  private _reconnectAttempts = 0;
  private _maxReconnectAttempts = 5;

  /** Status change callback */
  onStatusChange: ((s: QQBotStatus) => void) | null = null;

  get status(): QQBotStatus { return { ...this._status }; }
  get config(): QQBotConfig | null { return this._config; }

  onMessage(handler: QQBotMessageHandler): void {
    this._messageHandler = handler;
  }

  async connect(config: QQBotConfig): Promise<void> {
    this._config = config;
    this._baseUrl = 'https://api.sgroup.qq.com';

    if (!config.appId || !config.appSecret) {
      throw new Error('请在设置中填写 QQ Bot 的 AppID 和 AppSecret');
    }

    // Step 1: Get access token
    const tokenData = await this._getAccessToken(config.appId, config.appSecret);
    this._credentials = {
      accessToken: tokenData.access_token,
      expiresIn: tokenData.expires_in,
      acquiredAt: Date.now(),
    };
    console.log('[QQ-Bot] Got access token');

    // Step 2: Get WebSocket gateway URL
    const gateway = await this._getGateway(this._credentials.accessToken);
    console.log('[QQ-Bot] Gateway:', gateway.url);

    // Step 3: Connect WebSocket
    await this._connectWebSocket(gateway.url);

    this._status.online = true;
    this._status.nickname = `QQ Bot (${config.appId})`;
    this._running = true;
    this._emitStatus();
    console.log('[QQ-Bot] Connected');
  }

  async disconnect(): Promise<void> {
    this._running = false;
    if (this._heartbeatTimer) { clearInterval(this._heartbeatTimer); this._heartbeatTimer = null; }
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    if (this._ws) {
      try { this._ws.close(1000, 'disconnect'); } catch { /* ignore */ }
      this._ws = null;
    }
    this._status.online = false;
    this._emitStatus();
    console.log('[QQ-Bot] Disconnected');
  }

  async sendMessage(toId: string, text: string, isGroup: boolean): Promise<boolean> {
    if (!this._credentials) throw new Error('QQ not connected');
    try {
      const endpoint = isGroup
        ? `/v2/groups/${toId}/messages`
        : `/v2/users/${toId}/messages`;
      await this._apiPost(endpoint, { content: text });
      this._status.messageCount++;
      return true;
    } catch (e: any) {
      console.error('[QQ-Bot] Send error:', e.message);
      return false;
    }
  }

  // ── Auth ──────────────────────────────────────────────────────

  private async _getAccessToken(appId: string, appSecret: string): Promise<{ access_token: string; expires_in: number }> {
    const response = await fetch('https://bots.qq.com/app/getAppAccessToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId, clientSecret: appSecret }),
    });
    if (response.status === 401) throw new Error('QQ Bot 认证失败：AppID 或 AppSecret 无效');
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`QQ Bot 认证失败 (${response.status}): ${text}`);
    }
    interface TokenResponse { access_token: string; expires_in: number; }
    const data = await response.json() as TokenResponse;
    if (!data.access_token) {
      // Try alternate field names
      const raw: any = await response.json().catch(() => ({}));
      const token = raw.access_token || raw.token || raw.accessToken;
      if (token) return { access_token: token as string, expires_in: raw.expires_in || 7200 };
      throw new Error('QQ Bot 认证返回无效数据: ' + JSON.stringify(data));
    }
    return data;
  }

  private async _getGateway(token: string): Promise<QQGatewayInfo> {
    const response = await fetch(`${this._baseUrl}/gateway/bot`, {
      headers: { Authorization: `QQBot ${token}` },
    });
    if (!response.ok) throw new Error(`QQ Bot gateway error: ${response.status}`);
    const data = await response.json() as QQGatewayInfo;
    return data;
  }

  // ── WebSocket ─────────────────────────────────────────────────

  private async _connectWebSocket(gatewayUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const ws = new WebSocket(gatewayUrl);

        ws.on('open', () => {
          console.log('[QQ-Bot] WebSocket connected');
          this._ws = ws;
          resolve();
        });

        ws.on('message', (data: Buffer) => {
          try {
            const payload = JSON.parse(data.toString());
            this._handleWSPayload(payload);
          } catch (e) {
            console.error('[QQ-Bot] Invalid WS message:', e);
          }
        });

        ws.on('error', (err: Error) => {
          console.error('[QQ-Bot] WebSocket error:', err.message);
          if (!this._ws) reject(new Error('WebSocket connection failed'));
        });

        ws.on('close', (code: number, reason: Buffer) => {
          console.log(`[QQ-Bot] WebSocket closed: code=${code}, reason=${reason?.toString() || 'none'}`);
          this._ws = null;
          if (this._heartbeatTimer) { clearInterval(this._heartbeatTimer); this._heartbeatTimer = null; }
          if (this._running) {
            this._scheduleReconnect(gatewayUrl);
          }
        });

        // Set a timeout for connection
        setTimeout(() => {
          if (!this._ws) reject(new Error('WebSocket connection timeout'));
        }, 10000);
      } catch (e) {
        reject(e);
      }
    });
  }

  private _handleWSPayload(payload: any): void {
    const { op, d, s, t } = payload;

    // Log non-trivial events
    if (op !== 11) {
      console.log(`[QQ-Bot] WS op=${op}${t ? ` t=${t}` : ''}`, d ? JSON.stringify(d).slice(0, 200) : '');
      this._status.lastEvent = `${t || 'op:' + op} ${d ? JSON.stringify(d).slice(0, 60) : ''}`;
      this._emitStatus();
    }

    switch (op) {
      case 10: // Hello — receive heartbeat interval
        const heartbeatInterval = d?.heartbeat_interval || 30000;
        console.log(`[QQ-Bot] Hello received, heartbeat interval: ${heartbeatInterval}ms`);
        this._startHeartbeat(heartbeatInterval);
        // Send Identify
        this._sendIdentify();
        break;

      case 0: // Dispatch — event
        if (s) this._lastSeq = s;
        if (t === 'READY') {
          this._sessionId = d?.session_id;
          console.log('[QQ-Bot] Session ready:', JSON.stringify(d).slice(0, 200));
        } else if (t === 'RESUMED') {
          console.log('[QQ-Bot] Session resumed');
        } else if (t === 'AT_MESSAGE_CREATE' || t === 'MESSAGE_CREATE' || t === 'C2C_MESSAGE_CREATE') {
          console.log('[QQ-Bot] Received message:', JSON.stringify(d).slice(0, 300));
          this._handleMessage(d);
        }
        break;

      case 7: // Reconnect
        console.log('[QQ-Bot] Server requested reconnect');
        this._reconnectWebSocket();
        break;

      case 9: // Invalid Session
        console.log('[QQ-Bot] Invalid session, re-identifying');
        this._sessionId = null;
        this._sendIdentify();
        break;

      case 11: // Heartbeat ACK
        // All good
        break;
    }
  }

  private _sendIdentify(): void {
    if (!this._ws || !this._config) return;
    const botTokenStr = `QQBot ${this._credentials?.accessToken}`;
    const identify = {
      op: 2,
      d: {
        token: botTokenStr,
        intents: (1 << 30) | (1 << 12) | (1 << 9) | (1 << 25) | (1 << 28), // GUILD_MESSAGES | DIRECT_MESSAGE | PUBLIC_GUILD_MESSAGES | C2C_MESSAGE_CREATE | GROUP_AND_C2C_EVENT
        shard: [0, 1],
        properties: {
          $os: process.platform,
          $browser: 'z-assistant',
          $device: 'z-assistant',
        },
      },
    };
    if (this._sessionId && this._lastSeq) {
      this._ws.send(JSON.stringify({
        op: 6,
        d: {
          token: botTokenStr,
          session_id: this._sessionId,
          seq: this._lastSeq,
        },
      }));
    } else {
      this._ws.send(JSON.stringify(identify));
    }
  }

  private _startHeartbeat(intervalMs: number): void {
    if (this._heartbeatTimer) clearInterval(this._heartbeatTimer);
    this._heartbeatTimer = setInterval(() => {
      if (this._ws && this._ws.readyState === WebSocket.OPEN) {
        this._ws.send(JSON.stringify({ op: 1, d: this._lastSeq }));
      }
    }, intervalMs);
  }

  private _reconnectWebSocket(): void {
    this._getGateway(this._credentials?.accessToken || '')
      .then((gateway) => this._connectWebSocket(gateway.url))
      .catch((e) => console.error('[QQ-Bot] Reconnect failed:', e));
  }

  private _scheduleReconnect(gatewayUrl: string): void {
    if (this._reconnectAttempts >= this._maxReconnectAttempts) {
      console.log('[QQ-Bot] Max reconnect attempts reached');
      this._running = false;
      this._status.online = false;
      return;
    }
    const delay = Math.min(1000 * Math.pow(2, this._reconnectAttempts), 30000);
    this._reconnectAttempts++;
    console.log(`[QQ-Bot] Reconnecting in ${delay}ms (attempt ${this._reconnectAttempts})`);
    this._reconnectTimer = setTimeout(() => {
      this._connectWebSocket(gatewayUrl).catch((e) => {
        console.error('[QQ-Bot] Reconnect error:', e);
        this._scheduleReconnect(gatewayUrl);
      });
    }, delay);
  }

  private _emitStatus(): void {
    this.onStatusChange?.(this.status);
  }

  private _handleMessage(d: any): void {
    if (!this._messageHandler) return;
    this._status.messageCount++;
    this._emitStatus();
    const content = d?.content || '';
    const author = d?.author || {};
    const fromId = author.id || d?.user_openid || '';
    const fromName = author.username || author.name || d?.member_openid || 'unknown';

    // Strip @bot mentions
    const cleanContent = content.replace(/<@!\d+>/g, '').replace(/<@\d+>/g, '').trim();
    if (!cleanContent) return;

    this._messageHandler({
      fromId,
      fromName,
      text: cleanContent,
      isGroup: !!d?.group_openid || d?.chat_type === 2,
      groupId: d?.group_openid || d?.group_id,
      msgId: d?.id || String(Date.now()),
    });
  }

  // ── HTTP API ──────────────────────────────────────────────────

  private async _ensureToken(): Promise<string> {
    if (!this._credentials) throw new Error('Not authenticated');
    if (Date.now() - this._credentials.acquiredAt >= this._credentials.expiresIn * 1000 - 60000) {
      // Token expired, refresh
      const data = await this._getAccessToken(this._config!.appId!, this._config!.appSecret!);
      this._credentials = {
        accessToken: data.access_token,
        expiresIn: data.expires_in,
        acquiredAt: Date.now(),
      };
    }
    return this._credentials.accessToken;
  }

  private async _apiPost(path: string, body: Record<string, any>): Promise<any> {
    const token = await this._ensureToken();
    const response = await fetch(`${this._baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `QQBot ${token}`,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`QQ Bot API error (${response.status}): ${text}`);
    }
    return response.json();
  }
}

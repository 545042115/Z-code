// WeChat iLink Service — Tencent official WeChat Bot API (iLink protocol)

export interface WeChatILinkConfig {
  enabled: boolean;
  baseUrl?: string;
  botToken?: string;
  botWxid?: string;
  pollInterval?: number;
  /** User's WeChat nickname — used to filter @mentions in group chats */
  nickname?: string;
}

export interface WeChatILinkStatus {
  online: boolean;
  nickname: string;
  qrCodeUrl: string | null;
  messageCount: number;
  /** 最近一次 poll 的结果诊断信息 */
  lastPollInfo: string;
}

export type WeChatILinkMessageHandler = (msg: {
  fromWxid: string; fromName: string; text: string;
  isGroup: boolean; groupWxid?: string; msgId: string;
  contextToken: string;
}) => void;

interface ILinkMessage {
  from_user_id: string;
  from_name: string;
  content?: string;
  item_list?: Array<{
    type: number;
    text_item?: { text: string };
  }>;
  context_token?: string;
  message_type?: number;
  chat_type?: string;
  from_wxid?: string;
  msg_id?: string;
  group_wxid?: string;
}

export class WeChatILinkService {
  private _config: WeChatILinkConfig | null = null;
  private _running = false;
  private _pollTimer: ReturnType<typeof setInterval> | null = null;
  private _qrPollTimer: ReturnType<typeof setInterval> | null = null;
  private _messageHandler: WeChatILinkMessageHandler | null = null;
  private _status: WeChatILinkStatus = { online: false, nickname: '', qrCodeUrl: null, messageCount: 0, lastPollInfo: '' };
  private _botToken = '';
  private _baseUrl = 'https://ilinkai.weixin.qq.com';
  private _getUpdatesBuf = '';
  private _qrConfirmed = false;
  /** Callback fired when status changes (e.g., QR scanned, confirmed, expired) */
  onStatusChange: ((s: WeChatILinkStatus) => void) | null = null;

  get status(): WeChatILinkStatus { return { ...this._status }; }
  get config(): WeChatILinkConfig | null { return this._config; }

  onMessage(handler: WeChatILinkMessageHandler): void {
    this._messageHandler = handler;
  }

  async connect(config: WeChatILinkConfig): Promise<void> {
    this._config = config;
    this._botToken = config.botToken || '';
    this._baseUrl = config.baseUrl || 'https://ilinkai.weixin.qq.com';

    // If we have a stored token, use it directly
    if (this._botToken) {
      this._status.online = true;
      this._status.nickname = 'WeChat (iLink)';
      this._running = true;
      this._startPolling();
      console.log('[WeChat-iLink] Connected with stored token');
      return;
    }

    // Generate QR code
    const qrResult = await this._apiGet('/ilink/bot/get_bot_qrcode', { bot_type: '3' });
    if (!qrResult.qrcode_img_content) {
      throw new Error('无法生成微信登录二维码: ' + JSON.stringify(qrResult));
    }

    // Set QR code in status and return immediately
    this._status.qrCodeUrl = qrResult.qrcode_img_content;
    this._status.nickname = '等待扫码...';
    console.log('[WeChat-iLink] QR code URL:', qrResult.qrcode_img_content);

    // Start background polling for QR scan result
    this._startQRPolling(qrResult.qrcode);
  }

  private _startQRPolling(qrcodeKey: string): void {
    let attempts = 0;
    const maxAttempts = 90; // 3 minutes
    this._qrPollTimer = setInterval(async () => {
      attempts++;
      if (attempts >= maxAttempts) {
        clearInterval(this._qrPollTimer!);
        this._qrPollTimer = null;
        this._status.qrCodeUrl = null;
        this._status.nickname = '二维码已过期，请重新连接';
        this._emitStatus();
        return;
      }
      try {
        const result = await this._checkQRStatus(qrcodeKey);
        console.log('[WeChat-iLink] QR status response:', JSON.stringify(result));
        const s = result.status;
        if (s === 'scaned') {
          if (this._qrConfirmed) return; // Ignore stale scan update after confirmed
          this._status.nickname = '已扫码，请在手机上确认...';
          this._emitStatus();
        } else if (s === 'confirmed') {
          clearInterval(this._qrPollTimer!);
          this._qrPollTimer = null;
          this._botToken = result.bot_token;
          this._baseUrl = result.baseurl || this._baseUrl;
          this._status.online = true;
          this._status.nickname = 'WeChat (iLink)';
          this._status.qrCodeUrl = null;
          this._running = true;
          this._qrConfirmed = true;
          this._startPolling();
          this._emitStatus();
          console.log('[WeChat-iLink] Login confirmed');
        } else if (s === 'expired') {
          clearInterval(this._qrPollTimer!);
          this._qrPollTimer = null;
          this._status.qrCodeUrl = null;
          this._status.nickname = '二维码已过期，请重新连接';
          this._status.lastPollInfo = '二维码已过期';
          this._emitStatus();
        }
      } catch (e) {
        console.error('[WeChat-iLink] QR poll error:', e);
      }
      // Always log the result for debugging
      if (attempts % 5 === 0) {
        console.log(`[WeChat-iLink] QR poll attempt ${attempts}/${maxAttempts}, status: still waiting`);
      }
    }, 2000);
  }

  async disconnect(): Promise<void> {
    this._running = false;
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
    if (this._qrPollTimer) { clearInterval(this._qrPollTimer); this._qrPollTimer = null; }
    this._status.online = false;
    this._status.qrCodeUrl = null;
    this._emitStatus();
  }

  async sendMessage(toWxid: string, text: string, contextToken?: string): Promise<boolean> {
    if (!this._running) throw new Error('WeChat not connected');
    try {
      const clientId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      const body: Record<string, any> = {
        msg: {
          from_user_id: '',
          to_user_id: toWxid,
          client_id: clientId,
          message_type: 2,    // MessageType.BOT
          message_state: 4,   // MessageState.FINISH
          context_token: contextToken || '',
          item_list: [{ type: 1, text_item: { text } }],
          base_info: { channel_version: '2.0.0' },
        },
      };
      await this._apiPost('/ilink/bot/sendmessage', body);
      this._status.messageCount++;
      return true;
    } catch (e: any) {
      console.error('[WeChat-iLink] Send error:', e.message);
      return false;
    }
  }

  private async _startPolling(): Promise<void> {
    console.log('[WeChat-iLink] Starting long-poll loop...');
    this._status.lastPollInfo = '轮询中...';
    this._emitStatus();
    // Chain polls recursively — each poll completes before the next starts
    const pollLoop = async (): Promise<void> => {
      if (!this._running) return;
      await this._poll();
      // Schedule next poll immediately after current one completes
      if (this._running) {
        this._pollTimer = setTimeout(pollLoop, 500) as unknown as ReturnType<typeof setInterval>;
      }
    };
    pollLoop();
  }

  private async _poll(): Promise<void> {
    if (!this._running || !this._messageHandler) return;
    try {
      const body: Record<string, any> = { get_updates_buf: this._getUpdatesBuf || '' };
      const result = await this._apiPost('/ilink/bot/getupdates', body, 8000);
      if (result.ret === -14) {
        this._status.lastPollInfo = '会话过期';
        this._emitStatus();
        console.log('[WeChat-iLink] Session expired');
        await this.disconnect();
        return;
      }
      const msgs = result.msgs;
      if (msgs && Array.isArray(msgs) && msgs.length > 0) {
        for (const msg of msgs as ILinkMessage[]) {
          this._getUpdatesBuf = result.get_updates_buf || msg.msg_id;
          const text = msg.item_list?.find((i) => i.type === 1)?.text_item?.text || msg.content || '';
          this._status.lastPollInfo = `收到消息: ${text.slice(0, 30)}`;
          this._status.messageCount++;
          this._emitStatus();
          this._messageHandler({
            fromWxid: msg.from_user_id || msg.from_wxid || '',
            fromName: msg.from_name,
            text,
            isGroup: msg.chat_type === 'group',
            groupWxid: msg.group_wxid,
            msgId: msg.msg_id || '',
            contextToken: msg.context_token || result.context_token || '',
          });
        }
      } else {
        this._status.lastPollInfo = '轮询中 (无新消息)';
        this._emitStatus();
      }
    } catch { /* retry next cycle */ }
  }

  private async _checkQRStatus(qrcodeKey: string): Promise<any> {
    const url = `${this._baseUrl}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcodeKey)}`;
    const response = await fetch(url, {
      headers: { 'iLink-App-ClientVersion': '1' },
    });
    if (!response.ok) throw new Error(`QR status error: ${response.status}`);
    return response.json();
  }

  private _emitStatus(): void {
    this.onStatusChange?.(this.status);
  }

  private async _apiGet(path: string, params: Record<string, string> = {}): Promise<any> {
    const url = new URL(`${this._baseUrl}${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const headers: Record<string, string> = {};
    if (this._botToken) {
      headers['AuthorizationType'] = 'ilink_bot_token';
      headers['Authorization'] = `Bearer ${this._botToken}`;
      headers['X-WECHAT-UIN'] = this._randomUin();
    }
    const response = await fetch(url.toString(), { headers });
    if (!response.ok) throw new Error(`iLink API error: ${response.status}`);
    return response.json();
  }

  private async _apiPost(path: string, body: Record<string, any>, timeout?: number): Promise<any> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this._botToken) {
      headers['AuthorizationType'] = 'ilink_bot_token';
      headers['Authorization'] = `Bearer ${this._botToken}`;
      headers['X-WECHAT-UIN'] = this._randomUin();
    }
    body.base_info = { channel_version: '2.0.0' };
    const controller = new AbortController();
    const timer = timeout ? setTimeout(() => controller.abort(), timeout) : null;
    try {
      const response = await fetch(`${this._baseUrl}${path}`, {
        method: 'POST', headers, body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`iLink API error: ${response.status}`);
      return response.json();
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private _randomUin(): string {
    return Buffer.from(String(Math.floor(Math.random() * 0xFFFFFFFF))).toString('base64');
  }
}

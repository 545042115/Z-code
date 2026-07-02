// Runtime HTTP API Server
//
// Phase 6: Server-side Runtime API for mobile and remote clients.
//
// Lightweight HTTP server that exposes Runtime core functionality
// (chat, memory, health) over a simple REST + SSE API.
//
// Zero external dependencies — uses Node.js built-in http module.

import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { URL } from 'url';
import type { MemoryManager } from '../memory/memory-manager';
import type { MemoryRecord, MemoryListFilter, MemoryQuery } from '@ziner/contracts';

export interface RuntimeApiServerOptions {
  /** Port to listen on. Default 3000. */
  port?: number;
  /** Host to bind to. Default '0.0.0.0'. */
  host?: string;
  /** Memory manager instance. */
  memoryManager?: MemoryManager;
  /** Chat handler: takes a message and returns a response. */
  chatHandler?: (message: string, conversationId?: string) => Promise<string> | string;
  /**
   * API key for authentication. If set, all requests must include
   * an Authorization: Bearer <key> header.
   */
  apiKey?: string;
  /** CORS origins to allow. Default '*'. */
  corsOrigins?: string | string[];
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: number;
}

type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
) => Promise<void> | void;

interface Route {
  method: string;
  pattern: RegExp;
  handler: RouteHandler;
}

export class RuntimeApiServer {
  private readonly options: Required<RuntimeApiServerOptions>;
  private server: ReturnType<typeof createServer> | null = null;
  private routes: Route[] = [];
  private chatHistory = new Map<string, ChatMessage[]>();
  private msgCounter = 0;

  constructor(options: RuntimeApiServerOptions = {}) {
    this.options = {
      port: options.port ?? 3000,
      host: options.host ?? '0.0.0.0',
      memoryManager: options.memoryManager ?? (undefined as unknown as MemoryManager),
      chatHandler: options.chatHandler ?? (undefined as unknown as (msg: string, convId?: string) => string),
      apiKey: options.apiKey ?? '',
      corsOrigins: options.corsOrigins ?? '*',
    };
    this._setupRoutes();
  }

  /** Start the server. */
  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = createServer((req, res) => this._handleRequest(req, res));
      this.server.listen(this.options.port, this.options.host, () => {
        resolve();
      });
    });
  }

  /** Stop the server. */
  async stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
      this.server = null;
    });
  }

  get port(): number {
    if (!this.server) return this.options.port;
    const addr = this.server.address();
    if (addr && typeof addr === 'object') return addr.port;
    return this.options.port;
  }

  // ── Routing ───────────────────────────────────────────────────────

  private _setupRoutes(): void {
    // Health check
    this._addRoute('GET', /^\/api\/health$/, this._handleHealth.bind(this));

    // Config
    this._addRoute('GET', /^\/api\/config$/, this._handleGetConfig.bind(this));

    // Chat
    this._addRoute('POST', /^\/api\/chat$/, this._handleChat.bind(this));
    this._addRoute('POST', /^\/api\/chat\/stream$/, this._handleChatStream.bind(this));
    this._addRoute('GET', /^\/api\/chat\/history(?:\/([^/]+))?$/, this._handleChatHistory.bind(this));

    // Memory
    this._addRoute('GET', /^\/api\/memory$/, this._handleListMemory.bind(this));
    this._addRoute('POST', /^\/api\/memory$/, this._handleAddMemory.bind(this));
    this._addRoute('GET', /^\/api\/memory\/search$/, this._handleSearchMemory.bind(this));
    this._addRoute('DELETE', /^\/api\/memory\/([^/]+)$/, this._handleDeleteMemory.bind(this));
  }

  private _addRoute(method: string, pattern: RegExp, handler: RouteHandler): void {
    this.routes.push({ method, pattern, handler });
  }

  private async _handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      // CORS
      this._setCorsHeaders(res);
      if (req.method === 'OPTIONS') {
        res.statusCode = 204;
        res.end();
        return;
      }

      // Auth
      if (this.options.apiKey && !this._checkAuth(req)) {
        this._sendJson(res, 401, { error: 'Unauthorized' });
        return;
      }

      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

      for (const route of this.routes) {
        if (req.method !== route.method) continue;
        const match = url.pathname.match(route.pattern);
        if (match) {
          const params = match.slice(1).reduce<Record<string, string>>((acc, val, idx) => {
            acc[`p${idx}`] = val ?? '';
            return acc;
          }, {});
          await route.handler(req, res, params);
          return;
        }
      }

      this._sendJson(res, 404, { error: 'Not found' });
    } catch (e) {
      console.error('[api-server] error:', e);
      this._sendJson(res, 500, { error: e instanceof Error ? e.message : 'Internal server error' });
    }
  }

  private _checkAuth(req: IncomingMessage): boolean {
    const auth = req.headers['authorization'];
    if (!auth) return false;
    const [type, key] = auth.split(' ');
    return type === 'Bearer' && key === this.options.apiKey;
  }

  private _setCorsHeaders(res: ServerResponse): void {
    const origins = this.options.corsOrigins;
    const origin = typeof origins === 'string' ? origins : origins.join(', ');
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Max-Age', '86400');
  }

  private _sendJson(res: ServerResponse, status: number, data: unknown): void {
    const body = JSON.stringify(data);
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Length', Buffer.byteLength(body));
    res.end(body);
  }

  private async _readJsonBody<T>(req: IncomingMessage): Promise<T> {
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', (chunk) => {
        data += chunk;
        if (data.length > 1_000_000) {
          reject(new Error('Request body too large'));
          req.destroy();
        }
      });
      req.on('end', () => {
        try {
          resolve(JSON.parse(data || '{}') as T);
        } catch {
          reject(new Error('Invalid JSON'));
        }
      });
      req.on('error', reject);
    });
  }

  // ── Health ────────────────────────────────────────────────────────

  private _handleHealth(_req: IncomingMessage, res: ServerResponse): void {
    this._sendJson(res, 200, {
      ok: true,
      version: '0.1.0',
      timestamp: Date.now(),
      features: {
        chat: !!this.options.chatHandler,
        memory: !!this.options.memoryManager,
      },
    });
  }

  // ── Config ────────────────────────────────────────────────────────

  private _handleGetConfig(_req: IncomingMessage, res: ServerResponse): void {
    this._sendJson(res, 200, {
      storageBackend: this.options.memoryManager ? 'runtime' : 'mock',
      features: {
        chat: !!this.options.chatHandler,
        memory: !!this.options.memoryManager,
      },
    });
  }

  // ── Chat ──────────────────────────────────────────────────────────

  private async _handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this._readJsonBody<{ message: string; conversationId?: string }>(req);
    const conversationId = body.conversationId ?? 'default';

    const userMsg: ChatMessage = {
      id: `msg-${++this.msgCounter}`,
      role: 'user',
      content: body.message,
      createdAt: Date.now(),
    };
    this._appendHistory(conversationId, userMsg);

    let responseContent: string;

    if (this.options.chatHandler) {
      responseContent = await this.options.chatHandler(body.message, conversationId);
    } else {
      responseContent = this._mockChatResponse(body.message);
    }

    const assistantMsg: ChatMessage = {
      id: `msg-${++this.msgCounter}`,
      role: 'assistant',
      content: responseContent,
      createdAt: Date.now(),
    };
    this._appendHistory(conversationId, assistantMsg);

    this._sendJson(res, 200, { message: assistantMsg });
  }

  private async _handleChatStream(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this._readJsonBody<{ message: string; conversationId?: string }>(req);
    const conversationId = body.conversationId ?? 'default';

    const userMsg: ChatMessage = {
      id: `msg-${++this.msgCounter}`,
      role: 'user',
      content: body.message,
      createdAt: Date.now(),
    };
    this._appendHistory(conversationId, userMsg);

    // Set SSE headers
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    let responseContent: string;
    if (this.options.chatHandler) {
      responseContent = await this.options.chatHandler(body.message, conversationId);
    } else {
      responseContent = this._mockChatResponse(body.message);
    }

    // Stream character by character
    for (let i = 0; i < responseContent.length; i++) {
      const chunk = responseContent[i];
      res.write(`data: ${JSON.stringify({ delta: chunk, content: responseContent.slice(0, i + 1) })}\n\n`);
      await new Promise((r) => setTimeout(r, 15));
    }

    res.write(`data: [DONE]\n\n`);

    const assistantMsg: ChatMessage = {
      id: `msg-${++this.msgCounter}`,
      role: 'assistant',
      content: responseContent,
      createdAt: Date.now(),
    };
    this._appendHistory(conversationId, assistantMsg);

    res.end();
  }

  private _handleChatHistory(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>): void {
    const conversationId = params.p0 || 'default';
    const history = this.chatHistory.get(conversationId) ?? [];
    this._sendJson(res, 200, { messages: history });
  }

  private _appendHistory(conversationId: string, msg: ChatMessage): void {
    if (!this.chatHistory.has(conversationId)) {
      this.chatHistory.set(conversationId, []);
    }
    this.chatHistory.get(conversationId)!.push(msg);
  }

  private _mockChatResponse(message: string): string {
    const lower = message.toLowerCase();
    if (lower.includes('你好') || lower.includes('hello') || lower.includes('hi')) {
      return '你好！👋 我是 Z Code 的 Runtime 服务。\n\n我已经通过 HTTP API 成功连接了。你可以：\n\n• 💬 和我聊天\n• 🧠 管理长期记忆\n• ⚙️ 查看系统配置\n\n这是通过 Runtime HTTP API 提供的真实服务（虽然当前是演示模式）。';
    }
    if (lower.includes('记忆') || lower.includes('memory')) {
      return '记忆系统运行正常！\n\n目前支持：\n• 列出所有记忆\n• 按关键词搜索记忆\n• 添加新记忆\n• 删除记忆\n\n你可以在移动端的"记忆"标签页查看所有记忆。';
    }
    return `收到你的消息："${message}"\n\n这是来自 Runtime HTTP API 的响应。\n\n服务状态：运行正常\n当前时间：${new Date().toLocaleString()}`;
  }

  // ── Memory ────────────────────────────────────────────────────────

  private async _handleListMemory(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const filter: MemoryListFilter = {
      limit: url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : undefined,
      offset: url.searchParams.get('offset') ? Number(url.searchParams.get('offset')) : undefined,
    };

    if (this.options.memoryManager) {
      const memories = await this.options.memoryManager.list(filter);
      this._sendJson(res, 200, { memories });
    } else {
      // Mock memories
      const memories: MemoryRecord[] = [
        {
          id: 'mem-1',
          content: '用户正在使用 Z Code 移动端应用',
          kind: 'long-term',
          scope: 'user',
          userId: 'default',
          createdAt: Date.now() - 3600_000,
        } as MemoryRecord,
        {
          id: 'mem-2',
          content: '用户偏好简洁的回答风格',
          kind: 'long-term',
          scope: 'user',
          userId: 'default',
          createdAt: Date.now() - 7200_000,
        } as MemoryRecord,
      ].slice(filter.offset || 0, (filter.offset || 0) + (filter.limit || 100));
      this._sendJson(res, 200, { memories });
    }
  }

  private async _handleAddMemory(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this._readJsonBody<{ content: string; kind?: MemoryRecord['kind'] }>(req);

    if (this.options.memoryManager) {
      const memory = await this.options.memoryManager.remember(
        body.content,
        'long-term',
        'user',
        { kind: body.kind },
      );
      this._sendJson(res, 201, { memory });
    } else {
      const memory: MemoryRecord = {
        id: `mem-${Date.now()}`,
        content: body.content,
        kind: body.kind || 'long-term',
        scope: 'user',
        userId: 'default',
        createdAt: Date.now(),
      };
      this._sendJson(res, 201, { memory });
    }
  }

  private async _handleSearchMemory(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const query = url.searchParams.get('q') || '';
    const limit = url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : 10;

    if (this.options.memoryManager) {
      const results = await this.options.memoryManager.recall(query, { limit });
      this._sendJson(res, 200, { memories: results.map((r) => r.memory) });
    } else {
      // Mock search
      const memories: MemoryRecord[] = [
        {
          id: 'mem-search-1',
          content: `关于"${query}"的搜索结果`,
          kind: 'long-term',
          scope: 'user',
          userId: 'default',
          createdAt: Date.now(),
        } as MemoryRecord,
      ].slice(0, limit);
      this._sendJson(res, 200, { memories });
    }
  }

  private async _handleDeleteMemory(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
    const id = decodeURIComponent(params.p0);

    if (this.options.memoryManager) {
      await this.options.memoryManager.forget(id);
    }

    this._sendJson(res, 200, { ok: true });
  }
}

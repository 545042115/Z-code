// RemoteRuntimeBridge — connects to a remote Runtime server via HTTP API
//
// This bridge talks to a Runtime server (e.g. the Desktop app or a
// dedicated server) over a simple HTTP REST API. The server exposes
// endpoints like:
//
//   POST /api/chat           — send a chat message (JSON body)
//   GET  /api/memory         — list memories
//   POST /api/memory         — add a memory
//   DELETE /api/memory/:id   — delete a memory
//   GET  /api/memory/search  — search memories
//   GET  /api/health         — health check
//
// If the server is unreachable, the bridge reports status.connected=false
// and all methods throw a descriptive error.

import type {
  MobileRuntimeBridge,
  BridgeStatus,
  ChatMessage,
  MemoryRecord,
  MemoryListFilter,
  AppSettings,
  BridgeEvent,
  BridgeEventType,
  BridgeEventListener,
} from './types';

export class RemoteRuntimeBridge implements MobileRuntimeBridge {
  private _status: BridgeStatus = {
    connected: false,
    backend: 'remote',
  };
  private settings: AppSettings | null = null;
  private listeners = new Map<BridgeEventType, Set<BridgeEventListener>>();
  private abortController: AbortController | null = null;
  private healthPollTimer: number | null = null;

  get status(): BridgeStatus {
    return { ...this._status };
  }

  async init(settings: AppSettings): Promise<void> {
    this.settings = settings;
    this.abortController = new AbortController();

    if (!settings.runtimeServerUrl) {
      this._status = {
        connected: false,
        backend: 'remote',
      };
      return;
    }

    // Initial health check
    try {
      await this._healthCheck();
      this._status = {
        connected: true,
        backend: 'remote',
        version: 'remote',
      };
    } catch (e) {
      this._status = {
        connected: false,
        backend: 'remote',
        reason: e instanceof Error ? e.message : String(e),
      };
    }

    this._emit({ type: 'status', data: this._status });

    // Start periodic health checks (every 30s)
    this._startHealthPolling();
  }

  async close(): Promise<void> {
    if (this.healthPollTimer) {
      clearInterval(this.healthPollTimer);
      this.healthPollTimer = null;
    }
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.listeners.clear();
    this._status = { connected: false, backend: 'remote' };
  }

  // ── Chat ──────────────────────────────────────────────────────────

  async sendChat(message: string, conversationId?: string): Promise<ChatMessage> {
    this._ensureConnected();

    const result = await this._fetch<{ message: ChatMessage }>('/api/chat', {
      method: 'POST',
      body: JSON.stringify({
        message,
        conversationId,
      }),
    });

    return result.message;
  }

  async streamChat(
    message: string,
    conversationId: string | undefined,
    onChunk: (delta: string, fullMessage: string) => void,
  ): Promise<ChatMessage> {
    this._ensureConnected();

    const serverUrl = this.settings!.runtimeServerUrl!;
    const url = `${serverUrl.replace(/\/$/, '')}/api/chat/stream`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ message, conversationId }),
      signal: this.abortController?.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('No response body');
    }

    const decoder = new TextDecoder();
    let buffer = '';
    let fullContent = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Parse SSE-style lines: "data: { ... }\n\n"
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data:')) continue;

          const dataStr = trimmed.slice(5).trim();
          if (dataStr === '[DONE]') return this._makeMessage(fullContent);

          try {
            const data = JSON.parse(dataStr);
            const delta = data.delta ?? data.content ?? '';
            if (delta) {
              fullContent += delta;
              onChunk(delta, fullContent);
            }
          } catch {
            // ignore malformed JSON lines
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    return this._makeMessage(fullContent);
  }

  // ── Memory ────────────────────────────────────────────────────────

  async listMemories(filter: MemoryListFilter = {}): Promise<MemoryRecord[]> {
    this._ensureConnected();

    const params = new URLSearchParams();
    if (filter.kind) params.set('kind', filter.kind);
    if (filter.scope) params.set('scope', filter.scope);
    if (filter.limit) params.set('limit', String(filter.limit));
    if (filter.offset) params.set('offset', String(filter.offset));

    const result = await this._fetch<{ memories: MemoryRecord[] }>(
      `/api/memory?${params.toString()}`,
    );
    return result.memories;
  }

  async searchMemories(query: string, limit = 10): Promise<MemoryRecord[]> {
    this._ensureConnected();

    const params = new URLSearchParams({ q: query, limit: String(limit) });
    const result = await this._fetch<{ memories: MemoryRecord[] }>(
      `/api/memory/search?${params.toString()}`,
    );
    return result.memories;
  }

  async addMemory(content: string, kind: MemoryRecord['kind'] = 'fact'): Promise<MemoryRecord> {
    this._ensureConnected();

    const result = await this._fetch<{ memory: MemoryRecord }>('/api/memory', {
      method: 'POST',
      body: JSON.stringify({ content, kind }),
    });

    this._emit({ type: 'memoryUpdated', data: result.memory });
    return result.memory;
  }

  async deleteMemory(id: string): Promise<void> {
    this._ensureConnected();

    await this._fetch(`/api/memory/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });

    this._emit({ type: 'memoryUpdated', data: { id, deleted: true } });
  }

  // ── Trace (remote stub — server may expose later) ────────────────

  async listTraceRuns(_limit?: number): Promise<never[]> { return []; }
  async getTraceRun(_id: string): Promise<undefined> { return undefined; }
  async listTraceSessions(_limit?: number): Promise<never[]> { return []; }
  async deleteTraceRun(_id: string): Promise<void> { /* no-op */ }
  async clearTrace(): Promise<void> { /* no-op */ }

  // ── Events ────────────────────────────────────────────────────────

  addEventListener(type: BridgeEventType, listener: BridgeEventListener): void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)!.add(listener);
  }

  removeEventListener(type: BridgeEventType, listener: BridgeEventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  // ── Private helpers ───────────────────────────────────────────────

  private _ensureConnected(): void {
    if (!this._status.connected) {
      throw new Error('Not connected to Runtime server');
    }
  }

  private _startHealthPolling(): void {
    if (this.healthPollTimer) clearInterval(this.healthPollTimer);

    this.healthPollTimer = window.setInterval(async () => {
      try {
        const t0 = Date.now();
        await this._healthCheck();
        const latency = Date.now() - t0;
        if (!this._status.connected) {
          this._status = { connected: true, backend: 'remote', version: 'remote', latencyMs: latency };
          this._emit({ type: 'status', data: this._status });
        } else {
          this._status.latencyMs = latency;
        }
      } catch {
        if (this._status.connected) {
          this._status = { connected: false, backend: 'remote' };
          this._emit({ type: 'status', data: this._status });
        }
      }
    }, 30_000);
  }

  private async _healthCheck(): Promise<void> {
    await this._fetch<{ ok: boolean }>('/api/health');
  }

  private async _fetch<T>(path: string, options: RequestInit = {}): Promise<T> {
    if (!this.settings?.runtimeServerUrl) {
      throw new Error('Runtime server URL not configured');
    }

    const url = `${this.settings.runtimeServerUrl.replace(/\/$/, '')}${path}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string> | undefined),
    };

    if (this.settings.runtimeApiKey) {
      headers['Authorization'] = `Bearer ${this.settings.runtimeApiKey}`;
    }

    const response = await fetch(url, {
      ...options,
      headers,
      signal: this.abortController?.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status}: ${response.statusText} ${text}`);
    }

    const contentType = response.headers.get('content-type');
    if (contentType?.includes('application/json')) {
      return response.json();
    }
    return undefined as unknown as T;
  }

  private _makeMessage(content: string): ChatMessage {
    return {
      id: `msg-${Date.now()}`,
      role: 'assistant',
      content,
      createdAt: Date.now(),
    };
  }

  private _emit(event: BridgeEvent): void {
    const set = this.listeners.get(event.type);
    if (!set) return;
    for (const listener of set) {
      try {
        listener(event);
      } catch {
        // ignore listener errors
      }
    }
  }
}

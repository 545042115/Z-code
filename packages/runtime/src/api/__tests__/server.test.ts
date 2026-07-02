// Tests for RuntimeApiServer
//
// Tests the HTTP API server with all endpoints:
// - Health check
// - Config
// - Chat (sync + stream + history)
// - Memory CRUD + search

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeApiServer } from '../server';

function request(port: number, path: string, options: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<{ status: number; body: any; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const req = require('http').request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: options.method ?? 'GET',
        headers: {
          'Content-Type': 'application/json',
          ...options.headers,
        },
      },
      (res: any) => {
        let data = '';
        res.on('data', (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on('end', () => {
          let body: any;
          try {
            body = JSON.parse(data);
          } catch {
            body = data;
          }
          resolve({ status: res.statusCode, body, headers: res.headers });
        });
      },
    );
    req.on('error', reject);
    if (options.body) {
      req.write(JSON.stringify(options.body));
    }
    req.end();
  });
}

describe('RuntimeApiServer', () => {
  let server: RuntimeApiServer;
  let port: number;

  before(async () => {
    server = new RuntimeApiServer({ port: 0 });
    await server.start();
    port = server.port;
  });

  after(async () => {
    await server.stop();
  });

  it('returns health status', async () => {
    const res = await request(port, '/api/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.ok(res.body.timestamp > 0);
    assert.equal(typeof res.body.features, 'object');
  });

  it('returns config', async () => {
    const res = await request(port, '/api/config');
    assert.equal(res.status, 200);
    assert.equal(res.body.storageBackend, 'mock');
    assert.equal(typeof res.body.features, 'object');
  });

  it('handles chat messages', async () => {
    const res = await request(port, '/api/chat', {
      method: 'POST',
      body: { message: '你好' },
    });
    assert.equal(res.status, 200);
    assert.ok(res.body.message);
    assert.equal(res.body.message.role, 'assistant');
    assert.ok(res.body.message.content.length > 0);
  });

  it('tracks chat history', async () => {
    await request(port, '/api/chat', {
      method: 'POST',
      body: { message: 'test message', conversationId: 'test-conv' },
    });
    const res = await request(port, '/api/chat/history/test-conv');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.messages));
    assert.equal(res.body.messages.length, 2);
    assert.equal(res.body.messages[0].role, 'user');
    assert.equal(res.body.messages[1].role, 'assistant');
  });

  it('streams chat responses via SSE', async () => {
    // Use a simpler approach: just verify the endpoint responds with SSE content type
    const res = await new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; firstChunk?: string }>((resolve, reject) => {
      const req = require('http').request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/api/chat/stream',
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        },
        (res: any) => {
          let firstChunk: string | undefined;
          res.once('data', (chunk: Buffer) => {
            firstChunk = chunk.toString();
          });
          res.on('end', () => {
            resolve({ status: res.statusCode, headers: res.headers, firstChunk });
          });
        },
      );
      req.on('error', reject);
      req.write(JSON.stringify({ message: 'hello' }));
      req.end();
    });

    assert.equal(res.status, 200);
    assert.ok(res.headers['content-type']?.includes('text/event-stream'));
    assert.ok(res.firstChunk?.includes('data:'));
  });

  it('lists memories', async () => {
    const res = await request(port, '/api/memory');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.memories));
    assert.ok(res.body.memories.length > 0);
  });

  it('adds a memory', async () => {
    const res = await request(port, '/api/memory', {
      method: 'POST',
      body: { content: 'test memory content' },
    });
    assert.equal(res.status, 201);
    assert.ok(res.body.memory);
    assert.equal(res.body.memory.content, 'test memory content');
  });

  it('searches memories', async () => {
    const res = await request(port, '/api/memory/search?q=test');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.memories));
  });

  it('deletes a memory', async () => {
    const res = await request(port, '/api/memory/mem-1', { method: 'DELETE' });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
  });

  it('returns 404 for unknown routes', async () => {
    const res = await request(port, '/api/nonexistent');
    assert.equal(res.status, 404);
  });

  it('supports CORS', async () => {
    const res = await request(port, '/api/health', { method: 'OPTIONS' });
    assert.equal(res.status, 204);
    assert.ok(res.headers['access-control-allow-origin']);
  });

  it('rejects requests without API key when configured', async () => {
    const secureServer = new RuntimeApiServer({ port: 0, apiKey: 'test-key-123' });
    await secureServer.start();
    const securePort = secureServer.port;

    try {
      const res = await request(securePort, '/api/health');
      assert.equal(res.status, 401);

      const authed = await request(securePort, '/api/health', {
        headers: { Authorization: 'Bearer test-key-123' },
      });
      assert.equal(authed.status, 200);
    } finally {
      await secureServer.stop();
    }
  });

  it('uses custom chat handler when provided', async () => {
    const customServer = new RuntimeApiServer({
      port: 0,
      chatHandler: (msg: string) => `Custom reply to: ${msg}`,
    });
    await customServer.start();
    const customPort = customServer.port;

    try {
      const res = await request(customPort, '/api/chat', {
        method: 'POST',
        body: { message: 'hello world' },
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.message.content, 'Custom reply to: hello world');
    } finally {
      await customServer.stop();
    }
  });
});

// @z-assistant/app-desktop — unit tests

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';

// ── Test isolation helpers ───────────────────────────────────────────
// RuntimeBridge.loadSettings() reads `<storageDir>/settings.json` on
// construction. To avoid polluting unit tests with the developer's real
// disk settings, every test uses a fresh temp directory.

function tmpStorageDir(): string {
  const dir = path.join(os.tmpdir(), `za-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const _tmpDirs: string[] = [];

afterEach(() => {
  // Best-effort cleanup; ignore errors.
  while (_tmpDirs.length) {
    const dir = _tmpDirs.pop()!;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// ── RuntimeBridge ─────────────────────────────────────────────────────

describe('RuntimeBridge', () => {
  it('uses default settings when none provided', async () => {
    const { RuntimeBridge } = await import('../runtime-bridge');
    const storageDir = tmpStorageDir(); _tmpDirs.push(storageDir);
    const bridge = new RuntimeBridge({ storageDir });
    const settings = bridge.getSettings();
    assert.strictEqual(settings.defaultModel.provider, 'sglang');
    assert.strictEqual(settings.memoryEnabled, true);
    assert.ok(settings.storageDir.includes('za-test-'));
  });

  it('merges partial settings', async () => {
    const { RuntimeBridge } = await import('../runtime-bridge');
    const storageDir = tmpStorageDir(); _tmpDirs.push(storageDir);
    const bridge = new RuntimeBridge({ storageDir, memoryEnabled: false });
    const settings = bridge.getSettings();
    assert.strictEqual(settings.memoryEnabled, false);
    assert.strictEqual(settings.defaultModel.provider, 'sglang');
  });

  it('updateSettings returns merged settings', async () => {
    const { RuntimeBridge } = await import('../runtime-bridge');
    const storageDir = tmpStorageDir(); _tmpDirs.push(storageDir);
    const bridge = new RuntimeBridge({ storageDir });
    const updated = bridge.updateSettings({ memoryEnabled: false });
    assert.strictEqual(updated.memoryEnabled, false);
    const current = bridge.getSettings();
    assert.strictEqual(current.memoryEnabled, false);
  });

  it('isReady returns false before start', async () => {
    const { RuntimeBridge } = await import('../runtime-bridge');
    const storageDir = tmpStorageDir(); _tmpDirs.push(storageDir);
    const bridge = new RuntimeBridge({ storageDir });
    assert.strictEqual(bridge.isReady(), false);
  });
});

// ── Constants ─────────────────────────────────────────────────────────

describe('constants', () => {
  it('IPC_CHANNELS has expected keys', async () => {
    const { IPC_CHANNELS } = await import('../constants');
    assert.ok(IPC_CHANNELS.RUN_TASK);
    assert.ok(IPC_CHANNELS.LIST_RUNS);
    assert.ok(IPC_CHANNELS.GET_SPANS);
    assert.ok(IPC_CHANNELS.GET_RUN);
    assert.ok(IPC_CHANNELS.GET_SETTINGS);
    assert.ok(IPC_CHANNELS.SET_SETTINGS);
    assert.ok(IPC_CHANNELS.RECALL_MEMORY);
    assert.ok(IPC_CHANNELS.ON_RUN_EVENT);
  });

  it('WINDOW_SIZES has expected windows', async () => {
    const { WINDOW_SIZES } = await import('../constants');
    assert.ok(WINDOW_SIZES.main);
    assert.ok(WINDOW_SIZES.chat);
    assert.ok(WINDOW_SIZES.trace);
    assert.ok(WINDOW_SIZES.settings);
    assert.strictEqual(WINDOW_SIZES.main.width, 1200);
  });
});

// ── Hotkey ────────────────────────────────────────────────────────────

describe('hotkey', () => {
  it('DEFAULT_HOTKEY is defined as a string', () => {
    assert.strictEqual(typeof 'CommandOrControl+Shift+Z', 'string');
  });
});

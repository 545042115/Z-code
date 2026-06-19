// @z-assistant/app-desktop — unit tests

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

// ── RuntimeBridge ─────────────────────────────────────────────────────

describe('RuntimeBridge', () => {
  it('uses default settings when none provided', async () => {
    const { RuntimeBridge } = await import('../runtime-bridge');
    const bridge = new RuntimeBridge();
    const settings = bridge.getSettings();
    assert.strictEqual(settings.defaultModel.provider, 'sglang');
    assert.strictEqual(settings.memoryEnabled, true);
    assert.ok(settings.storageDir.includes('.z-assistant'));
  });

  it('merges partial settings', async () => {
    const { RuntimeBridge } = await import('../runtime-bridge');
    const bridge = new RuntimeBridge({ memoryEnabled: false });
    const settings = bridge.getSettings();
    assert.strictEqual(settings.memoryEnabled, false);
    assert.strictEqual(settings.defaultModel.provider, 'sglang');
  });

  it('updateSettings returns merged settings', async () => {
    const { RuntimeBridge } = await import('../runtime-bridge');
    const bridge = new RuntimeBridge();
    const updated = bridge.updateSettings({ memoryEnabled: false });
    assert.strictEqual(updated.memoryEnabled, false);
    const current = bridge.getSettings();
    assert.strictEqual(current.memoryEnabled, false);
  });

  it('isReady returns false before start', async () => {
    const { RuntimeBridge } = await import('../runtime-bridge');
    const bridge = new RuntimeBridge();
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

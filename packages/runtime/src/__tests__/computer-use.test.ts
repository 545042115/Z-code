// @z-assistant/runtime — Computer Use subsystem tests

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { classifyWebAction, classifyGUIAction, isDangerUrl } from '../permission/computer-use';
import { createNoopGUIProvider } from '../action/gui';
import { createNoopScreenProvider } from '../perception/screen';

// ── Computer Use Security ─────────────────────────────────────────────

describe('computer-use security', () => {
  it('classifyWebAction marks navigate to danger URL as critical', () => {
    const result = classifyWebAction('navigate', { url: 'https://example.com/delete-account' });
    assert.strictEqual(result.risk, 'critical');
    assert.strictEqual(result.blocked, true);
  });

  it('classifyWebAction marks safe navigation as safe', () => {
    const result = classifyWebAction('navigate', { url: 'https://example.com/docs' });
    assert.strictEqual(result.risk, 'safe');
    assert.strictEqual(result.blocked, false);
  });

  it('classifyWebAction marks non-HTTPS navigate as medium', () => {
    const result = classifyWebAction('navigate', { url: 'http://example.com' });
    assert.strictEqual(result.risk, 'medium');
    assert.strictEqual(result.blocked, false);
  });

  it('classifyGUIAction marks delete hotkey as high risk', () => {
    const result = classifyGUIAction('keyboard_hotkey', { keys: ['Control', 'Delete'] });
    assert.strictEqual(result.risk, 'high');
  });

  it('classifyGUIAction marks safe click as safe', () => {
    const result = classifyGUIAction('mouse_click', { x: 100, y: 200 });
    assert.strictEqual(result.risk, 'safe');
  });

  it('classifyGUIAction marks clipboard read as low risk', () => {
    const result = classifyGUIAction('clipboard_read', {});
    assert.strictEqual(result.risk, 'low');
  });

  it('isDangerUrl detects dangerous URL patterns', () => {
    assert.strictEqual(isDangerUrl('https://example.com/delete-account'), true);
    assert.strictEqual(isDangerUrl('https://example.com/docs'), false);
    assert.strictEqual(isDangerUrl('https://bank.example.com/transfer'), true);
    assert.strictEqual(isDangerUrl('https://example.com/settings'), false);
    assert.strictEqual(isDangerUrl('https://example.com/cancel-subscription'), true);
    assert.strictEqual(isDangerUrl('https://example.com/payment/confirm'), true);
  });
});

// ── GUI Provider ───────────────────────────────────────────────────────

describe('gui provider', () => {
  it('createNoopGUIProvider returns a working noop provider', async () => {
    const gui = createNoopGUIProvider();
    const result = await gui.execute({ type: 'mouse_click', x: 100, y: 200 });
    assert.strictEqual(result.success, true);
    const size = await gui.screenSize();
    assert.strictEqual(size.width, 0);
    assert.strictEqual(size.height, 0);
  });
});

// ── Screen Provider ────────────────────────────────────────────────────

describe('screen provider', () => {
  it('createNoopScreenProvider returns a working noop provider', async () => {
    const screen = createNoopScreenProvider();
    const cap = await screen.capture();
    assert.strictEqual(cap.screenshotBase64, '');
    assert.strictEqual(cap.width, 0);
    assert.strictEqual(cap.height, 0);
  });

  it('createNoopScreenProvider region capture works', async () => {
    const screen = createNoopScreenProvider();
    const cap = await screen.captureRegion(0, 0, 100, 100);
    assert.strictEqual(cap.screenshotBase64, '');
    assert.strictEqual(cap.height, 0);
  });
});

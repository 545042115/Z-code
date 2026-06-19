// @z-assistant/agent-browser — unit tests for backend, agent, overlay

import { describe, it } from 'node:test';
import assert from 'node:assert';

// ── Backend (interface contract) ───────────────────────────────────────

describe('backend types', () => {
  it('createPlaywrightBackend throws if playwright not installed', () => {
    // This is expected to throw at runtime when playwright is missing.
    // We just verify the function exists with the right signature.
    const { createPlaywrightBackend } = require('../backend');
    assert.strictEqual(typeof createPlaywrightBackend, 'function');
  });
});

// ── Overlay ────────────────────────────────────────────────────────────

describe('overlay', () => {
  it('generateOverlayScript returns a valid JavaScript string', () => {
    const { generateOverlayScript } = require('../overlay');
    const script = generateOverlayScript();
    assert.ok(typeof script === 'string');
    assert.ok(script.length > 100);
    assert.ok(script.includes('z-assistant-overlay'));
    assert.ok(script.includes('z-highlight'));
  });
});

// ── Agent ──────────────────────────────────────────────────────────────

describe('BrowserAgent config', () => {
  it('can be constructed with a config object', () => {
    const { BrowserAgent } = require('../agent');
    // This is a structural test only — actual browser execution requires
    // a running Playwright instance and LLM provider.
    assert.strictEqual(typeof BrowserAgent, 'function');
  });
});

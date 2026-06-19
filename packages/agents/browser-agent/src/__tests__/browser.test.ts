// @z-assistant/agent-browser — unit tests

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { pageToText, findElementByText, buildDOMTree } from '../dom';
import type { PageSnapshot, ElementInfo } from '../backend';

function makeSnapshot(overrides?: Partial<PageSnapshot>): PageSnapshot {
  return {
    url: 'https://example.com',
    title: 'Example',
    screenshotBase64: '',
    elements: [],
    viewport: { width: 1280, height: 800 },
    timestamp: Date.now(),
    ...overrides,
  };
}

// ── DOM ────────────────────────────────────────────────────────────────

describe('dom', () => {
  it('pageToText renders interactive elements', () => {
    const el: ElementInfo = {
      id: 1, tag: 'a', text: 'Click here', attrs: { href: '/page' },
      box: { x: 10, y: 20, width: 100, height: 30 },
      visible: true, interactive: true, children: [],
    };
    const snapshot = makeSnapshot({ elements: [el] });
    const text = pageToText(snapshot);
    assert.ok(text.includes('[1]'));
    assert.ok(text.includes('Click here'));
    assert.ok(text.includes('href="/page"'));
  });

  it('pageToText filters non-visible, non-interactive elements', () => {
    const el: ElementInfo = {
      id: 2, tag: 'div', text: 'hidden', attrs: {},
      box: { x: 0, y: 0, width: 0, height: 0 },
      visible: false, interactive: false, children: [],
    };
    const snapshot = makeSnapshot({ elements: [el] });
    const text = pageToText(snapshot);
    assert.ok(!text.includes('[2]'));
  });

  it('findElementByText matches case-insensitive', () => {
    const el: ElementInfo = {
      id: 3, tag: 'button', text: 'Submit Form', attrs: {},
      box: { x: 0, y: 0, width: 100, height: 30 },
      visible: true, interactive: true, children: [],
    };
    const snapshot = makeSnapshot({ elements: [el] });
    assert.strictEqual(findElementByText(snapshot, 'submit')?.id, 3);
    assert.strictEqual(findElementByText(snapshot, 'SUBMIT')?.id, 3);
    assert.strictEqual(findElementByText(snapshot, 'nonexistent'), undefined);
  });

  it('buildDOMTree builds hierarchy from flat list', () => {
    const outer: ElementInfo = {
      id: 4, tag: 'div', text: 'outer', attrs: {},
      box: { x: 0, y: 0, width: 500, height: 500 },
      visible: true, interactive: false, children: [],
    };
    const inner: ElementInfo = {
      id: 5, tag: 'button', text: 'inner', attrs: {},
      box: { x: 10, y: 10, width: 50, height: 30 },
      visible: true, interactive: true, children: [],
    };
    const snapshot = makeSnapshot({ elements: [outer, inner] });
    const tree = buildDOMTree(snapshot);
    assert.strictEqual(tree.length, 1);
    assert.strictEqual(tree[0].element.id, 4);
    assert.strictEqual(tree[0].children.length, 1);
    assert.strictEqual(tree[0].children[0].element.id, 5);
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

// ── Agent config ───────────────────────────────────────────────────────

describe('BrowserAgent', () => {
  it('can be constructed with a config object', () => {
    const { BrowserAgent } = require('../agent');
    assert.strictEqual(typeof BrowserAgent, 'function');
  });
});

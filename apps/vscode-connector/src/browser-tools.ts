// Browser automation tools for the Chat Agent.
//
// These tools are invoked by the LLM via function calling when the
// user asks the assistant to open a web page, click, scroll, etc.
// Uses runtime require() to avoid DOM type conflicts with Node.js tsconfig.

import { execSync } from 'node:child_process';

// ── Lazy Playwright backend ──────────────────────────────────────────

let _backend: any = null;

function loadBrowserBackend(): any {
  // Use computed require string to prevent TypeScript from resolving
  // @z-assistant/agent-browser through the tsconfig path mapping (which
  // would pull in DOM types incompatible with Node.js tsconfig).
  const pkgName = '@z-assistant/agent-browser';
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require(pkgName);
  return mod.createPlaywrightBackend();
}

async function ensureBrowser(): Promise<any> {
  if (_backend) return _backend;
  try {
    _backend = loadBrowserBackend();
    await _backend.start(false);
    return _backend;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // Try to install Playwright browsers automatically
    if (msg.includes('Executable doesn\'t exist') || msg.includes('playwright install')) {
      try {
        execSync('npx playwright install chromium', { timeout: 120_000, windowsHide: true });
        _backend = loadBrowserBackend();
        await _backend.start(false);
        return _backend;
      } catch {
        throw new Error(`Browser not available. Install Playwright browsers:\n  npx playwright install chromium\n\nError: ${msg}`);
      }
    }
    throw new Error(`Failed to start browser: ${msg}`);
  }
}

async function closeBrowser(): Promise<void> {
  if (_backend) {
    try { await _backend.close(); } catch { /* ignore */ }
    _backend = null;
  }
}

// ── Tool definitions ─────────────────────────────────────────────────

export const BROWSER_NAVIGATE_TOOL = {
  name: 'browser_navigate',
  description:
    'Open a URL in a real browser. Use this when the user asks you to visit a website, or when web_fetch fails to retrieve a dynamic page (e.g. hotel/flight/train price pages that require JavaScript, login, or interaction). ' +
    'After navigating, use browser_screenshot to see what is on the page, then browser_click/browser_scroll to interact with forms and result lists.',
  argsSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The full URL to navigate to (e.g. https://example.com)' },
    },
    required: ['url'],
  },
};

export const BROWSER_CLICK_TOOL = {
  name: 'browser_click',
  description: 'Click at specific coordinates on the current page. Use after browser_screenshot to see the page.',
  argsSchema: {
    type: 'object',
    properties: {
      x: { type: 'number', description: 'X coordinate to click' },
      y: { type: 'number', description: 'Y coordinate to click' },
    },
    required: ['x', 'y'],
  },
};

export const BROWSER_SCROLL_TOOL = {
  name: 'browser_scroll',
  description: 'Scroll the page up or down by a number of pixels.',
  argsSchema: {
    type: 'object',
    properties: {
      direction: { type: 'string', enum: ['up', 'down'], description: 'Scroll direction' },
      amount: { type: 'number', description: 'Pixels to scroll (default: 500)' },
    },
    required: ['direction'],
  },
};

export const BROWSER_SCREENSHOT_TOOL = {
  name: 'browser_screenshot',
  description:
    'Take a screenshot of the current page and return a description of what is visible, including interactive elements and visible text. ' +
    'Use this after browser_navigate or browser_click to inspect dynamic content such as hotel listings, flight results, or train ticket prices. ' +
    'If the price is visible in the screenshot description, report it to the user; otherwise click or scroll to reveal more results.',
  argsSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
};

export const BROWSER_GO_BACK_TOOL = {
  name: 'browser_go_back',
  description: 'Go back to the previous page in browser history.',
  argsSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
};

export const BROWSER_GO_FORWARD_TOOL = {
  name: 'browser_go_forward',
  description: 'Go forward to the next page in browser history.',
  argsSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
};

export const BROWSER_CLOSE_TOOL = {
  name: 'browser_close',
  description: 'Close the browser. Call this when you are done with browser tasks.',
  argsSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
};

export const BROWSER_TOOLS = [
  BROWSER_NAVIGATE_TOOL,
  BROWSER_CLICK_TOOL,
  BROWSER_SCROLL_TOOL,
  BROWSER_SCREENSHOT_TOOL,
  BROWSER_GO_BACK_TOOL,
  BROWSER_GO_FORWARD_TOOL,
  BROWSER_CLOSE_TOOL,
];

// ── Tool implementations ─────────────────────────────────────────────

export async function browserNavigate(url: string): Promise<string> {
  const backend = await ensureBrowser();
  const snapshot = await backend.navigate(url);
  const title = snapshot.title || '(no title)';
  return `Navigated to ${url}\nTitle: ${title}\nURL: ${snapshot.url || url}`;
}

export async function browserClick(x: number, y: number): Promise<string> {
  const backend = await ensureBrowser();
  await backend.act({ type: 'click', x, y });
  return `Clicked at (${x}, ${y})`;
}

export async function browserScroll(direction: string, amount = 500): Promise<string> {
  const backend = await ensureBrowser();
  if (direction === 'down') {
    await backend.act({ type: 'scroll', deltaX: 0, deltaY: amount });
  } else {
    await backend.act({ type: 'scroll', deltaX: 0, deltaY: -amount });
  }
  return `Scrolled ${direction} by ${amount}px`;
}

export async function browserScreenshot(): Promise<string> {
  const backend = await ensureBrowser();
  const snapshot = await backend.snapshot();
  const hasScreenshot = !!snapshot.screenshotBase64;
  const interactiveElements = snapshot.interactiveElements?.length ?? 0;
  const textContent = snapshot.textContent?.slice(0, 500) ?? '';
  let desc = `Screenshot captured (${hasScreenshot ? 'available' : 'not available'})`;
  desc += `\nInteractive elements: ${interactiveElements}`;
  if (textContent) desc += `\nVisible text: ${textContent}`;
  return desc;
}

export async function browserGoBack(): Promise<string> {
  const backend = await ensureBrowser();
  await backend.act({ type: 'goBack' });
  return 'Went back to previous page';
}

export async function browserGoForward(): Promise<string> {
  const backend = await ensureBrowser();
  await backend.act({ type: 'goForward' });
  return 'Went forward to next page';
}

export async function browserClose(): Promise<string> {
  await closeBrowser();
  return 'Browser closed';
}

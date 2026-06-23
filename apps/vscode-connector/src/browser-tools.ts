// Browser automation tools for the Chat Agent.
//
// These tools are invoked by the LLM via function calling when the
// user asks the assistant to open a web page, click, scroll, etc.
// Uses runtime require() to avoid DOM type conflicts with Node.js tsconfig.

import { spawn } from 'node:child_process';

// ── Lazy Playwright backend ──────────────────────────────────────────

let _backend: any = null;
let _lastSnapshot: any = null;
let _idleTimer: ReturnType<typeof setTimeout> | null = null;
const BROWSER_IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

function resetIdleTimer(): void {
  if (_idleTimer) clearTimeout(_idleTimer);
  _idleTimer = setTimeout(() => {
    closeBrowser();
  }, BROWSER_IDLE_TIMEOUT_MS);
}

function clearIdleTimer(): void {
  if (_idleTimer) {
    clearTimeout(_idleTimer);
    _idleTimer = null;
  }
}

function loadBrowserBackend(): any {
  // Use computed require string to prevent TypeScript from resolving
  // @z-assistant/agent-browser through the tsconfig path mapping (which
  // would pull in DOM types incompatible with Node.js tsconfig).
  const pkgName = '@z-assistant/agent-browser';
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require(pkgName);
  return mod.createPlaywrightBackend();
}

async function installPlaywrightChromium(timeoutMs = 120_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['playwright', 'install', 'chromium'], {
      windowsHide: true,
      shell: true,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
    child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Playwright browser installation timed out'));
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Playwright install exited with code ${code}: ${stderr || stdout}`));
      }
    });
  });
}

async function ensureBrowser(): Promise<any> {
  if (_backend) {
    resetIdleTimer();
    return _backend;
  }
  try {
    _backend = loadBrowserBackend();
    await _backend.start(false);
    resetIdleTimer();
    return _backend;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // Try to install Playwright browsers automatically (non-blocking).
    if (msg.includes('Executable doesn\'t exist') || msg.includes('playwright install')) {
      try {
        await installPlaywrightChromium();
        _backend = loadBrowserBackend();
        await _backend.start(false);
        resetIdleTimer();
        return _backend;
      } catch (installErr: unknown) {
        const installMsg = installErr instanceof Error ? installErr.message : String(installErr);
        throw new Error(`Browser not available. Install Playwright browsers manually:\n  npx playwright install chromium\n\nInstall error: ${installMsg}\nOriginal error: ${msg}`);
      }
    }
    throw new Error(`Failed to start browser: ${msg}`);
  }
}

async function closeBrowser(): Promise<void> {
  clearIdleTimer();
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
  description:
    'Click an interactive element on the current page. Use after browser_screenshot. ' +
    'Prefer passing elementId from the screenshot output; fall back to x/y coordinates only when necessary.',
  argsSchema: {
    type: 'object',
    properties: {
      elementId: { type: 'number', description: 'Element id from browser_screenshot output (preferred)' },
      x: { type: 'number', description: 'X coordinate to click (fallback)' },
      y: { type: 'number', description: 'Y coordinate to click (fallback)' },
    },
    required: [],
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

export async function browserClick(elementId?: number, x?: number, y?: number): Promise<string> {
  const backend = await ensureBrowser();

  // Prefer elementId from the last screenshot; map it to center coordinates.
  if (elementId !== undefined && _lastSnapshot?.elements) {
    const el = _lastSnapshot.elements.find((e: any) => e.id === elementId);
    if (el) {
      const cx = Math.round(el.box.x + el.box.width / 2);
      const cy = Math.round(el.box.y + el.box.height / 2);
      await backend.act({ type: 'click', x: cx, y: cy });
      return `Clicked element [${elementId}] <${el.tag}> at (${cx}, ${cy})`;
    }
    return `Element [${elementId}] not found in last screenshot`;
  }

  if (x !== undefined && y !== undefined) {
    await backend.act({ type: 'click', x, y });
    return `Clicked at (${x}, ${y})`;
  }

  throw new Error('browser_click requires elementId or x/y coordinates');
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
  _lastSnapshot = snapshot;

  const title = snapshot.title || '(no title)';
  const url = snapshot.url || '(no url)';
  const viewport = snapshot.viewport || { width: 0, height: 0 };

  // Build a concise but useful textual representation for the LLM.
  let desc = `Page: ${title}\nURL: ${url}\nViewport: ${viewport.width}x${viewport.height}`;

  const visibleText = snapshot.elements
    ?.filter((e: any) => e.visible && e.text)
    ?.map((e: any) => e.text)
    ?.join(' ')
    ?.slice(0, 800) ?? '';
  if (visibleText) {
    desc += `\n\nVisible text:\n${visibleText}`;
  }

  const interactive = snapshot.elements?.filter((e: any) => e.interactive && e.visible) ?? [];
  if (interactive.length > 0) {
    desc += `\n\nInteractive elements (use elementId or center coordinates to click):`;
    for (const el of interactive.slice(0, 30)) {
      const cx = Math.round(el.box.x + el.box.width / 2);
      const cy = Math.round(el.box.y + el.box.height / 2);
      const text = (el.text || '').replace(/\s+/g, ' ').slice(0, 60);
      desc += `\n- [${el.id}] <${el.tag}> "${text}" at (${cx}, ${cy})`;
    }
    if (interactive.length > 30) {
      desc += `\n... and ${interactive.length - 30} more`;
    }
  }

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

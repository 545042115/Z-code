// @z-assistant/agent-browser — Browser backend abstraction
//
// Pluggable browser automation backend. The default implementation uses
// Playwright (when available). The interface is agnostic so other
// backends (CDP direct, Puppeteer, Selenium) can be swapped in.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PlaywrightBrowser = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PlaywrightPage = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PlaywrightCookie = any;

export interface BrowserViewport {
  width: number;
  height: number;
  deviceScaleFactor?: number;
}

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ElementInfo {
  /** Accessible element id (assigned by the backend). */
  id: number;
  /** The HTML tag name. */
  tag: string;
  /** The inner text (truncated to 200 chars). */
  text?: string;
  /** Attribute values useful for identification. */
  attrs: Record<string, string>;
  /** Bounding box relative to viewport. */
  box: BoundingBox;
  /** Whether this element is visible. */
  visible: boolean;
  /** Whether this element is interactive (button, a, input, etc.). */
  interactive: boolean;
  /** Child element ids for tree construction. */
  children: number[];
}

export interface PageSnapshot {
  url: string;
  title: string;
  /** Base64-encoded PNG screenshot. */
  screenshotBase64: string;
  /** Flat array of all elements on the page. */
  elements: ElementInfo[];
  /** Viewport size at snapshot time. */
  viewport: BrowserViewport;
  /** Timestamp of the snapshot. */
  timestamp: number;
}

export type BrowserActionType =
  | 'click'
  | 'dblclick'
  | 'type'
  | 'scroll'
  | 'hover'
  | 'select'
  | 'navigate'
  | 'back'
  | 'forward'
  | 'reload'
  | 'wait'
  | 'screenshot'
  | 'press_key'
  | 'new_tab'
  | 'close_tab'
  | 'switch_tab';

export interface BrowserAction {
  type: BrowserActionType;
  /** Element id to act upon (for click/type/hover/select). */
  elementId?: number;
  /** Screen coordinates for mouse actions (click fallback). */
  x?: number;
  y?: number;
  /** Text to type (for type action). */
  text?: string;
  /** URL to navigate to (for navigate / new_tab). */
  url?: string;
  /** Key to press (for press_key). */
  key?: string;
  /** Tab index or id (for switch_tab). */
  tabIndex?: number;
  /** Absolute scroll position (scrollTo). */
  scrollX?: number;
  scrollY?: number;
  /** Relative scroll delta (scrollBy). */
  deltaX?: number;
  deltaY?: number;
  /** Wait duration in ms. */
  waitMs?: number;
}

export interface ActionResult {
  success: boolean;
  error?: string;
  /** Updated snapshot after the action (if the action caused navigation). */
  snapshot?: PageSnapshot;
}

export interface Cookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

export interface IBrowserBackend {
  readonly name: string;

  /** Start the browser (headless by default). */
  start(headless?: boolean): Promise<void>;

  /** Open a new tab/page and navigate to the given URL. */
  navigate(url: string): Promise<PageSnapshot>;

  /** Get the current page's full snapshot. */
  snapshot(opts?: { includeScreenshot?: boolean }): Promise<PageSnapshot>;

  /** Execute a single action on the current page. */
  act(action: BrowserAction): Promise<ActionResult>;

  /** Get the current page URL. */
  url(): Promise<string>;

  /** Get the current page title. */
  title(): Promise<string>;

  /** Get/set cookies for the current page. */
  cookies(): Promise<Cookie[]>;
  setCookies(cookies: Cookie[]): Promise<void>;

  /** Clear browser data (cookies, local storage). */
  clearData(): Promise<void>;

  /** Open a new tab and optionally navigate to a URL. */
  newTab(url?: string): Promise<PageSnapshot>;

  /** Close the current tab. Returns snapshot of remaining page or undefined if last tab. */
  closeTab(): Promise<PageSnapshot | undefined>;

  /** Switch to a tab by index (0-based). */
  switchTab(index: number): Promise<PageSnapshot>;

  /** List all open tab URLs and titles. */
  listTabs(): Promise<Array<{ index: number; url: string; title: string; active: boolean }>>;

  /** Close the browser and release resources. */
  close(): Promise<void>;
}

export function createPlaywrightBackend(): IBrowserBackend {
  return new PlaywrightBackend();
}

// Raw element data returned from page.evaluate
interface RawElementData {
  tag: string;
  text: string | undefined;
  attrs: Record<string, string>;
  rect: { x: number; y: number; w: number; h: number };
  visible: boolean;
  interactive: boolean;
}

class PlaywrightBackend implements IBrowserBackend {
  readonly name = 'playwright';

  private browser: PlaywrightBrowser | null = null;
  private context: PlaywrightBrowser | null = null;
  private page: PlaywrightPage | null = null;

  async start(headless = true): Promise<void> {
    let playwright: any;
    try {
      playwright = await import('playwright');
    } catch {
      throw new Error(
        'Playwright is not installed. Run `npm install playwright` ' +
        'or use a different IBrowserBackend implementation.'
      );
    }
    this.browser = await playwright.chromium.launch({ headless });
    this.context = await (this.browser as any).newContext({
      viewport: { width: 1280, height: 800 },
    });
    this.page = await (this.context as any).newPage();
  }

  async navigate(url: string): Promise<PageSnapshot> {
    await this.ensurePage();
    await (this.page as any).goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    return this.snapshot();
  }

  async snapshot(opts?: { includeScreenshot?: boolean }): Promise<PageSnapshot> {
    await this.ensurePage();
    const p = this.page as any;
    const includeScreenshot = opts?.includeScreenshot ?? false;
    const screenshotBase64 = includeScreenshot
      ? ((await p.screenshot({ type: 'png', fullPage: false })) as Buffer).toString('base64')
      : '';
    const elementsData: RawElementData[] = await p.evaluate(() => {
      const all: Array<{
        tag: string; text: string | undefined; attrs: Record<string, string>;
        rect: { x: number; y: number; w: number; h: number };
        visible: boolean; interactive: boolean;
      }> = [];
      const MAX_DEPTH = 20;
      const MAX_ELEMENTS = 200;
      function walk(node: Element, depth: number): void {
        if (depth > MAX_DEPTH || all.length >= MAX_ELEMENTS) return;
        const tag = node.tagName.toLowerCase();
        const rect = node.getBoundingClientRect();
        const visible = rect.width > 0 && rect.height > 0 &&
          rect.x + rect.width > 0 && rect.y + rect.height > 0 &&
          rect.x < window.innerWidth && rect.y < window.innerHeight;
        const text = node.textContent?.trim().slice(0, 200) || undefined;
        const attrs: Record<string, string> = {};
        for (let ai = 0; ai < node.attributes.length; ai++) {
          const a = node.attributes.item(ai);
          if (a) attrs[a.name] = a.value;
        }
        const interactive = ['a', 'button', 'input', 'select', 'textarea', 'details', 'summary'].includes(tag) ||
          (node as HTMLElement).contentEditable === 'true' ||
          node.getAttribute('role') === 'button' ||
          node.getAttribute('role') === 'link';
        if (visible || interactive) {
          all.push({
            tag, text: text || undefined, attrs,
            rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
            visible, interactive,
          });
        }
        for (let i = 0; i < node.children.length; i++) {
          walk(node.children[i] as HTMLElement, depth + 1);
        }
      }
      walk(document.body, 0);
      return all;
    });

    const viewport = await p.viewportSize();
    let idCounter = 1;
    const elements: ElementInfo[] = elementsData.map((d: RawElementData) => {
      const id = idCounter++;
      return {
        id, tag: d.tag, text: d.text, attrs: d.attrs,
        box: { x: d.rect.x, y: d.rect.y, width: d.rect.w, height: d.rect.h },
        visible: d.visible, interactive: d.interactive, children: [],
      };
    });

    return {
      url: await p.url(),
      title: await p.title(),
      screenshotBase64,
      elements,
      viewport: { width: viewport.width, height: viewport.height },
      timestamp: Date.now(),
    };
  }

  async act(action: BrowserAction): Promise<ActionResult> {
    await this.ensurePage();
    const p = this.page as any;
    try {
      switch (action.type) {
        case 'click': {
          if (action.elementId !== undefined) {
            await p.click(this.selector(action.elementId), { timeout: 5000 });
          } else if (action.x !== undefined && action.y !== undefined) {
            await p.mouse.click(action.x, action.y);
          } else {
            throw new Error('click requires elementId or x/y coordinates');
          }
          break;
        }
        case 'dblclick':
          await p.dblclick(this.selector(action.elementId!), { timeout: 5000 });
          break;
        case 'type':
          await p.fill(this.selector(action.elementId!), action.text ?? '');
          break;
        case 'hover':
          await p.hover(this.selector(action.elementId!), { timeout: 5000 });
          break;
        case 'select':
          await p.selectOption(this.selector(action.elementId!), action.text ?? '');
          break;
        case 'scroll': {
          // Prefer relative delta scroll; fall back to absolute scrollTo.
          if (action.deltaX !== undefined || action.deltaY !== undefined) {
            const dx = action.deltaX ?? 0;
            const dy = action.deltaY ?? 0;
            await p.evaluate((opts: { dx: number; dy: number }) => {
              window.scrollBy(opts.dx, opts.dy);
            }, { dx, dy });
          } else {
            await p.evaluate((opts: { x: number; y: number }) => window.scrollTo(opts.x, opts.y), { x: action.scrollX ?? 0, y: action.scrollY ?? 0 });
          }
          break;
        }
        case 'navigate':
          return await this.navigate(action.url!).then((snap) => ({ success: true, snapshot: snap }));
        case 'back':
          await p.goBack({ waitUntil: 'networkidle', timeout: 30000 });
          break;
        case 'forward':
          await p.goForward({ waitUntil: 'networkidle', timeout: 30000 });
          break;
        case 'reload':
          await p.reload({ waitUntil: 'networkidle', timeout: 30000 });
          break;
        case 'wait':
          await p.waitForTimeout(action.waitMs ?? 2000);
          break;
        case 'press_key':
          await p.keyboard.press(action.key ?? 'Enter');
          break;
        case 'screenshot':
          break;
        case 'new_tab':
          return await this.newTab(action.url).then((snap) => ({ success: true, snapshot: snap }));
        case 'close_tab':
          return await this.closeTab().then((snap) => ({ success: true, snapshot: snap }));
        case 'switch_tab': {
          const snap = await this.switchTab(action.tabIndex ?? 0);
          return { success: true, snapshot: snap };
        }
      }
      let snapshot: PageSnapshot | undefined;
      try { snapshot = await this.snapshot(); } catch { /* ignore */ }
      return { success: true, snapshot };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      let snapshot: PageSnapshot | undefined;
      try { snapshot = await this.snapshot(); } catch { /* ignore */ }
      return { success: false, error: msg, snapshot };
    }
  }

  async url(): Promise<string> {
    await this.ensurePage();
    return (this.page as any).url();
  }

  async title(): Promise<string> {
    await this.ensurePage();
    return (this.page as any).title();
  }

  async cookies(): Promise<Cookie[]> {
    await this.ensurePage();
    const ctx = (this.page as any).context();
    const raw: PlaywrightCookie[] = await ctx.cookies();
    return raw.map((c: PlaywrightCookie) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      expires: c.expires,
      httpOnly: c.httpOnly,
      secure: c.secure,
      sameSite: c.sameSite as 'Strict' | 'Lax' | 'None' | undefined,
    }));
  }

  async setCookies(cookies: Cookie[]): Promise<void> {
    await this.ensurePage();
    const ctx = (this.page as any).context();
    await ctx.addCookies(cookies.map((c: Cookie) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      expires: c.expires ?? -1,
      httpOnly: c.httpOnly ?? false,
      secure: c.secure ?? true,
      sameSite: c.sameSite ?? 'Lax',
    })));
  }

  async clearData(): Promise<void> {
    await this.ensurePage();
    const ctx = this.context as any;
    await ctx.clearCookies();
    await (this.page as any).evaluate(() => {
      localStorage.clear();
      sessionStorage.clear();
    });
  }

  async newTab(url?: string): Promise<PageSnapshot> {
    await this.ensureContext();
    this.page = await (this.context as any).newPage();
    if (url) {
      await (this.page as any).goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    }
    return this.snapshot();
  }

  async closeTab(): Promise<PageSnapshot | undefined> {
    const pages = (this.context as any)?.pages() ?? [];
    if (pages.length <= 1) {
      // Last tab: close page but don't close the context.
      await (this.page as any)?.close().catch(() => {});
      this.page = null;
      return undefined;
    }
    const currentIndex = pages.indexOf(this.page);
    await (this.page as any).close();
    // Switch to the nearest remaining tab.
    const remaining = (this.context as any).pages();
    const nextIndex = Math.min(currentIndex, remaining.length - 1);
    this.page = remaining[nextIndex];
    return this.snapshot();
  }

  async switchTab(index: number): Promise<PageSnapshot> {
    const pages = (this.context as any)?.pages() ?? [];
    if (index < 0 || index >= pages.length) {
      throw new Error(`Tab index ${index} out of range (0-${pages.length - 1})`);
    }
    this.page = pages[index];
    return this.snapshot();
  }

  async listTabs(): Promise<Array<{ index: number; url: string; title: string; active: boolean }>> {
    const pages = (this.context as any)?.pages() ?? [];
    const result: Array<{ index: number; url: string; title: string; active: boolean }> = [];
    for (let i = 0; i < pages.length; i++) {
      const p = pages[i];
      try {
        result.push({
          index: i,
          url: await p.url(),
          title: await p.title(),
          active: p === this.page,
        });
      } catch {
        result.push({ index: i, url: '<unreachable>', title: '', active: false });
      }
    }
    return result;
  }

  async close(): Promise<void> {
    try { await (this.browser as any)?.close(); } catch { /* ignore */ }
    this.browser = null;
    this.context = null;
    this.page = null;
  }

  private async ensurePage(): Promise<void> {
    if (!this.page) throw new Error('Browser not started. Call start() first.');
  }

  private async ensureContext(): Promise<void> {
    if (!this.context) throw new Error('Browser not started. Call start() first.');
  }

  private selector(elementId: number | undefined): string {
    if (elementId === undefined) throw new Error('elementId is required for this action');
    return `[data-z-id="${elementId}"]`;
  }
}

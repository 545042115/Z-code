// @z-assistant/agent-browser — Playwright type declarations
//
// Minimal declarations for the optional Playwright dependency.
// When `playwright` is installed, the real types take precedence.

declare module 'playwright' {
  export interface Browser {
    newContext(options?: { viewport?: { width: number; height: number } }): Promise<BrowserContext>;
    close(): Promise<void>;
  }
  export interface BrowserContext {
    newPage(): Promise<Page>;
    cookies(urls?: string | string[]): Promise<Cookie[]>;
    addCookies(cookies: CookieParam[]): Promise<void>;
    clearCookies(): Promise<void>;
  }
  export interface Page {
    goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
    screenshot(options?: { type?: string; fullPage?: boolean }): Promise<Buffer>;
    evaluate<R>(fn: (...args: unknown[]) => R, ...args: unknown[]): Promise<R>;
    click(selector: string, options?: { timeout?: number }): Promise<void>;
    dblclick(selector: string, options?: { timeout?: number }): Promise<void>;
    fill(selector: string, value: string): Promise<void>;
    hover(selector: string, options?: { timeout?: number }): Promise<void>;
    selectOption(selector: string, value: string): Promise<string[]>;
    goBack(options?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
    goForward(options?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
    reload(options?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
    waitForTimeout(ms: number): Promise<void>;
    url(): Promise<string>;
    title(): Promise<string>;
    viewportSize(): Promise<{ width: number; height: number }>;
    keyboard: { press(key: string): Promise<void> };
    context(): BrowserContext;
    close(): Promise<void>;
  }
  export interface Cookie {
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite: 'Strict' | 'Lax' | 'None';
  }
  export interface CookieParam {
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite: 'Strict' | 'Lax' | 'None';
  }
  export const chromium: {
    launch(options?: { headless?: boolean }): Promise<Browser>;
  };
}

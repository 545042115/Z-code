// @ziner/app-desktop — Browser Automation Service
//
// Wraps the @ziner/agent-browser package for desktop use.
// Provides browser navigation, actions, screenshots, and status.

import type { BrowserAction, PageSnapshot } from '@ziner/agent-browser';

export interface BrowserStatus {
  running: boolean;
  url: string;
  title: string;
  error: string;
}

export class BrowserService {
  private backend: any = null;
  private status: BrowserStatus = { running: false, url: '', title: '', error: '' };

  async start(): Promise<BrowserStatus> {
    try {
      const { createPlaywrightBackend } = await import('@ziner/agent-browser');
      this.backend = createPlaywrightBackend();
      await this.backend.start(false);
      this.status = { running: true, url: 'about:blank', title: '', error: '' };
      return { ...this.status };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.status = { running: false, url: '', title: '', error: msg };
      return { ...this.status };
    }
  }

  async stop(): Promise<BrowserStatus> {
    try {
      await this.backend?.close();
    } catch { /* ignore */ }
    this.backend = null;
    this.status = { running: false, url: '', title: '', error: '' };
    return { ...this.status };
  }

  async navigate(url: string): Promise<PageSnapshot> {
    if (!this.backend) throw new Error('Browser not started');
    const snapshot = await this.backend.navigate(url);
    this.status.url = url;
    this.status.title = snapshot.title || '';
    return snapshot;
  }

  async performAction(action: BrowserAction): Promise<any> {
    if (!this.backend) throw new Error('Browser not started');
    return this.backend.act(action);
  }

  async screenshot(): Promise<string> {
    if (!this.backend) throw new Error('Browser not started');
    const snapshot = await this.backend.snapshot();
    return snapshot.screenshotBase64;
  }

  getStatus(): BrowserStatus {
    return { ...this.status };
  }
}

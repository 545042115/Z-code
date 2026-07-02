// @ziner/app-desktop — Browser Agent IAgent bridge (P1-1).
//
// Lives in the desktop app because it depends on @ziner/agent-browser,
// which requires DOM types for its page-evaluation code. Keeping it here
// avoids forcing those dependencies into the VSCode connector.

import type { IAgent, ILLMProvider, ITool, ModelSpec, TaskContext, AgentResult } from '@ziner/contracts';
import { ok as okResult, fail as failResult } from '@ziner/contracts';
import { BrowserAgent, createPlaywrightBackend, type IBrowserBackend } from '@ziner/agent-browser';
import { emitAgentActivity } from './agent-activity-bus';

export interface CreateBrowserAgentOptions {
  llmProvider: ILLMProvider;
  model: ModelSpec;
  maxSteps?: number;
  headless?: boolean;
  /**
   * Optional MCP tools. The browser agent does not invoke MCP tools
   * directly today — it drives the real browser — but we accept them so
   * the factory signature stays consistent with the V2 connector and
   * future iterations (e.g. extracting structured data via MCP after a
   * page load) can use them.
   */
  mcpTools?: ITool[];
}

// Singleton browser backend so we don't pay Chromium launch cost for every task.
let sharedBackend: IBrowserBackend | null = null;
let sharedBackendPromise: Promise<IBrowserBackend> | null = null;

// Idle timeout: auto-close browser after 5 minutes of inactivity.
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

// Callback to notify when the browser state changes (for preview window).
let onBrowserStarted: (() => void) | null = null;
let onBrowserStopped: (() => void) | null = null;

/** Register callbacks for browser lifecycle events. */
export function setBrowserLifecycleCallbacks(opts: {
  onStarted?: () => void;
  onStopped?: () => void;
}): void {
  if (opts.onStarted) onBrowserStarted = opts.onStarted;
  if (opts.onStopped) onBrowserStopped = opts.onStopped;
}

/**
 * Start CDP screencast on the shared backend.
 * The browser pushes JPEG frames in real time (~10fps).
 */
export async function startScreencast(opts: {
  onFrame: (jpegBase64: string) => void;
  quality?: number;
  maxWidth?: number;
  maxHeight?: number;
}): Promise<void> {
  if (!sharedBackend) throw new Error('Browser not started');
  await sharedBackend.startScreencast(opts);
}

/** Stop CDP screencast. */
export async function stopScreencast(): Promise<void> {
  if (!sharedBackend) return;
  await sharedBackend.stopScreencast();
}

function resetIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    if (sharedBackend) {
      await sharedBackend.close().catch(() => {});
      sharedBackend = null;
      sharedBackendPromise = null;
      onBrowserStopped?.();
    }
  }, IDLE_TIMEOUT_MS);
}

async function initBackend(headless = true): Promise<IBrowserBackend> {
  if (sharedBackend) {
    resetIdleTimer();
    return sharedBackend;
  }
  if (sharedBackendPromise) {
    const backend = await sharedBackendPromise;
    resetIdleTimer();
    return backend;
  }

  sharedBackendPromise = (async () => {
    const backend = createPlaywrightBackend();
    await backend.start(headless);
    sharedBackend = backend;
    onBrowserStarted?.();
    resetIdleTimer();
    return backend;
  })();
  return sharedBackendPromise;
}

async function resetBackend(): Promise<void> {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  if (sharedBackend) {
    await sharedBackend.close().catch(() => {});
    sharedBackend = null;
  }
  sharedBackendPromise = null;
  onBrowserStopped?.();
}

export function createBrowserAgent(options: CreateBrowserAgentOptions): IAgent {
  const { llmProvider, model, maxSteps = 8, headless = true } = options;
  return {
    name: 'browser',
    role: 'Browser Automation',
    capabilities: ['browser', 'web', 'navigation', 'screenshot'],
    dependencies: [],
    modelPreference: model,

    canHandle(ctx: TaskContext): number {
      const t = ctx.task.toLowerCase();
      // Strong signals (directly mention browser usage)
      const strongKeywords = ['浏览器', 'browser', '打开网页', '打开网站', '用浏览器', '帮我浏览'];
      // Medium signals (likely need browser interaction)
      const mediumKeywords = [
        '网页', '网站', '截图', '点击', '导航', '登录', 'login',
        'browse', 'website', 'webpage', 'web page',
        'click', 'screenshot', 'navigate', 'go to', 'visit',
        'url', 'scroll', 'hover', 'type', '填表', '搜索框',
      ];
      let score = 0;
      for (const k of strongKeywords) {
        if (t.includes(k.toLowerCase())) score += 0.5;
      }
      for (const k of mediumKeywords) {
        if (t.includes(k.toLowerCase())) score += 0.15;
      }
      return Math.min(score, 0.95);
    },

    async execute(ctx: TaskContext): Promise<AgentResult> {
      const t0 = Date.now();
      let backend: IBrowserBackend | null = null;
      try {
        emitAgentActivity({
          agent: 'browser',
          icon: '\u{1F4BB}',
          message: `Starting browser automation: ${ctx.task.slice(0, 80)}`,
        });
        backend = await initBackend(headless);
        const agent = new BrowserAgent({
          llm: llmProvider,
          model: model.name,
          browser: backend,
          maxSteps,
          includeScreenshots: false,
        });
        const result = await agent.run(ctx.task, (stepResult) => {
          // Reset idle timer on each step
          resetIdleTimer();
          const actionType = stepResult.action.type;
          const actionIcons: Record<string, string> = {
            navigate: '\u{1F310}',
            click: '\u{1F446}',
            type: '\u{2328}',
            scroll: '\u{1F4D6}',
            wait: '\u{23F3}',
            screenshot: '\u{1F4F7}',
            reload: '\u{1F504}',
            back: '\u{25C0}',
            forward: '\u{25B6}',
            hover: '\u{1F441}',
            select: '\u{1F4CB}',
            press_key: '\u{2328}',
            new_tab: '\u{2795}',
            close_tab: '\u{274C}',
            switch_tab: '\u{1F4C4}',
          };
          emitAgentActivity({
            agent: 'browser',
            icon: actionIcons[actionType] || '\u{1F4BB}',
            message: `Step ${stepResult.step}: ${actionType}${stepResult.action.url ? ' ' + stepResult.action.url.slice(0, 60) : ''}${stepResult.action.text ? ' "' + stepResult.action.text.slice(0, 30) + '"' : ''}`,
            detail: stepResult.actionResult.success ? undefined : `Failed: ${stepResult.actionResult.error}`,
          });
        });
        const output = result.done
          ? `[Browser] 任务已完成（${result.steps} 步）。\n摘要：${result.summary}`
          : `[Browser] 任务未在限定步数内完成（${result.steps} 步）。\n摘要：${result.summary}`;
        emitAgentActivity({
          agent: 'browser',
          icon: result.done ? '\u{2705}' : '\u{26A0}',
          message: result.done ? `Task completed (${result.steps} steps)` : `Task incomplete (${result.steps} steps)`,
          detail: result.summary.slice(0, 120),
        });
        return okResult(output, {
          metrics: {
            tokensIn: 0,
            tokensOut: 0,
            costUsd: 0,
            durationMs: Date.now() - t0,
            llmCalls: 0,
            toolCalls: result.steps,
          },
        });
      } catch (err: unknown) {
        // If the shared backend died, reset it so the next task starts fresh.
        await resetBackend();
        return failResult('BROWSER_ERROR', err instanceof Error ? err.message : String(err));
      }
      // Intentionally NOT closing the shared backend here so it can be reused.
      // The idle timer will close it after IDLE_TIMEOUT_MS of inactivity.
    },
  };
}

/** Get the shared browser backend (creates one if needed). */
export function getSharedBackend(): Promise<IBrowserBackend> {
  return initBackend(true);
}

/** Call this on app quit to release the browser process. */
export async function closeSharedBrowser(): Promise<void> {
  await resetBackend();
}

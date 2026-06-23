// @z-assistant/app-desktop — Browser Agent IAgent bridge (P1-1).
//
// Lives in the desktop app because it depends on @z-assistant/agent-browser,
// which requires DOM types for its page-evaluation code. Keeping it here
// avoids forcing those dependencies into the VSCode connector.

import type { IAgent, ILLMProvider, ModelSpec, TaskContext, AgentResult } from '@z-assistant/contracts';
import { ok as okResult, fail as failResult } from '@z-assistant/contracts';
import { BrowserAgent, createPlaywrightBackend, type IBrowserBackend } from '@z-assistant/agent-browser';

export interface CreateBrowserAgentOptions {
  llmProvider: ILLMProvider;
  model: ModelSpec;
  maxSteps?: number;
  headless?: boolean;
}

// Singleton browser backend so we don't pay Chromium launch cost for every task.
let sharedBackend: IBrowserBackend | null = null;
let sharedBackendPromise: Promise<IBrowserBackend> | null = null;

async function getSharedBackend(headless = true): Promise<IBrowserBackend> {
  if (sharedBackend) return sharedBackend;
  if (sharedBackendPromise) return sharedBackendPromise;

  sharedBackendPromise = (async () => {
    const backend = createPlaywrightBackend();
    await backend.start(headless);
    sharedBackend = backend;
    return backend;
  })();
  return sharedBackendPromise;
}

async function resetBackend(): Promise<void> {
  if (sharedBackend) {
    await sharedBackend.close().catch(() => {});
    sharedBackend = null;
  }
  sharedBackendPromise = null;
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
      const keywords = [
        '浏览器', '网页', '打开网站', '截图', '点击', '导航',
        'browse', 'browser', 'website', 'web page', 'webpage',
        'click', 'screenshot', 'navigate', 'go to', 'visit',
        'url', 'login', '打开网页',
      ];
      let score = 0;
      for (const k of keywords) {
        if (t.includes(k.toLowerCase())) score += 0.18;
      }
      return Math.min(score, 0.95);
    },

    async execute(ctx: TaskContext): Promise<AgentResult> {
      const t0 = Date.now();
      let backend: IBrowserBackend | null = null;
      try {
        backend = await getSharedBackend(headless);
        const agent = new BrowserAgent({
          llm: llmProvider,
          model: model.name,
          browser: backend,
          maxSteps,
          includeScreenshots: false,
        });
        const result = await agent.run(ctx.task);
        const output = result.done
          ? `[Browser] 任务已完成（${result.steps} 步）。\n摘要：${result.summary}`
          : `[Browser] 任务未在限定步数内完成（${result.steps} 步）。\n摘要：${result.summary}`;
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
    },
  };
}

/** Call this on app quit to release the browser process. */
export async function closeSharedBrowser(): Promise<void> {
  await resetBackend();
}

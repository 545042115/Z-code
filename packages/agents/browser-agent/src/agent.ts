// @z-assistant/agent-browser — Browser Agent decision engine
//
// Observes the current page (DOM + screenshot), decides the next action
// using the LLM, executes it, and repeats until the task is done.

import type { ILLMProvider, LLMMessage } from '@z-assistant/contracts';
import type { IBrowserBackend, BrowserAction, BrowserActionType, PageSnapshot, ActionResult } from './backend';
import { pageToText } from './dom';

export interface BrowserAgentConfig {
  /** Max consecutive actions before forcing a break. */
  maxSteps: number;
  /** Target LLM model name. */
  model: string;
  /** LLM provider. */
  llm: ILLMProvider;
  /** Browser backend. */
  browser: IBrowserBackend;
  /** System prompt to prepend. */
  systemPrompt?: string;
  /** Include a base64 screenshot in every snapshot. Default false (faster). */
  includeScreenshots?: boolean;
  /**
   * Max number of recent page observations kept in full in the LLM context.
   * Older observations are summarized. Default 3.
   */
  maxObservations?: number;
}

export interface BrowserStepResult {
  step: number;
  action: BrowserAction;
  actionResult: ActionResult;
  snapshot: PageSnapshot;
  thought?: string;
}

export class BrowserAgent {
  private readonly config: BrowserAgentConfig;
  private conversation: LLMMessage[] = [];

  constructor(config: BrowserAgentConfig) {
    this.config = config;
    this.conversation = [
      {
        role: 'system',
        content: config.systemPrompt ?? `You are a browser automation agent. Your job is to complete web tasks step by step.

You receive a text representation of the current page (interactive elements with their IDs).
Respond with a JSON action in this format:
{"thought": "explain your reasoning", "action": {"type": "click|type|navigate|scroll|wait|select|press_key|screenshot|reload|back|forward|hover|new_tab|close_tab|switch_tab", "elementId": 123, "text": "value to type", "url": "https://...", "scrollY": 500, "key": "Enter", "tabIndex": 0}}

Available action types:
- click: Click an interactive element
- type: Type text into an input/textarea
- navigate: Go to a URL
- scroll: Scroll the page (use scrollY)
- wait: Wait for N milliseconds
- select: Select an option in a select element
- press_key: Press a keyboard key
- screenshot: Take a screenshot (for observation)
- reload: Reload the current page
- back/forward: Browser navigation
- new_tab: Open a new tab (optionally navigate to url)
- close_tab: Close the current tab
- switch_tab: Switch to a tab by index (use tabIndex)
- hover: Hover over an element

Continue until the task is complete, then respond with {"done": true, "summary": "..."}.`,
      },
    ];
  }

  get steps(): number {
    return this.conversation.filter((m) => m.role === 'assistant').length;
  }

  /** Run a task in the browser until completion or maxSteps. */
  async run(task: string, onStep?: (step: BrowserStepResult) => void): Promise<{ done: boolean; summary: string; steps: number }> {
    this.conversation.push({ role: 'user', content: `Task: ${task}` });

    for (let step = 1; step <= this.config.maxSteps; step++) {
      // 1) Observe the page
      let snapshot: PageSnapshot;
      try {
        snapshot = await this.config.browser.snapshot({ includeScreenshot: this.config.includeScreenshots ?? false });
      } catch {
        return { done: false, summary: 'Browser error: failed to take snapshot', steps: step - 1 };
      }

      // 2) Prepare observation for LLM
      const pageText = pageToText(snapshot);
      this.conversation.push({
        role: 'user',
        content: `Step ${step} — Page state:\n${pageText}`,
      });

      // 3) LLM decides next action
      const action = await this.decideAction(step);
      if (!action) {
        return { done: true, summary: 'Task completed', steps: step };
      }

      // 4) Execute the action
      const actionResult = await this.config.browser.act(action as BrowserAction);

      // 5) Record result
      const stepResult: BrowserStepResult = {
        step,
        action: action as BrowserAction,
        snapshot,
        actionResult,
      };
      onStep?.(stepResult);

      if (!actionResult.success) {
        this.conversation.push({
          role: 'assistant',
          content: `Action failed: ${actionResult.error}`,
        });
      }

      this.compressConversation();
    }

    return { done: false, summary: `Reached max steps (${this.config.maxSteps})`, steps: this.config.maxSteps };
  }

  /**
   * Keep the LLM context bounded. Retain the system prompt, the original
   * task, the most recent `maxObservations` observation/action pairs, and
   * summarize everything older into a single compact message.
   */
  private compressConversation(): void {
    const maxObservations = this.config.maxObservations ?? 3;
    // System (1) + task (1) + N observation/action pairs (2 each).
    const maxMessages = 2 + maxObservations * 2;
    if (this.conversation.length <= maxMessages) return;

    const tail = this.conversation.slice(-maxMessages);
    const oldPart = this.conversation.slice(2, -maxMessages);

    const summaryLines: string[] = [];
    let currentUrl = '';
    for (const m of oldPart) {
      const content = m.content ?? '';
      const urlMatch = content.match(/URL:\s*(.+)/);
      if (urlMatch) currentUrl = urlMatch[1].trim();
      const actionMatch = content.match(/\{"type":\s*"([^"]+)"/);
      if (actionMatch) {
        summaryLines.push(`- ${actionMatch[1]} at ${currentUrl || 'current page'}`);
      }
      if (content.startsWith('Action failed:')) {
        summaryLines.push(`- ${content.slice(0, 120)}`);
      }
    }

    const summary = summaryLines.length > 0
      ? `Earlier browser actions summary:\n${summaryLines.join('\n')}`
      : '[Earlier page observations omitted for brevity.]';

    this.conversation = [this.conversation[0], this.conversation[1], { role: 'user', content: summary }, ...tail];
  }

  private async decideAction(step: number, attempt = 0): Promise<BrowserAction | null> {
    const MAX_RETRIES = 2;
    const response = await this.config.llm.generate({
      model: { provider: 'unknown', name: this.config.model },
      messages: this.conversation,
      temperature: 0.2,
      jsonMode: true,
    });

    const text = response.message.content ?? '';
    try {
      const parsed = JSON.parse(text);
      if (parsed.done) return null;
      if (parsed.action) {
        const allowed: BrowserActionType[] = [
          'click', 'dblclick', 'type', 'scroll', 'hover', 'select',
          'navigate', 'back', 'forward', 'reload', 'wait', 'screenshot',
          'press_key', 'new_tab', 'close_tab', 'switch_tab',
        ];
        if (allowed.includes(parsed.action.type)) {
          return parsed.action as BrowserAction;
        }
        throw new Error(`Invalid action type: ${parsed.action.type}`);
      }
      throw new Error('No action in response');
    } catch (err) {
      // If JSON parsing fails, try to extract action from text
      const actionMatch = text.match(/\{"type":/);
      if (actionMatch) {
        try {
          const jsonStart = text.indexOf('{');
          const jsonEnd = text.lastIndexOf('}') + 1;
          return JSON.parse(text.slice(jsonStart, jsonEnd)).action as BrowserAction;
        } catch {
          // fall through
        }
      }
      if (attempt >= MAX_RETRIES) {
        return { type: 'wait', waitMs: 1000 } as BrowserAction;
      }
      this.conversation.push({
        role: 'user',
        content: `Invalid response format. Please respond with a valid JSON action object. Error: ${err instanceof Error ? err.message : String(err)}`,
      });
      // Retry recursively with bounded attempts
      return this.decideAction(step, attempt + 1);
    }
  }
}

import type { ILLMProvider } from '@z-assistant/contracts';
import type { IBrowserBackend, BrowserAction, PageSnapshot, ActionResult } from './backend';
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
}
export interface BrowserStepResult {
    step: number;
    action: BrowserAction;
    actionResult: ActionResult;
    snapshot: PageSnapshot;
    thought?: string;
}
export declare class BrowserAgent {
    private readonly config;
    private conversation;
    constructor(config: BrowserAgentConfig);
    get steps(): number;
    /** Run a task in the browser until completion or maxSteps. */
    run(task: string, onStep?: (step: BrowserStepResult) => void): Promise<{
        done: boolean;
        summary: string;
        steps: number;
    }>;
    private decideAction;
}
//# sourceMappingURL=agent.d.ts.map
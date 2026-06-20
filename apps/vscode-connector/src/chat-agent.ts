// Chat Agent — a Plan+ReAct+Reflect agent with Memory support.
//
// Supports web search, file operations, shell commands, code search,
// and cross-session memory for personalized, context-aware responses.

import type { IAgent, TaskContext, AgentResult, ILLMProvider, LLMMessage } from '@z-assistant/contracts';
import { ok as okResult, fail as failResult } from '@z-assistant/contracts';
import { computeCost } from '@z-assistant/infra-cost';
import {
  MemoryManager,
  JsonlMemoryProvider,
  ShortTermMemory,
  LongTermMemory,
  EpisodicMemory,
  PreferencesMemory,
  recall,
  type JsonlMemoryProviderOptions,
} from '@z-assistant/runtime';
import { CHAT_TOOLS as WEB_TOOLS, webSearch, webFetch } from './web-tools';
import { TASK_TOOLS, readFile, writeFile, replaceText, appendText, insertText, runTerminal, searchCode, listDirectory, getProjectContext } from './task-tools';

export interface ChatAgentOptions {
  llmProvider: ILLMProvider;
  systemPrompt?: string;
  /** Maximum tool-calling iterations (default: 8) */
  maxToolIterations?: number;
  /** Project working directory for file/shell operations (default: process.cwd()) */
  projectDir?: string;
  /** Style profile description for mimicking the user's chat tone (optional). */
  profileDescription?: string;
  /** Storage directory for Memory persistence (optional). If not set, memory is disabled. */
  storageDir?: string;
  /** Progress callback for streaming execution status to the UI. */
  onProgress?: (phase: string, detail: string) => void;
  /** Span factory for detailed execution tracing. */
  startSpan?: (name: string, type: string, input?: unknown) => { end: (output?: unknown) => void; fail: (err: unknown) => void; addEvent: (name: string) => void; };
}

/** Key used in SharedState to persist conversation history. */
export const CHAT_HISTORY_KEY = 'chat.history';

const DEFAULT_SYSTEM_PROMPT = `You are a friendly AI assistant having a conversation with the user.

## Capabilities
- **web_search(query, maxResults?)** — Search the web for real-time information (news, weather, current events)
- **web_fetch(url, maxLength?)** — Fetch and read the full content of a web page
- **read_file(filePath, startLine?, lineCount?)** — Read file content with line numbers
- **write_file(filePath, content)** — Write full content to a file (creates new files or overwrites)
- **replace_text(filePath, oldText, newText)** — Replace text in an existing file (surgical edits)
- **append_text(filePath, content)** — Append text to the end of a file
- **insert_text(filePath, anchorText, newText, mode)** — Insert text before/after an anchor
- **run_terminal(command, cwd?, timeoutMs?)** — Execute shell commands
- **search_code(pattern, filePattern?, maxResults?)** — Search for patterns across files
- **list_directory(dirPath?, depth?)** — List directory contents
- **get_project_context(detail?)** — Get project overview

## Guidelines
- Be conversational, natural, and concise
- When asked about current events, weather, or real-time info → use web_search
- Always cite your sources for web results
- Respond in the same language the user used
- You can use web_search multiple times to find the best answer
- When the user asks you to create or modify files, use the file tools above
- Always read a file before editing it to understand its current content`;

export function createChatAgent(opts: ChatAgentOptions): IAgent {
  let systemPrompt = opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  // Append style profile if available
  if (opts.profileDescription) {
    systemPrompt += `\n\n## Your Chat Style\n${opts.profileDescription}\nWhen replying to chat messages (especially via QQ/WeChat auto-reply), imitate the above style. Keep your responses natural and consistent with this tone.`;
  }
  const maxIterations = opts.maxToolIterations ?? 8;
  const allTools = [...WEB_TOOLS, ...TASK_TOOLS];
  const allToolNames = new Set(allTools.map((t) => t.name));

  // Create MemoryManager if storageDir is provided
  let memoryManager: MemoryManager | undefined;
  let shortTermMem: ShortTermMemory | undefined;
  let longTermMem: LongTermMemory | undefined;
  let episodicMem: EpisodicMemory | undefined;
  let preferencesMem: PreferencesMemory | undefined;

  if (opts.storageDir) {
    const provider = new JsonlMemoryProvider({
      rootDir: opts.storageDir,
    } as JsonlMemoryProviderOptions);
    memoryManager = new MemoryManager({ provider, userId: 'desktop-user', agentName: 'chat' });
    shortTermMem = new ShortTermMemory(memoryManager);
    longTermMem = new LongTermMemory(memoryManager);
    episodicMem = new EpisodicMemory(memoryManager);
    preferencesMem = new PreferencesMemory(memoryManager);
  }

  return {
    name: 'chat',
    role: 'Chat',
    capabilities: [
      'chat', 'general',
      'web_search', 'web_fetch',
      'read_file', 'write_file', 'replace_text', 'append_text', 'insert_text',
      'run_terminal', 'search_code', 'list_directory', 'get_project_context',
    ],
    dependencies: [],

    canHandle(): number {
      return 1.0;
    },

    async execute(ctx: TaskContext): Promise<AgentResult> {
      const t0 = Date.now();
      let totalTokensIn = 0;
      let totalTokensOut = 0;
      let llmCalls = 0;
      let toolCalls = 0;
      const progress = opts.onProgress ?? (() => {});
      const startSpan = opts.startSpan;

      try {
        // ── Phase 1: Memory Recall (fast, no LLM call) ──────────────
        const memorySpan = startSpan?.('memory-recall', 'memory', { task: ctx.task.slice(0, 200) });
        progress('memory', 'Recalling relevant context from memory...');
        let memoryContext = '';
        if (memoryManager && longTermMem && episodicMem && preferencesMem) {
          const [longTermHits, episodicHits, prefHits] = await Promise.all([
            recall(memoryManager, ctx.task, { scope: 'user', kind: 'long-term', limit: 3 }),
            recall(memoryManager, ctx.task, { scope: 'user', kind: 'episodic', limit: 2 }),
            memoryManager.list({ userId: 'desktop-user', kind: 'preference', limit: 5 }),
          ]);

          const parts: string[] = [];
          if (longTermHits.length > 0) {
            parts.push('## Relevant Facts\n' + longTermHits.map(h => `- ${h.memory.content}`).join('\n'));
          }
          if (episodicHits.length > 0) {
            parts.push('## Past Similar Tasks\n' + episodicHits.map(h => `- ${h.memory.content.slice(0, 200)}`).join('\n'));
          }
          if (prefHits.length > 0) {
            parts.push('## User Preferences\n' + prefHits.map(r => `- ${r.content}`).join('\n'));
          }
          if (parts.length > 0) {
            memoryContext = '\n\n' + parts.join('\n\n');
          }
        }
        memorySpan?.end({ hits: memoryContext ? 'found' : 'none' });

        // Load conversation history from shared state
        const history = ctx.sharedState.get<LLMMessage[]>(CHAT_HISTORY_KEY) ?? [];

        // ── Phase 2: Planning (1 LLM call) ──────────────────────────
        const planSpan = startSpan?.('planning', 'planner', { task: ctx.task.slice(0, 200) });
        progress('plan', 'Analyzing request and creating execution plan...');
        const planMessages: LLMMessage[] = [
          {
            role: 'system',
            content: `You are a task planner. Analyze the user's request and create a brief plan (2-4 steps).
Output ONLY a JSON object with a "plan" array of step descriptions.
Do NOT call any tools.`,
          },
          { role: 'user', content: ctx.task },
        ];

        const planResponse = await opts.llmProvider.generate({
          model: ctx.model,
          messages: planMessages,
          temperature: 0.3,
          maxTokens: 1024,
          signal: ctx.signal,
        });
        llmCalls++;
        totalTokensIn += planResponse.usage.tokensIn;
        totalTokensOut += planResponse.usage.tokensOut;

        // Extract plan text from response (best-effort, non-blocking if parse fails)
        let planText = '';
        try {
          const planJson = JSON.parse(planResponse.message.content ?? '{}');
          if (Array.isArray(planJson.plan)) {
            planText = '\n\n## Plan\n' + planJson.plan.map((s: string, i: number) => `${i + 1}. ${s}`).join('\n');
          }
        } catch {
          planText = '';
        }
        planSpan?.end({ plan: planText ? 'created' : 'skipped' });

        // ── Phase 3: ReAct loop ─────────────────────────────────────
        const messages: LLMMessage[] = [
          { role: 'system', content: systemPrompt + memoryContext + planText },
          ...history,
          { role: 'user', content: ctx.task },
        ];

        for (let i = 0; i < maxIterations; i++) {
          progress('think', `Step ${i + 1}: Thinking...`);
          const response = await opts.llmProvider.generate({
            model: ctx.model,
            messages,
            tools: allTools,
            temperature: 0.7,
            maxTokens: 4096,
            signal: ctx.signal,
          });

          llmCalls++;
          totalTokensIn += response.usage.tokensIn;
          totalTokensOut += response.usage.tokensOut;

          // No tool calls → final answer
          if (!response.message.toolCalls || response.message.toolCalls.length === 0) {
            progress('answer', 'Generating final answer...');
            const reply = response.message.content ?? '';
            const durationMs = Date.now() - t0;
            const costUsd = computeCost(ctx.model, totalTokensIn, totalTokensOut);

            // Append to conversation history
            const updatedHistory: LLMMessage[] = [
              ...history,
              { role: 'user', content: ctx.task },
              { role: 'assistant', content: reply },
            ];
            ctx.sharedState.set(CHAT_HISTORY_KEY, updatedHistory, 'chat');

            // ── Phase 4: Memory Save (async, non-blocking) ──────────
            if (shortTermMem && episodicMem && longTermMem && preferencesMem) {
              // Save as episode (fire-and-forget)
              episodicMem.record({
                task: ctx.task.slice(0, 200),
                story: reply.slice(0, 500),
                outcome: 'success',
                tags: ['chat'],
              }).catch(() => {});

              // Detect and save user preferences (simple heuristics)
              const prefKeywords = ['我喜欢', 'I like', 'I prefer', 'I use', 'I want', 'I need', 'I am'];
              for (const kw of prefKeywords) {
                const idx = ctx.task.indexOf(kw);
                if (idx !== -1) {
                  const statement = ctx.task.slice(idx, idx + 100).split(/[.。!！?？\n]/)[0];
                  if (statement) {
                    preferencesMem.learn({
                      key: 'inferred',
                      value: statement,
                      statement,
                      confidence: 0.5,
                    }).catch(() => {});
                  }
                }
              }
            }

            return okResult(reply, {
              artifacts: { reply, history: updatedHistory },
              metrics: {
                tokensIn: totalTokensIn,
                tokensOut: totalTokensOut,
                costUsd,
                durationMs,
                llmCalls,
                toolCalls,
              },
            });
          }

          // ── Execute tool calls ──────────────────────────────────
          messages.push({
            role: 'assistant',
            content: response.message.content,
            toolCalls: response.message.toolCalls,
          });

          for (const tc of response.message.toolCalls) {
            // Validate tool name
            if (!allToolNames.has(tc.name)) {
              messages.push({
                role: 'tool',
                content: `Unknown tool: ${tc.name}. Available tools: ${[...allToolNames].join(', ')}`,
                toolCallId: tc.id,
              });
              continue;
            }

            toolCalls++;
            const toolSpan = startSpan?.('tool:' + tc.name, 'tool', { name: tc.name, args: tc.arguments });
            progress('tool', `Executing ${tc.name}...`);
            const result = await executeTool(tc.name, tc.arguments);
            toolSpan?.end({ result: result.slice(0, 200) });
            messages.push({
              role: 'tool',
              content: result,
              toolCallId: tc.id,
            });
          }
        }

        // Max iterations reached — ask LLM for final answer
        progress('think', 'Generating final summary...');
        messages.push({
          role: 'user',
          content: 'Please provide your final answer based on all the tool results above. Do not call any more tools.',
        });

        const finalResponse = await opts.llmProvider.generate({
          model: ctx.model,
          messages,
          temperature: 0.7,
          maxTokens: 4096,
          signal: ctx.signal,
        });

        llmCalls++;
        totalTokensIn += finalResponse.usage.tokensIn;
        totalTokensOut += finalResponse.usage.tokensOut;

        const reply = finalResponse.message.content ?? '';
        const durationMs = Date.now() - t0;
        const costUsd = computeCost(ctx.model, totalTokensIn, totalTokensOut);

        const updatedHistory: LLMMessage[] = [
          ...history,
          { role: 'user', content: ctx.task },
          { role: 'assistant', content: reply },
        ];
        ctx.sharedState.set(CHAT_HISTORY_KEY, updatedHistory, 'chat');

        // ── Phase 4: Memory Save (async, non-blocking) ──────────
        if (shortTermMem && episodicMem) {
          episodicMem.record({
            task: ctx.task.slice(0, 200),
            story: reply.slice(0, 500),
            outcome: 'partial',
            tags: ['chat', 'max-iterations'],
          }).catch(() => {});
        }

        return okResult(reply, {
          artifacts: { reply, history: updatedHistory },
          metrics: {
            tokensIn: totalTokensIn,
            tokensOut: totalTokensOut,
            costUsd,
            durationMs,
            llmCalls,
            toolCalls,
          },
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return failResult('LLM_ERROR', msg);
      }
    },
  };
}

// ── Tool executor ─────────────────────────────────────────────────────

async function executeTool(name: string, args: Record<string, unknown>): Promise<string> {
  switch (name) {
    // Web tools
    case 'web_search':
      return webSearch(
        String(args.query ?? ''),
        typeof args.maxResults === 'number' ? args.maxResults : 5
      );
    case 'web_fetch':
      return webFetch(
        String(args.url ?? ''),
        typeof args.maxLength === 'number' ? args.maxLength : 5000
      );
    // File & task tools
    case 'read_file':
      return readFile(
        String(args.filePath ?? args.path ?? ''),
        typeof args.startLine === 'number' ? args.startLine : undefined,
        typeof args.lineCount === 'number' ? args.lineCount : undefined
      );
    case 'write_file':
      return writeFile(
        String(args.filePath ?? args.path ?? ''),
        String(args.content ?? '')
      );
    case 'replace_text':
      return replaceText(
        String(args.filePath ?? args.path ?? ''),
        String(args.oldText ?? ''),
        String(args.newText ?? '')
      );
    case 'append_text':
      return appendText(
        String(args.filePath ?? args.path ?? ''),
        String(args.content ?? '')
      );
    case 'insert_text':
      return insertText(
        String(args.filePath ?? args.path ?? ''),
        String(args.anchorText ?? ''),
        String(args.newText ?? ''),
        (args.mode as 'before' | 'after') ?? 'after'
      );
    case 'run_terminal':
      return runTerminal(
        String(args.command ?? args.cmd ?? ''),
        typeof args.cwd === 'string' ? args.cwd : undefined,
        typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined
      );
    case 'search_code':
      return searchCode(
        String(args.pattern ?? args.query ?? ''),
        typeof args.filePattern === 'string' ? args.filePattern : undefined,
        typeof args.maxResults === 'number' ? args.maxResults : 20
      );
    case 'list_directory':
      return listDirectory(
        typeof args.dirPath === 'string' ? args.dirPath : undefined,
        typeof args.depth === 'number' ? args.depth : 1
      );
    case 'get_project_context':
      return getProjectContext(
        (args.detail as 'summary' | 'full') ?? 'summary'
      );
    default:
      return `Unknown tool: ${name}`;
  }
}

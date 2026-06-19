// Chat Agent — a ReAct agent that calls an LLM with tool support.
//
// Supports web search, file operations, shell commands, and code
// search tools for full task execution capability.

import type { IAgent, TaskContext, AgentResult, ILLMProvider, LLMMessage } from '@z-assistant/contracts';
import { ok as okResult, fail as failResult } from '@z-assistant/contracts';
import { computeCost } from '@z-assistant/infra-cost';
import { CHAT_TOOLS as WEB_TOOLS, webSearch, webFetch } from './web-tools';

export interface ChatAgentOptions {
  llmProvider: ILLMProvider;
  systemPrompt?: string;
  /** Maximum tool-calling iterations (default: 8) */
  maxToolIterations?: number;
  /** Project working directory for file/shell operations (default: process.cwd()) */
  projectDir?: string;
  /** Style profile description for mimicking the user's chat tone (optional). */
  profileDescription?: string;
}

/** Key used in SharedState to persist conversation history. */
export const CHAT_HISTORY_KEY = 'chat.history';

const DEFAULT_SYSTEM_PROMPT = `You are a friendly AI assistant having a conversation with the user.

## Capabilities
- **web_search(query, maxResults?)** — Search the web for real-time information (news, weather, current events)
- **web_fetch(url, maxLength?)** — Fetch and read the full content of a web page

## Guidelines
- Be conversational, natural, and concise
- When asked about current events, weather, or real-time info → use web_search
- Always cite your sources for web results
- Respond in the same language the user used
- You can use web_search multiple times to find the best answer`;

export function createChatAgent(opts: ChatAgentOptions): IAgent {
  let systemPrompt = opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  // Append style profile if available
  if (opts.profileDescription) {
    systemPrompt += `\n\n## Your Chat Style\n${opts.profileDescription}\nWhen replying to chat messages (especially via QQ/WeChat auto-reply), imitate the above style. Keep your responses natural and consistent with this tone.`;
  }
  const maxIterations = opts.maxToolIterations ?? 8;
  const allTools = [...WEB_TOOLS];
  const allToolNames = new Set(allTools.map((t) => t.name));

  // Set project directory if provided
  if (opts.projectDir) {
    // no-op: project tools removed
  }

  return {
    name: 'chat',
    role: 'Chat',
    capabilities: [
      'chat', 'general',
      'web_search', 'web_fetch',
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

      try {
        // Load conversation history from shared state
        const history = ctx.sharedState.get<LLMMessage[]>(CHAT_HISTORY_KEY) ?? [];

        // Build initial messages
        const messages: LLMMessage[] = [
          { role: 'system', content: systemPrompt },
          ...history,
          { role: 'user', content: ctx.task },
        ];

        // ── ReAct loop ─────────────────────────────────────────────
        for (let i = 0; i < maxIterations; i++) {
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
            const result = await executeTool(tc.name, tc.arguments);
            messages.push({
              role: 'tool',
              content: result,
              toolCallId: tc.id,
            });
          }
        }

        // Max iterations reached — ask LLM for final answer
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
    // Web tools only
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
    default:
      return `Unknown tool: ${name}`;
  }
}

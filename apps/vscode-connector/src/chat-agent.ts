// Chat Agent — a Plan+ReAct+Reflect agent with Memory support.
//
// Supports web search, file operations, shell commands, code search,
// and cross-session memory for personalized, context-aware responses.

import type { IAgent, TaskContext, AgentResult, ILLMProvider, LLMMessage, IConfirmationGate, ToolInvocation } from '@z-assistant/contracts';
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
  DryRunExecutor,
  ToolInvocationPipeline,
  extractFacts,
  buildHierarchicalPlan,
  renderPlan,
  selectPlanningMode,
  type JsonlMemoryProviderOptions,
  type PlanningMode,
} from '@z-assistant/runtime';
import { CHAT_TOOLS as WEB_TOOLS, webSearch, webFetch } from './web-tools';
import { TASK_TOOLS, readFile, writeFile, replaceText, appendText, insertText, runTerminal, searchCode, listDirectory, getProjectContext } from './task-tools';
import { BROWSER_TOOLS, browserNavigate, browserClick, browserScroll, browserScreenshot, browserGoBack, browserGoForward, browserClose } from './browser-tools';
import { PERCEPTION_TOOLS, ocrImage, describeImage, transcribeAudio, parseDocument } from './perception-tools';

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
  /**
   * Optional shared MemoryManager (from AssistantRuntime.memory). When
   * provided, the chat agent uses this instance instead of creating its
   * own, so all memory access paths share the same provider + userId.
   */
  memoryManager?: MemoryManager;
  /**
   * Optional confirmation gate (P1-2 HITL). When provided, every tool
   * call passes through `gate.confirm()` before execution. Denied calls
   * are skipped and a "Blocked by user" tool message is pushed back to
   * the LLM. When not provided, all tools execute without confirmation
   * (backward-compatible behavior for tests / headless mode).
   */
  confirmationGate?: IConfirmationGate;
  /**
   * Optional: when true, tool calls are simulated instead of executed.
   * The DryRunExecutor returns a description of what each tool *would*
   * have done, so the user can preview the agent's full plan before
   * committing to real execution. Default: false.
   */
  dryRun?: boolean;
  /** Progress callback for streaming execution status to the UI. */
  onProgress?: (phase: string, detail: string) => void;
  /** Span factory for detailed execution tracing. */
  startSpan?: (name: string, type: string, input?: unknown) => { end: (output?: unknown) => void; fail: (err: unknown) => void; addEvent: (name: string) => void; };
  /**
   * Planning mode:
   *   - simple: native ReAct loop (default)
   *   - hierarchical: LLM generates milestones+steps before acting
   *   - auto: pick based on task complexity
   */
  planningMode?: PlanningMode;
  /**
   * Optional file attachments (images, audio, documents). Non-text media is
   * pre-processed by the perception layer (OCR/caption/transcribe/parse) into
   * text before being sent to the LLM. This allows text-only models like
   * DeepSeek to consume multimodal input.
   */
  attachments?: ChatAttachment[];
}

export type ChatAttachment =
  | { type: 'image'; path: string }
  | { type: 'audio'; path: string }
  | { type: 'document'; path: string };

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
- **browser_navigate(url)** — Open a URL in the browser
- **browser_click(x, y)** — Click at coordinates on the current page
- **browser_scroll(direction, amount?)** — Scroll the page up or down
- **browser_screenshot()** — Take a screenshot of the current page
- **browser_go_back()** — Go back in browser history
- **browser_go_forward()** — Go forward in browser history
- **browser_close()** — Close the browser
- **ocr_image(filePath)** — Extract text from an image
- **describe_image(filePath)** — Generate a description of an image
- **transcribe_audio(filePath)** — Transcribe audio to text
- **parse_document(filePath)** — Extract text from PDF/DOCX/PPTX/TXT

## Guidelines
- Be conversational, natural, and concise
- When asked about current events, weather, or real-time info → use web_search
- Always cite your sources for web results
- Respond in the same language the user used
- You can use web_search multiple times to find the best answer
- When the user asks you to create or modify files, use the file tools above
- Always read a file before editing it to understand its current content
- **IMPORTANT: You CAN write files to the user's computer.** When the user asks you to save a file to the desktop, use write_file with the full path. The desktop path is typically: C:\\Users\\[username]\\Desktop\\filename.md
- When the user asks you to open a website, use browser_navigate. The browser will be started automatically.`;

export function createChatAgent(opts: ChatAgentOptions): IAgent {
  // Inject actual desktop path into system prompt
  const homeDir = process.env.USERPROFILE || process.env.HOME || '';
  const desktopPath = homeDir ? `${homeDir}\\Desktop` : 'C:\\Users\\[username]\\Desktop';
  let systemPrompt = (opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT)
    .replace('[username]', homeDir ? homeDir.split('\\').pop()! : 'username')
    .replace('C:\\\\Users\\\\[username]\\\\Desktop', desktopPath.replace(/\\/g, '\\\\'));
  // Append style profile if available
  if (opts.profileDescription) {
    systemPrompt += `\n\n## Your Chat Style\n${opts.profileDescription}\nWhen replying to chat messages (especially via QQ/WeChat auto-reply), imitate the above style. Keep your responses natural and consistent with this tone.`;
  }
  const maxIterations = opts.maxToolIterations ?? 8;
  const allTools = [...WEB_TOOLS, ...TASK_TOOLS, ...BROWSER_TOOLS, ...PERCEPTION_TOOLS];
  const allToolNames = new Set(allTools.map((t) => t.name));

  // Create MemoryManager if storageDir is provided OR an external
  // memoryManager is supplied (from AssistantRuntime.memory). Preferring
  // the external instance keeps a single provider + userId across the
  // runtime, chat agent, and desktop memory panel.
  let memoryManager: MemoryManager | undefined;
  let shortTermMem: ShortTermMemory | undefined;
  let longTermMem: LongTermMemory | undefined;
  let episodicMem: EpisodicMemory | undefined;
  let preferencesMem: PreferencesMemory | undefined;

  if (opts.memoryManager) {
    memoryManager = opts.memoryManager;
    shortTermMem = new ShortTermMemory(memoryManager);
    longTermMem = new LongTermMemory(memoryManager);
    episodicMem = new EpisodicMemory(memoryManager);
    preferencesMem = new PreferencesMemory(memoryManager);
  } else if (opts.storageDir) {
    const provider = new JsonlMemoryProvider({
      rootDir: opts.storageDir,
    } as JsonlMemoryProviderOptions);
    memoryManager = new MemoryManager({ provider, userId: 'desktop-user', agentName: 'chat' });
    shortTermMem = new ShortTermMemory(memoryManager);
    longTermMem = new LongTermMemory(memoryManager);
    episodicMem = new EpisodicMemory(memoryManager);
    preferencesMem = new PreferencesMemory(memoryManager);
  }

  // Unified tool invocation pipeline (P1-2 HITL + sandbox): risk → injection
  // scan → path guard → confirmation gate → dry-run/execute → audit.
  const dryRunExecutor = opts.dryRun ? new DryRunExecutor() : undefined;
  const allowedRoots = [opts.projectDir ?? process.cwd(), opts.storageDir].filter(Boolean) as string[];
  const toolPipeline = new ToolInvocationPipeline({
    confirmationGate: opts.confirmationGate,
    dryRunExecutor,
    pathGuard: allowedRoots.length > 0 ? { allowedRoots } : undefined,
    runId: '',
    userId: 'desktop-user',
  });

  return {
    name: 'chat',
    role: 'Chat',
    capabilities: [
      'chat', 'general',
      'web_search', 'web_fetch',
      'read_file', 'write_file', 'replace_text', 'append_text', 'insert_text',
      'run_terminal', 'search_code', 'list_directory', 'get_project_context',
      'browser_navigate', 'browser_click', 'browser_scroll', 'browser_screenshot',
      'browser_go_back', 'browser_go_forward', 'browser_close',
      'ocr_image', 'describe_image', 'transcribe_audio', 'parse_document',
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

        // ── Phase 1.5: Multimodal attachment preprocessing ──────────
        // Convert images/audio/documents into text so text-only LLMs (e.g.
        // DeepSeek) can reason about them.
        let attachmentContext = '';
        if (opts.attachments && opts.attachments.length > 0) {
          const parts: string[] = [];
          for (const att of opts.attachments) {
            progress('perception', `Processing ${att.type} attachment: ${att.path}`);
            try {
              if (att.type === 'image') {
                const [ocr, caption] = await Promise.all([
                  ocrImage(att.path),
                  describeImage(att.path),
                ]);
                const imageParts = [`[Image: ${att.path}]`, caption];
                if (ocr && !ocr.startsWith('(no text') && !ocr.startsWith('OCR failed')) {
                  imageParts.push(`OCR text: ${ocr}`);
                }
                parts.push(imageParts.join('\n'));
              } else if (att.type === 'audio') {
                const text = await transcribeAudio(att.path);
                parts.push(`[Audio: ${att.path}]\nTranscription: ${text}`);
              } else if (att.type === 'document') {
                const text = await parseDocument(att.path);
                parts.push(`[Document: ${att.path}]\n${text}`);
              }
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : String(err);
              parts.push(`[Attachment ${att.path} failed: ${msg}]`);
            }
          }
          if (parts.length > 0) {
            attachmentContext = '\n\n## Attachments\n' + parts.join('\n\n---\n\n');
          }
        }

        // ── Phase 2: Planning ───────────────────────────────────────
        const planSpan = startSpan?.('planning', 'planner', { task: ctx.task.slice(0, 200) });
        progress('plan', 'Analyzing request and creating execution plan...');

        const mode = selectPlanningMode(ctx.task, opts.planningMode ?? 'simple');
        let planText = '';

        if (mode === 'hierarchical') {
          // Deep planning: milestones + steps, rendered into the system prompt.
          const hierarchicalPlan = await buildHierarchicalPlan(ctx.task, {
            llmProvider: opts.llmProvider,
            model: ctx.model,
          });
          planText = '\n\n' + renderPlan(hierarchicalPlan);
          llmCalls++;
          planSpan?.end({ plan: 'hierarchical', steps: hierarchicalPlan.steps.length });
        } else {
          // Simple planning: native ReAct with a brief 2-4 step plan.
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

          try {
            const planJson = JSON.parse(planResponse.message.content ?? '{}');
            if (Array.isArray(planJson.plan)) {
              planText = '\n\n## Plan\n' + planJson.plan.map((s: string, i: number) => `${i + 1}. ${s}`).join('\n');
            }
          } catch {
            planText = '';
          }
          planSpan?.end({ plan: planText ? 'simple' : 'skipped' });
        }

        // ── Phase 3: ReAct loop ─────────────────────────────────────
        const messages: LLMMessage[] = [
          { role: 'system', content: systemPrompt + memoryContext + attachmentContext + planText },
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

          // No tool calls → check for XML-style tool calls (fallback for models
          // that don't fully support native OpenAI function calling)
          if (!response.message.toolCalls || response.message.toolCalls.length === 0) {
            const reply = response.message.content ?? '';

            // Try to parse XML tool calls from the text response
            const xmlCalls = parseXmlToolCalls(reply);
            if (xmlCalls && xmlCalls.length > 0) {
              // Execute XML tool calls (same as native tool calls)
              // Strip the XML tags from the content for display
              const cleanReply = reply.replace(/<tool_calls>[\s\S]*?<\/tool_calls>/g, '').replace(/<invoke[\s\S]*?<\/invoke>/g, '').trim();

              // Only keep the clean text as the assistant message
              if (cleanReply) {
                messages.push({ role: 'assistant', content: cleanReply });
              } else {
                messages.push({ role: 'assistant', content: '(executing tools...)' });
              }

              for (const tc of xmlCalls) {
                if (!allToolNames.has(tc.name)) {
                  messages.push({
                    role: 'tool',
                    content: `Unknown tool: ${tc.name}. Available tools: ${[...allToolNames].join(', ')}`,
                    toolCallId: `xml_${tc.name}_${i}`,
                  });
                  continue;
                }

                // P1-2: Confirmation gate — check before executing.
                if (opts.confirmationGate) {
                  const inv: ToolInvocation = { id: `xml_${tc.name}_${i}`, toolName: tc.name, args: tc.arguments };
                  const decision = await opts.confirmationGate.confirm(inv);
                  if (decision === 'deny') {
                    messages.push({
                      role: 'tool',
                      content: `Blocked by user (tool: ${tc.name}).`,
                      toolCallId: `xml_${tc.name}_${i}`,
                    });
                    continue;
                  }
                }

                toolCalls++;
                const toolSpan = startSpan?.('tool:' + tc.name, 'tool', { name: tc.name, args: tc.arguments });
                const inv = { id: `xml_${tc.name}_${i}`, toolName: tc.name, args: tc.arguments };
                progress('tool', opts.dryRun ? `Simulating ${tc.name}...` : `Executing ${tc.name}...`);
                const pipelineResult = await toolPipeline.invoke(inv, async () => executeTool(tc.name, tc.arguments));
                const result = pipelineResult.ok
                  ? String(pipelineResult.output ?? '')
                  : `Error: ${pipelineResult.error?.message ?? 'unknown'}`;
                toolSpan?.end({ result: result.slice(0, 200) });
                messages.push({
                  role: 'tool',
                  content: result,
                  toolCallId: `xml_${tc.name}_${i}`,
                });
              }
              continue; // Go to next iteration
            }

            progress('answer', 'Generating final answer...');
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

            // Extract durable facts about the user using rules + optional LLM.
            // Heuristics catch "我在上海", "I prefer dark mode", etc.
            // LLM fallback handles implicit or complex statements.
            extractFacts(ctx.task, { minConfidence: 0.7 }).then(async (facts) => {
              for (const f of facts) {
                await longTermMem!.remember(
                  {
                    content: `${f.entity ?? 'user'} ${f.factType}: ${f.value}`,
                    payload: {
                      factType: f.factType,
                      entity: f.entity ?? 'user',
                      value: f.value,
                      statement: f.statement,
                      confidence: f.confidence,
                      source: f.source,
                    },
                    importance: f.confidence,
                  },
                  'user',
                ).catch(() => {});

                // Also keep explicit preferences in the preference subsystem
                // for backwards-compatible recall paths.
                if (f.factType === 'preference') {
                  await preferencesMem!.learn({
                    key: `inferred-${f.factType}`,
                    value: f.value,
                    statement: f.statement,
                    confidence: f.confidence,
                  }).catch(() => {});
                }
              }
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
            const inv: ToolInvocation = { id: tc.id ?? `native_${tc.name}_${i}`, toolName: tc.name, args: tc.arguments };
            progress('tool', opts.dryRun ? `Simulating ${tc.name}...` : `Executing ${tc.name}...`);
            const pipelineResult = await toolPipeline.invoke(inv, async () => executeTool(tc.name, tc.arguments));
            const result = pipelineResult.ok
              ? String(pipelineResult.output ?? '')
              : `Error: ${pipelineResult.error?.message ?? 'unknown'}`;
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

/**
 * Parse XML-style tool calls from LLM text output.
 * Some models (e.g. DeepSeek) may fall back to XML format when they
 * don't fully support native OpenAI function calling.
 *
 * Supported formats:
 *   <invoke name="tool_name"><parameter name="arg">value</parameter></invoke>
 *   <tool_calls><invoke name="tool_name"><parameter name="arg">value</parameter></invoke></tool_calls>
 */
function parseXmlToolCalls(text: string): Array<{ name: string; arguments: Record<string, unknown> }> | null {
  // Try to find <tool_calls> wrapper first, then individual <invoke> tags
  const wrapperMatch = text.match(/<tool_calls>([\s\S]*?)<\/tool_calls>/);
  const invokeContent = wrapperMatch ? wrapperMatch[1] : text;

  // Find all <invoke name="..."> blocks
  const invokeRegex = /<invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/invoke>/g;
  const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  let match: RegExpExecArray | null;

  while ((match = invokeRegex.exec(invokeContent)) !== null) {
    const name = match[1];
    const paramsText = match[2];

    // Parse <parameter name="...">value</parameter>
    const args: Record<string, unknown> = {};
    const paramRegex = /<parameter\s+name="([^"]+)"\s*>([\s\S]*?)<\/parameter>/g;
    let pm: RegExpExecArray | null;
    while ((pm = paramRegex.exec(paramsText)) !== null) {
      let value: string | number = pm[2].trim();
      // Try to parse as number
      const num = Number(value);
      if (!isNaN(num) && value !== '') value = num;
      args[pm[1]] = value;
    }
    calls.push({ name, arguments: args });
  }

  return calls.length > 0 ? calls : null;
}

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
    // Browser tools
    case 'browser_navigate':
      return browserNavigate(String(args.url ?? ''));
    case 'browser_click':
      return browserClick(
        typeof args.x === 'number' ? args.x : 0,
        typeof args.y === 'number' ? args.y : 0
      );
    case 'browser_scroll':
      return browserScroll(
        String(args.direction ?? 'down'),
        typeof args.amount === 'number' ? args.amount : 500
      );
    case 'browser_screenshot':
      return browserScreenshot();
    case 'browser_go_back':
      return browserGoBack();
    case 'browser_go_forward':
      return browserGoForward();
    case 'browser_close':
      return browserClose();
    // Perception tools
    case 'ocr_image':
      return ocrImage(String(args.filePath ?? ''));
    case 'describe_image':
      return describeImage(String(args.filePath ?? ''));
    case 'transcribe_audio':
      return transcribeAudio(String(args.filePath ?? ''));
    case 'parse_document':
      return parseDocument(String(args.filePath ?? ''));
    default:
      return `Unknown tool: ${name}`;
  }
}

// Exported for V2 adapter wiring (see coding-agent-factory.ts).
// `executeToolByName` is the same dispatcher used inside the chat-agent's
// ReAct loop, exposed so the V2 CodingToolRegistry can invoke chat tools
// by name without re-implementing the dispatch table.
export const executeToolByName = executeTool;

// Aggregate of all tool definitions exported for V2 adapter wiring.
// Each entry is in OpenAI function-calling format; the V2 factory wraps
// them into ITool instances.
export const ALL_CHAT_TOOLS = [
  ...WEB_TOOLS,
  ...TASK_TOOLS,
  ...BROWSER_TOOLS,
  ...PERCEPTION_TOOLS,
];

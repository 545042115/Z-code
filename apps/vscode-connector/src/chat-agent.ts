// Chat Agent — a Plan+ReAct+Reflect agent with Memory support.
//
// Supports web search, file operations, shell commands, code search,
// and cross-session memory for personalized, context-aware responses.

import type { IAgent, TaskContext, AgentResult, ILLMProvider, LLMMessage, LLMRequest, LLMResponse, IConfirmationGate, ToolInvocation, ToolPolicy } from '@ziner/contracts';
import { ok as okResult, fail as failResult, isToolAllowed } from '@ziner/contracts';
import { computeCost } from '@ziner/infra-cost';
import { compressToolResult, parseXmlToolCalls } from '@ziner/runtime-core';
import {
  MemoryManager,
  JsonlMemoryProvider,
  ShortTermMemory,
  LongTermMemory,
  EpisodicMemory,
  PreferencesMemory,
  SemanticMemory,
  recall,
  DryRunExecutor,
  ToolInvocationPipeline,
  extractFacts,
  buildHierarchicalPlan,
  renderPlan,
  selectPlanningMode,
  type JsonlMemoryProviderOptions,
  type PlanningMode,
} from '@ziner/runtime';
import {
  selectSkills,
  type SkillIndex,
  type SelectedSkill,
} from '@ziner/runtime/skills';
import { CHAT_TOOLS as WEB_TOOLS, webSearch, webFetch, getLocation } from './web-tools';
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
  /**
   * Optional extra tools (e.g. from MCP servers) injected into the ReAct loop.
   * Each entry provides the tool definition sent to the LLM and an invoke
   * handler that returns plain text for the chat history.
   */
  extraTools?: Array<{
    name: string;
    description: string;
    argsSchema?: Record<string, unknown>;
    invoke: (args: Record<string, unknown>) => Promise<string>;
  }>;
  /**
   * Optional skill index. When provided, the agent selects relevant skills
   * based on the user's request and injects their content into the system
   * prompt. Skills are OpenClaw / Claude Code compatible SKILL.md files.
   */
  skillIndex?: SkillIndex;
  /**
   * Optional tool allow/deny policy (P1-2). When set, the ReAct loop will
   * refuse to invoke any tool that is not allowed by the policy.
   */
  toolPolicy?: ToolPolicy;
  /**
   * Optional streaming callback. When provided AND the underlying
   * `llmProvider` implements `stream()`, every LLM call in the ReAct
   * loop streams its text deltas to this callback as they arrive.
   * The final assembled `LLMResponse` (content + tool calls + usage)
   * is returned by the provider as usual; tool calls are processed
   * normally after the stream completes.
   */
  onStreamChunk?: (chunk: string) => void;
}

export type ChatAttachment =
  | { type: 'image'; path: string }
  | { type: 'audio'; path: string }
  | { type: 'document'; path: string };

/** Key used in SharedState to persist conversation history. */
export const CHAT_HISTORY_KEY = 'chat.history';

const MAX_HISTORY_MESSAGES = 24;

const DEFAULT_SYSTEM_PROMPT = `You are a friendly AI assistant having a conversation with the user.

## Capabilities
- **web_search(query, maxResults?)** — Search the web for real-time information (news, weather, current events, live prices for hotels/flights/trains)
- **web_fetch(url, maxLength?)** — Fetch and read the full content of a web page
- **get_location()** — Get the approximate geographic location of the current machine (city, region, country, coordinates) based on public IP. Use when the user asks for local services, navigation, weather, delivery, or payment options that depend on location.
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
- **MCP external tools**: when MCP servers are configured, additional tools with names like 'mcp_<serverName>_<toolName>' are available. After thinking about the user's request, prefer the corresponding 'mcp_<serverName>_' tools for tasks that match those external services (e.g. McDonald's ordering, food delivery, payment, maps/navigation) instead of using web_search, web_fetch, or the browser. Examples: "帮我点麦当劳" → prefer 'mcp_mcdonald_...' tools; "帮我叫外卖" → prefer the configured delivery MCP tools; "附近有什么餐厅" / "导航去天安门" / "查上海天气" → prefer 'mcp_amap_...' tools when AMap MCP is configured.
- **Avoid MCP tool-call loops**: MCP tools (menu queries, store lookups, route searches) often return *all available data* in a single call. If a tool result already contains the data you need (menu items, store list, route options), do NOT re-call the same tool with the same arguments hoping to "see more" — the result is final. If you genuinely need a different slice (e.g. menu filtered by category, stores near a different location), change the parameters; otherwise summarise and answer. Repeated identical calls are detected by the system and will be cut off with a forced final answer.
- **Multi-step transactional tasks** (ordering, booking, paying): if a required input is missing or ambiguous (store id, product id, delivery address, payment method), ask the user directly with a short follow-up question — do NOT retry the search tool. Once you have enough information, call the action tool (e.g. mcp_mcdonalds_create-order) exactly once and report the result.
- When asked about current events, weather, or real-time info → use web_search
- For live price queries (hotels, flights, high-speed trains), follow this workflow **unless a relevant MCP tool is configured**:
  1. Use **web_search** with a specific query including the platform, route/location, and date, e.g. "携程 上海外滩W酒店 2025-06-25 价格" or "北京到上海 高铁票 2025-06-25".
  2. Use **web_fetch** on a promising search result to extract price details quickly.
  3. If web_fetch returns a login wall, CAPTCHA, missing dynamic content, or stale data, switch to **browser_navigate** to open the page in a real browser, then use **browser_screenshot**, **browser_click**, and **browser_scroll** to interact with search forms and result lists until the price appears.
  4. Always tell the user the source, query time, and any limitations (e.g. "价格来自携程搜索结果，实际下单可能变动").
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

  // Select relevant skills for the user request and format them as
  // additional context for the system prompt.
  function buildSkillContext(task: string): string {
    if (!opts.skillIndex || opts.skillIndex.skills.length === 0) return '';
    const selected = selectSkills(opts.skillIndex, { userRequest: task, topK: 3 });
    if (selected.length === 0) return '';
    const parts = selected.map((s: SelectedSkill) => {
      const header = `## Skill: ${s.skill.name}`;
      const triggerInfo = s.reasons.map((r) => `${r.type}(${r.detail})`).join(', ');
      return `${header}  <!-- matched: ${triggerInfo}; score=${s.score} -->\n${s.skill.content}`;
    });
    return '\n\n# Selected Skills\n\n' + parts.join('\n\n---\n\n');
  }

  // Build a concise semantic summary from a user task + assistant reply.
  // Avoids an extra LLM call; uses simple heuristics.
  function buildChatSummary(task: string, reply: string): { concept: string; description: string } {
    const t = task.trim();
    const r = reply.trim();
    const concept = t.split(/[，。,!?！？;；]|\n/)[0].slice(0, 40) || 'Chat';
    const replyHead = r.split(/\n/)[0].slice(0, 120);
    const description = `User: ${t.slice(0, 160)} | Assistant: ${replyHead}${r.length > replyHead.length ? '…' : ''}`;
    return { concept, description };
  }

  // Unified memory save — called on both normal exit and max-iterations.
  // Fire-and-forget: never throws, never blocks the response.
  function saveRunMemory(task: string, reply: string, outcome: 'success' | 'partial' | 'failure', runId: string, extraTags: string[] = []): void {
    if (!shortTermMem || !episodicMem || !longTermMem || !preferencesMem || !semanticMem) return;

    episodicMem.record({
      task: task.slice(0, 200),
      story: reply.slice(0, 500),
      outcome,
      tags: ['chat', ...extraTags],
    }).catch(() => {});

    const summary = buildChatSummary(task, reply);
    semanticMem.learn(
      { concept: summary.concept, description: summary.description, runId },
      'user',
    ).catch(() => {});

    const combinedText = `${task}\n${reply}`;
    extractFacts(combinedText, { minConfidence: 0.7 }).then(async (facts) => {
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
  // Append style profile if available
  if (opts.profileDescription) {
    systemPrompt += `\n\n## Your Chat Style\n${opts.profileDescription}\nWhen replying to chat messages (especially via QQ/WeChat auto-reply), imitate the above style. Keep your responses natural and consistent with this tone.`;
  }
  const maxIterations = opts.maxToolIterations ?? 8;
  const extraTools = opts.extraTools ?? [];
  const allTools: Array<{ name: string; description: string; argsSchema: Record<string, unknown> }> = [
    ...WEB_TOOLS,
    ...TASK_TOOLS,
    ...BROWSER_TOOLS,
    ...PERCEPTION_TOOLS,
    ...extraTools.map((t) => ({
      name: t.name,
      description: t.description,
      argsSchema: (t.argsSchema ?? { type: 'object', properties: {} }) as Record<string, unknown>,
    })),
  ];
  const allToolNames = new Set(allTools.map((t) => t.name));
  const extraToolMap = new Map(extraTools.map((t) => [t.name, t.invoke]));

  // Create MemoryManager if storageDir is provided OR an external
  // memoryManager is supplied (from AssistantRuntime.memory). Preferring
  // the external instance keeps a single provider + userId across the
  // runtime, chat agent, and desktop memory panel.
  let memoryManager: MemoryManager | undefined;
  let shortTermMem: ShortTermMemory | undefined;
  let longTermMem: LongTermMemory | undefined;
  let episodicMem: EpisodicMemory | undefined;
  let preferencesMem: PreferencesMemory | undefined;
  let semanticMem: SemanticMemory | undefined;

  if (opts.memoryManager) {
    memoryManager = opts.memoryManager;
    shortTermMem = new ShortTermMemory(memoryManager);
    longTermMem = new LongTermMemory(memoryManager);
    episodicMem = new EpisodicMemory(memoryManager);
    preferencesMem = new PreferencesMemory(memoryManager);
    semanticMem = new SemanticMemory(memoryManager);
  } else if (opts.storageDir) {
    const provider = new JsonlMemoryProvider({
      rootDir: opts.storageDir,
    } as JsonlMemoryProviderOptions);
    memoryManager = new MemoryManager({ provider, userId: 'desktop-user', agentName: 'chat' });
    shortTermMem = new ShortTermMemory(memoryManager);
    longTermMem = new LongTermMemory(memoryManager);
    episodicMem = new EpisodicMemory(memoryManager);
    preferencesMem = new PreferencesMemory(memoryManager);
    semanticMem = new SemanticMemory(memoryManager);
  }

  // Unified tool invocation pipeline (P1-2 HITL + sandbox): risk → injection
  // scan → path guard → confirmation gate → dry-run/execute → audit.
  const dryRunExecutor = opts.dryRun ? new DryRunExecutor() : undefined;
  const userHome = process.env.USERPROFILE ?? process.env.HOME ?? '';
  const allowedRoots = [opts.projectDir ?? process.cwd(), opts.storageDir, userHome].filter(Boolean) as string[];
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
      'web_search', 'web_fetch', 'get_location',
      'read_file', 'write_file', 'replace_text', 'append_text', 'insert_text',
      'run_terminal', 'search_code', 'list_directory', 'get_project_context',
      'browser_navigate', 'browser_click', 'browser_scroll', 'browser_screenshot',
      'browser_go_back', 'browser_go_forward', 'browser_close',
      'ocr_image', 'describe_image', 'transcribe_audio', 'parse_document',
    ],
    dependencies: [],

    canHandle(ctx: TaskContext): number {
      // Chat is the default fallback. Return a moderate base so that
      // generic / conversational tasks (no strong coding, research or
      // browser signal) route to chat — which can handle short replies,
      // follow-up clarifications, MCP-driven tool calls and general
      // Q&A. Domain-specific agents (research, coding, browser) can
      // still outrank chat when they detect a strong signal.
      //
      // EXCEPTION: tasks that are transactional / MCP-driven (ordering,
      // paying, booking, sending, navigating, querying a configured MCP
      // service) must go to chat because chat has the full ReAct tool
      // loop wired with MCP tools. We return 0.9 to outrank any
      // keyword-based agent.
      const task = ctx.task.toLowerCase();
      // Match colloquial Chinese ("点个/想要/来一份/给我来...") and
      // English action verbs. Keep the list permissive — false positives
      // (chat handles generic Q&A just fine) are cheap; false negatives
      // (research runs on an ordering task) are expensive.
      const transactional = /(点[一份个]|来[一]?[份个]?|想要|我想要|想[要吃]?个?|请帮我点|给我来|帮我[来买做]|来[杯碗]?|点[杯碗盘]?|下[一]?[个份]?单|叫[一]?[份个]?|外卖|订[一]?[份个张张位]?|预[购订]|订[票房]|点[餐饭]?|支付|付款|买单|结账|place[ _-]?order|order[ _-]?food|waimai|叫车|打车|网约车|叫[一]?辆[车]|收银|加好友|发[一]?[条个]?消息?|转账|登录|login|sign[ _-]?in|登出|logout|sign[ _-]?out|注册|register|高德|amap|gaode|麦当劳|mcdonald|kfc|肯德基|starbucks|星巴克|必胜客|pizzahut|meituan|美团|eleme|饿了么|滴滴|didi|jdb|京东|taobao|淘宝|baidu|百度)/i;
      if (transactional.test(task)) return 0.9;
      return 0.3;
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

        // Load conversation history from shared state. Trim to the most
        // recent exchanges to keep LLM context small and latency low.
        const fullHistory = ctx.sharedState.get<LLMMessage[]>(CHAT_HISTORY_KEY) ?? [];
        const history = fullHistory.slice(-MAX_HISTORY_MESSAGES);

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

        const mode = selectPlanningMode(ctx.task, opts.planningMode ?? 'auto');
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
          // Simple tasks skip the dedicated planning LLM call and rely on
          // the native ReAct loop, saving one round-trip.
          planSpan?.end({ plan: 'skipped' });
        }

        // ── Phase 2.5: Skill selection ──────────────────────────────
        const skillContext = buildSkillContext(ctx.task);

        // ── Phase 3: ReAct loop ─────────────────────────────────────
        const messages: LLMMessage[] = [
          { role: 'system', content: systemPrompt + memoryContext + attachmentContext + planText + skillContext },
          ...history,
          { role: 'user', content: ctx.task },
        ];

        // Execute a single tool call with all the common bookkeeping.
        // Used by both native tool calls and XML/DSML fallback tool calls.
        async function executeOneTool(
          toolName: string,
          toolId: string,
          args: Record<string, unknown>,
        ): Promise<void> {
          if (!allToolNames.has(toolName)) {
            messages.push({
              role: 'tool',
              content: `Unknown tool: ${toolName}. Available tools: ${[...allToolNames].join(', ')}`,
              toolCallId: toolId,
            });
            return;
          }

          toolCalls++;
          const toolSpan = startSpan?.('tool:' + toolName, 'tool', { name: toolName, args });
          const inv: ToolInvocation = { id: toolId, toolName, args };
          progress('tool', opts.dryRun ? `Simulating ${toolName}...` : `Executing ${toolName}...`);
          const pipelineResult = await toolPipeline.invoke(inv, async () => executeTool(toolName, args, extraToolMap, opts.toolPolicy));
          const result = pipelineResult.ok
            ? String(pipelineResult.output ?? '')
            : `Error: ${pipelineResult.error?.message ?? 'unknown'}`;
          toolSpan?.end({ result: result.slice(0, 200) });
          messages.push({
            role: 'tool',
            content: compressToolResult(toolName, result),
            toolCallId: toolId,
          });
        }

        // Build the final result object with metrics, history, and memory save.
        // Used by both normal exit and max-iterations exit paths.
        function buildFinalResult(
          reply: string,
          outcome: 'success' | 'partial' | 'failure',
          extraTags: string[] = [],
        ): AgentResult {
          const durationMs = Date.now() - t0;
          const costUsd = computeCost(ctx.model, totalTokensIn, totalTokensOut);
          const updatedHistory: LLMMessage[] = [
            ...fullHistory,
            { role: 'user', content: ctx.task },
            { role: 'assistant', content: reply },
          ];
          ctx.sharedState.set(CHAT_HISTORY_KEY, updatedHistory, 'chat');
          saveRunMemory(ctx.task, reply, outcome, ctx.parentRunId, extraTags);
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

        // Record LLM usage stats from a response.
        function recordLlmUsage(response: LLMResponse): void {
          llmCalls++;
          totalTokensIn += response.usage.tokensIn;
          totalTokensOut += response.usage.tokensOut;
        }

        // Strip XML/DSML tool call tags from reply text.
        function stripXmlToolTags(text: string): string {
          return text
            .replace(/<tool_calls>[\s\S]*?<\/tool_calls>/g, '')
            .replace(/<invoke[\s\S]*?<\/invoke>/g, '')
            .replace(/<｜｜DSML｜｜tool_calls>[\s\S]*?<\/｜｜DSML｜｜tool_calls>/g, '')
            .replace(/<｜｜DSML｜｜invoke[\s\S]*?<\/｜｜DSML｜｜invoke>/g, '')
            .trim();
        }

        // Pick stream() vs generate() once per execute() so the ReAct
        // loop can stream text deltas via opts.onStreamChunk when the
        // provider supports it. Falls back to generate() silently.
        const streamingEnabled = !!(opts.onStreamChunk && opts.llmProvider.stream);
        const callLlm = async (req: LLMRequest): Promise<LLMResponse> => {
          if (streamingEnabled && opts.llmProvider.stream && opts.onStreamChunk) {
            return opts.llmProvider.stream(req, (msg) => {
              if (msg.content) opts.onStreamChunk!(msg.content);
            });
          }
          return opts.llmProvider.generate(req);
        };

        // Track tool-call fingerprints for the current task so we can
        // detect when the LLM is calling the same tool with the same
        // arguments in a loop (a common ReAct failure mode for MCP
        // tools that return partial / ambiguous results, e.g. McDonald's
        // "查完整菜单" repeated 5 times). The LLM doesn't remember
        // earlier tool results as well as it thinks — adding a hint
        // to its message history breaks the loop.
        const recentCallFingerprints: string[] = [];
        const DUP_WINDOW = 4; // look back over the last 4 iterations
        const DUP_THRESHOLD = 2; // 2 identical calls in the window → warn
        function fingerprint(toolName: string, args: Record<string, unknown>): string {
          try {
            return `${toolName}::${JSON.stringify(args ?? {})}`;
          } catch {
            return `${toolName}::${Date.now()}`;
          }
        }

        for (let i = 0; i < maxIterations; i++) {
          progress('think', `Step ${i + 1}: Thinking...`);
          const response = await callLlm({
            model: ctx.model,
            messages,
            tools: allTools,
            temperature: 0.7,
            maxTokens: 4096,
            signal: ctx.signal,
          });

          recordLlmUsage(response);

          // No tool calls → check for XML-style tool calls (fallback for models
          // that don't fully support native OpenAI function calling)
          if (!response.message.toolCalls || response.message.toolCalls.length === 0) {
            const reply = response.message.content ?? '';

            // Try to parse XML tool calls from the text response
            const xmlCalls = parseXmlToolCalls(reply);
            if (xmlCalls && xmlCalls.length > 0) {
              // Strip the XML/DSML tags from the content for display
              const cleanReply = stripXmlToolTags(reply);

              // Only keep the clean text as the assistant message
              if (cleanReply) {
                messages.push({ role: 'assistant', content: cleanReply });
              } else {
                messages.push({ role: 'assistant', content: '(executing tools...)' });
              }

              for (const tc of xmlCalls) {
                await executeOneTool(tc.name, `xml_${tc.name}_${i}`, tc.arguments);
              }
              continue; // Go to next iteration
            }

            progress('answer', 'Generating final answer...');
            return buildFinalResult(reply, 'success');
          }

          // ── Execute tool calls ──────────────────────────────────
          messages.push({
            role: 'assistant',
            content: response.message.content,
            toolCalls: response.message.toolCalls,
          });

          for (const tc of response.message.toolCalls) {
            const fp = fingerprint(tc.name, tc.arguments);
            recentCallFingerprints.push(fp);
            if (recentCallFingerprints.length > DUP_WINDOW) {
              recentCallFingerprints.splice(0, recentCallFingerprints.length - DUP_WINDOW);
            }
            await executeOneTool(tc.name, tc.id ?? `native_${tc.name}_${i}`, tc.arguments);
          }

          // Loop guard: if the LLM is calling the same tool with the same
          // arguments repeatedly, it's not converging. Inject a strong
          // hint and, if the loop persists, force a final answer.
          if (i + 1 < maxIterations) {
            const counts = new Map<string, number>();
            for (const fp of recentCallFingerprints) {
              counts.set(fp, (counts.get(fp) ?? 0) + 1);
            }
            let worstFp: string | null = null;
            let worstCount = 0;
            for (const [fp, c] of counts) {
              if (c > worstCount) { worstCount = c; worstFp = fp; }
            }
            if (worstCount >= DUP_THRESHOLD && worstFp) {
              const [toolName] = worstFp.split('::');
              messages.push({
                role: 'user',
                content:
                  `注意：你刚才已经用完全相同的参数连续调用了 \`${toolName}\` ${worstCount} 次，得到的结果已经在上面历史消息里。` +
                  `请**停止重复调用**，改用其他策略：` +
                  `(1) 如果你需要的字段在返回结果中已经存在，直接使用；` +
                  `(2) 如果需要用不同的参数再次调用（例如分页/不同类别），请用**不同的参数**；` +
                  `(3) 如果工具已经返回最终结果或不能提供更多数据，直接基于已有信息给出最终答案。`,
              });
              if (worstCount >= DUP_THRESHOLD + 1) {
                // Two consecutive rounds of duplicate calls — force
                // convergence: replace the next tool-call instruction
                // with a final-answer instruction.
                progress('think', 'Loop detected, forcing final answer...');
                messages.push({
                  role: 'user',
                  content: '请立即基于已有工具结果给出最终答案，不要再调用任何工具。',
                });
              }
            }
          }
        }

        // Max iterations reached — ask LLM for final answer
        progress('think', 'Generating final summary...');
        messages.push({
          role: 'user',
          content: 'Please provide your final answer based on all the tool results above. Do not call any more tools.',
        });

        const finalResponse = await callLlm({
          model: ctx.model,
          messages,
          temperature: 0.7,
          maxTokens: 4096,
          signal: ctx.signal,
        });

        recordLlmUsage(finalResponse);

        const reply = finalResponse.message.content ?? '';
        return buildFinalResult(reply, 'partial', ['max-iterations']);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return failResult('LLM_ERROR', msg);
      }
    },
  };
}

// ── Tool executor ─────────────────────────────────────────────────────

// ── Tool executor ─────────────────────────────────────────────────────

type ToolHandler = (args: Record<string, unknown>) => Promise<string>;

const toolHandlers = new Map<string, ToolHandler>([
  // Web tools
  ['web_search', (args) => webSearch(
    String(args.query ?? ''),
    typeof args.maxResults === 'number' ? args.maxResults : 5
  )],
  ['web_fetch', (args) => webFetch(
    String(args.url ?? ''),
    typeof args.maxLength === 'number' ? args.maxLength : 5000
  )],
  ['get_location', () => getLocation()],
  // File & task tools
  ['read_file', (args) => readFile(
    String(args.filePath ?? args.path ?? ''),
    typeof args.startLine === 'number' ? args.startLine : undefined,
    typeof args.lineCount === 'number' ? args.lineCount : undefined
  )],
  ['write_file', (args) => writeFile(
    String(args.filePath ?? args.path ?? ''),
    String(args.content ?? '')
  )],
  ['replace_text', (args) => replaceText(
    String(args.filePath ?? args.path ?? ''),
    String(args.oldText ?? ''),
    String(args.newText ?? '')
  )],
  ['append_text', (args) => appendText(
    String(args.filePath ?? args.path ?? ''),
    String(args.content ?? '')
  )],
  ['insert_text', (args) => insertText(
    String(args.filePath ?? args.path ?? ''),
    String(args.anchorText ?? ''),
    String(args.newText ?? ''),
    (args.mode as 'before' | 'after') ?? 'after'
  )],
  ['run_terminal', (args) => runTerminal(
    String(args.command ?? args.cmd ?? ''),
    typeof args.cwd === 'string' ? args.cwd : undefined,
    typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined
  )],
  ['search_code', (args) => searchCode(
    String(args.pattern ?? args.query ?? ''),
    typeof args.filePattern === 'string' ? args.filePattern : undefined,
    typeof args.maxResults === 'number' ? args.maxResults : 20
  )],
  ['list_directory', (args) => listDirectory(
    typeof args.dirPath === 'string' ? args.dirPath : undefined,
    typeof args.depth === 'number' ? args.depth : 1
  )],
  ['get_project_context', (args) => getProjectContext(
    (args.detail as 'summary' | 'full') ?? 'summary'
  )],
  // Browser tools
  ['browser_navigate', (args) => browserNavigate(String(args.url ?? ''))],
  ['browser_click', (args) => browserClick(
    typeof args.elementId === 'number' ? args.elementId : undefined,
    typeof args.x === 'number' ? args.x : undefined,
    typeof args.y === 'number' ? args.y : undefined
  )],
  ['browser_scroll', (args) => browserScroll(
    String(args.direction ?? 'down'),
    typeof args.amount === 'number' ? args.amount : 500
  )],
  ['browser_screenshot', () => browserScreenshot()],
  ['browser_go_back', () => browserGoBack()],
  ['browser_go_forward', () => browserGoForward()],
  ['browser_close', () => browserClose()],
  // Perception tools
  ['ocr_image', (args) => ocrImage(String(args.filePath ?? ''))],
  ['describe_image', (args) => describeImage(String(args.filePath ?? ''))],
  ['transcribe_audio', (args) => transcribeAudio(String(args.filePath ?? ''))],
  ['parse_document', (args) => parseDocument(String(args.filePath ?? ''))],
]);

async function executeTool(
  name: string,
  args: Record<string, unknown>,
  extraTools?: Map<string, (args: Record<string, unknown>) => Promise<string>>,
  toolPolicy?: ToolPolicy,
): Promise<string> {
  // P1-2: enforce tool policy before any execution.
  if (toolPolicy && !isToolAllowed(toolPolicy, name)) {
    return `Error: TOOL_DENIED_BY_POLICY — tool '${name}' is not allowed by the active tool policy.`;
  }

  const handler = toolHandlers.get(name);
  if (handler) {
    return handler(args);
  }

  const extra = extraTools?.get(name);
  if (extra) {
    try {
      return await extra(args);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Error: ${msg}`;
    }
  }

  return `Unknown tool: ${name}`;
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

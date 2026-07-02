// @ziner/agent-planner — Task Planner (P2 Multi-Agent).
//
// Decomposes a user task into a DAG of sub-tasks (SubTask[]) so the
// Orchestrator's `plan` mode can dispatch them in waves.
//
// Output:
//   - Returns the `PlanDag` as `AgentResult.output` and `artifacts['plan.dag']`.
//   - Also writes it to `SharedState['plan.dag']` so the Orchestrator
//     (and other downstream agents) can read it.
//
// Trigger:
//   - The connector routes here when `planningMode === 'hierarchical'`.
//   - `canHandle` returns a high score for non-trivial tasks so the
//     router prefers this agent when a plan is wanted.

import type { ILLMProvider, IAgent, ModelSpec, TaskContext, AgentResult, PlanDag, SubTask } from '@ziner/contracts';
import { ok as okResult, fail as failResult, parseJsonObject, getPath, callWithMetrics } from '@ziner/contracts';

export interface PlannerAgentConfig {
  /** LLM provider used to call the model for decomposition. */
  llmProvider: ILLMProvider;
  /** Default model for the planner. */
  model: ModelSpec;
  /** Names of agents that may be assigned sub-tasks. The Planner will
   *  prefer these; if a sub-task references an unknown agent, the
   *  Orchestrator falls back to the chat agent. */
  availableAgents?: string[];
  /** Max sub-tasks per plan. Default 5. */
  maxSubTasks?: number;
  /** Override the default system prompt. */
  systemPrompt?: string;
}

// Per-agent role descriptions shown in the Planner prompt. Only the
// agents that are actually registered are included, so the model can
// never invent a name that would later fail at dispatch time.
//
// Keep the canonical "chat" name in this map too, even when the
// runtime registers the general agent as "coding" — the Planner's
// system prompt is the *contract* with the LLM, and the connector
// re-maps "chat" → "coding" at dispatch time via the orchestrator's
// fallback. That way the prompt stays readable, while the runtime
// still uses the name that's wired into the agent-registry.
const AGENT_ROLE_HINTS: Record<string, string> = {
  chat: 'general reasoning, writing, math, summarisation, comparison, follow-up Q&A. Also preferred for tasks that benefit from MCP-backed tools (maps, hotels, restaurants, navigation, weather, real-time prices) since the chat agent has the full ReAct tool loop wired with MCP tools.',
  browser: 'interactive web pages (login walls, JS-heavy sites, screenshots, clicks, form fills, pricing tables)',
  research: 'web search + multi-page synthesis, produces a report with citations',
  coding: 'write / edit / refactor code, run tests, fix bugs, package changes',
  office: 'Office documents (.docx/.xlsx/.pptx) read & edit',
};

const DEFAULT_AVAILABLE_AGENTS = ['chat', 'browser', 'research', 'coding', 'office'];

/**
 * Pick the best "general" agent from a list of available agents.
 * The Planner's prompt must always have a single name to fall back
 * to, otherwise the model invents one and the orchestrator can't
 * dispatch. We prefer agents whose role covers "general" work
 * (chat / coding), then the first name in the list as a last resort.
 */
function pickFallbackAgent(available: string[]): string {
  for (const preferred of ['chat', 'coding', 'research', 'browser', 'office']) {
    if (available.includes(preferred)) return preferred;
  }
  return available[0] ?? 'chat';
}

/**
 * Render the `available` placeholder with bullet lines including
 * each agent's role hint. Skips any agent not in AGENT_ROLE_HINTS
 * (unknown agents get a generic label so the prompt still works).
 */
function renderAvailableList(available: string[]): string {
  return available
    .map((name) => {
      const hint = AGENT_ROLE_HINTS[name] ?? 'general worker';
      return `- ${name.padEnd(8)} — ${hint}`;
    })
    .join('\n');
}

const DEFAULT_SYSTEM_PROMPT = `You are a task-planning agent. Your job is to decompose a user's request into a DAG of sub-tasks so that specialised worker agents can execute them.

**YOU ARE FREE TO CHOOSE ANY AGENT FOR EACH SUB-TASK.** The router's seed selection is a soft hint, not a hard cap — feel free to overrule it when the sub-task (especially one informed by recent conversation) clearly belongs to a different agent. The agent roster is dynamic; trust your own judgement about which role best fits each sub-task.

Available agents (use exactly these names in \`assignedTo\`):
- {available}

The remaining lines of the prompt (HARD RULES through EXAMPLES) are
unchanged from the previous revision; the placeholder {available}
above is filled in at runtime with the agents actually registered
in the live registry (so the model never invents an agent name
that doesn't exist on this machine).

=== HARD RULES — DO NOT VIOLATE ===

1. **One sub-task = ONE worker agent.** A sub-task must be assigned to exactly one agent. NEVER list multiple agents for a single sub-task. If a goal needs both browsing and code editing, split it into two sub-tasks: one for browser, one for coding.

2. **No multi-agent collaboration on a single sub-task.** A sub-task runs in a single worker's context. The worker must be able to complete the sub-task on its own. Do NOT create sub-tasks like "have research and browser work together on this URL".

3. **Decompose further when complex.** If a sub-task is too complex for one worker (e.g. "build a website with login, payments, and an admin panel"), split it into smaller sub-tasks that EACH fit a single agent. Keep splitting until each leaf sub-task is small enough to be done in one worker pass.

4. **Pick the BEST agent per sub-task.** Choose the agent that is most specialised for the sub-task. For "visit X and read the price table" → browser (because pricing pages are JS-rendered). For "summarise what we found" → chat or research. For "write a Python function" → coding. For tasks involving maps, hotels, restaurants, navigation, weather, real-time prices, ordering food, delivery, takeout, or any other interaction with a configured MCP service (e.g. AMap/Gaode maps, McDonald's ordering) → prefer the \`chat\` agent because it has the full ReAct tool loop wired with MCP tools and can call \`mcp_<server>_<tool>\` directly.

5. **Read the recent-conversation block at the top of the task.** When the user has been having a multi-turn dialogue, the Orchestrator prepends a "同一会话的最近对话" block to the task. Use it as the primary signal for which sub-tasks make sense. A short follow-up like "我在上海虹桥阿里中心" only makes sense in the context of the prior turn ("帮我点个麦当劳"); the sub-task should preserve the prior intent (e.g. "search for McDonald's stores near 虹桥阿里中心, Shanghai") not just answer "我听到了".

6. **Pick the agent based on the SUB-TASK, not the surface intent.** Even if the user says a few short words, the underlying sub-task (informed by recent context) might be a search, a tool call, a code change or a report. Always pick the agent whose role description best matches the actual sub-task. If two agents could do the job, prefer the more specific one.

7. **Prefer fewer sub-tasks.** Aim for {max} or fewer. Over-decomposition wastes budget. An atomic task is ONE sub-task with empty \`dependsOn\`.

8. **Use \`dependsOn\` for ordering.** If sub-task B needs A's output, B.dependsOn must include A.id. Independent sub-tasks get empty dependsOn and run in parallel.

9. **NEVER assign a sub-task to yourself.** Never invent agent names not in the list above. If a sub-task truly cannot be done by any listed agent, assign it to the most general agent in the list ({fallback_agent}) and describe the work in \`prompt\`.

=== OUTPUT FORMAT ===

Respond with ONLY a JSON object (no markdown fences, no prose) of the form:
{
  "rationale": "one-sentence explanation of the decomposition and the key agent choice",
  "subtasks": [
    {
      "id": "snake_case_id",
      "title": "Short label, max 8 words",
      "prompt": "Self-contained instruction for the worker. Include any URL, filename, or context the worker needs.",
      "assignedTo": "one of: chat | browser | research | coding | office",
      "dependsOn": ["id_of_prerequisite_subtask"]
    }
  ]
}

=== EXAMPLES ===

Example 1 — "查询 GLM/火山方舟 coding plan 费用"
{
  "rationale": "One browse on each pricing page is enough; no extra search or synthesis needed.",
  "subtasks": [
    {
      "id": "browse_glm_pricing",
      "title": "Open GLM pricing page",
      "prompt": "Navigate to https://open.bigmodel.cn/pricing and extract the coding plan and token plan price table. Return the plan names, monthly prices, and included tokens as a markdown table.",
      "assignedTo": "browser",
      "dependsOn": []
    },
    {
      "id": "browse_volc_pricing",
      "title": "Open Volcano Ark pricing page",
      "prompt": "Navigate to https://www.volcengine.com/pricing and find the coding plan and token plan for the LLM services. Return the plan names, monthly prices, and included tokens as a markdown table.",
      "assignedTo": "browser",
      "dependsOn": []
    },
    {
      "id": "compare_and_recommend",
      "title": "Compare and recommend",
      "prompt": "Given the two pricing tables above, compare them on price-per-million-tokens and recommend which is more cost-effective for a developer using ~5M tokens/day. Return a short verdict (3-5 lines).",
      "assignedTo": "{fallback_agent}",
      "dependsOn": ["browse_glm_pricing", "browse_volc_pricing"]
    }
  ]
}

Example 2 — "Refactor login.ts to use async/await and add tests"
{
  "rationale": "Single coding sub-task: one worker, no browser, no research.",
  "subtasks": [
    {
      "id": "refactor_login",
      "title": "Refactor login.ts and add tests",
      "prompt": "Open login.ts, convert the callback-style code to async/await, and add Jest tests covering the success and failure paths. Run the test suite when done.",
      "assignedTo": "coding",
      "dependsOn": []
    }
  ]
}

Now decompose the user's request. Output ONLY the JSON.`;

/** Factory: build a Planner `IAgent`. */
export function createPlannerAgent(config: PlannerAgentConfig): IAgent {
  const maxSubTasks = config.maxSubTasks ?? 5;
  const available = config.availableAgents ?? DEFAULT_AVAILABLE_AGENTS;
  // When the caller passes a subset of agents (e.g. the connector
  // filters out 'planner' and 'synthesizer'), make sure the prompt
  // never mentions agents that aren't actually registered. We also
  // append the canonical "chat" name as a soft alias when the
  // runtime registers the general agent as "coding" — the prompt
  // stays consistent with older revisions and the orchestrator
  // re-maps "chat" → "coding" at dispatch time.
  const availableWithFallback = available.includes('chat') || !available.includes('coding')
    ? available
    : ['chat', ...available];
  const fallbackAgent = pickFallbackAgent(availableWithFallback);
  const systemPrompt = (config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT)
    .replace('{max}', String(maxSubTasks))
    .replace('{available}', renderAvailableList(availableWithFallback))
    .replace('{fallback_agent}', fallbackAgent);

  return {
    name: 'planner',
    role: 'Task Planner',
    capabilities: ['plan', 'decompose', 'orchestrate'],
    dependencies: [],
    modelPreference: config.model,
    canHandle(ctx) {
      // Prefer the planner for non-trivial requests; the connector
      // forces us to run anyway in `hierarchical` mode, so this is
      // a routing hint rather than a gate.
      return ctx.task.length > 30 ? 0.9 : 0.4;
    },
    async execute(ctx: TaskContext): Promise<AgentResult> {
      let callResult;
      try {
        callResult = await callWithMetrics({
          llmProvider: config.llmProvider,
          model: config.model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: ctx.task },
          ],
          temperature: 0.2,
          maxTokens: 1024,
          signal: ctx.signal,
        });
      } catch (e) {
        return failResult('4001', `Planner LLM call failed: ${(e as Error).message}`);
      }

      const plan = parsePlan(callResult.content, ctx.task, availableWithFallback);
      if (!plan) {
        return failResult('4001', 'Planner could not produce a valid plan DAG');
      }

      // Publish to SharedState so the Orchestrator (and Synthesizer)
      // can read the decomposition.
      ctx.sharedState.set('plan.dag', plan, 'planner');

      return okResult(plan, {
        artifacts: { 'plan.dag': plan },
        metrics: callResult.metrics,
      });
    },
  };
}

// ── Plan parser ───────────────────────────────────────────────────────

interface RawPlan {
  rationale?: string;
  subtasks?: Array<{
    id?: string;
    title?: string;
    prompt?: string;
    assignedTo?: string;
    dependsOn?: string[];
  }>;
}

/** Best-effort parse of the LLM's JSON response. Returns null when
 *  the response doesn't contain a usable plan; the caller should then
 *  fail rather than dispatching a bogus DAG. */
function parsePlan(content: string, originalTask: string, availableAgents: string[]): PlanDag | null {
  const parsed = parseJsonObject<RawPlan>(content);
  if (!parsed.ok) return null;
  const rawSubtasks = parsed.value.subtasks;
  if (!Array.isArray(rawSubtasks) || rawSubtasks.length === 0) return null;

  const allowed = new Set(availableAgents);
  const subtasks: SubTask[] = [];
  const seenIds = new Set<string>();

  for (let i = 0; i < rawSubtasks.length; i++) {
    const s = rawSubtasks[i];
    if (typeof s?.prompt !== 'string' || s.prompt.trim().length === 0) continue;

    // Normalise the id: keep the model's choice if it's a valid
    // snake_case string, otherwise synthesise one.
    let id = typeof s.id === 'string' && /^[a-z][a-z0-9_]*$/.test(s.id) ? s.id : `subtask_${i + 1}`;
    while (seenIds.has(id)) id = `${id}_${i + 1}`;
    seenIds.add(id);

    // Force the assigned agent to a known name. LLM can occasionally
    // invent new names (e.g. "research_agent") — in that case we
    // log a warning and keep the raw name; the Orchestrator will
    // fall back to a valid agent at dispatch time.
    //
    // When the model omits `assignedTo` entirely, default to the
    // most-general available agent (chat > coding > research > …).
    // Hardcoding 'chat' here would break hosts that have re-mapped
    // 'chat' → 'coding' (e.g. the desktop connector).
    const fallback = pickFallbackAgent(availableAgents);
    const assignedTo = typeof s.assignedTo === 'string' && s.assignedTo.length > 0
      ? s.assignedTo
      : fallback;

    const dependsOn = Array.isArray(s.dependsOn)
      ? s.dependsOn.filter((d): d is string => typeof d === 'string')
      : [];

    subtasks.push({
      id,
      title: typeof s.title === 'string' && s.title.length > 0 ? s.title : id,
      prompt: s.prompt.trim(),
      assignedTo,
      dependsOn: dependsOn.filter((d) => d !== id), // drop self-deps
    });

    if (subtasks.length >= 8) break; // hard cap as a safety belt
  }

  if (subtasks.length === 0) return null;

  return {
    task: originalTask,
    subtasks,
    rationale: typeof parsed.value.rationale === 'string' ? parsed.value.rationale : undefined,
    // Note: `allowed` is consulted for awareness; we do not mutate
    // the model output beyond the safety checks above.
    ...(allowed.size > 0 ? {} : {}),
  };
}

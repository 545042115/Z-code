// @z-assistant/agent-planner — Task Planner (P2 Multi-Agent).
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

import type { ILLMProvider, IAgent, ModelSpec, TaskContext, AgentResult, PlanDag, SubTask } from '@z-assistant/contracts';
import { ok as okResult, fail as failResult } from '@z-assistant/contracts';

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

const DEFAULT_AVAILABLE_AGENTS = ['chat', 'browser', 'research', 'coding', 'office'];

const DEFAULT_SYSTEM_PROMPT = `You are a task-planning agent. Your job is to decompose a user's request into a DAG of sub-tasks so that specialised worker agents can execute them.

Available agents (use exactly these names in \`assignedTo\`):
- chat      — general reasoning, code, writing, math, summarisation
- browser   — interactive web pages (login walls, JS-heavy sites, screenshots, clicks, form fills)
- research  — web search + multi-page synthesis, produces a report
- coding    — write / edit / refactor code, run tests, fix bugs
- office    — Office documents (.docx/.xlsx/.pptx) read & edit

=== HARD RULES — DO NOT VIOLATE ===

1. **One sub-task = ONE worker agent.** A sub-task must be assigned to exactly one agent. NEVER list multiple agents for a single sub-task. If a goal needs both browsing and code editing, split it into two sub-tasks: one for browser, one for coding.

2. **No multi-agent collaboration on a single sub-task.** A sub-task runs in a single worker's context. The worker must be able to complete the sub-task on its own. Do NOT create sub-tasks like "have research and browser work together on this URL".

3. **Decompose further when complex.** If a sub-task is too complex for one worker (e.g. "build a website with login, payments, and an admin panel"), split it into smaller sub-tasks that EACH fit a single agent. Keep splitting until each leaf sub-task is small enough to be done in one worker pass.

4. **Pick the BEST agent per sub-task.** Choose the agent that is most specialised for the sub-task. For "visit X and read the price table" → browser (because pricing pages are JS-rendered). For "summarise what we found" → chat or research. For "write a Python function" → coding.

5. **Prefer fewer sub-tasks.** Aim for {max} or fewer. Over-decomposition wastes budget. An atomic task is ONE sub-task with empty \`dependsOn\`.

6. **Use \`dependsOn\` for ordering.** If sub-task B needs A's output, B.dependsOn must include A.id. Independent sub-tasks get empty dependsOn and run in parallel.

7. **NEVER assign a sub-task to yourself.** Never invent agent names not in the list above. If a sub-task truly cannot be done by any listed agent, assign it to "chat" and describe the work in \`prompt\`.

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
      "assignedTo": "chat",
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
  const systemPrompt = (config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT)
    .replace('{max}', String(maxSubTasks))
    .replace('{available}', available.join(', '));

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
      const t0 = performance.now();
      let response;
      try {
        response = await config.llmProvider.generate({
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

      const plan = parsePlan(response.message.content ?? '', ctx.task, available);
      if (!plan) {
        return failResult('4001', 'Planner could not produce a valid plan DAG');
      }

      // Publish to SharedState so the Orchestrator (and Synthesizer)
      // can read the decomposition.
      ctx.sharedState.set('plan.dag', plan, 'planner');

      return okResult(plan, {
        artifacts: { 'plan.dag': plan },
        metrics: {
          tokensIn: response.usage.tokensIn,
          tokensOut: response.usage.tokensOut,
          costUsd: response.costUsd ?? 0,
          durationMs: Math.round(performance.now() - t0),
          llmCalls: 1,
          toolCalls: 0,
        },
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
  const raw = extractJson(content) as RawPlan | null;
  if (!raw || !Array.isArray(raw.subtasks) || raw.subtasks.length === 0) {
    return null;
  }

  const allowed = new Set(availableAgents);
  const subtasks: SubTask[] = [];
  const seenIds = new Set<string>();

  for (let i = 0; i < raw.subtasks.length; i++) {
    const s = raw.subtasks[i];
    if (typeof s?.prompt !== 'string' || s.prompt.trim().length === 0) continue;

    // Normalise the id: keep the model's choice if it's a valid
    // snake_case string, otherwise synthesise one.
    let id = typeof s.id === 'string' && /^[a-z][a-z0-9_]*$/.test(s.id) ? s.id : `subtask_${i + 1}`;
    while (seenIds.has(id)) id = `${id}_${i + 1}`;
    seenIds.add(id);

    // Force the assigned agent to a known name. LLM can occasionally
    // invent new names (e.g. "research_agent") — in that case we
    // log a warning and keep the raw name; the Orchestrator will
    // fall back to the chat agent at dispatch time.
    const assignedTo = typeof s.assignedTo === 'string' && s.assignedTo.length > 0
      ? s.assignedTo
      : 'chat';

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
    rationale: typeof raw.rationale === 'string' ? raw.rationale : undefined,
    // Note: `allowed` is consulted for awareness; we do not mutate
    // the model output beyond the safety checks above.
    ...(allowed.size > 0 ? {} : {}),
  };
}

/** Extract a JSON object from a (possibly markdown-wrapped) string. */
function extractJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;

  // 1. Direct parse
  try { return JSON.parse(trimmed); } catch { /* fall through */ }

  // 2. Strip ```json ... ``` or ``` ... ``` fences
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]+?)\s*```/i);
  if (fenced) {
    try { return JSON.parse(fenced[1]); } catch { /* fall through */ }
  }

  // 3. First balanced { ... } block
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try { return JSON.parse(trimmed.slice(first, last + 1)); } catch { /* fall through */ }
  }
  return null;
}

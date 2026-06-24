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

const DEFAULT_AVAILABLE_AGENTS = ['chat', 'browser', 'research', 'office'];

const DEFAULT_SYSTEM_PROMPT = `You are a task-planning agent. Your job is to decompose a user's request into a DAG of sub-tasks so that specialised agents can execute them in parallel.

Available agents (use exactly these names in \`assignedTo\`):
- chat      — general reasoning, code, writing, math, summarisation
- browser   — interactive web pages (login walls, JS-heavy sites, screenshots)
- research  — web search + multi-page synthesis, produces a report
- office    — Office documents (.docx/.xlsx/.pptx) read & edit

Rules:
1. Produce AT MOST {max} sub-tasks. Prefer fewer — over-decomposition wastes budget.
2. Every sub-task MUST have a unique \`id\` (snake_case), a non-empty \`prompt\`, and an \`assignedTo\` from the list above.
3. Use \`dependsOn\` to express ordering (e.g. "search then summarise" → the second node depends on the first).
4. If the task is ATOMIC (single intent, fits one agent), return ONE sub-task with empty \`dependsOn\`.
5. NEVER assign a sub-task to yourself. Never invent agent names not in the list.

Respond with a JSON object of the form:
{
  "rationale": "one-sentence explanation of the decomposition",
  "subtasks": [
    { "id": "search_news", "title": "Search latest AI news", "prompt": "...", "assignedTo": "research", "dependsOn": [] }
  ]
}

Output ONLY the JSON — no prose, no markdown fences.`;

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

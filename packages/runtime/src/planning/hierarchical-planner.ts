// @z-assistant/runtime — Hierarchical Planner
//
// Builds a multi-level plan (milestones → steps) from a task using an LLM,
// then executes it step-by-step. This is the "deep planning" mode for
// complex tasks; the chat-agent can fall back to its native ReAct loop for
// simple tasks.

import type { ILLMProvider, LLMMessage, Plan, PlanResult, PlanStep, TaskContext } from '@z-assistant/contracts';
import { executeSequential, type StepHandler } from './sequential-executor';

export type PlanningMode = 'simple' | 'hierarchical' | 'auto';

export interface HierarchicalPlannerOptions {
  llmProvider: ILLMProvider;
  model?: { provider: string; name: string };
  /**
   * Max planning LLM calls. Each milestone may be expanded into steps if the
   * initial plan is too coarse. Default 2.
   */
  maxPlanningRounds?: number;
}

export interface HierarchicalPlan extends Plan {
  milestones: Milestone[];
}

export interface Milestone {
  id: string;
  name: string;
  objective: string;
  stepIds: string[];
}

export interface MilestoneDraft {
  id: string;
  name: string;
  objective: string;
}

export interface StepDraft {
  id: string;
  milestoneId: string;
  name: string;
  instruction: string;
  dependsOn?: string[];
}

/**
 * Select the planning mode for a task.
 *
 * Heuristics:
 * - Keywords like "plan", "方案", "步骤", "strategy" → hierarchical
 * - Long tasks (>80 chars) or tasks with multiple sentences → hierarchical
 * - Otherwise → simple
 */
export function selectPlanningMode(task: string, preferred?: PlanningMode): 'simple' | 'hierarchical' {
  if (preferred && preferred !== 'auto') return preferred;
  const lowered = task.toLowerCase();
  const hierarchicalSignals = ['plan', '方案', '步骤', 'strategy', 'roadmap', 'milestone', 'workflow'];
  if (hierarchicalSignals.some((s) => lowered.includes(s))) return 'hierarchical';
  if (task.length > 80) return 'hierarchical';
  if (task.split(/[.。!！?？;；]/).filter(Boolean).length > 1) return 'hierarchical';
  return 'simple';
}

/**
 * Build a hierarchical plan from a task using an LLM.
 *
 * The LLM is asked to output a JSON plan with milestones and steps. If the
 * response cannot be parsed, a single-milestone fallback plan is returned so
 * the caller can still proceed.
 */
export async function buildHierarchicalPlan(
  task: string,
  opts: HierarchicalPlannerOptions,
): Promise<HierarchicalPlan> {
  const messages: LLMMessage[] = [
    {
      role: 'system',
      content:
        'You are a planning assistant. Break the user task into milestones and steps. ' +
        'Output ONLY valid JSON in this exact shape:\n' +
        '{"milestones":[{"id":"m1","name":"...","objective":"..."}],' +
        '"steps":[{"id":"s1","milestoneId":"m1","name":"...","instruction":"...","dependsOn":[]}]}\n' +
        'Each step should be concrete, actionable, and small enough to execute with one tool call or a short reasoning chain.',
    },
    { role: 'user', content: `Task: ${task}` },
  ];

  let raw = '';
  try {
    const response = await opts.llmProvider.generate({
      model: opts.model ?? { provider: 'openai', name: 'gpt-4o-mini' },
      messages,
      temperature: 0.3,
      maxTokens: 2048,
    });
    raw = response.message.content ?? '';
  } catch {
    return fallbackPlan(task);
  }

  const parsed = parsePlanJson(raw);
  return parsed ?? fallbackPlan(task);
}

function parsePlanJson(raw: string): HierarchicalPlan | undefined {
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  const json = jsonMatch ? jsonMatch[0] : raw;
  try {
    const data = JSON.parse(json) as { milestones?: MilestoneDraft[]; steps?: StepDraft[] };
    if (!Array.isArray(data.milestones) || !Array.isArray(data.steps)) return undefined;

    const milestones: Milestone[] = data.milestones.map((m) => ({
      id: m.id,
      name: m.name,
      objective: m.objective,
      stepIds: [],
    }));

    const steps: PlanStep[] = data.steps.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.instruction,
      dependsOn: s.dependsOn,
      status: 'pending',
    }));

    for (const s of data.steps) {
      const m = milestones.find((x) => x.id === s.milestoneId);
      if (m) m.stepIds.push(s.id);
    }

    return {
      id: `plan-${Date.now()}`,
      name: 'Hierarchical Plan',
      milestones,
      steps,
    };
  } catch {
    return undefined;
  }
}

function fallbackPlan(task: string): HierarchicalPlan {
  return {
    id: `plan-${Date.now()}`,
    name: 'Fallback Plan',
    milestones: [
      { id: 'm1', name: 'Execute task', objective: task, stepIds: ['s1'] },
    ],
    steps: [
      { id: 's1', name: 'Execute task', description: task, status: 'pending' },
    ],
  };
}

/**
 * Execute a hierarchical plan using the sequential executor.
 *
 * The handler is invoked for each step. It receives the step (with its
 * instruction in `description`) and the original task context.
 */
export async function executeHierarchicalPlan(
  plan: HierarchicalPlan,
  ctx: TaskContext,
  handler: StepHandler,
): Promise<PlanResult> {
  return executeSequential(plan, ctx, handler, { stopOnError: true });
}

/**
 * Render a hierarchical plan as a markdown string for inclusion in a system
 * prompt or UI preview.
 */
export function renderPlan(plan: HierarchicalPlan): string {
  const lines: string[] = ['## Plan', ''];
  for (const m of plan.milestones) {
    lines.push(`### ${m.name}`);
    lines.push(m.objective);
    lines.push('');
    for (const stepId of m.stepIds) {
      const step = plan.steps.find((s) => s.id === stepId);
      if (step) lines.push(`- [ ] ${step.name}: ${step.description ?? ''}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

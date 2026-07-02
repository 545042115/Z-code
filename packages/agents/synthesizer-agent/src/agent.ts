// @ziner/agent-synthesizer — Result Synthesizer (P2 Multi-Agent).
//
// Aggregates multiple sub-task outputs into a single coherent answer
// for the user. Reads from `SharedState`:
//   - `plan.dag`                  — the decomposition (optional, for context)
//   - `subtasks.{id}.output`      — one entry per completed sub-task
//
// Behaviour:
//   - 0 outputs          → fail (nothing to synthesize)
//   - 1 output           → return verbatim, no LLM call (saves tokens)
//   - 2+ outputs         → one LLM call to weave them into a single response

import type { ILLMProvider, IAgent, ModelSpec, TaskContext, AgentResult, PlanDag } from '@ziner/contracts';
import { ok as okResult, fail as failResult, callWithMetrics } from '@ziner/contracts';

export interface SynthesizerAgentConfig {
  /** LLM provider used to weave outputs together. */
  llmProvider: ILLMProvider;
  /** Default model for the synthesizer. */
  model: ModelSpec;
  /** Override the default system prompt. */
  systemPrompt?: string;
}

const DEFAULT_SYSTEM_PROMPT = `You are a result-synthesis agent. The user asked a question and a team of specialised agents produced partial answers in parallel. Your job is to merge those partial answers into a single, coherent, user-facing response.

Rules:
- Preserve concrete facts, numbers, names, and code from the inputs.
- Remove redundancy — do NOT repeat the same point from multiple sub-task results.
- Resolve conflicts by stating both views and noting the disagreement briefly.
- If the original task asked for a specific format (table, list, JSON, code), honour it.
- Do not add new information that isn't supported by the inputs.
- Be concise. A long answer is worse than a focused one.`;

interface SubTaskResult {
  id: string;
  title: string;
  prompt: string;
  assignedTo: string;
  output: string;
}

/** Factory: build a Synthesizer `IAgent`. */
export function createSynthesizerAgent(config: SynthesizerAgentConfig): IAgent {
  const systemPrompt = config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;

  return {
    name: 'synthesizer',
    role: 'Result Synthesizer',
    capabilities: ['synthesize', 'aggregate', 'summarize'],
    dependencies: [],
    modelPreference: config.model,
    canHandle() {
      // Always available; the Orchestrator decides when to call us.
      return 0.3;
    },
    async execute(ctx: TaskContext): Promise<AgentResult> {
      const collected = collectSubTaskOutputs(ctx);

      if (collected.length === 0) {
        return failResult('4002', 'No sub-task outputs to synthesize');
      }

      // Fast path: a single sub-task — return it verbatim. Avoids a
      // pointless LLM call and preserves the agent's original tone.
      if (collected.length === 1) {
        return okResult(collected[0].output, {
          artifacts: { synthesized: true, sources: [collected[0].id] },
          metrics: zeroMetrics(),
        });
      }

      let callResult;
      try {
        callResult = await callWithMetrics({
          llmProvider: config.llmProvider,
          model: config.model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: buildUserPrompt(ctx.task, collected) },
          ],
          temperature: 0.3,
          maxTokens: 2048,
          signal: ctx.signal,
        });
      } catch (e) {
        return failResult('4003', `Synthesizer LLM call failed: ${(e as Error).message}`);
      }

      return okResult(callResult.content, {
        artifacts: {
          synthesized: true,
          sources: collected.map((c) => c.id),
        },
        metrics: callResult.metrics,
      });
    },
  };
}

// ── Helpers ───────────────────────────────────────────────────────────

/** Read all sub-task outputs from SharedState. Falls back to scanning
 *  any `subtasks.*.output` keys when no `plan.dag` is available (the
 *  connector can publish outputs without going through the planner). */
function collectSubTaskOutputs(ctx: TaskContext): SubTaskResult[] {
  const plan = ctx.sharedState.get<PlanDag>('plan.dag');
  const out: SubTaskResult[] = [];

  if (plan) {
    for (const st of plan.subtasks) {
      const v = ctx.sharedState.get<unknown>(`subtasks.${st.id}.output`);
      if (v == null) continue;
      out.push({
        id: st.id,
        title: st.title,
        prompt: st.prompt,
        assignedTo: st.assignedTo,
        output: stringify(v),
      });
    }
  } else {
    // No plan — sweep all `subtasks.*.output` keys.
    const snap = ctx.sharedState.snapshot();
    for (const [key, entry] of Object.entries(snap)) {
      if (!key.startsWith('subtasks.') || !key.endsWith('.output')) continue;
      const id = key.slice('subtasks.'.length, -'.output'.length);
      out.push({
        id,
        title: id,
        prompt: '',
        assignedTo: entry.writer ?? '',
        output: stringify(entry.value),
      });
    }
  }
  return out;
}

function stringify(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v == null) return '';
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}

function buildUserPrompt(task: string, parts: SubTaskResult[]): string {
  const sections = parts.map((p, i) => {
    const header = p.title && p.title !== p.id ? `${p.title} [${p.id}]` : p.id;
    const meta = p.assignedTo ? ` (executed by: ${p.assignedTo})` : '';
    return `## ${i + 1}. ${header}${meta}\n${p.output}`;
  });
  return `# Original task\n${task}\n\n# Sub-task results\n${sections.join('\n\n')}`;
}

function zeroMetrics(): AgentResult['metrics'] {
  return { tokensIn: 0, tokensOut: 0, costUsd: 0, durationMs: 0, llmCalls: 0, toolCalls: 0 };
}

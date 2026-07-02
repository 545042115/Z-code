// Orchestrator — coordinates execution of multiple IAgents.
//
// Responsibilities:
//   - Build a TaskContext (with SharedState + Budget + trace Span)
//   - Dispatch to selected agents (sequential or fan-out)
//   - Respect dependencies (topo order)
//   - Aggregate results
//   - Record an `orchestrator` Span containing child agent Spans
//   - Enforce budget + max iterations
//
// Three primary execution modes:
//   1. `sequential` — agents run one after another, in dependency order
//   2. `parallel`   — agents run concurrently, all results aggregated
//   3. `dag`        — agents run in topo order; parallel where no edge
//
// Plus one P2 multi-agent mode:
//   4. `plan`       — first runs the planner, then dispatches sub-tasks
//                     from `SharedState['plan.dag']` in waves, then
//                     runs the synthesizer when there are multiple
//                     sub-task outputs. Requires `plannerAgent` to be
//                     set and a 'synthesizer' agent in the registry
//                     (synthesizer is optional but recommended).
//
// The orchestrator does NOT itself call LLMs. It only orchestrates.

import type {
  IAgent,
  TaskContext,
  AgentResult,
  ModelRef,
  RunStatus,
  ErrorRef,
  PlanDag,
  SubTask,
} from '@ziner/contracts';
import { ok as okResult, fail as failResult } from '@ziner/contracts';
import type { RunTracker, Span } from '@ziner/trace';
import { classify } from '@ziner/infra-errors';
import { BudgetGuard, BudgetExceededError } from '@ziner/infra-cost';
import type { Checkpoint, CheckpointManager, SubTaskResult } from './checkpoint';
import { AgentRegistry, DependencyCycleError } from './agent-registry';
import { SharedState } from './shared-state';
import {
  getDelegationRequest,
  markDelegationRunning,
  completeDelegation,
  failDelegation,
} from './delegation';
import type { MemoryManager } from '../memory/memory-manager';
import { EpisodicMemory } from '../memory/episodic';
import { heuristicFactExtract } from '../memory/fact-extractor';
import { deterministicMemoryId } from '../memory/types';
import { recall as memoryRecall } from '../memory/recall';
import { MemoryContextProvider } from '../context/memory-provider';

export type OrchestratorMode = 'dag' | 'plan';

export interface OrchestratorOptions {
  tracker: RunTracker;
  registry: AgentRegistry;
  task: string;
  model: ModelRef;
  sessionId: string;
  userId?: string;
  mode?: OrchestratorMode;
  /** Maximum total agent calls across this orchestrator. Default 16. */
  maxAgentCalls?: number;
  /** Pre-existing shared state (e.g. restored from earlier Run). */
  initialState?: Record<string, unknown>;
  /** Optional override of agent names. Default: registry.list() in topo order. */
  agents?: string[];
  /** Optional per-context extras to inject into TaskContext.metadata. */
  metadata?: Record<string, string | number | boolean | null>;
  /**
   * Optional BudgetGuard. When set:
   *  - Checked before each agent dispatch (fail-fast)
   *  - Agent's `AgentMetrics.{tokensIn,tokensOut,costUsd}` is consumed after
   *  - On exceed, remaining agents are skipped with error code 3003
   */
  budgetGuard?: BudgetGuard;
  /** Optional abort signal for cancelling the run. */
  signal?: AbortSignal;
  /**
   * Name of the planner agent to invoke in `plan` mode. Must be
   * registered. The planner writes `SharedState['plan.dag']`; the
   * Orchestrator then dispatches the sub-tasks in dependency waves.
   * Required when `mode === 'plan'`.
   */
  plannerAgent?: string;
  /**
   * Name of the synthesizer agent to invoke in `plan` mode when
   * multiple sub-task outputs were produced. Defaults to 'synthesizer'.
   * Set to '' (empty) to skip synthesis and return the raw outputs.
   */
  synthesizerAgent?: string;
  /**
   * Optional callback invoked for each `plan.*` event the Orchestrator
   * emits (plan.dag, plan.subtask.started, plan.subtask.completed,
   * plan.subtask.fallback). Used by the desktop UI to render a live
   * To-do list. The `data` payload mirrors the span-event attributes.
   */
  onPlanEvent?: (event: { name: 'plan.dag' | 'plan.subtask.started' | 'plan.subtask.completed' | 'plan.subtask.fallback'; data: Record<string, unknown> }) => void;
  /**
   * Optional MemoryManager. When set:
   *  - After each run, an episodic memory is auto-recorded
   *  - User facts are heuristically extracted from the task and stored
   *    as long-term memory
   */
  memoryManager?: MemoryManager;
  /**
   * Optional loader for the session's recent messages. The Orchestrator
   * uses this to inject prior turns of the same session into every
   * dispatched agent's task — so multi-turn follow-ups
   * ("我想要1+1, 双层吉士汉堡，不要番茄酱") carry the user's earlier
   * intent ("帮我点个麦当劳") into the downstream sub-task context.
   */
  loadRecentMessages?: (sessionId: string, limit: number) => Promise<Array<{ role: 'user' | 'assistant'; content: string }>>;
  /** Max recent messages to inject. Default 10. */
  recentMessagesLimit?: number;
  /**
   * Optional list of agent names the router seeded for this task.
   * Surface it to the Planner so it knows what the lightweight
   * keyword/embedding router suggested — and can overrule it when
   * the actual sub-task (informed by recent context) clearly belongs
   * to a different agent.
   */
  routerSeed?: string[];
  /**
   * Optional CheckpointManager for automatic checkpoint-after-every-
   * sub-task persistence. When supplied, the Orchestrator snapshots
   * the plan, completed sub-task ids, per-sub-task outputs and
   * SharedState to `<rootDir>/checkpoints/<runId>.json` so a crashed
   * or user-cancelled run can be resumed via `resumeFrom`.
   */
  checkpointManager?: CheckpointManager;
  /**
   * Optional pre-loaded Checkpoint to resume from. When provided, the
   * Orchestrator rebuilds the SharedState from the snapshot and
   * skips any sub-task whose id is in `completedSubTaskIds`.
   *
   * The `runId` in the new run is freshly generated (Trace), so the
   * caller should pass `resumeFromRunId` if they want the new run to
   * inherit the original runId (used so resume rewrites the same
   * checkpoint file rather than creating a new one).
   */
  resumeFrom?: Checkpoint;
  /** When resuming, reuse the original runId for the new run. */
  resumeFromRunId?: string;
}

/** A plan sub-task as observed by the UI (after the planner produced a PlanDag). */
export interface PlanSubTaskView {
  id: string;
  title: string;
  assignedTo: string;
  dependsOn: string[];
  status: 'pending' | 'running' | 'done' | 'failed';
}

export interface OrchestratorResult {
  status: RunStatus;
  outputs: AgentResult[];
  sharedStateSnapshot: ReturnType<SharedState['snapshot']>;
  error?: ErrorRef;
}

export class Orchestrator {
  private readonly opts: Required<Omit<OrchestratorOptions, 'userId' | 'initialState' | 'metadata' | 'agents' | 'budgetGuard' | 'signal' | 'plannerAgent' | 'synthesizerAgent' | 'onPlanEvent' | 'memoryManager' | 'loadRecentMessages' | 'recentMessagesLimit' | 'routerSeed' | 'checkpointManager' | 'resumeFrom' | 'resumeFromRunId'>> & Pick<OrchestratorOptions, 'userId' | 'initialState' | 'metadata' | 'agents' | 'budgetGuard' | 'signal' | 'plannerAgent' | 'synthesizerAgent' | 'onPlanEvent' | 'memoryManager' | 'loadRecentMessages' | 'recentMessagesLimit' | 'routerSeed' | 'checkpointManager' | 'resumeFrom' | 'resumeFromRunId'>;

  constructor(opts: OrchestratorOptions) {
    this.opts = {
      mode: 'dag',
      maxAgentCalls: 16,
      ...opts,
    };
  }

  // ── Public API ──────────────────────────────────────────────────────

  /** Run the orchestration. Always returns an OrchestratorResult. */
  async run(): Promise<OrchestratorResult> {
    const root = this.opts.tracker.startSpan({
      name: `orchestrator:${this.opts.mode}`,
      type: 'agent',
      input: {
        task: this.opts.task.slice(0, 200),
        mode: this.opts.mode,
        maxAgentCalls: this.opts.maxAgentCalls,
        budgetEnforced: !!this.opts.budgetGuard,
      },
    });
    const sharedState = new SharedState({ initial: this.opts.initialState });
    const outputs: AgentResult[] = [];
    let status: RunStatus = 'success';
    let firstError: ErrorRef | undefined;
    let agentCallCount = 0;

    // P3 checkpoint resume: if the caller passed a pre-loaded Checkpoint,
    // rebuild the SharedState from the snapshot so the Planner / sub-tasks
    // see the values that were in place when the original run stopped.
    // We also pre-seed `subtaskOutputs` so the run looks as if those
    // sub-tasks had already completed.
    let resumedOutputs: AgentResult[] = [];
    if (this.opts.resumeFrom) {
      const ck = this.opts.resumeFrom;
      for (const [key, entry] of Object.entries(ck.sharedState)) {
        sharedState.set(key, entry.value, entry.writer ?? 'checkpoint');
      }
      for (const [subTaskId, sr] of Object.entries(ck.subtaskOutputs)) {
        resumedOutputs.push({
          ok: sr.ok,
          output: sr.output,
          error: sr.error,
          metrics: {
            tokensIn: 0,
            tokensOut: 0,
            costUsd: 0,
            durationMs: sr.durationMs ?? 0,
            llmCalls: 0,
            toolCalls: 0,
          },
        });
        void subTaskId; // keep eslint happy; index access is the seed
      }
      root.addEvent('orchestrator.resumed', {
        runId: ck.runId,
        completedSubTaskIds: ck.completedSubTaskIds.join(','),
        completedCount: ck.completedSubTaskIds.length,
        totalSubTasks: ck.planDag.subtasks.length,
      });
    }
    let budgetExhausted = false;
    const signal = this.opts.signal;

    // P3 checkpoint state — declared before the try/catch so the
    // catch and final-return paths can finalise the checkpoint on
    // cancel / failure / success. The plan case populates these;
    // other modes leave them empty and finalisation is a no-op.
    let ckCompletedIds: string[] = [];
    let ckOutputs: Record<string, SubTaskResult> = {};
    let ckPlanDag: PlanDag | null = null;
    let ckSnapshot: Record<string, { value: unknown; version: number; updatedAt: number; writer?: string }> = {};
    const finalizeCheckpoint = async (
      ckStatus: 'completed' | 'cancelled' | 'failed',
    ): Promise<void> => {
      if (!this.opts.checkpointManager) return;
      try {
        await this.opts.checkpointManager.save({
          runId: this.opts.resumeFromRunId ?? this.opts.tracker.id,
          task: this.opts.task,
          mode: this.opts.mode,
          sessionId: this.opts.sessionId,
          planDag: ckPlanDag ?? { task: this.opts.task, subtasks: [] },
          completedSubTaskIds: ckCompletedIds,
          subtaskOutputs: ckOutputs,
          sharedState: ckSnapshot,
          plannerAgent: this.opts.plannerAgent ?? '',
          synthesizerAgent: this.opts.synthesizerAgent ?? '',
          routerSeed: this.opts.routerSeed,
          createdAt: this.opts.resumeFrom?.createdAt ?? Date.now(),
          updatedAt: Date.now(),
          status: ckStatus,
        });
      } catch {
        // best-effort; never fail the run on a slow disk
      }
    };

    try {
      if (signal?.aborted) {
        throw new Error('run cancelled');
      }
      const order = this._resolveOrder();
      root.setAttribute('agent.count', order.length);
      root.addEvent('orchestrator.start', { count: order.length });

      // Memory recall: pull relevant long-term / episodic / preference
      // memories and publish them to sharedState so every dispatched
      // agent (including the Planner and sub-tasks) can see them in
      // their `ctx.task`. Plan mode previously bypassed the chat
      // agent's per-execute memory recall, so we centralise it here.
      if (this.opts.memoryManager) {
        try {
          const memProvider = new MemoryContextProvider(this.opts.memoryManager, { defaultLimit: 6 });
          const memCtx: TaskContext = {
            task: this.opts.task,
            model: this.opts.model,
            sessionId: this.opts.sessionId,
            userId: this.opts.userId,
            sharedState,
            parentRunId: this.opts.tracker.id,
            traceId: this.opts.tracker.traceId,
            budget: { tokensLeft: 0, costLeftUsd: 0 },
          };
          const chunks = await memProvider.fetch(memCtx, this.opts.task, 6);
          if (chunks.length > 0) {
            const memoryContext = chunks.map((c) => c.content).join('\n\n');
            sharedState.set('orchestrator.memoryContext', memoryContext, 'orchestrator');
            root.addEvent('orchestrator.memory_recall', { chunks: chunks.length });
          }
        } catch {
          // best-effort; never fail the run
        }
      }

      // Recent-message recall: load the last N turns of the same session
      // (excluding the current task) and publish them as a
      // `orchestrator.recentContext` block. Multi-turn follow-ups
      // ("我想要1+1, 双层吉士汉堡，不要番茄酱") otherwise lose the user's
      // earlier intent ("帮我点个麦当劳") when the Planner dispatches
      // sub-tasks, because sub-tasks only see the immediate task text.
      if (this.opts.loadRecentMessages) {
        try {
          const limit = this.opts.recentMessagesLimit ?? 10;
          const recent = await this.opts.loadRecentMessages(this.opts.sessionId, limit + 1);
          // The most recent message is the current task; drop it so we
          // don't duplicate the user prompt inside the context block.
          const prior = recent.slice(0, Math.max(0, recent.length - 1)).slice(-limit);
          if (prior.length > 0) {
            const recentContext = prior
              .map((m) => {
                const who = m.role === 'user' ? '用户' : '助手';
                const content = m.content.length > 600
                  ? m.content.slice(0, 600) + '…'
                  : m.content;
                return `${who}：${content}`;
              })
              .join('\n\n');
            sharedState.set('orchestrator.recentContext', recentContext, 'orchestrator');
            root.addEvent('orchestrator.recent_recall', { turns: prior.length });
          }
        } catch {
          // best-effort; never fail the run
        }
      }

      // Wrap _runOne to enforce budget; returns a fail result if exceeded.
      const wrapped = (name: string) => {
        if (budgetExhausted) {
          return Promise.resolve(failResult('3003', `budget exhausted before '${name}'`));
        }
        return this._runOne(name, sharedState, root).then((r) => {
          // Consume budget from metrics if present
          if (r.metrics && this.opts.budgetGuard) {
            try {
              this.opts.budgetGuard.consume(r.metrics.tokensIn + r.metrics.tokensOut, r.metrics.costUsd);
            } catch (e) {
              if (e instanceof BudgetExceededError) {
                budgetExhausted = true;
                const budgetErr = failResult('3003', e.message);
                root.addEvent('budget.exceeded', { code: e.code });
                return budgetErr;
              }
              throw e;
            }
          }
          return r;
        });
      };

      switch (this.opts.mode) {
        case 'dag': {
          const waves = this._toWaves(order);
          for (const wave of waves) {
            if (signal?.aborted) {
              throw new Error('run cancelled');
            }
            if (agentCallCount + wave.length > this.opts.maxAgentCalls) {
              throw new Error(`max agent calls (${this.opts.maxAgentCalls}) exceeded`);
            }
            const tasks = wave.map((name) => wrapped(name));
            const results = await Promise.all(tasks);
            agentCallCount += results.length;
            outputs.push(...results);
            const failed = results.find((r) => !r.ok);
            if (failed) {
              status = 'failed';
              firstError = failed.error;
              break;
            }
            if (budgetExhausted) break;
          }
          break;
        }
        case 'plan': {
          // P2 multi-agent: Planner → sub-tasks per plan.dag → Synthesizer.
          if (signal?.aborted) throw new Error('run cancelled');
          if (!this.opts.plannerAgent) {
            throw new Error('plan mode requires `plannerAgent` to be set');
          }
          if (!this.opts.registry.has(this.opts.plannerAgent)) {
            throw new Error(`planner agent '${this.opts.plannerAgent}' is not registered`);
          }
          root.addEvent('plan.start', { planner: this.opts.plannerAgent });

          // P3 checkpoint resume: when resuming we already have the
          // PlanDag in SharedState (it was restored at the top of run()).
          // Skip the planner call entirely; jump straight to sub-task
          // dispatch.
          if (this.opts.resumeFrom) {
            root.addEvent('plan.planner_skipped_for_resume', {});
          } else {
            // Phase 1: run the planner. It writes `plan.dag` to SharedState.
            if (agentCallCount >= this.opts.maxAgentCalls) {
              throw new Error(`max agent calls (${this.opts.maxAgentCalls}) exceeded`);
            }
            const planResult = await wrapped(this.opts.plannerAgent);
            outputs.push(planResult);
            agentCallCount++;
            if (!planResult.ok) {
              status = 'failed';
              firstError = planResult.error;
              root.addEvent('plan.planner_failed', { code: planResult.error?.code ?? 'unknown' });
              break;
            }
            if (budgetExhausted) break;
          }

          // Read the plan. If the planner didn't produce a usable one,
          // fall back to single-agent behaviour (use the planner's own
          // output as the final answer).
          const plan = sharedState.get<PlanDag>('plan.dag');
          if (!plan || !Array.isArray(plan.subtasks) || plan.subtasks.length === 0) {
            root.addEvent('plan.empty', {});
            break;
          }
          root.addEvent('plan.dag_ready', { subtasks: plan.subtasks.length });

          // P3 checkpoint: pre-seed the hoisted state from any
          // resumed checkpoint so subsequent sub-task completions
          // build on the right baseline.
          ckCompletedIds = [...(this.opts.resumeFrom?.completedSubTaskIds ?? [])];
          ckOutputs = {};
          if (this.opts.resumeFrom) {
            for (const [id, sr] of Object.entries(this.opts.resumeFrom.subtaskOutputs)) {
              ckOutputs[id] = sr;
            }
          }
          const resumedCompletedSet = new Set(ckCompletedIds);
          ckPlanDag = plan;
          const persistCheckpointInProgress = async (): Promise<void> => {
            if (!this.opts.checkpointManager) return;
            ckSnapshot = sharedState.snapshot();
            try {
              await this.opts.checkpointManager.save({
                runId: this.opts.resumeFromRunId ?? this.opts.tracker.id,
                task: this.opts.task,
                mode: this.opts.mode,
                sessionId: this.opts.sessionId,
                planDag: plan,
                completedSubTaskIds: [...ckCompletedIds],
                subtaskOutputs: { ...ckOutputs },
                sharedState: ckSnapshot,
                plannerAgent: this.opts.plannerAgent ?? '',
                synthesizerAgent: this.opts.synthesizerAgent ?? '',
                routerSeed: this.opts.routerSeed,
                createdAt: this.opts.resumeFrom?.createdAt ?? Date.now(),
                updatedAt: Date.now(),
                status: 'in_progress',
              });
            } catch {
              // best-effort; never block the run on a slow disk
            }
          };

          // Phase 2: dispatch sub-tasks in dependency waves.
          const subWaves = this._planToWaves(plan);
          const subTaskOutputs: AgentResult[] = [];
          // Emit the full plan up-front so the UI can render a To-do
          // list with all sub-tasks in "pending" state, then update
          // individual sub-tasks as they transition.
          const dagData = {
            rationale: plan.rationale,
            subtasks: plan.subtasks.map((st) => ({
              id: st.id,
              title: st.title,
              assignedTo: st.assignedTo,
              dependsOn: st.dependsOn,
              status: 'pending' as const,
            })),
          };
          // Persist a compact Span event (primitive attributes only) and
          // forward the full structured payload to the onPlanEvent
          // callback so the UI can render a structured To-do list.
          root.addEvent('plan.dag', {
            rationale: plan.rationale ?? '',
            subtaskCount: plan.subtasks.length,
            subtaskIds: plan.subtasks.map((s) => s.id).join(','),
          });
          this.opts.onPlanEvent?.({ name: 'plan.dag', data: dagData });
          for (const wave of subWaves) {
            if (signal?.aborted) throw new Error('run cancelled');
            if (agentCallCount + wave.length > this.opts.maxAgentCalls) {
              throw new Error(`max agent calls (${this.opts.maxAgentCalls}) exceeded`);
            }
            const tasks = wave.map(async (subTask) => {
              if (budgetExhausted) {
                return failResult('3003', `budget exhausted before '${subTask.id}'`);
              }

              // P3 checkpoint resume: skip sub-tasks that were already
              // completed in the original run. We replay their saved
              // output (with a `resumed: true` flag) so the UI shows
              // them as already done without an extra LLM call.
              if (resumedCompletedSet.has(subTask.id)) {
                const sr = ckOutputs[subTask.id];
                const replayed: AgentResult = sr
                  ? {
                      ok: sr.ok,
                      output: sr.output,
                      error: sr.error,
                      metrics: {
                        tokensIn: 0,
                        tokensOut: 0,
                        costUsd: 0,
                        durationMs: sr.durationMs ?? 0,
                        llmCalls: 0,
                        toolCalls: 0,
                      },
                    }
                  : okResult(undefined);
                root.addEvent('plan.subtask.completed', {
                  subTask: subTask.id,
                  agent: sr?.agent ?? 'unknown',
                  status: sr?.ok ? ('done' as const) : ('failed' as const),
                  ok: !!sr?.ok,
                  error: sr?.error?.message ?? '',
                  outputPreview: '',
                  completedAt: Date.now(),
                  resumed: true,
                });
                this.opts.onPlanEvent?.({
                  name: 'plan.subtask.completed',
                  data: {
                    subTask: subTask.id,
                    agent: sr?.agent ?? 'unknown',
                    status: sr?.ok ? 'done' : 'failed',
                    ok: !!sr?.ok,
                    error: sr?.error?.message,
                    outputPreview: '',
                    completedAt: Date.now(),
                    resumed: true,
                  },
                });
                if (sr?.ok && sr.output !== undefined) {
                  sharedState.set(
                    `subtasks.${subTask.id}.output`,
                    sr.output,
                    `subtask:${subTask.id}`,
                  );
                }
                return replayed;
              }

              // Resolve the assigned agent. Unknown names fall back to
              // the chat agent when present, else the first registered
              // agent. The fallback is recorded in the parent Span so
              // the operator can see what happened.
              const assignedName = this._resolveAssignedAgent(subTask.assignedTo);
              if (assignedName !== subTask.assignedTo) {
                const fbData = {
                  subTask: subTask.id,
                  requested: subTask.assignedTo,
                  used: assignedName,
                };
                root.addEvent('plan.subtask.fallback', fbData);
                this.opts.onPlanEvent?.({ name: 'plan.subtask.fallback', data: fbData });
              }
              // Emit a per-sub-task "started" event so the UI can flip
              // the To-do list item from pending → running.
              const startedData = {
                subTask: subTask.id,
                title: subTask.title,
                agent: assignedName,
                prompt: subTask.prompt.slice(0, 200),
                startedAt: Date.now(),
              };
              root.addEvent('plan.subtask.started', startedData);
              this.opts.onPlanEvent?.({ name: 'plan.subtask.started', data: startedData });
              const t0 = Date.now();
              const result = await this._runOneWithTask(
                assignedName,
                subTask.prompt,
                sharedState,
                root,
                subTask.id,
              );
              // Emit a per-sub-task "completed" event with status so the
              // UI can flip running → done/failed and show the output.
              const completedData = {
                subTask: subTask.id,
                agent: assignedName,
                status: result.ok ? ('done' as const) : ('failed' as const),
                ok: result.ok,
                error: result.error?.message,
                outputPreview:
                  typeof result.output === 'string'
                    ? result.output.slice(0, 300)
                    : result.output != null
                    ? JSON.stringify(result.output).slice(0, 300)
                    : undefined,
                completedAt: Date.now(),
              };
              // Persist a compact Span event (primitive attributes only)
              // and forward the full structured payload to onPlanEvent.
              root.addEvent('plan.subtask.completed', {
                subTask: completedData.subTask,
                agent: completedData.agent,
                status: completedData.status,
                ok: completedData.ok,
                error: completedData.error ?? '',
                outputPreview: completedData.outputPreview ?? '',
                completedAt: completedData.completedAt,
              });
              this.opts.onPlanEvent?.({ name: 'plan.subtask.completed', data: completedData });
              // Persist the sub-task output for the synthesizer.
              if (result.ok && result.output !== undefined) {
                sharedState.set(
                  `subtasks.${subTask.id}.output`,
                  result.output,
                  `subtask:${subTask.id}`,
                );
              }
              // P3 checkpoint: record the sub-task result and persist
              // a fresh checkpoint after every completion so a crash /
              // cancel between sub-tasks leaves the run resumable.
              if (this.opts.checkpointManager) {
                ckCompletedIds.push(subTask.id);
                ckOutputs[subTask.id] = {
                  ok: result.ok,
                  output: result.output,
                  error: result.error,
                  agent: assignedName,
                  durationMs: Date.now() - t0,
                  completedAt: Date.now(),
                };
                // Fire-and-forget; never block the run on a slow disk.
                void persistCheckpointInProgress();
              }
              return result;
            });
            const results = await Promise.all(tasks);
            agentCallCount += results.length;
            outputs.push(...results);
            subTaskOutputs.push(...results);
            // Continue on failure so the synthesizer can surface partial
            // results; only break when the budget is blown.
            if (budgetExhausted) break;
          }
          if (budgetExhausted) break;

          // Phase 3: synthesizer — only when there are ≥ 2 sub-task
          // outputs (single-output case is the fast path; the caller
          // already has the answer from the sub-task).
          const successfulOutputs = subTaskOutputs.filter((r) => r.ok);
          const synthName = this.opts.synthesizerAgent === '' ? '' : (this.opts.synthesizerAgent ?? 'synthesizer');
          if (successfulOutputs.length >= 2 && synthName && this.opts.registry.has(synthName)) {
            if (agentCallCount >= this.opts.maxAgentCalls) {
              throw new Error(`max agent calls (${this.opts.maxAgentCalls}) exceeded`);
            }
            root.addEvent('plan.synthesize', { sources: successfulOutputs.length });
            const synthResult = await wrapped(synthName);
            outputs.push(synthResult);
            agentCallCount++;
            if (!synthResult.ok) {
              // Synthesis failed — fall through with raw outputs rather
              // than fail the whole run, since the user already has the
              // data.
              root.addEvent('plan.synthesize_failed', { code: synthResult.error?.code ?? 'unknown' });
            }
          }
          break;
        }
      }
    } catch (e) {
      const cls = classify(e);
      root.fail(cls);
      // P3 checkpoint: mark the run as cancelled / failed so a
      // subsequent resume knows to skip ahead to the next pending
      // sub-task rather than re-run completed ones.
      const ckStatus: 'cancelled' | 'failed' =
        (e as Error)?.message === 'run cancelled' || signal?.aborted ? 'cancelled' : 'failed';
      await finalizeCheckpoint(ckStatus);
      const result = {
        status: 'failed' as RunStatus,
        outputs,
        sharedStateSnapshot: sharedState.snapshot(),
        error: cls,
      };
      // best-effort memory capture
      await this._captureRunMemory(result.status, outputs);
      return result;
    }

    root.setOutput({
      status,
      agentCalls: agentCallCount,
      outputs: outputs.length,
    });
    if (status === 'failed' && firstError) {
      root.setAttribute('error.code', firstError.code);
    }
    root.end();

    const finalResult = {
      status,
      outputs,
      sharedStateSnapshot: sharedState.snapshot(),
      error: firstError,
    };
    // P3 checkpoint: mark the run as completed so the resume UI can
    // distinguish "finished" from "in progress / paused".
    await finalizeCheckpoint(status === 'failed' ? 'failed' : 'completed');
    // best-effort memory capture — never fail the run
    await this._captureRunMemory(status, outputs);
    return finalResult;
  }

  // ── Internals ───────────────────────────────────────────────────────

  private _resolveOrder(): string[] {
    const names = this.opts.agents ?? this.opts.registry.list().map((a) => a.name);
    if (names.length === 0) {
      throw new Error('no agents available');
    }
    return this.opts.registry.resolveOrder(names);
  }

  /** Group agents into waves of independent agents (for 'dag' mode). */
  private _toWaves(names: string[]): string[][] {
    const byId = new Map<string, string>();
    for (const n of names) byId.set(n, n);
    return this._groupIntoWaves({
      items: names,
      getId: (n) => n,
      getDeps: (n) => this.opts.registry.get(n).dependencies.filter((d) => byId.has(d)),
      onCycle: (remaining) => { throw new DependencyCycleError([...remaining]); },
    });
  }

  /**
   * Generic wave-stratification algorithm for DAG scheduling.
   * Items are grouped into waves where each wave contains all items
   * whose dependencies have already been placed in earlier waves.
   */
  private _groupIntoWaves<T>(opts: {
    items: T[];
    getId: (item: T) => string;
    getDeps: (item: T) => string[];
    onCycle?: (remaining: Set<string>) => void;
  }): T[][] {
    const { items, getId, getDeps, onCycle } = opts;
    const byId = new Map<string, T>();
    for (const item of items) byId.set(getId(item), item);

    const waves: T[][] = [];
    const placed = new Set<string>();
    const remaining = new Set(byId.keys());

    while (remaining.size > 0) {
      const wave: T[] = [];
      for (const id of remaining) {
        const item = byId.get(id)!;
        const deps = getDeps(item);
        const ready = deps.every((d) => placed.has(d) || !byId.has(d));
        if (ready) wave.push(item);
      }
      if (wave.length === 0) {
        if (onCycle) {
          onCycle(remaining);
          // if onCycle didn't throw, treat remaining as last wave
          for (const id of remaining) wave.push(byId.get(id)!);
        } else {
          // default: treat remaining as last wave (graceful degradation)
          for (const id of remaining) wave.push(byId.get(id)!);
        }
      }
      waves.push(wave);
      for (const item of wave) {
        placed.add(getId(item));
        remaining.delete(getId(item));
      }
    }
    return waves;
  }

  private async _runOne(
    name: string,
    sharedState: SharedState,
    parentSpan: Span
  ): Promise<AgentResult> {
    const result = await this._executeAgent({
      name,
      task: this.opts.task,
      sharedState,
      parentSpan,
      spanName: `agent:${name}`,
      extraMetadata: {},
      handleVariant: true,
      handleDelegation: true,
    });
    return result;
  }

  private async _runOneWithTask(
    name: string,
    task: string,
    sharedState: SharedState,
    parentSpan: Span,
    subTaskId?: string,
  ): Promise<AgentResult> {
    return this._executeAgent({
      name,
      task,
      sharedState,
      parentSpan,
      spanName: subTaskId ? `subtask:${subTaskId}` : `agent:${name}`,
      extraMetadata: subTaskId ? { 'subtask.id': subTaskId } : {},
      handleVariant: false,
      handleDelegation: false,
      subTaskId,
    });
  }

  // ── Core agent executor (shared by _runOne and _runOneWithTask) ────

  private async _executeAgent(opts: {
    name: string;
    task: string;
    sharedState: SharedState;
    parentSpan: Span;
    spanName: string;
    extraMetadata: Record<string, string>;
    handleVariant: boolean;
    handleDelegation: boolean;
    subTaskId?: string;
  }): Promise<AgentResult> {
    const { name, task, sharedState, parentSpan, spanName, extraMetadata, handleVariant, handleDelegation, subTaskId } = opts;
    const agent = this.opts.registry.get(name);

    // Prepend centrally-recalled memory context AND recent session
    // turns to the task so the agent sees them. Plan mode used to skip
    // per-agent recall entirely.
    const memoryContext = sharedState.get<string>('orchestrator.memoryContext');
    const recentContext = sharedState.get<string>('orchestrator.recentContext');
    const contextBlocks: string[] = [];
    if (this.opts.routerSeed && this.opts.routerSeed.length > 0) {
      // Surface the router's seed so the Planner LLM knows what the
      // keyword/embedding router suggested and can explicitly overrule
      // it when the actual sub-task calls for a different agent.
      contextBlocks.push(`## Router suggestion (soft hint, not a hard cap)\nThe lightweight router suggested: ${this.opts.routerSeed.join(', ')}. You are free to pick any other agent from the available roster.`);
    }
    if (recentContext) {
      contextBlocks.push(`## 同一会话的最近对话（用于理解上下文）\n${recentContext}`);
    }
    if (memoryContext) {
      contextBlocks.push(`## Relevant context from memory\n${memoryContext}`);
    }
    const effectiveTask = contextBlocks.length > 0
      ? `${contextBlocks.join('\n\n')}\n\n${task}`
      : task;

    const ctx: TaskContext = {
      task: effectiveTask,
      model: this.opts.model,
      sessionId: this.opts.sessionId,
      userId: this.opts.userId,
      sharedState,
      parentRunId: this.opts.tracker.id,
      traceId: this.opts.tracker.traceId,
      budget: this.opts.budgetGuard
        ? this.opts.budgetGuard.snapshot()
        : { tokensLeft: 0, costLeftUsd: 0 },
      metadata: {
        ...(this.opts.metadata ?? {}),
        ...extraMetadata,
        // Preserve the ORIGINAL task (before context-injection) so
        // agents can run per-task routing / sanity checks (e.g.
        // "is this turn itself transactional?") without being misled
        // by recent-context prepended to ctx.task.
        ...(name === this.opts.plannerAgent
          ? {}
          : { 'original.task': task.slice(0, 2000) }),
        ...(memoryContext ? { 'memory.recalled': 'true' } : {}),
        ...(recentContext ? { 'session.recent_recalled': 'true' } : {}),
      },
      signal: this.opts.signal,
    };

    const span = this.opts.tracker.startSpan({
      name: spanName,
      type: 'agent',
      agent: name,
      input: { task: task.slice(0, 200) },
      parentSpanId: parentSpan.id,
    });
    if (subTaskId) span.setAttribute('subtask.id', subTaskId);

    let result: AgentResult;
    try {
      const r = await agent.execute(ctx);
      if (!r || (typeof r.ok !== 'boolean')) {
        result = failResult('3004', `agent ${name} returned invalid result`);
      } else {
        result = r;
      }
    } catch (e) {
      const cls = classify(e);
      result = failResult(cls.code, cls.message);
    }

    if (handleVariant) {
      const variantId = ctx.metadata?.['variant.id'];
      if (typeof variantId === 'string' && variantId.length > 0) {
        const tag = `variant:${variantId}`;
        try {
          await this.opts.tracker.updateMeta({ tags: [tag] });
        } catch {
          // tagging is best-effort; never fail the agent dispatch
        }
        span.setAttribute('variant.id', variantId);
      }
    }

    span.setOutput({
      ok: result.ok,
      artifactKeys: Object.keys(result.artifacts ?? {}),
      metrics: result.metrics,
    });
    if (!result.ok) {
      span.fail(result.error!);
    }
    span.end();

    // Accumulate token/cost counters from agent metrics into the Run.
    // This ensures totalCostUsd is always computed from real token usage,
    // even when agents don't go through the Instrumenter.
    if (result.metrics && (result.metrics.tokensIn > 0 || result.metrics.tokensOut > 0)) {
      try {
        await this.opts.tracker.addUsage(result.metrics.tokensIn, result.metrics.tokensOut);
      } catch {
        // best-effort; never fail the agent dispatch
      }
    }

    // If the agent wrote artifacts, mirror them into SharedState with
    // namespacing so other agents can subscribe.
    if (result.artifacts) {
      for (const [k, v] of Object.entries(result.artifacts)) {
        sharedState.set(`artifacts.${name}.${k}`, v, name);
      }
    }

    if (handleDelegation) {
      await this._dispatchDelegations(name, sharedState);
    }

    return result;
  }

  // ── Delegation dispatch ────────────────────────────────────────────

  private async _dispatchDelegations(name: string, sharedState: SharedState): Promise<void> {
    const registeredNames = new Set(this.opts.registry.list().map((a) => a.name));
    for (const targetName of registeredNames) {
      if (targetName === name) continue; // skip self
      const req = getDelegationRequest(sharedState, targetName);
      if (!req) continue;
      // Found a pending delegation request from the just-finished agent.
      // Dispatch it to the target agent synchronously.
      try {
        const targetAgent = this.opts.registry.get(targetName);
        markDelegationRunning(sharedState, targetName, this.opts.tracker.id);
        const delegateCtx: TaskContext = {
          task: req.task,
          model: this.opts.model,
          sessionId: this.opts.sessionId,
          userId: this.opts.userId,
          sharedState,
          parentRunId: this.opts.tracker.id,
          traceId: this.opts.tracker.traceId,
          budget: this.opts.budgetGuard
            ? this.opts.budgetGuard.snapshot()
            : { tokensLeft: 0, costLeftUsd: 0 },
          metadata: { ...this.opts.metadata, delegationId: req.id, delegator: name },
          signal: this.opts.signal,
        };
        const delegateResult = await targetAgent.execute(delegateCtx);
        if (delegateResult.ok) {
          const output = typeof delegateResult.output === 'string'
            ? delegateResult.output
            : JSON.stringify(delegateResult.output);
          completeDelegation(sharedState, targetName, output, targetName, delegateResult.artifacts);
        } else {
          failDelegation(sharedState, targetName, delegateResult.error?.message ?? 'Delegation failed', targetName);
        }
      } catch (e: any) {
        failDelegation(sharedState, targetName, e?.message ?? String(e), targetName);
      }
    }
  }

  /**
   * Group sub-tasks into waves respecting their `dependsOn` edges.
   * Sub-tasks whose dependencies are all already placed run together
   * in the same wave. Mirrors the algorithm used for `dag` mode but
   * operates on SubTask ids rather than agent names, and does NOT
   * require topological validation up-front (the planner should have
   * produced a valid DAG; if not, a cycle error surfaces naturally).
   */
  private _planToWaves(plan: PlanDag): SubTask[][] {
    return this._groupIntoWaves({
      items: plan.subtasks,
      getId: (st) => st.id,
      getDeps: (st) => st.dependsOn,
    });
  }

  /**
   * Resolve the agent name the planner picked for a sub-task. If the
   * name is not registered, fall back to the chat agent (commonly
   * present), else the first registered agent. The fallback is
   * recorded on the Span so the operator can spot miscalibrated
   * decompositions.
   */
  private _resolveAssignedAgent(requested: string): string {
    // Happy path: the requested agent is in the registry.
    if (this.opts.registry.has(requested)) return requested;

    // The Planner's prompt still uses the canonical name "chat" as a
    // soft alias for the general worker. The desktop connector
    // registers that worker as "coding" (via createCodingAgentFromChat
    // → asIAgent), so re-map "chat" → "coding" before the next
    // registry lookup. This keeps the prompt contract stable while
    // letting the runtime use the name that's actually wired in.
    if (requested === 'chat' && this.opts.registry.has('coding')) {
      return 'coding';
    }
    if (this.opts.registry.has('chat')) return 'chat';

    // Last resort: any *worker* agent (skip planner / synthesizer,
    // which would create an infinite dispatch loop and burn budget
    // for no progress). Sort for determinism.
    const names = this.opts.registry.list()
      .map((a) => a.name)
      .filter((n) => n !== 'planner' && n !== 'synthesizer')
      .sort();
    if (names.length > 0) return names[0];
    // Nothing at all — surface a clear error rather than
    // `registry.get(undefined)` or an infinite loop.
    throw new Error(
      `Orchestrator: no worker agent available to run sub-task assigned to '${requested}'` +
      ` (registry is empty or only contains planner/synthesizer)`,
    );
  }

  // ── Auto-memory capture ─────────────────────────────────────────────

  /**
   * Best-effort memory capture after a run completes.
   * 1. Records an episodic memory of the task and outcome
   * 2. Heuristically extracts user facts from the task and stores them
   *    as long-term memory
   * Never throws — memory is optional and should never break a run.
   */
  private async _captureRunMemory(status: RunStatus, outputs: AgentResult[]): Promise<void> {
    if (!this.opts.memoryManager) return;
    try {
      const task = this.opts.task;
      const outcome: 'success' | 'failure' | 'partial' =
        status === 'success' ? 'success'
        : outputs.some((r) => r.ok) ? 'partial'
        : 'failure';

      // 1. Episodic memory — record the task episode
      const episodic = new EpisodicMemory(this.opts.memoryManager);
      const lastOutput = outputs[outputs.length - 1];
      let outputPreview = '';
      if (lastOutput?.output != null) {
        outputPreview = typeof lastOutput.output === 'string'
          ? lastOutput.output.slice(0, 500)
          : JSON.stringify(lastOutput.output).slice(0, 500);
      }
      const errorMsg = lastOutput && !lastOutput.ok ? lastOutput.error?.message ?? '' : '';
      const story = errorMsg
        ? `Task failed with error: ${errorMsg}\nOutput preview: ${outputPreview}`
        : `Task completed successfully.\nOutput preview: ${outputPreview}`;

      await episodic.record({
        task: task.slice(0, 200),
        story,
        outcome,
        tags: ['auto', `mode:${this.opts.mode}`],
        runId: this.opts.tracker.id,
      });

      // 2. Long-term facts — heuristic extraction from the user's task
      const facts = heuristicFactExtract(task).filter((f) => f.confidence >= 0.7);
      for (const fact of facts) {
        const content = `${fact.entity ?? 'user'}: ${fact.value}`;
        // Deterministic ID based on fact type + entity + value
        // so the same fact gets updated instead of duplicated
        const factKey = `fact:${fact.factType}:${fact.entity ?? 'user'}:${fact.value.toLowerCase().trim()}`;
        const factId = deterministicMemoryId(factKey);
        await this.opts.memoryManager.remember(
          content,
          'long-term',
          'user',
          {
            id: factId,
            payload: {
              factType: fact.factType,
              entity: fact.entity ?? 'user',
              value: fact.value,
              statement: fact.statement,
              source: 'heuristic',
              tags: ['auto-extracted', `fact:${fact.factType}`],
            },
            importance: fact.confidence,
          },
        );
      }
    } catch {
      // best-effort — never fail the run
    }
  }

}

/** Convenience: a no-op agent for tests and stubbing. */
export const NoopAgent: IAgent = {
  name: 'noop',
  role: 'Noop',
  capabilities: ['test'],
  dependencies: [],
  modelPreference: { provider: 'sglang', name: 'default', temperature: 0 },
  canHandle: () => 0,
  async execute(): Promise<AgentResult> {
    return okResult(undefined);
  },
};

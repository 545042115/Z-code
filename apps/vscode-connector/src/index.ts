// @z-assistant/app-vscode-connector
//
// V2 VSCode Connector — the only file in the V2 tree that bridges
// the V1 VSCode extension (`extensions/coding-agent`) to the V2
// Assistant Runtime (`@z-assistant/runtime`).
//
// Architecture (per ADR-0007 §四):
//
//   ┌────────────────────────┐        ┌─────────────────────┐
//   │ V1 Extension           │        │ V2 Runtime          │
//   │ extension.ts           │        │ packages/runtime    │
//   │ panels / commands      │ <────> │ AssistantRuntime    │
//   │ (vscode-coupled)       │ bridge │ trace / eval / evo  │
//   └────────────────────────┘        │ (pure Node)         │
//                                     └─────────────────────┘
//
// The V1 extension does NOT import from `@z-assistant/runtime`
// directly for any side-effectful code; it goes through this
// bridge. That keeps the V1 extension teardown-safe and the V2
// runtime swappable.
//
// Phase 6A R7: this module ships the *real* AssistantRuntime.boot
// (no longer a stub) — it composes:
//   - createFileStore  (@z-assistant/infra-storage)
//   - TraceManager     (@z-assistant/trace)
//   - Orchestrator + AgentRegistry (@z-assistant/runtime)
//   - BudgetGuard      (@z-assistant/infra-cost)

import * as path from 'path';
import * as fs from 'fs/promises';

import {
  AgentRegistry,
  Orchestrator,
  registerExampleAgents,
  type OrchestratorMode,
  type OrchestratorResult,
} from '@z-assistant/runtime';
import { TraceManager } from '@z-assistant/trace';
import { createFileStore } from '@z-assistant/infra-storage';
import { BudgetGuard } from '@z-assistant/infra-cost';

import type { Store } from '@z-assistant/infra-storage';
import type { AgentResult } from '@z-assistant/contracts';

// ── Configuration shape coming from V1 ─────────────────────────────────

export interface VSCodeConnectorConfig {
  /** Where V2 stores its data; defaults to `<globalStorage>/v2` in the workspace. */
  storageDir: string;
  /** Project key for multi-root workspaces. */
  projectKey?: string;
  /** Optional model override applied to the default Coding agent. */
  defaultModel?: { provider: string; name: string };
  /** Budget policy (sane defaults applied if missing). */
  budget?: { perRunTokens?: number; perRunUsd?: number; perDayUsd?: number };
}

// ── Lifecycle event types ──────────────────────────────────────────────

export type ConnectorEvent =
  | { type: 'runStart'; runId: string; task: string }
  | { type: 'runEnd'; runId: string; status: 'ok' | 'error' | 'cancelled' }
  | { type: 'spanStart'; runId: string; spanId: string; name: string }
  | { type: 'spanEnd'; runId: string; spanId: string; status: 'ok' | 'error' }
  | { type: 'evalComplete'; evaluationId: string; pass: boolean }
  | { type: 'evolutionReport'; reportId: string; readyToApply: boolean };

export type ConnectorEventListener = (e: ConnectorEvent) => void;

// ── Public types for multi-agent run ──────────────────────────────────

export interface RunMultiAgentTaskOptions {
  task: string;
  mode: OrchestratorMode;
  model: { provider: string; name: string };
  sessionId?: string;
  /** Optional registry customizer; defaults to `registerExampleAgents`. */
  registerAgents?: (registry: AgentRegistry) => void;
  /** Per-run cap on agent calls. */
  maxAgentCalls?: number;
}

export interface RunMultiAgentTaskResult {
  runId: string;
  result: OrchestratorResult;
}

// ── The connector itself ──────────────────────────────────────────────

/**
 * V2 → V1 bridge. The V1 extension instantiates one of these
 * during `activate()` and tears it down on `deactivate()`.
 *
 * Pure Node, no vscode imports — this file is allowed to be loaded
 * in headless test environments.
 */
export class VSCodeConnector {
  private listeners = new Set<ConnectorEventListener>();
  private _runtime: AssistantRuntime | null = null;
  private _runCounter = 0;

  constructor(public readonly config: VSCodeConnectorConfig) {}

  /** Wire the V2 runtime. Idempotent. */
  async start(): Promise<void> {
    if (this._runtime) return;
    this._runtime = await AssistantRuntime.boot({
      storageDir: this.config.storageDir,
      projectKey: this.config.projectKey,
    });
  }

  /** Stop the V2 runtime. Idempotent. */
  async stop(): Promise<void> {
    if (!this._runtime) return;
    await this._runtime.shutdown();
    this._runtime = null;
  }

  /** V1 panels subscribe here for live updates. */
  onEvent(fn: ConnectorEventListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * V1 command-handler: run a multi-agent task via the V2 runtime.
   * Returns the runId + final OrchestratorResult.
   */
  async runMultiAgentTask(opts: RunMultiAgentTaskOptions): Promise<RunMultiAgentTaskResult> {
    if (!this._runtime) throw new Error('VSCodeConnector not started');
    const runtime = this._runtime;
    const sessionId = opts.sessionId ?? `ma-${Date.now()}`;

    const tracker = await runtime.trace.startRun({
      task: opts.task,
      model: opts.model,
      sessionId,
      userId: 'local',
    });

    const registry = new AgentRegistry();
    (opts.registerAgents ?? registerExampleAgents)(registry);

    const guard = new BudgetGuard({
      perRunTokens: this.config.budget?.perRunTokens ?? 1_000_000,
      perRunUsd: this.config.budget?.perRunUsd ?? 5,
      perDayUsd: this.config.budget?.perDayUsd ?? 50,
    });

    const orch = new Orchestrator({
      tracker,
      registry,
      task: opts.task,
      model: opts.model,
      sessionId,
      mode: opts.mode,
      budgetGuard: guard,
      maxAgentCalls: opts.maxAgentCalls ?? 8,
    });

    this._runCounter++;
    this.emit({ type: 'runStart', runId: tracker.id, task: opts.task });

    let status: 'ok' | 'error' | 'cancelled' = 'ok';
    try {
      const result = await orch.run();
      await tracker.flush();
      await tracker.finish();
      status = result.status === 'success' ? 'ok' : 'error';
      this.emit({ type: 'runEnd', runId: tracker.id, status });
      return { runId: tracker.id, result };
    } catch (e) {
      status = 'error';
      try {
        await tracker.flush();
        await tracker.finish();
      } catch { /* ignore secondary failures */ }
      this.emit({ type: 'runEnd', runId: tracker.id, status });
      throw e;
    }
  }

  /** V1 status-bar: cheap health check. */
  isReady(): boolean {
    return this._runtime !== null;
  }

  /**
   * Simple single-task entry point (used by `apps/cli`).
   * Runs a single-agent sequential task with minimal config.
   */
  async runTask(task: string, _projectKey?: string): Promise<{ runId: string }> {
    const result = await this.runMultiAgentTask({
      task,
      mode: 'sequential' as OrchestratorMode,
      model: { provider: 'sglang', name: 'default' },
    });
    return { runId: result.runId };
  }

  /** Expose the underlying trace manager (for V1 panels: TracePanel etc.). */
  trace(): TraceManager | null {
    return this._runtime?.trace ?? null;
  }

  /** Expose the underlying store (for V1 panels: QueryService etc.). */
  store(): Store | null {
    return this._runtime?.store ?? null;
  }

  // ── Internal helpers ─────────────────────────────────────────────────

  private emit(e: ConnectorEvent): void {
    for (const l of this.listeners) {
      try { l(e); } catch { /* swallow; V1 listeners must not crash V2 */ }
    }
  }
}

// ── AssistantRuntime façade (real implementation, R7) ─────────────────

import { RUNTIME_VERSION } from '@z-assistant/runtime';

export interface AssistantRuntimeBootOptions {
  storageDir: string;
  projectKey?: string;
}

/**
 * The runtime façade — composes Store + TraceManager and exposes them
 * to the connector. Pure Node; safe to instantiate in headless tests.
 */
export class AssistantRuntime {
  static readonly RUNTIME_VERSION = RUNTIME_VERSION;

  private constructor(
    public readonly trace: TraceManager,
    public readonly store: Store,
  ) {}

  /** Compose the runtime from disk-backed services. Idempotent per dir. */
  static async boot(opts: AssistantRuntimeBootOptions): Promise<AssistantRuntime> {
    const dataDir = opts.storageDir;
    const tracesDir = path.join(dataDir, 'traces');
    await fs.mkdir(tracesDir, { recursive: true });

    const store = await createFileStore({ rootDir: dataDir });
    const trace = new TraceManager({ store, tracesDir });
    return new AssistantRuntime(trace, store);
  }

  /** Tear down. Currently a no-op; reserved for future flush/close. */
  async shutdown(): Promise<void> {
    // Trace events are flushed per-tracker; FileStore has no global handle.
  }
}

// ── Public exports ────────────────────────────────────────────────────

export { RUNTIME_VERSION };
export type { AgentResult, Store, TraceManager, OrchestratorMode, OrchestratorResult };

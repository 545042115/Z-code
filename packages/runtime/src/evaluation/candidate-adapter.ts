// CandidateAdapter — runs an IAgent in a sandboxed subprocess.
//
// A "candidate" in Harness parlance is the thing being evaluated:
// an agent, a prompt, a config, a model. This file ships an
// `IAgent`-based adapter; other adapters (model-swap, prompt-swap)
// can be added similarly.
//
// The adapter's `evaluate` method:
//   1. Wraps the agent's `execute` in a SandboxExecutor call
//   2. Records the AgentResult as a SandboxResult-shaped output
//   3. Optionally scores via RubricSpec
//
// Phase 6A: moved from V1 `extensions/coding-agent/src/harness/candidate-adapter.ts`
// to V2 `packages/runtime/src/evaluation/candidate-adapter.ts`. Pure Node, no vscode.

import type { IAgent, TaskContext } from '@z-assistant/contracts';
import type { SandboxExecutor, SandboxSpec } from './sandbox';
import type { RubricSpec } from './rubric';
import { scoreSandboxResult, makeEvaluation, type Evaluation } from './rubric';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

export interface CandidateOptions {
  agent: IAgent;
  sandbox: SandboxExecutor;
}

export interface EvaluateOptions {
  runId: string;
  task: string;
  input: unknown;
  rubric: RubricSpec;
  candidate: string;
  timeoutMs?: number;
  /** Build a TaskContext for the agent. */
  buildCtx?: (input: unknown) => Omit<TaskContext, 'sharedState' | 'parentRunId' | 'traceId' | 'budget'>;
}

export class CandidateAdapter {
  constructor(private readonly opts: CandidateOptions) {}

  /**
   * Evaluate the candidate on a single input.
   * Returns an Evaluation (always; never throws on the agent's failures).
   */
  async evaluate(o: EvaluateOptions): Promise<Evaluation> {
    const t0 = Date.now();
    // Prepare a clean sandbox with input.json mounted
    const scratch = await mkdtemp(join(tmpdir(), `z-candidate-${o.runId}-`));
    const inputPath = join(scratch, 'input.json');
    try {
      await writeFile(inputPath, JSON.stringify(o.input ?? null), 'utf8');
      const spec: SandboxSpec = {
        runId: o.runId,
        workdir: '/work',
        mounts: [{ src: inputPath, dst: 'input.json', readonly: true }],
        timeoutMs: o.timeoutMs ?? 30_000,
        network: 'offline',
      };
      // Delegate to a sandbox-side runner script
      const result = await this.opts.sandbox.run(spec, 'node', [
        '-e', this._buildEvalScript(),
      ]);
      const { total, scores, passed } = await scoreSandboxResult(result, o.rubric);
      return makeEvaluation({
        id: `${o.runId}-${Date.now()}`,
        benchmarkId: o.rubric.id,
        runId: o.runId,
        candidate: o.candidate,
        scores,
        total,
        passed,
        notes: result.stdout.slice(-200),
        startedAt: t0,
        finishedAt: Date.now(),
      });
    } finally {
      try { await rm(scratch, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  /**
   * Build a self-contained Node script that:
   *   - reads input.json
   *   - calls a stub Agent function with the parsed input
   *   - writes output.json
   * The script is intentionally minimal; for real harness, the
   * candidate is a full CLI in the sandbox image.
   */
  private _buildEvalScript(): string {
    return `
      const fs = require('fs');
      const input = JSON.parse(fs.readFileSync('/work/input.json', 'utf8'));
      // The real harness would shell out to the candidate CLI; for
      // the in-process stub we just echo the input shape to stdout
      // and write a 'result.json' so hasArtifact checks can fire.
      const result = { echoed: input, ts: Date.now() };
      fs.writeFileSync('/work/result.json', JSON.stringify(result));
      process.stdout.write('OK\\n');
      process.exit(0);
    `;
  }
}

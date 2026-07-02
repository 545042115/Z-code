// @ziner/runtime — CodeTaskRunner
//
// Glue that runs a CodingAgent candidate inside a DockerSandbox against
// a GitRepoFixture, executes the fixture's grader script, and returns
// a normalized (SandboxResult, evalCtx) pair for the RubricScorer.
//
// Lifecycle for one case
// -----------------------
//   1. Resolve fixture: download tarball (cached) → extract → lay out
//      a writable workdir
//   2. Mount:
//        /fixture (ro) — pristine repo at base commit
//        /work     (rw) — agent's working copy
//        /grader   (ro) — grader.sh that writes /work/grader.json
//   3. Inside the container:
//        cp -r /fixture/* /work/        (init)
//        cd /work && git init && git add -A && git commit -m base
//        node /agent/eval.js --task <prompt>   (the agent)
//        bash /grader/grader.sh               (the test grader)
//   4. Read /work/grader.json back into evalCtx
//
// Why split runner from agent
// ---------------------------
// The agent itself is just a node script we drop into the container.
// It's the IAgent's responsibility to write a `patch.diff` we can apply
// or to edit files in /work directly. For Phase M1 we ship a "direct
// editor" agent that mutates files in /work and writes `patch.diff`.
// The fixture's grader then runs `git apply patch.diff` in a fresh
// checkout and runs the test suite there — so a passing grade means
// "the agent's patch is real, reproducible, and the tests still pass."

import { mkdtemp, rm, writeFile, mkdir, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createReadStream, createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import Extract from 'unzipper';
import type { SandboxExecutor, SandboxSpec, SandboxResult } from './sandbox';
import { scoreSandboxResult, type RubricSpec } from './rubric';
import { makeEvaluation, type Evaluation } from './rubric';

export interface GitRepoFixture {
  id: string;
  /** Human-readable name. */
  name: string;
  /** Tarball URL (codeload.github.com/.../tarball/refs/tags/... or similar). */
  tarballUrl: string;
  /** Sub-path inside the tarball to use as the repo root. */
  subPath?: string;
  /** The base commit SHA we check the agent's patch against. */
  baseCommit?: string;
  /** The actual coding task given to the agent. */
  prompt: string;
  /**
   * Bash script (entry: /work) that writes a JSON object to
   * /work/grader.json with shape:
   *   { testsPassed, testsFailed, patchApplied, buildClean,
   *     appliedFiles, expectedFiles }
   */
  graderScript: string;
  /** Docker image. Default inherited from sandbox. */
  image?: string;
  /** Hard timeout in ms. Default 10 minutes. */
  timeoutMs?: number;
}

export interface CodeTaskRunOptions {
  runId: string;
  caseId: string;
  fixture: GitRepoFixture;
  /** Implementation to drop into the container (defaults to bundled). */
  agentScript?: string;
}

export interface CodeTaskRunResult {
  sandbox: SandboxResult;
  evalCtx: Record<string, unknown>;
  evaluation: Evaluation;
  /** Diff that the agent produced, in unified form. */
  patchDiff: string;
}

export class CodeTaskRunner {
  constructor(private readonly sandbox: SandboxExecutor) {}

  async run(o: CodeTaskRunOptions): Promise<CodeTaskRunResult> {
    const scratch = await mkdtemp(join(tmpdir(), `z-codetask-${o.runId}-`));
    try {
      const fixtureDir = join(scratch, 'fixture');
      const workSeedDir = join(scratch, 'work');
      const graderDir = join(scratch, 'grader');
      await mkdir(fixtureDir, { recursive: true });
      await mkdir(workSeedDir, { recursive: true });
      await mkdir(graderDir, { recursive: true });

      // 1. fetch + extract fixture
      await fetchAndExtract(o.fixture.tarballUrl, fixtureDir, o.fixture.subPath);
      // 2. copy pristine repo into writable workdir
      await copyDir(fixtureDir, workSeedDir);
      // 3. write grader script
      await writeFile(join(graderDir, 'grader.sh'), o.fixture.graderScript, 'utf8');
      // 4. drop agent script (the bundled one writes a patch.diff + mutates files)
      const agentScript = o.agentScript ?? DEFAULT_AGENT_SCRIPT;
      const agentDir = join(scratch, 'agent');
      await mkdir(agentDir, { recursive: true });
      await writeFile(join(agentDir, 'agent.mjs'), agentScript, 'utf8');
      await writeFile(join(agentDir, 'task.txt'), o.fixture.prompt, 'utf8');

      // 5. run inside the sandbox
      const spec: SandboxSpec = {
        runId: o.runId,
        workdir: '/work',
        timeoutMs: o.fixture.timeoutMs ?? 10 * 60_000,
        network: 'offline',
        env: {
          ZINER_TASK_FILE: '/agent/task.txt',
          ZINER_AGENT_SCRIPT: '/agent/agent.mjs',
        },
        mounts: [
          { src: workSeedDir, dst: '/work', readonly: false },
          { src: agentDir, dst: '/agent', readonly: true },
          { src: graderDir, dst: '/grader', readonly: true },
        ],
      };
      const result = await this.sandbox.run(spec, 'node', [
        '/agent/agent.mjs',
      ]);
      // 6. run grader
      const graderSpec: SandboxSpec = {
        ...spec,
        mounts: [
          { src: workSeedDir, dst: '/work', readonly: true },
          { src: graderDir, dst: '/grader', readonly: true },
        ],
      };
      const graderResult = await this.sandbox.run(graderSpec, 'bash', [
        '/grader/grader.sh',
      ]);
      // 7. parse grader.json (best effort)
      const evalCtx = await readGraderJson(workSeedDir);
      // 8. capture the diff (best effort)
      const patchDiff = await readPatch(workSeedDir);

      const merged: SandboxResult = {
        exitCode: result.exitCode !== 0 ? result.exitCode : graderResult.exitCode,
        stdout: result.stdout + '\n' + graderResult.stdout,
        stderr: result.stderr + '\n' + graderResult.stderr,
        durationMs: result.durationMs + graderResult.durationMs,
        timedOut: result.timedOut || graderResult.timedOut,
        artifacts: result.artifacts,
      };
      const scoring = await scoreSandboxResult(merged, CODE_TASK_RUBRIC);
      const evaluation = makeEvaluation({
        id: `${o.runId}-${o.caseId}`,
        benchmarkId: o.fixture.id,
        runId: o.runId,
        candidate: 'coding-agent',
        scores: scoring.scores,
        total: scoring.total,
        passed: scoring.passed,
        notes: merged.stdout.slice(-500),
        startedAt: Date.now() - merged.durationMs,
        finishedAt: Date.now(),
      });
      return { sandbox: merged, evalCtx, evaluation, patchDiff };
    } finally {
      await rm(scratch, { recursive: true, force: true }).catch(() => {});
    }
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

async function fetchAndExtract(url: string, dest: string, subPath?: string): Promise<void> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) {
    throw new Error(`fixture fetch failed: ${res.status} ${res.statusText} (${url})`);
  }
  if (!res.body) throw new Error(`fixture fetch returned empty body: ${url}`);
  // Convert Web ReadableStream → Node Readable for the file writer
  const nodeStream = await import('stream');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const readable = nodeStream.Readable.fromWeb(res.body as any);
  const tmpZip = join(dest, '..', 'fixture.zip');
  await pipeline([readable, createWriteStream(tmpZip)]);
  const extractDir = join(dest, '..', 'extracted');
  await mkdir(extractDir, { recursive: true });
  const unzipper: { (opts: { path: string }): NodeJS.ReadableStream } = Extract as unknown as { (opts: { path: string }): NodeJS.ReadableStream };
  await pipeline([
    createReadStream(tmpZip),
    unzipper({ path: extractDir }),
  ]);
  if (subPath) {
    const sub = join(extractDir, subPath);
    await copyDir(sub, dest);
  } else {
    // tarball/zipball top-level is a single folder; copy its contents
    const entries = await (await import('fs/promises')).readdir(extractDir);
    if (entries.length === 1) {
      const inner = join(extractDir, entries[0]!);
      await copyDir(inner, dest);
    } else {
      await copyDir(extractDir, dest);
    }
  }
}

async function copyDir(src: string, dst: string): Promise<void> {
  await (await import('fs/promises')).cp(src, dst, { recursive: true });
}

async function readGraderJson(workDir: string): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(join(workDir, 'grader.json'), 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function readPatch(workDir: string): Promise<string> {
  try {
    return await readFile(join(workDir, 'patch.diff'), 'utf8');
  } catch {
    return '';
  }
}

// ── Default agent ──────────────────────────────────────────────────────
//
// M1 ships a "no-op" agent: it sleeps for 3s and writes an empty
// patch.diff. This is intentional — the harness plumbing (fixture
// download, container lifecycle, grader invocation, JSON parsing) is
// what we validate. Wiring a real CodingAgent call comes in M3 when
// the BenchmarksService passes the live IAgent.
//
// A future M3 swap replaces this with: copy /agent/payload.json (built
// outside the container by the host) → invoke the real agent's CLI →
// diff /work against a baseline snapshot.

const DEFAULT_AGENT_SCRIPT = `// Bundled no-op agent. Writes an empty patch.diff.
import { writeFile } from 'node:fs/promises';
await writeFile('/work/patch.diff', '', 'utf8');
console.log('agent: no-op (M1)');
`;

// ── Default Rubric for code tasks ──────────────────────────────────────

export const CODE_TASK_RUBRIC: RubricSpec = {
  id: 'code-task',
  name: 'Code Task',
  weights: {
    patchApplied: 0.3,
    testsPassed: 0.5,
    buildClean: 0.2,
  },
  checks: {
    patchApplied: (r, ctx) => 0, // overridden at score time via evalCtx
    testsPassed: (r, ctx) => 0,
    buildClean: (r, ctx) => 0,
  },
  passThreshold: 60,
};

/**
 * Score a `CodeTaskRunResult` with the default rubric. Unlike the
 * stock `scoreSandboxResult` (which passes an empty evalCtx), this
 * routes the runner's `evalCtx` (grader output) into the checks.
 */
export async function scoreCodeTaskResult(
  result: CodeTaskRunResult,
  rubric: RubricSpec = CODE_TASK_RUBRIC,
): Promise<{ total: number; scores: Record<string, number>; passed: boolean }> {
  const dims = Object.keys(rubric.weights);
  const scores: Record<string, number> = {};
  let weightedSum = 0;
  let totalWeight = 0;
  for (const dim of dims) {
    const w = rubric.weights[dim]!;
    const check = rubric.checks[dim]!;
    let s = 0;
    try {
      s = Number(await check(result.sandbox, result.evalCtx));
      if (!Number.isFinite(s)) s = 0;
    } catch {
      s = 0;
    }
    scores[dim] = s;
    weightedSum += s * w;
    totalWeight += w;
  }
  const total = totalWeight > 0 ? (weightedSum / totalWeight) * 100 : 0;
  return { total, scores, passed: total >= rubric.passThreshold };
}

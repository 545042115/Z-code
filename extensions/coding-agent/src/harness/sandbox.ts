// Sandbox — isolated execution environment for Harness.
//
// V2_VISION §"Harness" requires that candidate agents run in a
// sandboxed environment where:
//   - The working directory is a clean copy
//   - Network is restricted (no outbound, except allow-listed hosts)
//   - Filesystem writes are limited to a writable overlay
//   - Process is killed after a timeout
//
// ADR-0005 requires Docker as the production sandbox; for tests and
// development we ship a `LocalSandbox` that runs in-process with
// the same semantics. Both implement `SandboxExecutor`.

import type { Rubric } from '../contracts';

/** Where the candidate agent's process can read/write. */
export interface SandboxMount {
  src: string;        // absolute host path
  dst: string;        // path inside the sandbox (relative to /)
  readonly?: boolean;
}

export interface SandboxSpec {
  /** Unique run identifier; used in the sandbox path. */
  runId: string;
  /** Working directory inside the sandbox. */
  workdir: string;
  /** Mount points (file/dir copies into the sandbox). */
  mounts?: SandboxMount[];
  /** Hard wall-clock timeout in ms. */
  timeoutMs?: number;
  /** Memory cap in MB. */
  memoryMb?: number;
  /** Network mode: 'offline' | 'allowlist'. Default 'offline'. */
  network?: 'offline' | 'allowlist';
  /** Allow-listed hosts when network='allowlist'. */
  networkAllowlist?: string[];
  /** Env vars; secrets go through the loader, NOT this field. */
  env?: Record<string, string>;
}

export interface SandboxResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** True if killed by timeout. */
  timedOut: boolean;
  /** Files written to the workdir (relative paths). */
  artifacts: string[];
}

/** Pluggable sandbox implementations. */
export interface SandboxExecutor {
  readonly name: string;
  /**
   * Run `cmd` in a fresh sandbox per spec, return the result.
   * MUST clean up the sandbox (rm -rf) after the run.
   */
  run(spec: SandboxSpec, cmd: string, args?: string[]): Promise<SandboxResult>;
}

// ── LocalSandbox ──────────────────────────────────────────────────────

/**
 * In-process sandbox for development & testing.
 * - Copies mount sources into a temp dir
 * - Spawns the command with `cwd` = temp dir
 * - Enforces a wall-clock timeout (kills the process)
 * - Cleans up on exit
 *
 * This is NOT production-grade isolation. For production, use a
 * Docker-backed implementation (see ADR-0005). The contract is
 * the same so swapping is trivial.
 */
export class LocalSandbox implements SandboxExecutor {
  readonly name = 'local';

  async run(spec: SandboxSpec, cmd: string, args: string[] = []): Promise<SandboxResult> {
    const { mkdtemp, cp, rm, readdir, stat } = await import('fs/promises');
    const { tmpdir } = await import('os');
    const { join, resolve } = await import('path');
    const { spawn } = await import('child_process');

    const timeoutMs = spec.timeoutMs ?? 60_000;
    const root = await mkdtemp(join(tmpdir(), `z-sandbox-${spec.runId}-`));
    const workdir = join(root, spec.workdir);
    await (await import('fs/promises')).mkdir(workdir, { recursive: true });

    // Mount points
    for (const m of spec.mounts ?? []) {
      const target = join(root, m.dst);
      try {
        const s = await stat(m.src);
        if (s.isDirectory()) {
          await cp(m.src, target, { recursive: true } as never);
        } else {
          await (await import('fs/promises')).mkdir(resolve(target, '..'), { recursive: true });
          await cp(m.src, target);
        }
      } catch (e) {
        // mount source missing — record and continue
        // eslint-disable-next-line no-console
        console.warn(`[LocalSandbox] mount src missing: ${m.src}`);
      }
    }

    // Build env
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...(spec.env ?? {}),
    };
    if (spec.network === 'offline') {
      env['HTTP_PROXY'] = 'http://127.0.0.1:0';
      env['HTTPS_PROXY'] = 'http://127.0.0.1:0';
      env['NO_PROXY'] = '*';
    }

    // Spawn
    const t0 = Date.now();
    const child = spawn(cmd, args, {
      cwd: workdir,
      env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const killTimer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }, timeoutMs);

    child.stdout?.on('data', (b: Buffer) => { stdout += b.toString('utf8'); });
    child.stderr?.on('data', (b: Buffer) => { stderr += b.toString('utf8'); });

    let exitCode = -1;
    const exited = new Promise<void>((resolve) => {
      child.on('exit', (code) => { exitCode = code ?? -1; resolve(); });
    });
    await exited;
    clearTimeout(killTimer);

    // Collect artifact file names
    const artifacts: string[] = [];
    try {
      const stack = [''];
      while (stack.length) {
        const p = stack.pop()!;
        const abs = join(workdir, p);
        const entries = await readdir(abs, { withFileTypes: true });
        for (const e of entries) {
          const rel = p ? `${p}/${e.name}` : e.name;
          if (e.isDirectory()) stack.push(rel);
          else artifacts.push(rel);
        }
      }
    } catch { /* ignore */ }

    // Cleanup
    try { await rm(root, { recursive: true, force: true }); } catch { /* ignore */ }

    return {
      exitCode,
      stdout,
      stderr,
      durationMs: Date.now() - t0,
      timedOut,
      artifacts,
    };
  }
}

// ── StubSandbox (for tests) ───────────────────────────────────────────

/**
 * Configurable stub for unit tests. Returns a pre-set SandboxResult.
 */
export class StubSandbox implements SandboxExecutor {
  readonly name = 'stub';
  private _next: SandboxResult;
  /** Optional: capture the last invocation for assertions. */
  public lastSpec?: SandboxSpec;
  public lastCmd?: string;
  public lastArgs?: string[];

  constructor(result: SandboxResult) {
    this._next = result;
  }

  setNext(r: SandboxResult): void { this._next = r; }

  async run(spec: SandboxSpec, cmd: string, args: string[] = []): Promise<SandboxResult> {
    this.lastSpec = spec;
    this.lastCmd = cmd;
    this.lastArgs = args;
    return { ...this._next };
  }
}

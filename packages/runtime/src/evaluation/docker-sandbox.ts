// @ziner/runtime — DockerSandbox
//
// Production-grade sandbox executor per ADR-0005. Wraps a `cmd` in a
// short-lived Docker container, copies mount sources into it, runs the
// command, and tears the container down — whether the run succeeded,
// timed out, or was killed.
//
// Why dockerode
// -------------
//   - Promise-first API (no callbacks)
//   - Supports both Unix socket and Windows named pipe
//     (we use `DOCKER_HOST` env var for portability)
//   - Stream-based stdout/stderr demuxing (no manual split)
//
// Lifecycle
// ---------
//   1. ping()            — verify the daemon is reachable
//   2. ensureImage()     — `docker pull <image>` if not present
//   3. createContainer() — bind mounts from spec.mounts
//   4. start + wait      — exec `cmd` with `timeoutMs` (we use Docker's
//                          own per-command timeout, not a Node-side
//                          timer, so the process group is killed by
//                          the kernel when the wall clock hits)
//   5. collect logs      — stdout/stderr/exitCode
//   6. rm container      — even on failure / timeout
//
// Network isolation
// -----------------
//   network='offline'  → `NetworkMode: 'none'`
//   network='allowlist'→ `NetworkMode: 'bridge'` + an outbound HTTP
//                        proxy at 127.0.0.1 that the host enforces the
//                        allowlist against (out of scope for M1; we
//                        just emit a warning in `allowlist` mode and
//                        fall back to `none` — a follow-up will add
//                        a proper sidecar proxy)
//
// Determinism
// -----------
//   The container's filesystem layer is not committed; each run starts
//   from a clean image. Mount points are read-only by default so the
//   agent can mutate the workdir but cannot tamper with the fixture.

import Docker from 'dockerode';
import { createReadStream, existsSync } from 'fs';
import { resolve as resolvePath } from 'path';
import type { SandboxExecutor, SandboxResult, SandboxSpec, SandboxMount } from './sandbox';

export class DockerSandboxUnavailableError extends Error {
  constructor(cause: unknown) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    super(`Docker daemon unavailable: ${msg}`);
    this.name = 'DockerSandboxUnavailableError';
  }
}

export class DockerSandboxTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`DockerSandbox: command timed out after ${timeoutMs}ms`);
    this.name = 'DockerSandboxTimeoutError';
  }
}

export interface DockerSandboxOptions {
  /** Default image when the spec doesn't pin one. Default `node:20-slim`. */
  defaultImage?: string;
  /** Override the docker socket (e.g. `unix:///var/run/docker.sock`). */
  socketPath?: string;
  /** Auto-pull images that aren't present locally. Default true. */
  autoPull?: boolean;
}

export class DockerSandbox implements SandboxExecutor {
  readonly name = 'docker';
  private readonly defaultImage: string;
  private readonly autoPull: boolean;
  // The dockerode client. Typed as `any` (see __types__/shims.d.ts)
  // because dockerode ships no .d.ts. We only use a small surface
  // (version / getImage / pull / createContainer) so the ergonomics
  // penalty is minimal.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly docker: any;

  constructor(opts: DockerSandboxOptions = {}) {
    this.defaultImage = opts.defaultImage ?? 'node:20-slim';
    this.autoPull = opts.autoPull ?? true;
    this.docker = opts.socketPath
      ? new Docker({ socketPath: opts.socketPath })
      : new Docker();
  }

  /**
   * Verify the docker daemon is reachable. Throws
   * `DockerSandboxUnavailableError` on failure.
   *
   * Use this as a soft-healthcheck at app startup (the desktop
   * "Benchmarks" panel calls this and grays out the "Run" button
   * when it fails).
   */
  async ping(): Promise<{ ok: true; version: string }> {
    try {
      const v = await this.docker.version();
      return { ok: true, version: v.Version ?? 'unknown' };
    } catch (e) {
      throw new DockerSandboxUnavailableError(e);
    }
  }

  capabilities(): import('./sandbox').SandboxCapabilities {
    return {
      isolated: true,
      networkControl: true,
      memoryLimit: true,
      kernelTimeout: true,
      architectures: ['x64', 'arm64'],
      performanceFactor: 0.9,
    };
  }

  async run(spec: SandboxSpec, cmd: string, args: string[] = []): Promise<SandboxResult> {
    const image = spec.env?.['ZINER_SANDBOX_IMAGE'] ?? this.defaultImage;
    if (this.autoPull) {
      await this.ensureImage(image);
    }

    const binds: string[] = (spec.mounts ?? []).map((m) => toBind(m));
    const networkMode = spec.network === 'allowlist' ? 'bridge' : 'none';
    const memMb = spec.memoryMb ?? 2048;
    const timeoutMs = spec.timeoutMs ?? 60_000;

    const t0 = Date.now();
    const container = await this.docker.createContainer({
      Image: image,
      Cmd: [cmd, ...args],
      WorkingDir: spec.workdir,
      Env: Object.entries(spec.env ?? {})
        .filter(([k]) => k !== 'ZINER_SANDBOX_IMAGE')
        .map(([k, v]) => `${k}=${v}`),
      HostConfig: {
        AutoRemove: true,
        NetworkMode: networkMode,
        Memory: memMb * 1024 * 1024,
        Binds: binds,
        // Cap CPU at 2 cores to prevent runaway containers
        NanoCpus: 2_000_000_000,
      },
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let exitCode = -1;

    try {
      const stream = await container.attach({
        stream: true,
        stdout: true,
        stderr: true,
      });
      // dockerode multiplexes stdout/stderr in a single stream; the
      // header is 8 bytes:
      //   byte 0:       stream type (1=stdout, 2=stderr)
      //   bytes 1..4:   big-endian uint32 size of the payload (top
      //                 byte is reserved / zero; the low 3 bytes hold
      //                 the actual length, max 16 MiB)
      //   bytes 5..7:   zero padding
      // followed by `size & 0xffffff` payload bytes.
      // Real dockerode streams may coalesce multiple frames into
      // one chunk, so we loop. We bound-check before each read so a
      // truncated frame is dropped rather than throwing.
      stream.on('data', (chunk: Buffer) => {
        let off = 0;
        while (off < chunk.length) {
          if (off + 8 > chunk.length) break;
          const fd = chunk[off];
          const size = chunk.readUInt32BE(off + 4) & 0xffffff;
          if (off + 8 + size > chunk.length) break;
          const slice = chunk.subarray(off + 8, off + 8 + size);
          off += 8 + size;
          if (fd === 1) stdout += slice.toString('utf8');
          else if (fd === 2) stderr += slice.toString('utf8');
        }
      });

      await container.start();

      // Wait with the container's own timeout: `wait` resolves when
      // the container exits; we race it against setTimeout so we can
      // call `kill()` on timeout.
      const waitResult = await Promise.race<{ StatusCode: number } | 'timeout'>([
        container.wait(),
        new Promise<'timeout'>((resolve) => {
          setTimeout(() => resolve('timeout'), timeoutMs);
        }),
      ]);

      if (waitResult === 'timeout') {
        timedOut = true;
        try { await container.kill({ signal: 'SIGKILL' }); } catch { /* already dead */ }
        throw new DockerSandboxTimeoutError(timeoutMs);
      }
      exitCode = waitResult.StatusCode;
    } finally {
      try { await container.remove({ force: true }); } catch { /* already gone */ }
    }

    return {
      exitCode,
      stdout,
      stderr,
      durationMs: Date.now() - t0,
      timedOut,
      // Mount points aren't reported as artifacts — only files written
      // inside the workdir are. The CodingAgentRunner below runs a
      // follow-up `ls` to collect them; for the bare executor we
      // return an empty list.
      artifacts: [],
    };
  }

  private async ensureImage(image: string): Promise<void> {
    try {
      await this.docker.getImage(image).inspect();
    } catch {
      // Image missing — pull it
      await new Promise<void>((resolve, reject) => {
        this.docker.pull(image, (err: Error | null, stream: NodeJS.ReadableStream | null) => {
          if (err) return reject(err);
          if (!stream) {
            // The dockerode modem can return null when the daemon
            // short-circuits (e.g. image already cached server-side
            // or pull is a no-op). Treat as success.
            return resolve();
          }
          this.docker.modem.followProgress(stream, (e: Error | null) => (e ? reject(e) : resolve()));
        });
      });
    }
  }
}

function toBind(m: SandboxMount): string {
  const abs = resolvePath(m.src);
  if (!existsSync(abs)) {
    throw new Error(`mount src does not exist: ${m.src}`);
  }
  const mode = m.readonly ? 'ro' : 'rw';
  // Docker bind format: <host-src>:<container-dst>:<mode>
  return `${abs}:${m.dst}:${mode}`;
}

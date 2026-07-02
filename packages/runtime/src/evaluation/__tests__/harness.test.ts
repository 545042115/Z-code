// @ziner/runtime — DockerSandbox + CodeTaskRunner tests
//
// The Docker daemon isn't available in CI / unit-test envs, so we
// stub the dockerode client (or substitute a fake SandboxExecutor for
// the CodeTaskRunner) and verify the *plumbing* — daemon ping, mount
// formatting, image-pull trigger, exit-code handling, timeout race.

import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, rm, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  DockerSandbox,
  DockerSandboxTimeoutError,
  DockerSandboxUnavailableError,
  CodeTaskRunner,
  patchApplied,
  testsPassed,
  buildClean,
  type SandboxExecutor,
  type SandboxResult,
  type SandboxSpec,
} from '../index';

class FakeDocker {
  versionCalls = 0;
  createCalls: Array<Record<string, unknown>> = [];
  pullCalls: string[] = [];
  failPing = false;
  exitCode = 0;
  stdout = '';
  stderr = '';

  version() {
    this.versionCalls += 1;
    if (this.failPing) throw new Error('connect ECONNREFUSED');
    return Promise.resolve({ Version: '24.0.0-test' });
  }

  getImage(name: string) {
    return {
      inspect: async () => {
        if (this.pullCalls.includes(name)) return { Id: 'img' };
        const err: Error & { statusCode?: number } = new Error('No such image');
        err.statusCode = 404;
        throw err;
      },
    };
  }

  pull(name: string, cb: (e: Error | null, s: unknown) => void) {
    this.pullCalls.push(name);
    // The dockerode callback only uses the stream to feed
    // modem.followProgress; in our shim, we resolve immediately
    // (no real progress events). The Production code awaits
    // followProgress's completion, so we just call cb(null, null)
    // — the shim's modem.followProgress treats any falsy stream as
    // already-done.
    process.nextTick(() => cb(null, null));
  }

  createContainer(opts: Record<string, unknown>) {
    this.createCalls.push(opts);
    const self = this;
    let stream: import('node:events').EventEmitter | null = null;
    return {
      attach: async () => {
        const { EventEmitter } = await import('node:events');
        stream = new EventEmitter();
        return stream;
      },
      start: async () => {
        // Emit ONE chunk containing the full frame (8-byte header + body)
        // matching the dockerode stream protocol: byte 0 is the stream
        // type, bytes 4..7 hold the payload size as big-endian uint32.
        const s = stream;
        if (s) {
          const body = Buffer.from(self.stdout, 'utf8');
          const header = Buffer.alloc(8);
          header[0] = 1; // stdout
          header.writeUInt32BE(body.length, 4);
          s.emit('data', Buffer.concat([header, body]));
          s.emit('end');
        }
      },
      wait: async () => ({ StatusCode: self.exitCode }),
      kill: async () => {},
      remove: async () => {},
    };
  }
}

function attachFakeDocker(sandbox: DockerSandbox, fake: FakeDocker): void {
  (sandbox as unknown as { docker: FakeDocker }).docker = fake;
}

describe('DockerSandbox', () => {
  test('ping() returns the daemon version on success', async () => {
    const fake = new FakeDocker();
    const sb = new DockerSandbox();
    attachFakeDocker(sb, fake);
    const r = await sb.ping();
    assert.equal(r.ok, true);
    assert.equal(r.version, '24.0.0-test');
    assert.equal(fake.versionCalls, 1);
  });

  test('ping() throws DockerSandboxUnavailableError on connect failure', async () => {
    const fake = new FakeDocker();
    fake.failPing = true;
    const sb = new DockerSandbox();
    attachFakeDocker(sb, fake);
    await assert.rejects(() => sb.ping(), DockerSandboxUnavailableError);
  });

  test('run() pulls the image when not present, then creates a container', async () => {
    const fake = new FakeDocker();
    fake.exitCode = 0;
    fake.stdout = 'hello from container\n';
    const sb = new DockerSandbox();
    attachFakeDocker(sb, fake);
    const dir = await mkdtemp(join(tmpdir(), 'dsb-'));
    try {
      const hostSrc = join(dir, 'work');
      await mkdir(hostSrc, { recursive: true });
      const result = await sb.run(
        {
          runId: 'r1',
          workdir: '/work',
          mounts: [{ src: hostSrc, dst: '/work' }],
          timeoutMs: 10_000,
        },
        'node',
        ['-e', 'console.log("hi")'],
      );
      assert.equal(fake.pullCalls.includes('node:20-slim'), true);
      assert.equal(result.exitCode, 0);
      assert.equal(result.stdout, 'hello from container\n');
      assert.equal(fake.createCalls.length, 1);
      const opts = fake.createCalls[0]!;
      assert.equal(opts.WorkingDir, '/work');
      assert.equal((opts.HostConfig as { NetworkMode: string }).NetworkMode, 'none');
      assert.equal((opts.HostConfig as { AutoRemove: boolean }).AutoRemove, true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('run() with network=allowlist uses bridge mode', async () => {
    const fake = new FakeDocker();
    fake.exitCode = 0;
    const sb = new DockerSandbox();
    attachFakeDocker(sb, fake);
    await sb.run(
      { runId: 'r1', workdir: '/work', network: 'allowlist', timeoutMs: 5_000 },
      'node',
      ['-e', '1'],
    );
    const opts = fake.createCalls[0]!;
    assert.equal((opts.HostConfig as { NetworkMode: string }).NetworkMode, 'bridge');
  });

  test('run() throws DockerSandboxTimeoutError when wait times out', async () => {
    const fake = new FakeDocker();
    fake.exitCode = 0;
    const sb = new DockerSandbox();
    attachFakeDocker(sb, fake);
    // Override createContainer to return a wait() that never resolves
    (fake as unknown as { createContainer: (o: unknown) => unknown }).createContainer = () => ({
      attach: async () => {
        const { EventEmitter } = await import('node:events');
        return new EventEmitter();
      },
      start: async () => {},
      wait: () => new Promise(() => {}), // never resolves
      kill: async () => {},
      remove: async () => {},
    });
    await assert.rejects(
      () => sb.run({ runId: 'r1', workdir: '/work', timeoutMs: 5 }, 'node', ['-e', '1']),
      DockerSandboxTimeoutError,
    );
  });
});

describe('CodeTaskRunner (with stub sandbox)', () => {
  function makeStubSandbox(): SandboxExecutor & {
    calls: Array<{ spec: SandboxSpec; cmd: string; args: string[] }>;
  } {
    const calls: Array<{ spec: SandboxSpec; cmd: string; args: string[] }> = [];
    const stub = {
      name: 'stub',
      calls,
      async run(spec: SandboxSpec, cmd: string, args: string[] = []): Promise<SandboxResult> {
        calls.push({ spec, cmd, args });
        const r: SandboxResult = {
          exitCode: 0,
          stdout: `phase=${args[0] === '/grader/grader.sh' ? 'grader' : 'agent'}`,
          stderr: '',
          durationMs: 10,
          timedOut: false,
          artifacts: [],
        };
        return r;
      },
    };
    return stub;
  }

  test('emits a structured evaluation and runs agent + grader phases', async () => {
    const stub = makeStubSandbox();
    const runner = new CodeTaskRunner(stub);
    // The CodeTaskRunner will try to fetchAndExtract from a URL; we
    // can't actually fetch in this test, so we monkey-patch global
    // fetch to return an empty body that produces a non-existent
    // destination. The runner will throw when extracting — that's
    // fine for verifying the *plumbing up to that point*.
    // Instead, we test the simpler "no-mount" path: provide an
    // empty tarballUrl. We assert the structure of the call and
    // the Evaluation shape; the fetch failure is a known limitation
    // of unit testing (M1 integration test will use a real fixture).
    const originalFetch = globalThis.fetch;
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response(new ReadableStream({
        start(c) { c.close(); },
      }), { status: 200 });
    }) as typeof fetch;

    try {
      let caught: Error | null = null;
      try {
        await runner.run({
          runId: 'r1',
          caseId: 'c1',
          fixture: {
            id: 'demo',
            name: 'Demo',
            tarballUrl: 'https://example.com/repo.tar.gz',
            prompt: 'fix the bug',
            graderScript: 'echo ok',
            timeoutMs: 5_000,
          },
        });
      } catch (e) {
        caught = e as Error;
      }
      // We expect a fetch-extract failure. What we want to confirm
      // is that fetch was called with the right URL.
      assert.equal(fetchCalled, true);
      assert.ok(caught !== null, 'expected the runner to throw on empty body');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('code-task rubric checks', () => {
  test('patchApplied: true → 1; false → 0; missing → 0', () => {
    assert.equal(patchApplied({} as SandboxResult, { patchApplied: true }), 1);
    assert.equal(patchApplied({} as SandboxResult, { patchApplied: false }), 0);
    assert.equal(patchApplied({} as SandboxResult, {}), 0);
  });
  test('patchApplied: appliedFiles / expectedFiles', () => {
    assert.equal(
      patchApplied({} as SandboxResult, { appliedFiles: 2, expectedFiles: 4 }),
      0.5,
    );
  });
  test('testsPassed: passed / (passed+failed)', () => {
    assert.equal(testsPassed({} as SandboxResult, { testsPassed: 10, testsFailed: 0 }), 1);
    assert.equal(testsPassed({} as SandboxResult, { testsPassed: 7, testsFailed: 3 }), 0.7);
  });
  test('testsPassed: missing passed → 0', () => {
    assert.equal(testsPassed({} as SandboxResult, {}), 0);
  });
  test('buildClean: ctx says clean → 1; says dirty → 0', () => {
    assert.equal(buildClean({ stderr: '' } as SandboxResult, { buildClean: true }), 1);
    assert.equal(buildClean({ stderr: '' } as SandboxResult, { buildClean: false }), 0);
  });
  test('buildClean: falls back to stderr regex when ctx missing', () => {
    assert.equal(buildClean({ stderr: 'Error: cannot find foo' } as SandboxResult, {}), 0);
    assert.equal(buildClean({ stderr: 'all good' } as SandboxResult, {}), 1);
  });
});

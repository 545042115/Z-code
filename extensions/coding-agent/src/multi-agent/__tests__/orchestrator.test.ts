// End-to-end multi-agent tests: register example agents, run orchestrator,
// verify SharedState propagation, Span emission, error handling.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { TraceManager } from '../../trace';
import { createFileStore } from '../../infra/storage';
import { AgentRegistry } from '../agent-registry';
import { Orchestrator, NoopAgent } from '../orchestrator';
import { ResearcherAgent, CoderAgent, ReviewerAgent, registerExampleAgents } from '../example-agents';
import type { IAgent, TaskContext, AgentResult } from '../../contracts';
import { ok, fail } from '../../contracts';

const model = { provider: 'sglang', name: 'default' };

async function withTracker<T>(fn: (m: TraceManager) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'z-ma-e2e-'));
  try {
    const store = await createFileStore({ rootDir: root });
    const m = new TraceManager({ store, tracesDir: join(root, 'traces') });
    return await fn(m);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('e2e: researcher → coder → reviewer share state via SharedState', async () => {
  await withTracker(async (m) => {
    const reg = new AgentRegistry();
    registerExampleAgents(reg);
    const t = await m.startRun({ task: '研究并实现', model, sessionId: 's1' });
    const o = new Orchestrator({
      tracker: t, registry: reg, task: '研究并实现', model, sessionId: 's1', mode: 'sequential',
    });
    const out = await o.run();
    await t.flush();
    await t.finish();
    assert.strictEqual(out.status, 'success');
    assert.strictEqual(out.outputs.length, 3);
    // Each agent produced a SharedState key
    assert.ok(out.sharedStateSnapshot['research.findings'], 'research.findings missing');
    assert.ok(out.sharedStateSnapshot['code.patch'], 'code.patch missing');
    assert.ok(out.sharedStateSnapshot['review.report'], 'review.report missing');
  });
});

test('e2e: each agent gets its own Span with parent=orchestrator', async () => {
  await withTracker(async (m) => {
    const reg = new AgentRegistry();
    registerExampleAgents(reg);
    const t = await m.startRun({ task: 'test', model, sessionId: 's1' });
    const o = new Orchestrator({ tracker: t, registry: reg, task: 'test', model, sessionId: 's1' });
    await o.run();
    await t.flush();
    await t.finish();
    const mgr = m as unknown as { opts: { store: import('../../infra/storage').Store } };
    const spans = await mgr.opts.store.spans.listByRun(t.id);
    const orchSpan = spans.find((s) => s.name === 'orchestrator:sequential');
    const agentSpans = spans.filter((s) => s.name.startsWith('agent:'));
    assert.ok(orchSpan);
    assert.strictEqual(agentSpans.length, 3);
    for (const s of agentSpans) {
      assert.strictEqual(s.parentSpanId, orchSpan!.id);
    }
  });
});

test('e2e: parallel mode runs all agents concurrently', async () => {
  await withTracker(async (m) => {
    const reg = new AgentRegistry();
    // Use NoopAgent variants to avoid the coder/reviewer requiring
    // research findings (test is about parallelism, not the pipeline).
    for (const n of ['a', 'b', 'c']) {
      reg.register({ ...NoopAgent, name: n, dependencies: [] });
    }
    const t = await m.startRun({ task: 'test', model, sessionId: 's1' });
    const o = new Orchestrator({ tracker: t, registry: reg, task: 'test', model, sessionId: 's1', mode: 'parallel' });
    const out = await o.run();
    await t.finish();
    assert.strictEqual(out.status, 'success');
    assert.strictEqual(out.outputs.length, 3);
  });
});

test('e2e: dag mode respects dependencies and parallelizes when safe', async () => {
  await withTracker(async (m) => {
    const reg = new AgentRegistry();
    registerExampleAgents(reg);
    const t = await m.startRun({ task: 'test', model, sessionId: 's1' });
    const o = new Orchestrator({ tracker: t, registry: reg, task: 'test', model, sessionId: 's1', mode: 'dag' });
    const out = await o.run();
    await t.finish();
    assert.strictEqual(out.status, 'success');
    // researcher first, then coder + reviewer must wait
    assert.ok(out.sharedStateSnapshot['research.findings']);
    assert.ok(out.sharedStateSnapshot['code.patch']);
    assert.ok(out.sharedStateSnapshot['review.report']);
  });
});

test('e2e: agent that throws returns a fail result, not a crash', async () => {
  await withTracker(async (m) => {
    const reg = new AgentRegistry();
    const broken: IAgent = {
      name: 'broken',
      role: 'Broken',
      capabilities: [], dependencies: [],
      execute: async (): Promise<AgentResult> => { throw new Error('boom'); },
    };
    reg.register(broken);
    const t = await m.startRun({ task: 'test', model, sessionId: 's1' });
    const o = new Orchestrator({ tracker: t, registry: reg, task: 'test', model, sessionId: 's1' });
    const out = await o.run();
    await t.finish();
    assert.strictEqual(out.status, 'failed');
    assert.strictEqual(out.outputs[0].ok, false);
    assert.strictEqual(out.outputs[0].error?.code.length, 4);
  });
});

test('e2e: fail-fast in sequential mode stops after first failure', async () => {
  await withTracker(async (m) => {
    const reg = new AgentRegistry();
    const exec1: IAgent = {
      name: 'a', role: 'A', capabilities: [], dependencies: [],
      execute: async (): Promise<AgentResult> => fail('9999', 'nope'),
    };
    const exec2: IAgent = {
      name: 'b', role: 'B', capabilities: [], dependencies: [],
      execute: async (ctx: TaskContext): Promise<AgentResult> => { ctx.sharedState.set('touched', true); return ok(undefined); },
    };
    reg.register(exec1);
    reg.register(exec2);
    const t = await m.startRun({ task: 'test', model, sessionId: 's1' });
    const o = new Orchestrator({ tracker: t, registry: reg, task: 'test', model, sessionId: 's1' });
    const out = await o.run();
    await t.finish();
    assert.strictEqual(out.status, 'failed');
    assert.strictEqual(out.outputs.length, 1, 'b should not have run');
    assert.strictEqual(out.sharedStateSnapshot.touched, undefined);
  });
});

test('e2e: invalid agent result is coerced to fail(3004)', async () => {
  await withTracker(async (m) => {
    const reg = new AgentRegistry();
    const garbage: IAgent = {
      name: 'garbage', role: 'G', capabilities: [], dependencies: [],
      // returns null - shape mismatch
      execute: async () => null as unknown as AgentResult,
    };
    reg.register(garbage);
    const t = await m.startRun({ task: 'test', model, sessionId: 's1' });
    const o = new Orchestrator({ tracker: t, registry: reg, task: 'test', model, sessionId: 's1' });
    const out = await o.run();
    await t.finish();
    assert.strictEqual(out.outputs[0].error?.code, '3004');
  });
});

test('e2e: maxAgentCalls is enforced', async () => {
  await withTracker(async (m) => {
    const reg = new AgentRegistry();
    reg.register(NoopAgent);
    reg.register({ ...NoopAgent, name: 'n2' });
    reg.register({ ...NoopAgent, name: 'n3' });
    const t = await m.startRun({ task: 'test', model, sessionId: 's1' });
    const o = new Orchestrator({ tracker: t, registry: reg, task: 'test', model, sessionId: 's1', maxAgentCalls: 2 });
    const out = await o.run();
    await t.finish();
    // Should run 2, then fail on the third
    assert.strictEqual(out.status, 'failed');
  });
});

test('e2e: artifact keys are namespaced with agent name', async () => {
  await withTracker(async (m) => {
    const reg = new AgentRegistry();
    reg.register({
      name: 'a', role: 'A', capabilities: [], dependencies: [],
      execute: async (ctx) => {
        ctx.sharedState.set('plain', 1);
        return ok({ report: { ok: true } }, { artifacts: { report: { ok: true } } });
      },
    });
    const t = await m.startRun({ task: 'test', model, sessionId: 's1' });
    const o = new Orchestrator({ tracker: t, registry: reg, task: 'test', model, sessionId: 's1' });
    const out = await o.run();
    await t.finish();
    assert.strictEqual(out.sharedStateSnapshot['plain'].value, 1);                   // agent's own write
    assert.ok((out.sharedStateSnapshot['artifacts.a.report'] as { value: { ok: boolean } }).value.ok);  // mirrored artifact
  });
});

test('e2e: NoopAgent runs without dependencies and produces a success result', async () => {
  await withTracker(async (m) => {
    const reg = new AgentRegistry();
    reg.register(NoopAgent);
    const t = await m.startRun({ task: 'noop', model, sessionId: 's1' });
    const o = new Orchestrator({ tracker: t, registry: reg, task: 'noop', model, sessionId: 's1' });
    const out = await o.run();
    await t.finish();
    assert.strictEqual(out.status, 'success');
  });
});

test('e2e: agent setting ctx.metadata["variant.id"] tags the Run', async () => {
  await withTracker(async (m) => {
    const reg = new AgentRegistry();
    const taggingAgent: IAgent = {
      name: 't', role: 'T', capabilities: [], dependencies: [],
      execute: async (ctx) => {
        if (!ctx.metadata) ctx.metadata = {};
        ctx.metadata['variant.id'] = 'v-abc';
        return ok({ tagged: true });
      },
    };
    reg.register(taggingAgent);
    const t = await m.startRun({ task: 'test', model, sessionId: 's1' });
    const o = new Orchestrator({ tracker: t, registry: reg, task: 'test', model, sessionId: 's1' });
    await o.run();
    await t.flush();
    await t.finish();
    // The Run should now have a `variant:v-abc` tag.
    const run = t.run;
    assert.ok(run.tags.includes('variant:v-abc'), `expected variant tag, got: ${JSON.stringify(run.tags)}`);
    // Span should also carry the variant attribute.
    const mgr = m as unknown as { opts: { store: import('../../infra/storage').Store } };
    const spans = await mgr.opts.store.spans.listByRun(t.id);
    const agentSpan = spans.find((s) => s.name === 'agent:t');
    assert.strictEqual(agentSpan?.attributes?.['variant.id'], 'v-abc');
  });
});

test('e2e: non-string variant.id in metadata is ignored, no tag added', async () => {
  await withTracker(async (m) => {
    const reg = new AgentRegistry();
    // The agent's metadata assignment is fine, but if updateMeta throws
    // we should still complete. Simulate by using an agent that writes
    // an *array* (not a string) for variant.id; the orchestrator only
    // acts on string values, so this should be a no-op.
    const agent: IAgent = {
      name: 't', role: 'T', capabilities: [], dependencies: [],
      execute: async (ctx) => {
        if (!ctx.metadata) ctx.metadata = {};
        // intentionally wrong type
        (ctx.metadata as Record<string, unknown>)['variant.id'] = ['not', 'a', 'string'];
        return ok({});
      },
    };
    reg.register(agent);
    const t = await m.startRun({ task: 'test', model, sessionId: 's1' });
    const o = new Orchestrator({ tracker: t, registry: reg, task: 'test', model, sessionId: 's1' });
    const out = await o.run();
    await t.finish();
    assert.strictEqual(out.status, 'success');
    assert.strictEqual(out.outputs[0].ok, true);
    // No variant tag should have been added.
    assert.ok(!t.run.tags.some((x) => x.startsWith('variant:')));
  });
});

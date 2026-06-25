// End-to-end tests for the Orchestrator's `plan` mode (P2 multi-agent).
//
// `plan` mode runs three phases:
//   1. Planner    — writes a `PlanDag` (subtasks + deps) to SharedState
//   2. Sub-tasks  — dispatched in dependency waves; each writes
//                   `subtasks.{id}.output` to SharedState
//   3. Synthesizer — reads `subtasks.*.output` and returns a final answer
//
// These tests use in-process mock IAgents to keep the runtime package
// self-contained. The real `@z-assistant/agent-planner` and
// `@z-assistant/agent-synthesizer` are exercised by their own unit tests
// and by the connector integration test.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { TraceManager } from '@z-assistant/trace';
import { createFileStore } from '@z-assistant/infra-storage';
import { AgentRegistry } from '../agent-registry';
import { Orchestrator } from '../orchestrator';
import type {
  IAgent,
  TaskContext,
  AgentResult,
  PlanDag,
  SubTask,
} from '@z-assistant/contracts';
import { ok as okResult } from '@z-assistant/contracts';

const model = { provider: 'fake', name: 'fake' };

async function withTracker<T>(fn: (m: TraceManager) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'z-plan-e2e-'));
  try {
    const store = await createFileStore({ rootDir: root });
    const m = new TraceManager({ store, tracesDir: join(root, 'traces') });
    return await fn(m);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Build a mock Planner that writes a fixed plan into SharedState. */
function makePlanner(subtasks: SubTask[], rationale = 'mock'): IAgent {
  return {
    name: 'planner',
    role: 'Mock Planner',
    capabilities: ['plan'],
    dependencies: [],
    execute: async (ctx: TaskContext): Promise<AgentResult> => {
      const plan: PlanDag = { task: ctx.task, subtasks, rationale };
      ctx.sharedState.set('plan.dag', plan, 'planner');
      return okResult(plan, { artifacts: { 'plan.dag': plan } });
    },
  };
}

/** Build a mock sub-task agent that echoes the prompt and writes a known output. */
function makeSubTaskAgent(name: string, output: string): IAgent {
  return {
    name,
    role: `Mock ${name}`,
    capabilities: [],
    dependencies: [],
    execute: async (ctx: TaskContext): Promise<AgentResult> => {
      // Sub-task agents should write their own output so the synthesizer
      // can read it. The orchestrator ALSO mirrors `result.output` to
      // `subtasks.{id}.output`; both paths are exercised here.
      const id = ctx.metadata?.['subtask.id'];
      if (typeof id === 'string') {
        ctx.sharedState.set(`subtasks.${id}.output`, `from-${name}: ${output}`, name);
      }
      return okResult(output);
    },
  };
}

/** Build a mock Synthesizer that concatenates all sub-task outputs. */
function makeSynthesizer(name = 'synthesizer'): IAgent {
  return {
    name,
    role: 'Mock Synthesizer',
    capabilities: ['synthesize'],
    dependencies: [],
    execute: async (ctx: TaskContext): Promise<AgentResult> => {
      const snap = ctx.sharedState.snapshot();
      const parts: string[] = [];
      for (const [key, entry] of Object.entries(snap)) {
        if (key.startsWith('subtasks.') && key.endsWith('.output')) {
          parts.push(String(entry.value));
        }
      }
      const merged = parts.join(' | ');
      return okResult(merged, {
        artifacts: { synthesized: true, sources: parts.length },
      });
    },
  };
}

test('plan mode: runs planner → 2 sub-tasks → synthesizer end-to-end', async () => {
  await withTracker(async (m) => {
    const reg = new AgentRegistry();
    reg.register(makePlanner([
      { id: 'a', title: 'A', prompt: 'subtask A', assignedTo: 'worker-a', dependsOn: [] },
      { id: 'b', title: 'B', prompt: 'subtask B', assignedTo: 'worker-b', dependsOn: [] },
    ]));
    reg.register(makeSubTaskAgent('worker-a', 'result-A'));
    reg.register(makeSubTaskAgent('worker-b', 'result-B'));
    reg.register(makeSynthesizer());

    const t = await m.startRun({ task: 'parent task', model, sessionId: 's1' });
    const o = new Orchestrator({
      tracker: t,
      registry: reg,
      task: 'parent task',
      model,
      sessionId: 's1',
      mode: 'plan',
      plannerAgent: 'planner',
      synthesizerAgent: 'synthesizer',
    });
    const out = await o.run();
    await t.flush();
    await t.finish();

    // ── Status ────────────────────────────────────────────────────
    assert.strictEqual(out.status, 'success', `expected success, got: ${out.error?.message}`);

    // ── Plan mode emits: planner + 2 sub-tasks + synthesizer = 4 outputs
    assert.strictEqual(out.outputs.length, 4, `expected 4 outputs, got ${out.outputs.length}`);

    // ── Every output is ok
    for (const r of out.outputs) {
      assert.strictEqual(r.ok, true, `agent failed: ${r.error?.message ?? r.error?.code}`);
    }

    // ── SharedState has the plan + per-sub-task outputs
    const plan = out.sharedStateSnapshot['plan.dag'] as { value: PlanDag } | undefined;
    assert.ok(plan, 'plan.dag missing from SharedState');
    assert.strictEqual(plan.value.subtasks.length, 2);
    assert.ok(out.sharedStateSnapshot['subtasks.a.output'], 'subtasks.a.output missing');
    assert.ok(out.sharedStateSnapshot['subtasks.b.output'], 'subtasks.b.output missing');

    // ── Final answer is the synthesizer's merged text
    const last = out.outputs[out.outputs.length - 1];
    assert.strictEqual(
      typeof last.output,
      'string',
      'synthesizer must return a string output',
    );
    assert.ok(
      (last.output as string).includes('result-A') && (last.output as string).includes('result-B'),
      `synthesizer output should include both sub-task results, got: ${last.output}`,
    );
  });
});

test('plan mode: respects sub-task dependencies (B waits for A)', async () => {
  await withTracker(async (m) => {
    const reg = new AgentRegistry();
    const callOrder: string[] = [];
    reg.register(makePlanner([
      { id: 'first', title: 'First', prompt: 'first', assignedTo: 'worker-a', dependsOn: [] },
      { id: 'second', title: 'Second', prompt: 'second', assignedTo: 'worker-b', dependsOn: ['first'] },
    ]));
    reg.register({
      name: 'worker-a',
      role: 'A',
      capabilities: [],
      dependencies: [],
      execute: async (ctx) => {
        callOrder.push('a');
        const id = ctx.metadata?.['subtask.id'];
        ctx.sharedState.set(`subtasks.${id}.output`, 'A', 'worker-a');
        return okResult('A');
      },
    });
    reg.register({
      name: 'worker-b',
      role: 'B',
      capabilities: [],
      dependencies: [],
      execute: async (ctx) => {
        callOrder.push('b');
        const id = ctx.metadata?.['subtask.id'];
        ctx.sharedState.set(`subtasks.${id}.output`, 'B', 'worker-b');
        return okResult('B');
      },
    });
    reg.register(makeSynthesizer());

    const t = await m.startRun({ task: 'dep test', model, sessionId: 's2' });
    const o = new Orchestrator({
      tracker: t,
      registry: reg,
      task: 'dep test',
      model,
      sessionId: 's2',
      mode: 'plan',
      plannerAgent: 'planner',
      synthesizerAgent: 'synthesizer',
    });
    const out = await o.run();
    await t.finish();

    assert.strictEqual(out.status, 'success');
    assert.deepStrictEqual(callOrder, ['a', 'b'], 'B must run after A');
  });
});

test('plan mode: falls back to chat when sub-task assignedTo is unknown', async () => {
  await withTracker(async (m) => {
    const reg = new AgentRegistry();
    let chatInvoked = false;
    reg.register(makePlanner([
      { id: 'x', title: 'X', prompt: 'do x', assignedTo: 'nonexistent-agent', dependsOn: [] },
    ]));
    reg.register({
      name: 'chat',
      role: 'Chat',
      capabilities: [],
      dependencies: [],
      execute: async (ctx) => {
        chatInvoked = true;
        const id = ctx.metadata?.['subtask.id'];
        ctx.sharedState.set(`subtasks.${id}.output`, 'chat-did-it', 'chat');
        return okResult('chat-did-it');
      },
    });
    // No synthesizer registered → 1 sub-task, fast path is skipped
    // (synthesizer only runs when ≥ 2 successful outputs).

    const t = await m.startRun({ task: 'fallback', model, sessionId: 's3' });
    const o = new Orchestrator({
      tracker: t,
      registry: reg,
      task: 'fallback',
      model,
      sessionId: 's3',
      mode: 'plan',
      plannerAgent: 'planner',
    });
    const out = await o.run();
    await t.finish();

    assert.strictEqual(out.status, 'success');
    assert.strictEqual(chatInvoked, true, 'chat agent should have been invoked as fallback');
    assert.ok(out.sharedStateSnapshot['subtasks.x.output'], 'subtask output should be persisted');
  });
});

test('plan mode: re-maps chat → coding when only coding is registered', async () => {
  // Regression test for the desktop connector's wiring: the chat
  // agent is registered as "coding" (via createCodingAgentFromChat
  // → asIAgent), but the Planner's prompt still uses the canonical
  // name "chat". The orchestrator must translate one to the other
  // so that the sub-task lands on a real agent instead of throwing
  // AgentNotFoundError.
  await withTracker(async (m) => {
    const reg = new AgentRegistry();
    let codingInvoked = false;
    reg.register(makePlanner([
      { id: 'a', title: 'A', prompt: 'do a', assignedTo: 'chat', dependsOn: [] },
    ]));
    reg.register({
      name: 'coding',
      role: 'Coding',
      capabilities: [],
      dependencies: [],
      execute: async (ctx) => {
        codingInvoked = true;
        const id = ctx.metadata?.['subtask.id'];
        ctx.sharedState.set(`subtasks.${id}.output`, 'coding-did-it', 'coding');
        return okResult('coding-did-it');
      },
    });

    const t = await m.startRun({ task: 'chat-to-coding', model, sessionId: 's-chat' });
    const o = new Orchestrator({
      tracker: t,
      registry: reg,
      task: 'chat-to-coding',
      model,
      sessionId: 's-chat',
      mode: 'plan',
      plannerAgent: 'planner',
    });
    const out = await o.run();
    await t.finish();

    assert.strictEqual(out.status, 'success');
    assert.strictEqual(codingInvoked, true,
      'orchestrator should remap "chat" to "coding" when only coding is registered');
  });
});

test('plan mode: fallback excludes planner and synthesizer', async () => {
  // A sub-task assigned to an unknown agent should never be re-routed
  // to "planner" or "synthesizer" (which would create a dispatch
  // loop and waste budget). It should land on the first real worker
  // instead.
  await withTracker(async (m) => {
    const reg = new AgentRegistry();
    let workerInvoked = false;
    reg.register(makePlanner([
      { id: 'a', title: 'A', prompt: 'do a', assignedTo: 'ghost', dependsOn: [] },
    ]));
    reg.register({
      name: 'worker',
      role: 'Worker',
      capabilities: [],
      dependencies: [],
      execute: async (ctx) => {
        workerInvoked = true;
        const id = ctx.metadata?.['subtask.id'];
        ctx.sharedState.set(`subtasks.${id}.output`, 'worker-did-it', 'worker');
        return okResult('worker-did-it');
      },
    });
    reg.register(makeSynthesizer());

    const t = await m.startRun({ task: 'no-planner-fallback', model, sessionId: 's-pf' });
    const o = new Orchestrator({
      tracker: t,
      registry: reg,
      task: 'no-planner-fallback',
      model,
      sessionId: 's-pf',
      mode: 'plan',
      plannerAgent: 'planner',
      synthesizerAgent: 'synthesizer',
    });
    const out = await o.run();
    await t.finish();

    assert.strictEqual(out.status, 'success');
    assert.strictEqual(workerInvoked, true,
      'fallback should land on a real worker, not on planner/synthesizer');
  });
});

test('plan mode: continues on sub-task failure (does not abort the run)', async () => {
  await withTracker(async (m) => {
    const reg = new AgentRegistry();
    reg.register(makePlanner([
      { id: 'ok1', title: 'OK 1', prompt: 'ok1', assignedTo: 'w1', dependsOn: [] },
      { id: 'bad', title: 'Bad', prompt: 'bad', assignedTo: 'w2', dependsOn: [] },
      { id: 'ok2', title: 'OK 2', prompt: 'ok2', assignedTo: 'w3', dependsOn: [] },
    ]));
    reg.register({
      name: 'w1', role: 'W1', capabilities: [], dependencies: [],
      execute: async (ctx) => {
        const id = ctx.metadata?.['subtask.id'];
        ctx.sharedState.set(`subtasks.${id}.output`, 'good-1', 'w1');
        return okResult('good-1');
      },
    });
    reg.register({
      name: 'w2', role: 'W2', capabilities: [], dependencies: [],
      execute: async () => ({ ok: false, error: { code: '9999', message: 'intentional' }, output: undefined }),
    });
    reg.register({
      name: 'w3', role: 'W3', capabilities: [], dependencies: [],
      execute: async (ctx) => {
        const id = ctx.metadata?.['subtask.id'];
        ctx.sharedState.set(`subtasks.${id}.output`, 'good-2', 'w3');
        return okResult('good-2');
      },
    });
    reg.register(makeSynthesizer());

    const t = await m.startRun({ task: 'partial', model, sessionId: 's4' });
    const o = new Orchestrator({
      tracker: t,
      registry: reg,
      task: 'partial',
      model,
      sessionId: 's4',
      mode: 'plan',
      plannerAgent: 'planner',
      synthesizerAgent: 'synthesizer',
    });
    const out = await o.run();
    await t.finish();

    // Planner ok + 2 sub-tasks ok + 1 sub-task failed + synthesizer ran = 5
    assert.strictEqual(out.outputs.length, 5);
    // Two sub-tasks wrote outputs; synthesizer should still merge them
    assert.ok(out.sharedStateSnapshot['subtasks.ok1.output']);
    assert.ok(out.sharedStateSnapshot['subtasks.ok2.output']);
    assert.strictEqual(out.sharedStateSnapshot['subtasks.bad.output'], undefined);
    // Status stays success because planner didn't fail
    assert.strictEqual(out.status, 'success');
  });
});

test('plan mode: throws when plannerAgent is not set', async () => {
  await withTracker(async (m) => {
    const reg = new AgentRegistry();
    reg.register(makeSynthesizer());
    const t = await m.startRun({ task: 'no-planner', model, sessionId: 's5' });
    const o = new Orchestrator({
      tracker: t,
      registry: reg,
      task: 'no-planner',
      model,
      sessionId: 's5',
      mode: 'plan',
      // plannerAgent deliberately omitted
    });
    const out = await o.run();
    await t.finish();
    assert.strictEqual(out.status, 'failed');
    assert.ok(out.error?.message.includes('plannerAgent'));
  });
});

test('plan mode: throws when plannerAgent is not registered', async () => {
  await withTracker(async (m) => {
    const reg = new AgentRegistry();
    reg.register(makeSynthesizer());
    const t = await m.startRun({ task: 'no-such-planner', model, sessionId: 's6' });
    const o = new Orchestrator({
      tracker: t,
      registry: reg,
      task: 'no-such-planner',
      model,
      sessionId: 's6',
      mode: 'plan',
      plannerAgent: 'ghost',
    });
    const out = await o.run();
    await t.finish();
    assert.strictEqual(out.status, 'failed');
    assert.ok(out.error?.message.includes('not registered'));
  });
});

test('plan mode: empty plan (planner writes no subtasks) breaks out gracefully', async () => {
  await withTracker(async (m) => {
    const reg = new AgentRegistry();
    reg.register({
      name: 'planner',
      role: 'Empty Planner',
      capabilities: [],
      dependencies: [],
      execute: async (ctx) => {
        // Planner that doesn't write a plan.dag at all
        ctx.sharedState.set('plan.dag', { task: ctx.task, subtasks: [] }, 'planner');
        return okResult({ task: ctx.task, subtasks: [] });
      },
    });
    reg.register(makeSynthesizer());

    const t = await m.startRun({ task: 'empty', model, sessionId: 's7' });
    const o = new Orchestrator({
      tracker: t,
      registry: reg,
      task: 'empty',
      model,
      sessionId: 's7',
      mode: 'plan',
      plannerAgent: 'planner',
      synthesizerAgent: 'synthesizer',
    });
    const out = await o.run();
    await t.finish();
    // Planner ran → 1 output. No sub-tasks, no synthesizer.
    assert.strictEqual(out.outputs.length, 1);
    assert.strictEqual(out.status, 'success');
  });
});

test('plan mode: synthesizer skipped when only 1 sub-task output (fast path)', async () => {
  await withTracker(async (m) => {
    const reg = new AgentRegistry();
    reg.register(makePlanner([
      { id: 'only', title: 'Only', prompt: 'only', assignedTo: 'worker', dependsOn: [] },
    ]));
    reg.register({
      name: 'worker',
      role: 'W',
      capabilities: [],
      dependencies: [],
      execute: async (ctx) => {
        const id = ctx.metadata?.['subtask.id'];
        ctx.sharedState.set(`subtasks.${id}.output`, 'sole-result', 'worker');
        return okResult('sole-result');
      },
    });
    let synthCalled = false;
    reg.register({
      name: 'synthesizer',
      role: 'S',
      capabilities: [],
      dependencies: [],
      execute: async () => {
        synthCalled = true;
        return okResult('should-not-run');
      },
    });

    const t = await m.startRun({ task: 'single', model, sessionId: 's8' });
    const o = new Orchestrator({
      tracker: t,
      registry: reg,
      task: 'single',
      model,
      sessionId: 's8',
      mode: 'plan',
      plannerAgent: 'planner',
      synthesizerAgent: 'synthesizer',
    });
    const out = await o.run();
    await t.finish();
    // Planner + 1 sub-task = 2 outputs (synthesizer should NOT run)
    assert.strictEqual(out.outputs.length, 2);
    assert.strictEqual(synthCalled, false, 'synthesizer must not run for single sub-task');
  });
});

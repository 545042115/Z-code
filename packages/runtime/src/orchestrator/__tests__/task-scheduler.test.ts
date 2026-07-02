// TaskScheduler unit tests
import { describe, it, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { TaskScheduler } from '../task-scheduler';
import type { TaskPriority } from '../task-scheduler';

describe('TaskScheduler', () => {
  let scheduler: TaskScheduler;

  beforeEach(() => {
    scheduler = new TaskScheduler({ maxConcurrency: 2 });
  });

  it('runs tasks in priority order (high first)', async () => {
    const order: string[] = [];
    const delays: Record<string, number> = { low: 50, normal: 30, high: 10 };

    const priorities: TaskPriority[] = ['low', 'normal', 'high'];
    for (const p of priorities) {
      scheduler.submit({
        name: p,
        priority: p,
        fn: async () => {
          await new Promise((r) => setTimeout(r, delays[p]));
          order.push(p);
        },
      });
    }

    await scheduler.waitForAll();

    // High should finish first, then normal, then low
    assert.equal(order[0], 'high');
    assert.equal(order[1], 'normal');
    assert.equal(order[2], 'low');
  });

  it('respects maxConcurrency', async () => {
    let running = 0;
    let maxRunning = 0;
    const tasks: string[] = [];

    for (let i = 0; i < 5; i++) {
      scheduler.submit({
        name: `task-${i}`,
        fn: async () => {
          running++;
          maxRunning = Math.max(maxRunning, running);
          await new Promise((r) => setTimeout(r, 20));
          running--;
          tasks.push(`task-${i}`);
        },
      });
    }

    await scheduler.waitForAll();

    assert.equal(tasks.length, 5);
    assert.ok(maxRunning <= 2, `Expected max 2 concurrent, got ${maxRunning}`);
  });

  it('reports task status correctly', async () => {
    const id = scheduler.submit({
      name: 'test',
      fn: async () => {
        await new Promise((r) => setTimeout(r, 20));
        return 42;
      },
    });

    const pending = scheduler.getTask(id);
    assert.ok(pending);
    assert.equal(pending!.status, 'pending');

    await scheduler.waitForAll();

    const completed = scheduler.getTask(id);
    assert.ok(completed);
    assert.equal(completed!.status, 'completed');
    assert.equal(completed!.result, 42);
    assert.ok(completed!.completedAt! > completed!.createdAt);
  });

  it('handles task failures', async () => {
    const id = scheduler.submit({
      name: 'failing',
      fn: async () => {
        throw new Error('test error');
      },
    });

    await scheduler.waitForAll();

    const task = scheduler.getTask(id);
    assert.ok(task);
    assert.equal(task!.status, 'failed');
    assert.equal(task!.error, 'test error');
  });

  it('cancels pending tasks', () => {
    const id = scheduler.submit({
      name: 'cancel-me',
      fn: async () => {
        // should not run
      },
    });

    const cancelled = scheduler.cancel(id);
    assert.ok(cancelled);

    const task = scheduler.getTask(id);
    assert.ok(task);
    assert.equal(task!.status, 'cancelled');
  });

  it('canRun blocks low-priority tasks in critical memory', () => {
    const s = new TaskScheduler({ maxConcurrency: 4 });
    s.updateResources({ memoryUsage: 0.95 });

    assert.equal(s.canRun('high', 'normal'), true);
    assert.equal(s.canRun('normal', 'normal'), false);
    assert.equal(s.canRun('low', 'normal'), false);
    assert.equal(s.canRun('background', 'normal'), false);
  });

  it('canRun allows low-resource tasks in critical memory', () => {
    const s = new TaskScheduler({ maxConcurrency: 4 });
    s.updateResources({ memoryUsage: 0.95 });

    assert.equal(s.canRun('high', 'normal'), true);
    assert.equal(s.canRun('background', 'low'), true);
    assert.equal(s.canRun('low', 'low'), true);
  });

  it('effectiveConcurrency reduces in low memory', () => {
    const s = new TaskScheduler({ maxConcurrency: 4 });
    assert.equal(s.effectiveConcurrency, 4);

    s.updateResources({ memoryUsage: 0.85 }); // low memory
    assert.ok(s.effectiveConcurrency < 4);
    assert.ok(s.effectiveConcurrency >= 1);
  });

  it('effectiveConcurrency is 1 in critical memory', () => {
    const s = new TaskScheduler({ maxConcurrency: 4 });
    s.updateResources({ memoryUsage: 0.95 }); // critical
    assert.equal(s.effectiveConcurrency, 1);
  });

  it('background tasks blocked when not charging and low battery', () => {
    const s = new TaskScheduler({ maxConcurrency: 4 });
    s.updateResources({ batteryLevel: 0.1, isCharging: false });

    assert.equal(s.canRun('high', 'normal'), true);
    assert.equal(s.canRun('normal', 'normal'), true);
    assert.equal(s.canRun('low', 'normal'), false);
    assert.equal(s.canRun('background', 'normal'), false);
  });

  it('background tasks allowed when charging', () => {
    const s = new TaskScheduler({ maxConcurrency: 4 });
    s.updateResources({ batteryLevel: 0.1, isCharging: true });

    assert.equal(s.canRun('background', 'normal'), true);
  });

  it('lowers concurrency in background (not in foreground)', () => {
    const s = new TaskScheduler({ maxConcurrency: 4 });
    assert.equal(s.effectiveConcurrency, 4);

    s.updateResources({ inForeground: false });
    assert.equal(s.effectiveConcurrency, 1);
  });

  it('pauses non-urgent tasks when network unavailable', () => {
    const s = new TaskScheduler({ maxConcurrency: 4 });
    s.updateResources({ networkAvailable: false });

    assert.equal(s.canRun('high', 'normal'), false);
    assert.equal(s.canRun('background', 'normal'), true); // background tasks may not need network
  });

  it('onTaskChange fires for status changes', async () => {
    const events: string[] = [];
    scheduler.onTaskChange((task) => {
      events.push(`${task.id}:${task.status}`);
    });

    const id = scheduler.submit({
      fn: async () => 'done',
    });

    await scheduler.waitForAll();

    assert.ok(events.some((e) => e.endsWith(':pending')), 'should have pending event');
    assert.ok(events.some((e) => e.endsWith(':running')), 'should have running event');
    assert.ok(events.some((e) => e.endsWith(':completed')), 'should have completed event');
  });

  it('timeout kills long-running tasks', async () => {
    const id = scheduler.submit({
      timeoutMs: 20,
      fn: async () => {
        await new Promise((r) => setTimeout(r, 200));
        return 'should not complete';
      },
    });

    await scheduler.waitForAll();

    const task = scheduler.getTask(id);
    assert.ok(task);
    assert.equal(task!.status, 'failed');
    assert.ok(task!.error?.includes('timed out'));
  });
});

// Task Scheduler — priority queue + resource-aware scheduling
//
// Phase 4: Orchestrator scheduling & background execution.
//
// The scheduler manages a priority queue of tasks and decides when
// to run them based on:
//   - Task priority (high / normal / low / background)
//   - System resources (memory, CPU, battery on mobile)
//   - Current concurrency limits
//   - Network availability
//
// This is especially important on mobile where resources are constrained
// and the OS may kill background processes at any time.

// ── Types ────────────────────────────────────────────────────────────

export type TaskPriority = 'high' | 'normal' | 'low' | 'background';

export type TaskStatus =
  | 'pending'     // waiting in queue
  | 'running'     // currently executing
  | 'completed'   // finished successfully
  | 'failed'      // finished with error
  | 'cancelled';  // cancelled before completion

export interface TaskSpec<T = unknown> {
  /** Unique task ID (auto-generated if not provided). */
  id?: string;
  /** Task priority. Higher priority tasks run first. */
  priority?: TaskPriority;
  /** Task name/description for debugging. */
  name?: string;
  /** Estimated cost in tokens (for budget tracking). */
  estimatedCost?: number;
  /** Task timeout in ms. 0 = no timeout. */
  timeoutMs?: number;
  /**
   * Minimum required resource level.
   * - 'normal': can run under normal conditions
   * - 'low':    can run even when resources are low
   * - 'idle':   only run when system is idle
   */
  resourceLevel?: 'normal' | 'low' | 'idle';
  /** The actual task function to execute. */
  fn: () => Promise<T>;
}

export interface Task<T = unknown> extends TaskSpec<T> {
  id: string;
  status: TaskStatus;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  error?: string;
  result?: T;
}

export interface SystemResources {
  /** Memory usage as a fraction (0-1). null = unknown. */
  memoryUsage: number | null;
  /** CPU usage as a fraction (0-1). null = unknown. */
  cpuUsage: number | null;
  /** Battery level as a fraction (0-1). null = unknown (e.g. desktop). */
  batteryLevel: number | null;
  /** Whether the device is charging. null = unknown. */
  isCharging: boolean | null;
  /** Whether the network is available. */
  networkAvailable: boolean;
  /** Whether the app is in the foreground. Always true on desktop. */
  inForeground: boolean;
}

export interface SchedulerOptions {
  /** Maximum concurrent tasks. Default 2. */
  maxConcurrency?: number;
  /**
   * Degradation thresholds. When resources drop below these levels,
   * the scheduler automatically limits concurrency and pauses low-priority tasks.
   */
  thresholds?: {
    /** Memory threshold (0-1) below which we enter low-memory mode. Default 0.8. */
    memoryLow?: number;
    /** Memory threshold (0-1) below which we pause all non-critical tasks. Default 0.9. */
    memoryCritical?: number;
    /** Battery threshold (0-1) below which we throttle background tasks. Default 0.2. */
    batteryLow?: number;
    /** CPU threshold (0-1) above which we throttle new tasks. Default 0.8. */
    cpuHigh?: number;
  };
  /**
   * Called when the scheduler wants to know current system resources.
   * If not provided, assumes normal/unknown resources.
   */
  resourceMonitor?: () => Promise<SystemResources> | SystemResources;
}

interface ResolvedThresholds {
  memoryLow: number;
  memoryCritical: number;
  batteryLow: number;
  cpuHigh: number;
}

interface ResolvedSchedulerOptions {
  maxConcurrency: number;
  thresholds: ResolvedThresholds;
  resourceMonitor: () => Promise<SystemResources> | SystemResources;
}

// ── Priority queue ───────────────────────────────────────────────────

const PRIORITY_ORDER: Record<TaskPriority, number> = {
  high: 0,
  normal: 1,
  low: 2,
  background: 3,
};

class PriorityQueue {
  private items: Task[] = [];

  get size(): number {
    return this.items.length;
  }

  push(task: Task): void {
    this.items.push(task);
    this.items.sort((a, b) => {
      const prioDiff = PRIORITY_ORDER[a.priority ?? 'normal'] - PRIORITY_ORDER[b.priority ?? 'normal'];
      if (prioDiff !== 0) return prioDiff;
      return a.createdAt - b.createdAt; // FIFO within same priority
    });
  }

  pop(): Task | undefined {
    return this.items.shift();
  }

  peek(): Task | undefined {
    return this.items[0];
  }

  remove(id: string): boolean {
    const idx = this.items.findIndex((t) => t.id === id);
    if (idx === -1) return false;
    this.items.splice(idx, 1);
    return true;
  }

  clear(): void {
    this.items = [];
  }

  toArray(): Task[] {
    return [...this.items];
  }
}

// ── TaskScheduler ────────────────────────────────────────────────────

export class TaskScheduler {
  private readonly queue = new PriorityQueue();
  private readonly running = new Map<string, Task>();
  private readonly completed = new Map<string, Task>();
  private readonly options: ResolvedSchedulerOptions;
  private readonly maxConcurrency: number;
  private taskCounter = 0;
  private isProcessing = false;
  private resourceSnapshot: SystemResources = {
    memoryUsage: null,
    cpuUsage: null,
    batteryLevel: null,
    isCharging: null,
    networkAvailable: true,
    inForeground: true,
  };
  private listeners = new Set<(task: Task) => void>();
  private resourcePollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: SchedulerOptions = {}) {
    this.options = {
      maxConcurrency: options.maxConcurrency ?? 2,
      thresholds: {
        memoryLow: options.thresholds?.memoryLow ?? 0.8,
        memoryCritical: options.thresholds?.memoryCritical ?? 0.9,
        batteryLow: options.thresholds?.batteryLow ?? 0.2,
        cpuHigh: options.thresholds?.cpuHigh ?? 0.8,
        ...options.thresholds,
      },
      resourceMonitor: options.resourceMonitor ?? (() => this.resourceSnapshot),
    };
    this.maxConcurrency = this.options.maxConcurrency;
  }

  /** Get current effective concurrency limit, adjusted for resource state. */
  get effectiveConcurrency(): number {
    const { memoryUsage, cpuUsage, batteryLevel, isCharging, inForeground } = this.resourceSnapshot;
    let limit = this.maxConcurrency;

    // Background mode: only one task at a time
    if (!inForeground) {
      limit = Math.min(limit, 1);
    }

    // Low memory: reduce concurrency
    if (memoryUsage !== null && memoryUsage >= this.options.thresholds.memoryCritical) {
      limit = Math.min(limit, 1);
    } else if (memoryUsage !== null && memoryUsage >= this.options.thresholds.memoryLow) {
      limit = Math.min(limit, Math.max(1, Math.floor(limit * 0.5)));
    }

    // High CPU: reduce concurrency
    if (cpuUsage !== null && cpuUsage >= this.options.thresholds.cpuHigh) {
      limit = Math.min(limit, Math.max(1, Math.floor(limit * 0.5)));
    }

    // Low battery & not charging: only high-priority tasks, limit to 1
    if (batteryLevel !== null && batteryLevel < this.options.thresholds.batteryLow && !isCharging) {
      limit = Math.min(limit, 1);
    }

    return Math.max(1, limit);
  }

  /** Check if a task with the given priority can run right now. */
  canRun(priority: TaskPriority, resourceLevel: 'normal' | 'low' | 'idle'): boolean {
    const { memoryUsage, batteryLevel, isCharging, networkAvailable, inForeground } = this.resourceSnapshot;

    // Network check: tasks that need network (most tasks)
    if (!networkAvailable && priority !== 'background') {
      return false;
    }

    // Idle tasks: only run when system is fully idle
    if (resourceLevel === 'idle') {
      if (!inForeground) return false;
      if (memoryUsage !== null && memoryUsage > 0.6) return false;
      if (batteryLevel !== null && batteryLevel < 0.5 && !isCharging) return false;
    }

    // Low resource tasks: can run in low battery/memory
    if (resourceLevel === 'low') {
      // Always allow low-resource tasks (they use minimal resources)
      return true;
    }

    // Critical memory: only high priority
    if (memoryUsage !== null && memoryUsage >= this.options.thresholds.memoryCritical) {
      return priority === 'high';
    }

    // Low battery & not charging: only high and normal
    if (batteryLevel !== null && batteryLevel < this.options.thresholds.batteryLow && !isCharging) {
      return priority === 'high' || priority === 'normal';
    }

    // Background tasks: only in foreground or with charger
    if (priority === 'background') {
      if (!inForeground && !isCharging) return false;
    }

    return true;
  }

  /** Queue a task and return its ID. */
  submit<T>(spec: TaskSpec<T>): string {
    const task: Task<T> = {
      ...spec,
      id: spec.id ?? `task-${++this.taskCounter}`,
      status: 'pending',
      createdAt: Date.now(),
      priority: spec.priority ?? 'normal',
      resourceLevel: spec.resourceLevel ?? 'normal',
    } as Task<T>;

    this.queue.push(task as Task);
    this._notify(task as Task);
    this._scheduleProcessing();
    return task.id;
  }

  /** Cancel a pending task. */
  cancel(id: string): boolean {
    // Try to remove from queue first
    const queued = this.queue.toArray().find((t) => t.id === id);
    if (queued && this.queue.remove(id)) {
      queued.status = 'cancelled';
      this.completed.set(id, queued);
      this._notify(queued);
      return true;
    }

    // Cancel running task if possible (we just mark it; the task function needs to check)
    const running = this.running.get(id);
    if (running) {
      running.status = 'cancelled';
      return true;
    }

    return false;
  }

  /** Get a task by ID. */
  getTask(id: string): Task | undefined {
    return this.running.get(id) ?? this.completed.get(id) ?? this.queue.toArray().find((t) => t.id === id);
  }

  /** Get all pending tasks. */
  get pendingTasks(): Task[] {
    return this.queue.toArray();
  }

  /** Get all running tasks. */
  get runningTasks(): Task[] {
    return Array.from(this.running.values());
  }

  /** Subscribe to task status changes. */
  onTaskChange(listener: (task: Task) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Update the resource snapshot manually.
   * Useful for platforms where resource monitoring is event-driven.
   */
  updateResources(resources: Partial<SystemResources>): void {
    this.resourceSnapshot = { ...this.resourceSnapshot, ...resources };
    this._scheduleProcessing();
  }

  /** Start periodic resource polling (if a monitor is provided). */
  startResourcePolling(intervalMs = 5000): void {
    if (this.resourcePollTimer) return;
    this.resourcePollTimer = setInterval(async () => {
      try {
        const resources = await this.options.resourceMonitor();
        this.resourceSnapshot = resources;
        this._scheduleProcessing();
      } catch {
        // ignore monitor errors
      }
    }, intervalMs);
  }

  /** Stop periodic resource polling. */
  stopResourcePolling(): void {
    if (this.resourcePollTimer) {
      clearInterval(this.resourcePollTimer);
      this.resourcePollTimer = null;
    }
  }

  /** Wait for all currently pending + running tasks to complete. */
  async waitForAll(): Promise<void> {
    while (this.queue.size > 0 || this.running.size > 0) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /** Shutdown the scheduler. Cancels all pending tasks and waits for running ones. */
  async shutdown(): Promise<void> {
    this.stopResourcePolling();
    this.queue.clear();
    await this.waitForAll();
    this.listeners.clear();
  }

  // ── Internal ───────────────────────────────────────────────────

  private _scheduleProcessing(): void {
    if (this.isProcessing) return;
    this.isProcessing = true;
    queueMicrotask(() => this._processQueue());
  }

  private async _processQueue(): Promise<void> {
    try {
      while (this.running.size < this.effectiveConcurrency) {
        const next = this._findRunnableTask();
        if (!next) break;

        this.queue.remove(next.id);
        this.running.set(next.id, next);
        next.status = 'running';
        next.startedAt = Date.now();
        this._notify(next);

        this._executeTask(next).catch(() => undefined);
      }
    } finally {
      this.isProcessing = false;
    }
  }

  private _findRunnableTask(): Task | undefined {
    const tasks = this.queue.toArray();
    for (const task of tasks) {
      if (this.canRun(task.priority ?? 'normal', task.resourceLevel ?? 'normal')) {
        return task;
      }
    }
    return undefined;
  }

  private async _executeTask(task: Task): Promise<void> {
    try {
      // Set up timeout
      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      const timeoutPromise = task.timeoutMs
        ? new Promise<never>((_, reject) => {
            timeoutId = setTimeout(() => {
              reject(new Error(`Task timed out after ${task.timeoutMs}ms`));
            }, task.timeoutMs);
          })
        : null;

      const result = timeoutPromise
        ? await Promise.race([task.fn(), timeoutPromise])
        : await task.fn();

      if (timeoutId) clearTimeout(timeoutId);

      task.status = 'completed';
      task.result = result;
    } catch (e) {
      task.status = 'failed';
      task.error = e instanceof Error ? e.message : String(e);
    } finally {
      task.completedAt = Date.now();
      this.running.delete(task.id);
      this.completed.set(task.id, task);
      this._notify(task);
      this._scheduleProcessing();
    }
  }

  private _notify(task: Task): void {
    for (const listener of this.listeners) {
      try {
        listener(task);
      } catch {
        // ignore listener errors
      }
    }
  }
}

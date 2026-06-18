// AgentRegistry — multi-Agent dispatcher.
//
// Holds a set of `IAgent` instances and provides:
//   - Registration with name uniqueness check
//   - Capability-based lookup
//   - `canHandle` scoring for routing
//   - Dependency resolution (topo sort)
//
// The registry is **only** a dispatcher. Execution is the Orchestrator's
// job. This split keeps scheduling and coordination separate from
// agent selection, which is testable in isolation.

import type { IAgent, TaskContext } from '@z-assistant/contracts';

export class AgentConflictError extends Error {
  constructor(name: string) {
    super(`agent name conflict: ${name}`);
    this.name = 'AgentConflictError';
  }
}

export class AgentNotFoundError extends Error {
  constructor(name: string) {
    super(`agent not found: ${name}`);
    this.name = 'AgentNotFoundError';
  }
}

export class DependencyCycleError extends Error {
  constructor(cycle: string[]) {
    super(`dependency cycle detected: ${cycle.join(' -> ')}`);
    this.name = 'DependencyCycleError';
  }
}

export class AgentRegistry {
  private _agents = new Map<string, IAgent>();
  private _byCapability = new Map<string, Set<IAgent>>();

  // ── Registration ────────────────────────────────────────────────────

  /**
   * Register an agent. Throws AgentConflictError if the name is taken.
   * Returns the registered agent (for chaining).
   */
  register<T extends IAgent>(agent: T): T {
    if (this._agents.has(agent.name)) {
      throw new AgentConflictError(agent.name);
    }
    this._agents.set(agent.name, agent);
    for (const cap of agent.capabilities) {
      let set = this._byCapability.get(cap);
      if (!set) {
        set = new Set();
        this._byCapability.set(cap, set);
      }
      set.add(agent);
    }
    return agent;
  }

  /** Unregister an agent. Returns true if it was present. */
  unregister(name: string): boolean {
    const a = this._agents.get(name);
    if (!a) return false;
    this._agents.delete(name);
    for (const cap of a.capabilities) {
      this._byCapability.get(cap)?.delete(a);
    }
    return true;
  }

  // ── Lookup ──────────────────────────────────────────────────────────

  get(name: string): IAgent {
    const a = this._agents.get(name);
    if (!a) throw new AgentNotFoundError(name);
    return a;
  }

  /** True if the agent is registered. */
  has(name: string): boolean {
    return this._agents.has(name);
  }

  /** All registered agents, sorted by name. */
  list(): IAgent[] {
    return [...this._agents.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Agents that declare a capability. */
  byCapability(cap: string): IAgent[] {
    return [...(this._byCapability.get(cap) ?? [])];
  }

  // ── Routing ─────────────────────────────────────────────────────────

  /**
   * Score all agents against a context. Returns a sorted list
   * (highest score first). Agents returning a score of 0 or lower
   * are excluded. `canHandle` may be async.
   */
  async rank(ctx: TaskContext): Promise<Array<{ agent: IAgent; score: number }>> {
    const out: Array<{ agent: IAgent; score: number }> = [];
    for (const a of this._agents.values()) {
      let s = 0;
      try {
        const score = a.canHandle ? await a.canHandle(ctx) : 0.5;
        s = Number(score);
        if (!Number.isFinite(s)) s = 0;
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error(`[AgentRegistry] ${a.name}.canHandle threw:`, e);
        continue;
      }
      if (s > 0) out.push({ agent: a, score: s });
    }
    out.sort((a, b) => b.score - a.score);
    return out;
  }

  /**
   * Find the best agent for a context. Returns undefined if none score > 0.
   * Ties are broken by registration order (deterministic).
   */
  async bestFor(ctx: TaskContext): Promise<IAgent | undefined> {
    const ranked = await this.rank(ctx);
    return ranked[0]?.agent;
  }

  // ── Dependency resolution ───────────────────────────────────────────

  /**
   * Topological sort of a set of agent names by their `dependencies`.
   * Throws DependencyCycleError on cycle. Returns the names in
   * dependency order (dependencies first).
   */
  resolveOrder(names: string[]): string[] {
    const inSet = new Set(names);
    const visited = new Set<string>();
    const onStack = new Set<string>();
    const out: string[] = [];

    const visit = (n: string, path: string[]): void => {
      if (visited.has(n)) return;
      if (onStack.has(n)) {
        throw new DependencyCycleError([...path, n]);
      }
      onStack.add(n);
      const a = this._agents.get(n);
      if (!a) throw new AgentNotFoundError(n);
      for (const dep of a.dependencies) {
        if (!inSet.has(dep)) continue;  // skip out-of-scope deps
        visit(dep, [...path, n]);
      }
      onStack.delete(n);
      visited.add(n);
      out.push(n);
    };

    // Sort the input for determinism
    for (const n of [...names].sort()) visit(n, []);
    return out;
  }
}

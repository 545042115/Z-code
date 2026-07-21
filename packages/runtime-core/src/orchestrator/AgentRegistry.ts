import type { IAgent, TaskContext } from '@ziner/contracts';

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
  private agents = new Map<string, IAgent>();
  private byCapabilityIndex = new Map<string, Set<IAgent>>();

  register<T extends IAgent>(agent: T): T {
    if (this.agents.has(agent.name)) {
      throw new AgentConflictError(agent.name);
    }
    this.agents.set(agent.name, agent);
    for (const capability of agent.capabilities) {
      let set = this.byCapabilityIndex.get(capability);
      if (!set) {
        set = new Set();
        this.byCapabilityIndex.set(capability, set);
      }
      set.add(agent);
    }
    return agent;
  }

  unregister(name: string): boolean {
    const agent = this.agents.get(name);
    if (!agent) return false;
    this.agents.delete(name);
    for (const capability of agent.capabilities) {
      this.byCapabilityIndex.get(capability)?.delete(agent);
    }
    return true;
  }

  get(name: string): IAgent {
    const agent = this.agents.get(name);
    if (!agent) throw new AgentNotFoundError(name);
    return agent;
  }

  has(name: string): boolean {
    return this.agents.has(name);
  }

  list(): IAgent[] {
    return [...this.agents.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  byCapability(capability: string): IAgent[] {
    return [...(this.byCapabilityIndex.get(capability) ?? [])];
  }

  async rank(ctx: TaskContext): Promise<Array<{ agent: IAgent; score: number }>> {
    const out: Array<{ agent: IAgent; score: number }> = [];
    for (const agent of this.agents.values()) {
      let score = 0;
      try {
        const value = agent.canHandle ? await agent.canHandle(ctx) : 0.5;
        score = Number(value);
        if (!Number.isFinite(score)) score = 0;
      } catch (error) {
        console.error(`[AgentRegistry] ${agent.name}.canHandle threw:`, error);
        continue;
      }
      if (score > 0) out.push({ agent, score });
    }
    out.sort((a, b) => b.score - a.score);
    return out;
  }

  async bestFor(ctx: TaskContext): Promise<IAgent | undefined> {
    const ranked = await this.rank(ctx);
    return ranked[0]?.agent;
  }

  resolveOrder(names: string[]): string[] {
    const inSet = new Set(names);
    const visited = new Set<string>();
    const onStack = new Set<string>();
    const out: string[] = [];

    const visit = (name: string, path: string[]): void => {
      if (visited.has(name)) return;
      if (onStack.has(name)) {
        throw new DependencyCycleError([...path, name]);
      }
      onStack.add(name);
      const agent = this.agents.get(name);
      if (!agent) throw new AgentNotFoundError(name);
      for (const dep of agent.dependencies) {
        if (!inSet.has(dep)) continue;
        visit(dep, [...path, name]);
      }
      onStack.delete(name);
      visited.add(name);
      out.push(name);
    };

    for (const name of [...names].sort()) visit(name, []);
    return out;
  }
}

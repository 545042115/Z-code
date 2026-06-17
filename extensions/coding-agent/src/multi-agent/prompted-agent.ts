// PromptedAgent — wraps an IAgent and injects the *active* PromptVariant
// at execution time.
//
// Phase 5 A/B Testing: the Evolution panel manages `PromptCandidate`
// records (one per agent, with multiple variants). The user can switch
// the active variant. The agent that actually runs should see the
// content of the active variant in its TaskContext, and the parent Run
// should be tagged with the variant id so per-variant stats can be
// computed by `QueryService.variantStats`.
//
// Usage:
//   const registry = new AgentRegistry();
//   registerExampleAgents(registry);                  // raw agents
//   const wrapped = new PromptedAgent(                 // wrap each
//     registry.get('researcher'),
//     queryService,
//   );
//   registry.unregister('researcher');
//   registry.register(wrapped);
//
// During `_runOne` the Orchestrator will:
//   1. Call `wrapped.execute(ctx)`.
//   2. After return, read `ctx.metadata['variant.id']` and tag the Run.
//
// If no candidate is registered (e.g. dev / no candidates yet), the
// wrapper is a transparent pass-through — no `variant.id` is set.

import type { IAgent, TaskContext, AgentResult } from '../contracts';
import { ok } from '../contracts';
import type { QueryService } from '../trace-ui/query-service';

export interface PromptedAgentOptions {
  /** Underlying agent whose execute() will be called. */
  base: IAgent;
  /** Query service to read PromptCandidate from. */
  query: QueryService;
  /**
   * If true, errors from the candidate lookup are swallowed (the agent
   * runs without a prompt). Default true — a missing candidate should
   * not break user workflows.
   */
  swallowErrors?: boolean;
}

/** Keys used on `TaskContext.metadata` to surface the active variant. */
export const PROMPT_METADATA_KEYS = {
  variantId: 'variant.id',
  variantLabel: 'variant.label',
  promptActive: 'prompt.active',
  candidateId: 'candidate.id',
} as const;

export class PromptedAgent implements IAgent {
  public readonly name: string;
  public readonly role: string;
  public readonly capabilities: string[];
  public readonly dependencies: string[];
  public readonly modelPreference: IAgent['modelPreference'];
  public readonly canHandle: IAgent['canHandle'];
  public readonly rollback?: IAgent['rollback'];
  public readonly health?: IAgent['health'];

  private readonly opts: PromptedAgentOptions;

  constructor(opts: PromptedAgentOptions) {
    this.opts = opts;
    const b = opts.base;
    this.name = b.name;
    this.role = b.role;
    this.capabilities = b.capabilities;
    this.dependencies = b.dependencies;
    this.modelPreference = b.modelPreference;
    this.canHandle = b.canHandle?.bind(b);
    this.rollback = b.rollback?.bind(b);
    this.health = b.health?.bind(b);
  }

  async execute(ctx: TaskContext): Promise<AgentResult> {
    // Resolve the active variant (if any). We look up ALL candidates for
    // this agentName and pick the one with `activeVariantId` set; if
    // multiple candidates exist, the first wins deterministically.
    const candidates = await this._safeListCandidates(this.opts.base.name);
    const active = this._pickActive(candidates);

    // Ensure metadata is an object
    if (!ctx.metadata) ctx.metadata = {};

    if (active) {
      const v = active.variants.find((x) => x.id === active.activeVariantId);
      if (v) {
        ctx.metadata[PROMPT_METADATA_KEYS.variantId] = v.id;
        ctx.metadata[PROMPT_METADATA_KEYS.variantLabel] = v.label;
        ctx.metadata[PROMPT_METADATA_KEYS.promptActive] = v.content;
        ctx.metadata[PROMPT_METADATA_KEYS.candidateId] = active.id;
      }
    }

    // Delegate
    return this.opts.base.execute(ctx);
  }

  /** For tests: peek the underlying base agent. */
  get base(): IAgent { return this.opts.base; }

  // ── Internals ───────────────────────────────────────────────────────

  private async _safeListCandidates(agentName: string) {
    if (this.opts.swallowErrors === false) {
      return this.opts.query.listCandidates({ agentName });
    }
    try {
      return await this.opts.query.listCandidates({ agentName });
    } catch {
      return [];
    }
  }

  private _pickActive(list: import('../contracts').PromptCandidate[]): import('../contracts').PromptCandidate | undefined {
    if (!list || list.length === 0) return undefined;
    // Prefer the candidate whose activeVariantId is present in its own
    // variants array (defensive: dangling ids are ignored).
    for (const c of list) {
      if (c.variants.some((v) => v.id === c.activeVariantId)) return c;
    }
    return undefined;
  }
}

/** Convenience: return a noop pass-through AgentResult for unit tests. */
export function __noopPrompted(): AgentResult {
  return ok({ via: 'noop' });
}

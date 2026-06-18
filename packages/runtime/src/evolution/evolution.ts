// Evolution Engine Framework — Universal Phase-5 self-improvement loop.
//
// Per V2_VISION §"Phase 5 — Evolution" and ADR-0004:
//   1. Collect failed Runs (and their Span trees)
//   2. Group them by error pattern (code, message signature, agent)
//   3. Suggest a *candidate* prompt/tool change for the human
//   4. Apply ONLY with explicit human approval
//
// The current implementation covers steps 1-3. Step 4 is a UI flow
// hosted in the VSCode Connector (`EvolutionPanel` in V1).
//
// Phase 6A: moved from V1 `extensions/coding-agent/src/evolution/evolution.ts`
// to V2 `packages/runtime/src/evolution/evolution.ts`. Pure Node, no vscode.

import type { AgentRun, AgentSpan } from '@z-assistant/contracts';
import type { Store, RunQuery } from '@z-assistant/infra-storage';
import type { TraceManager } from '@z-assistant/trace';

// ── Data shapes ───────────────────────────────────────────────────────

/** A normalized signature of a single failure. */
export interface FailureFingerprint {
  runId: string;
  task: string;
  sessionId: string;
  agent: string;
  spanId: string;
  errorCode: string;
  errorMessage: string;
  /** Stable shape of the error message (digits/whitespace normalized). */
  errorPattern: string;
  timestamp: number;
}

export interface FailureCluster {
  id: string;
  signature: string;
  /** Human-readable label (e.g. "<agent>: <errorCode>"). */
  label: string;
  count: number;
  distinctRuns: number;
  distinctTasks: number;
  /** Sample of up to 5 representative fingerprint ids. */
  samples: FailureFingerprint[];
  /** First / last seen timestamps. */
  firstSeen: number;
  lastSeen: number;
}

export type SuggestionKind = 'prompt' | 'tool' | 'config';

export interface PromptSuggestion {
  kind: 'prompt';
  agentName: string;
  currentHint: string;       // where in the current prompt the issue lies
  proposed: string;          // proposed prompt addition
  rationale: string;
}

export interface ToolSuggestion {
  kind: 'tool';
  toolName: string;
  reason: 'permission' | 'timeout' | 'rate_limit' | 'unknown';
  proposed: { action: 'tighten' | 'loosen' | 'add' | 'remove'; reason: string };
}

export interface ConfigSuggestion {
  kind: 'config';
  key: string;
  currentValue: unknown;
  proposedValue: unknown;
  rationale: string;
}

export type EvolutionSuggestion = PromptSuggestion | ToolSuggestion | ConfigSuggestion;

export interface EvolutionReport {
  generatedAt: number;
  windowMs: number;
  totalFailures: number;
  clusters: FailureCluster[];
  suggestions: EvolutionSuggestion[];
  /** If true, at least one cluster has been seen more than once → apply threshold met. */
  readyToApply: boolean;
}

// ── Collector ─────────────────────────────────────────────────────────

/** Walk a Run's spans and extract FailureFingerprints. */
export function fingerprintRun(run: AgentRun, spans: AgentSpan[]): FailureFingerprint[] {
  const out: FailureFingerprint[] = [];
  for (const s of spans) {
    if (s.status !== 'error' || !s.error) continue;
    const msg = s.error.message ?? '';
    out.push({
      runId: run.id,
      task: run.task.slice(0, 200),
      sessionId: run.sessionId,
      agent: s.name,
      spanId: s.id,
      errorCode: s.error.code,
      errorMessage: msg.slice(0, 200),
      errorPattern: normalizePattern(msg),
      timestamp: s.startTime,
    });
  }
  return out;
}

/** Reduce a free-text message to a stable pattern. */
export function normalizePattern(msg: string): string {
  return msg
    .toLowerCase()
    // Hex first (greedy) so 0xabc… is captured as a single <hex>.
    .replace(/0x[0-9a-f]+/g, '<hex>')
    // All remaining digits → <n>. (After hex so plain numbers still
    // become <n>; before paths so the path pattern does not see
    // numeric fragments like "abc123".)
    .replace(/\d+/g, '<n>')
    .replace(/['"`][^'"`]{0,80}['"`]/g, '<q>')
    // Path-like tokens (e.g. /tmp/x.ts or /tmp/<n>).
    .replace(/\/[a-z0-9._<>-]{1,80}/g, '<path>')
    .replace(/[a-z]:[\\/][a-z0-9._<>-]{1,80}/g, '<path>')
    // Remaining punctuation → space.
    .replace(/[^a-z0-9\s<>_-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
}

// ── Clusterer ─────────────────────────────────────────────────────────

/** Group fingerprints by (agent, errorCode) + same normalized pattern. */
export function clusterFingerprints(fps: FailureFingerprint[]): FailureCluster[] {
  const map = new Map<string, FailureFingerprint[]>();
  for (const f of fps) {
    const key = `${f.agent}|${f.errorCode}|${f.errorPattern}`;
    let arr = map.get(key);
    if (!arr) { arr = []; map.set(key, arr); }
    arr.push(f);
  }
  const out: FailureCluster[] = [];
  for (const [key, items] of map) {
    const [agent, code, ...rest] = key.split('|');
    const sig = rest.join('|');
    const distinctRuns = new Set(items.map((x) => x.runId)).size;
    const distinctTasks = new Set(items.map((x) => x.task)).size;
    out.push({
      id: `cl-${code}-${sig.replace(/[^a-z0-9]/gi, '').slice(0, 32) || 'general'}`,
      signature: sig,
      label: `${agent}: [${code}]`,
      count: items.length,
      distinctRuns,
      distinctTasks,
      samples: items.slice(0, 5),
      firstSeen: Math.min(...items.map((x) => x.timestamp)),
      lastSeen: Math.max(...items.map((x) => x.timestamp)),
    });
  }
  out.sort((a, b) => b.count - a.count);
  return out;
}

// ── Adviser ───────────────────────────────────────────────────────────

/** Heuristic prompt suggestion based on the cluster's agent + code. */
export function suggestForCluster(c: FailureCluster): EvolutionSuggestion[] {
  const out: EvolutionSuggestion[] = [];
  const code = c.samples[0]?.errorCode ?? '0000';
  const agent = c.samples[0]?.agent ?? 'unknown';

  // Code-based heuristics (matches infra/errors/error-codes.ts)
  if (code === '1003' || code === '1004') {   // auth / config
    out.push({
      kind: 'config',
      key: 'auth.refresh',
      currentValue: 'auto',
      proposedValue: 'manual',
      rationale: `Recurring ${code} suggests auth reauth flow is failing silently.`,
    });
  } else if (code === '2002') {              // permission denied
    out.push({
      kind: 'tool',
      toolName: 'fs',
      reason: 'permission',
      proposed: { action: 'tighten', reason: 'Repeated permission denials on fs tool' },
    });
  } else if (code === '3001' || code === '3002') {  // agent failure
    out.push({
      kind: 'prompt',
      agentName: agent,
      currentHint: 'unknown',
      proposed: `If the previous attempt errored with: "${c.samples[0]?.errorPattern}". Verify the inputs are correct before calling tools, and decompose the task into smaller sub-steps.`,
      rationale: `Cluster ${c.label} seen ${c.count} time(s) across ${c.distinctRuns} run(s).`,
    });
  } else if (code === '3003') {              // budget exceeded
    out.push({
      kind: 'config',
      key: 'budget.perRunTokens',
      currentValue: 1_000_000,
      proposedValue: 1_500_000,
      rationale: 'Budget exhaustion is the failure cause. Consider raising the cap or trimming the prompt.',
    });
  }
  return out;
}

// ── Engine ────────────────────────────────────────────────────────────

export class EvolutionEngine {
  constructor(
    private readonly store: Store,
    private readonly mgr: TraceManager,
  ) {}

  /** Generate a full EvolutionReport from recent failed runs. */
  async generate(opts: { windowMs?: number; minOccurrences?: number } = {}): Promise<EvolutionReport> {
    const windowMs = opts.windowMs ?? 7 * 24 * 60 * 60 * 1000;  // 7 days
    const minOccurrences = opts.minOccurrences ?? 2;
    const fromTs = Date.now() - windowMs;
    const q: RunQuery = { status: 'failed', fromTs, limit: 500 };
    const runs = await this.store.runs.list(q);

    // Collect fingerprints
    const allFp: FailureFingerprint[] = [];
    for (const r of runs) {
      const spans = await this.store.spans.listByRun(r.id);
      allFp.push(...fingerprintRun(r, spans));
    }

    // Cluster
    const clusters = clusterFingerprints(allFp);
    const recurring = clusters.filter((c) => c.count >= minOccurrences);

    // Suggestions (top 5 recurring)
    const suggestions: EvolutionSuggestion[] = [];
    for (const c of recurring.slice(0, 5)) {
      suggestions.push(...suggestForCluster(c));
    }

    return {
      generatedAt: Date.now(),
      windowMs,
      totalFailures: allFp.length,
      clusters: recurring,
      suggestions,
      readyToApply: recurring.length > 0,
    };
  }
}

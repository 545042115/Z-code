// @z-assistant/runtime — Skill Obsolescence Detector (P1-3).
//
// Heuristic detector that flags active SkillVersions which appear to
// be no longer effective. Two signals are inspected:
//
//   1. low-success-rate — count recent failures whose agent name or
//      toolName matches the skill; if failures exceed `minSample`
//      and the implied success rate drops below the threshold, the
//      version is reported.
//
//   2. stale — the version has not been created or updated within
//      the configurable staleness window.
//
// The detector is deliberately conservative: it only emits reports;
// the actual deprecation flow is owned by the version registry and
// the human reviewer.

import type {
  ISkillObsolescenceDetector,
  ISkillVersionRegistry,
  IFailureCaseStore,
  ObsolescenceReport,
  Skill,
  SkillVersion,
} from '@z-assistant/contracts';

// ── Options ──────────────────────────────────────────────────────────

export interface HeuristicObsolescenceDetectorOptions {
  versions: ISkillVersionRegistry;
  failureStore: IFailureCaseStore;
  /** Default 30 days. */
  staleThresholdMs?: number;
  /** Below this success rate, flag low-success. Default 0.4. */
  lowSuccessThreshold?: number;
  /** Minimum failure sample size to consider. Default 10. */
  minSample?: number;
}

export interface ObsolescenceScanInput {
  /** Active skills to scan. If empty, no skills are evaluated. */
  skills?: readonly Skill[];
  /** Optional usage map (skillId → successful invocations in window). */
  recentUsage?: Map<string, number>;
  /** Override window for failure lookup (ms). Defaults to staleThresholdMs. */
  windowMs?: number;
}

const DEFAULT_STALE_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_LOW_SUCCESS = 0.4;
const DEFAULT_MIN_SAMPLE = 10;

// ── HeuristicObsolescenceDetector ────────────────────────────────────

export class HeuristicObsolescenceDetector implements ISkillObsolescenceDetector {
  private readonly versions: ISkillVersionRegistry;
  private readonly failureStore: IFailureCaseStore;
  private readonly staleThresholdMs: number;
  private readonly lowSuccessThreshold: number;
  private readonly minSample: number;

  constructor(opts: HeuristicObsolescenceDetectorOptions) {
    this.versions = opts.versions;
    this.failureStore = opts.failureStore;
    this.staleThresholdMs = opts.staleThresholdMs ?? DEFAULT_STALE_MS;
    this.lowSuccessThreshold = opts.lowSuccessThreshold ?? DEFAULT_LOW_SUCCESS;
    this.minSample = opts.minSample ?? DEFAULT_MIN_SAMPLE;
  }

  async scan(input?: ObsolescenceScanInput): Promise<ObsolescenceReport[]> {
    const skills = input?.skills ?? [];
    const recentUsage = input?.recentUsage;
    if (skills.length === 0) return [];
    const now = Date.now();
    const windowMs = input?.windowMs ?? this.staleThresholdMs;
    const fromTs = now - windowMs;

    const out: ObsolescenceReport[] = [];
    for (const skill of skills) {
      const active = await this.versions.getActive(skill.id);
      if (!active) continue;

      const reasons: ObsolescenceReport['reasons'] = [];

      // ── low-success-rate signal ─────────────────────────────
      const failures = await this.failureStore.list({
        agent: skill.name,
        fromTs,
        toTs: now,
      });
      const toolFailures = await this.collectToolFailures(skill, fromTs, now);
      const totalFailures = failures.length + toolFailures;
      const successes = recentUsage?.get(skill.id) ?? 0;
      const sample = totalFailures + successes;
      if (totalFailures >= this.minSample && sample > 0) {
        const rate = successes / sample;
        if (rate < this.lowSuccessThreshold) {
          reasons.push({
            type: 'low-success-rate',
            rate,
            threshold: this.lowSuccessThreshold,
            sample,
          });
        }
      }

      // ── stale signal ────────────────────────────────────────
      if (now - active.createdAt > this.staleThresholdMs) {
        reasons.push({
          type: 'stale',
          lastUsedAt: active.createdAt,
          thresholdMs: this.staleThresholdMs,
        });
      }

      if (reasons.length > 0) {
        out.push({
          skillId: skill.id,
          version: active.version,
          reasons,
          suggestedAction: chooseAction(reasons),
        });
      }
    }
    out.sort((a, b) => a.skillId.localeCompare(b.skillId));
    return out;
  }

  private async collectToolFailures(
    skill: Skill,
    fromTs: number,
    toTs: number
  ): Promise<number> {
    const tools = new Set<string>();
    for (const tool of skill.toolsAllow ?? []) tools.add(tool);
    let n = 0;
    for (const tool of tools) {
      n += await this.failureStore.count({ toolName: tool, fromTs, toTs });
    }
    return n;
  }
}

function chooseAction(reasons: ObsolescenceReport['reasons']): 'deprecate' | 'replace' | 'review' {
  if (reasons.some((r) => r.type === 'low-success-rate')) return 'replace';
  if (reasons.some((r) => r.type === 'verification-failed')) return 'deprecate';
  return 'review';
}

// Re-export for callers that need the version shape.
export type { SkillVersion };

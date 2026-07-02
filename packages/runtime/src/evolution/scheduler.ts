// @ziner/runtime — Background Evolution Scheduler (Phase 5)
//
// Watches audit/failure logs and automatically triggers the evolution loop
// and skill auto-discovery when a threshold of failures is crossed. All
// generated candidates are routed to a human review queue; nothing is applied
// automatically.

import type { AuditLogEntry, ISkillReviewQueue, AutoDiscoveryReport } from '@ziner/contracts';
import type { AuditLogger } from '../audit/logger';
import type { EvolutionEngine, EvolutionReport } from './evolution';
import type { AutoDiscoveryEngine } from '../skills/auto-discovery';

export interface BackgroundSchedulerOptions {
  auditLogger: AuditLogger;
  evolution: EvolutionEngine;
  skillDiscovery: AutoDiscoveryEngine;
  reviewQueue: ISkillReviewQueue;
  /**
   * Minimum failures with the same (toolName, errorMessage) pattern before
   * triggering auto-analysis. Default 2.
   */
  failureThreshold?: number;
  /**
   * Cooldown between automatic analysis runs (ms). Default 5 minutes.
   */
  cooldownMs?: number;
  /**
   * Optional hook called after each automatic analysis. Useful for UI
   * notifications or logging.
   */
  onAnalysis?: (report: { evolution: EvolutionReport; skills: AutoDiscoveryReport }) => void;
}

interface FailureKey {
  toolName: string;
  errorPattern: string;
}

function makeKey(entry: AuditLogEntry): FailureKey {
  return {
    toolName: entry.toolName,
    errorPattern: normalizeError(entry.errorMessage ?? 'unknown'),
  };
}

function normalizeError(msg: string): string {
  return msg
    .toLowerCase()
    .replace(/\d+/g, '#')
    .replace(/['"`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

/**
 * Background scheduler that connects failure telemetry to the evolution
 * and skill-discovery loops.
 *
 * Usage:
 *   const scheduler = new BackgroundScheduler({ auditLogger, evolution, skillDiscovery, reviewQueue });
 *   scheduler.start();
 *   // ... later
 *   scheduler.stop();
 */
export class BackgroundScheduler {
  private readonly opts: BackgroundSchedulerOptions;
  private readonly failureCounts = new Map<string, number>();
  private lastAnalysisAt = 0;
  private timer?: ReturnType<typeof setInterval>;

  constructor(opts: BackgroundSchedulerOptions) {
    this.opts = {
      failureThreshold: 2,
      cooldownMs: 5 * 60 * 1000,
      ...opts,
    };
  }

  /** Start watching the audit log for failures. */
  start(): void {
    // Immediate feedback on each error outcome.
    const original = (this.opts.auditLogger as any).onAppend;
    // Replace the audit logger's onAppend callback so we receive every entry.
    // This is a non-invasive way to subscribe without changing caller code.
    (this.opts.auditLogger as any).onAppend = (entry: AuditLogEntry) => {
      try { original?.(entry); } catch { /* ignore */ }
      this.handleAuditEntry(entry);
    };

    // Periodic safety net: re-analyse every cooldown window even if no new
    // failures arrived (catches failures written before the scheduler started).
    this.timer = setInterval(() => {
      void this.analyzeIfReady();
    }, this.opts.cooldownMs);
  }

  /** Stop watching and clear timers. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private handleAuditEntry(entry: AuditLogEntry): void {
    if (entry.outcome !== 'error' && entry.outcome !== 'blocked') return;
    const key = makeKey(entry);
    const mapKey = `${key.toolName}::${key.errorPattern}`;
    const count = (this.failureCounts.get(mapKey) ?? 0) + 1;
    this.failureCounts.set(mapKey, count);
    if (count >= (this.opts.failureThreshold ?? 2)) {
      void this.analyzeIfReady();
    }
  }

  private async analyzeIfReady(): Promise<void> {
    const now = Date.now();
    if (now - this.lastAnalysisAt < (this.opts.cooldownMs ?? 0)) return;
    this.lastAnalysisAt = now;

    const evolutionReport = await this.opts.evolution.generate();
    if (!evolutionReport.readyToApply) return;

    const skillReport = await this.opts.skillDiscovery.discover();

    this.opts.onAnalysis?.({ evolution: evolutionReport, skills: skillReport });
  }
}

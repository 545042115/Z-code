// @z-assistant/runtime — background evolution scheduler tests

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { BackgroundScheduler } from '../scheduler';
import { AuditLogger } from '../../audit/logger';
import type { AuditLogEntry, RiskLevel, AutoDiscoveryReport, ISkillReviewQueue } from '@z-assistant/contracts';
import type { EvolutionEngine, EvolutionReport } from '../evolution';
import type { AutoDiscoveryEngine } from '../../skills/auto-discovery';

function makeEntry(outcome: AuditLogEntry['outcome'], toolName: string, errorMessage?: string): AuditLogEntry {
  return {
    id: 'e1',
    timestamp: Date.now(),
    invocationId: 'i1',
    toolName,
    args: {},
    risk: 'medium' as RiskLevel,
    outcome,
    errorMessage,
  };
}

describe('BackgroundScheduler', () => {
  it('triggers evolution and skill discovery after threshold failures', async () => {
    let evoRuns = 0;
    let skillRuns = 0;

    const audit = new AuditLogger();
    const evolution = {
      generate: async (): Promise<EvolutionReport> => {
        evoRuns++;
        return {
          generatedAt: Date.now(),
          windowMs: 1000,
          totalFailures: 2,
          clusters: [],
          suggestions: [],
          readyToApply: true,
        } as unknown as EvolutionReport;
      },
    } as unknown as EvolutionEngine;

    const skillDiscovery = {
      discover: async (): Promise<AutoDiscoveryReport> => {
        skillRuns++;
        return { generatedAt: Date.now(), proposed: [], skipped: [] } as unknown as AutoDiscoveryReport;
      },
    } as unknown as AutoDiscoveryEngine;

    const scheduler = new BackgroundScheduler({
      auditLogger: audit,
      evolution,
      skillDiscovery,
      reviewQueue: {} as unknown as ISkillReviewQueue,
      failureThreshold: 2,
      cooldownMs: 60000,
    });
    scheduler.start();

    // 2 failures with same pattern should trigger analysis.
    await audit.log(makeEntry('error', 'run_terminal', 'command failed: 1'));
    await audit.log(makeEntry('error', 'run_terminal', 'command failed: 2'));

    // Allow async analysis to run.
    await new Promise((r) => setTimeout(r, 50));

    scheduler.stop();

    assert.strictEqual(evoRuns, 1);
    assert.strictEqual(skillRuns, 1);
  });

  it('does not trigger on success outcomes', async () => {
    let evoRuns = 0;
    const audit = new AuditLogger();
    const evolution = {
      generate: async (): Promise<EvolutionReport> => {
        evoRuns++;
        return { readyToApply: false } as unknown as EvolutionReport;
      },
    } as unknown as EvolutionEngine;

    const scheduler = new BackgroundScheduler({
      auditLogger: audit,
      evolution,
      skillDiscovery: {} as unknown as AutoDiscoveryEngine,
      reviewQueue: {} as unknown as ISkillReviewQueue,
      failureThreshold: 1,
      cooldownMs: 60000,
    });
    scheduler.start();

    await audit.log(makeEntry('success', 'run_terminal'));
    await new Promise((r) => setTimeout(r, 20));

    scheduler.stop();

    assert.strictEqual(evoRuns, 0);
  });

  it('does not trigger when evolution report is not ready', async () => {
    let skillRuns = 0;
    const audit = new AuditLogger();
    const evolution = {
      generate: async (): Promise<EvolutionReport> => {
        return { readyToApply: false } as unknown as EvolutionReport;
      },
    } as unknown as EvolutionEngine;
    const skillDiscovery = {
      discover: async (): Promise<AutoDiscoveryReport> => {
        skillRuns++;
        return { generatedAt: Date.now(), proposed: [], skipped: [] } as unknown as AutoDiscoveryReport;
      },
    } as unknown as AutoDiscoveryEngine;

    const scheduler = new BackgroundScheduler({
      auditLogger: audit,
      evolution,
      skillDiscovery,
      reviewQueue: {} as unknown as ISkillReviewQueue,
      failureThreshold: 1,
      cooldownMs: 60000,
    });
    scheduler.start();

    await audit.log(makeEntry('error', 'run_terminal', 'boom'));
    await new Promise((r) => setTimeout(r, 20));

    scheduler.stop();

    assert.strictEqual(skillRuns, 0);
  });
});

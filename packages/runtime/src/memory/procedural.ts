// @ziner/runtime — procedural memory
//
// Skill-level "I can do X" memory. Procedural memories bridge the
// generic Runtime memory system with the Skills framework: a learned
// procedure can be recalled and turned into a skill candidate for
// validation and registration.

import type { MemoryRecord, MemoryHit } from '@ziner/contracts';
import type { MemoryManager } from './memory-manager';

export interface Procedure {
  /** Skill / procedure name. */
  name: string;
  /** Step-by-step description of the procedure. */
  steps: string;
  /** When to use this procedure. */
  whenToUse?: string;
  /** Tools or APIs involved. */
  tools?: string[];
  runId?: string;
}

export class ProceduralMemory {
  constructor(private readonly manager: MemoryManager) {}

  /** Store a learned procedure. */
  async learn(procedure: Procedure, scope: 'agent' | 'user' | 'project' | 'global' = 'agent'): Promise<MemoryRecord> {
    const content = `${procedure.name}\nWhen: ${procedure.whenToUse ?? 'any'}\n${procedure.steps}`;
    return this.manager.remember(
      content,
      'procedural',
      scope,
      {
        payload: {
          name: procedure.name,
          whenToUse: procedure.whenToUse,
          tools: procedure.tools ?? [],
        },
        importance: 0.75,
        runId: procedure.runId,
      },
    );
  }

  /** Recall procedures relevant to the current task. */
  async recall(task: string, limit = 5): Promise<MemoryHit[]> {
    return this.manager.recall(task, { kind: 'procedural', limit });
  }

  /** List stored procedures. */
  async list(limit = 100): Promise<MemoryRecord[]> {
    return this.manager.list({ kind: 'procedural', limit });
  }
}

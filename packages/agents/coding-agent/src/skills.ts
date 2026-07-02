// CodingSkillRegistry — V2 `ISkillRegistry` adapter backed by V1's
// `extensions/coding-agent/src/skills/skill-manager.ts`.
//
// Phase 6A: skeleton. R7 wires the real V1 SkillManager (which
// scans the .skills/ directory) behind this. The shape is fixed:
// implements V2 `ISkillRegistry` so V2 Apps can call select() to
// pick the top-K skills for a task.

import type {
  ISkillRegistry,
  SkillId,
  SkillSpec,
  SelectedSkill,
  TaskContext,
} from '@ziner/contracts';

export interface CodingSkillOptions {
  impl?: ISkillRegistry;
}

export class CodingSkillRegistry implements ISkillRegistry {
  readonly name = 'coding-skills';
  private _skills = new Map<SkillId, SkillSpec>();

  constructor(private readonly opts: CodingSkillOptions = {}) {}

  register(skill: SkillSpec): void {
    this._skills.set(skill.id, skill);
  }

  unregister(id: SkillId): boolean {
    return this._skills.delete(id);
  }

  async get(id: SkillId): Promise<SkillSpec | null> {
    if (this.opts.impl) return this.opts.impl.get(id);
    return this._skills.get(id) ?? null;
  }

  async list(): Promise<SkillSpec[]> {
    if (this.opts.impl) return this.opts.impl.list();
    return [...this._skills.values()];
  }

  async select(_ctx: TaskContext, topK = 5): Promise<SelectedSkill[]> {
    if (this.opts.impl) return this.opts.impl.select(_ctx, topK);
    // Phase 6A stub — R7 delegates to V1 SkillSelector
    return [...this._skills.values()].slice(0, topK).map((skill) => ({
      skill,
      score: 1,
      reasons: [{ type: 'priority', detail: 'stub', score: 1 }],
    }));
  }
}

// Skill Registry Contracts — interface for the V2 Skill system.
//
// `ISkillRegistry` is the canonical lookup surface for skill
// packages. Concrete skills (PR review, refactor, browser
// navigation, research summarization) live in their agent packages
// and register themselves with the registry on boot.

import type { TaskContext } from './agent';

// ── Skill identity ───────────────────────────────────────────────────

export type SkillId = string;

// ── SkillSpec ─────────────────────────────────────────────────────────

export interface SkillSpec {
  /** Stable id within the registry. */
  id: SkillId;
  /** Human-readable name. */
  name: string;
  /** What this skill is good for; surfaced in the UI. */
  description?: string;
  /** Tags for routing. */
  tags: string[];
  /** Free-form triggers: intents, file globs, keywords. */
  triggers?: {
    intents?: string[];
    fileGlobs?: string[];
    keywords?: string[];
  };
  /** 0-100; higher = preferred when multiple match. */
  priority?: number;
  /** Advisory vs strict mode. */
  mode?: 'advisory' | 'strict';
  /** Skill body (markdown). */
  body: string;
}

// ── Skill selection result ───────────────────────────────────────────

export interface SkillSelectionReason {
  type: 'trigger' | 'keyword' | 'tag' | 'file' | 'priority' | 'import';
  detail: string;
  score: number;
}

export interface SelectedSkill {
  skill: SkillSpec;
  score: number;
  reasons: SkillSelectionReason[];
}

// ── ISkillRegistry ────────────────────────────────────────────────────

export interface ISkillRegistry {
  readonly name: string;
  /** Register a skill. Idempotent; re-registration replaces by id. */
  register(skill: SkillSpec): void;
  /** Unregister a skill by id. */
  unregister(id: SkillId): boolean;
  /** Look up a skill by id. */
  get(id: SkillId): Promise<SkillSpec | null>;
  /** List all skills. */
  list(): Promise<SkillSpec[]>;
  /** Select skills for a given task context. */
  select(ctx: TaskContext, topK?: number): Promise<SelectedSkill[]>;
}

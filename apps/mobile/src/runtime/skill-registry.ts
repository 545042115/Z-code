// Mobile Skill Loader
//
// Discovers SKILL.md files bundled with the mobile app (Vite import.meta.glob)
// and parses them using the same parser as the desktop runtime.
//
// Each SKILL.md is a markdown file with YAML frontmatter following the
// OpenClaw / ModelScope convention. Loaded at app startup, refreshed
// on demand. Selected skills add their content to the system prompt
// and provide trigger keywords for auto-activation.
//
// NOTE: We import directly from skill-parser.ts and skills.ts (not the
// package index) to avoid pulling in Node.js fs/path modules that
// can't run in a browser/WebView environment.
import { selectSkills } from '../../../../packages/runtime/src/skills/skills.ts';
import { parseSkillFile } from '../../../../packages/runtime/src/skills/skill-parser.ts';
import type {
  Skill,
  SkillIndex,
  SelectedSkill,
  SkillSelectionInput,
} from '../../../../packages/runtime/src/skills/skills.ts';

import { skillModules } from './generated/skills-manifest';

export interface SkillRegistryOptions {
  /** Maximum skills to include in system prompt. */
  maxInjected?: number;
}

export class SkillRegistry {
  private index: SkillIndex = { skills: [], lastUpdated: 0 };
  private selected: Map<string, SelectedSkill> = new Map();
  private options: Required<SkillRegistryOptions>;

  constructor(options: SkillRegistryOptions = {}) {
    this.options = { maxInjected: options.maxInjected ?? 3 };
    this.loadBundledSkills();
  }

  /** Load all SKILL.md files bundled with the app via Vite. */
  private loadBundledSkills(): void {
    const skills: Skill[] = [];
    for (const mod of skillModules) {
      try {
        const raw = mod.content as string;
        const path = mod.path;
        const rootDir = path.replace(/\/SKILL\.md$/, '');
        const skill = parseSkillFile(raw, path, rootDir);
        if (skill) {
          skills.push(skill);
        }
      } catch (err) {
        console.warn(`[SkillRegistry] Failed to parse ${mod.path}:`, err);
      }
    }
    this.index = { skills, lastUpdated: Date.now() };
  }

  /** Reload skills (e.g. after adding new ones). */
  reload(): void {
    this.loadBundledSkills();
    this.selected.clear();
  }

  /** Get the in-memory index. */
  getIndex(): SkillIndex {
    return this.index;
  }

  /** List all bundled skills. */
  listSkills(): Skill[] {
    return this.index.skills;
  }

  /** Select skills for a user request. Returns the selected skills
   *  and caches them in `selected` map for system prompt injection. */
  selectFor(userRequest: string): SelectedSkill[] {
    const input: SkillSelectionInput = { userRequest, topK: this.options.maxInjected };
    const selected = selectSkills(this.index, input);
    for (const s of selected) {
      this.selected.set(s.skill.id, s);
    }
    return selected;
  }

  /** Build the system prompt addition from currently selected skills. */
  buildSystemPromptAddition(): string {
    if (this.selected.size === 0) return '';
    const sections: string[] = [];
    for (const s of this.selected.values()) {
      const sk = s.skill;
      sections.push(`# 技能：${sk.name}\n\n${sk.content}`);
    }
    return sections.join('\n\n---\n\n');
  }

  /** Clear the active selection. */
  clearSelection(): void {
    this.selected.clear();
  }

  /** Total number of bundled skills. */
  get size(): number {
    return this.index.skills.length;
  }
}

// Skill Loader - Discovers SKILL.md files from .skills/ directory.
//
// Phase 6A: the YAML frontmatter parser + markdown section splitter
// have moved to V2 (`@z-assistant/runtime/skills/skill-parser`).
// This file keeps only the filesystem scan (which is Coding-specific
// because it uses the V1 workspace root convention).

import * as fs from 'fs';
import * as path from 'path';
import { Skill, SkillIndex } from './skill-types';
import { parseSkillFile } from '@z-assistant/runtime';

export class SkillLoader {
  private readonly SKILL_DIR = '.skills';
  private readonly SKILL_FILE = 'SKILL.md';

  /**
   * Discover all SKILL.md files under the workspace's .skills/ directory.
   */
  discoverSkills(workspaceRoot: string): Skill[] {
    const skillDir = path.join(workspaceRoot, this.SKILL_DIR);
    if (!fs.existsSync(skillDir)) {
      return [];
    }

    const skills: Skill[] = [];
    const entries = this.listSkillMdFiles(skillDir);

    for (const filePath of entries) {
      try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        // Delegate parsing to V2 framework
        const skill = parseSkillFile(raw, filePath, path.dirname(filePath));
        if (skill) {
          skills.push(skill);
        }
      } catch (err) {
        console.warn(`[SkillLoader] Failed to parse ${filePath}:`, err);
      }
    }

    return skills;
  }

  /**
   * Recursively list all SKILL.md files under a directory.
   */
  private listSkillMdFiles(dir: string): string[] {
    const results: string[] = [];
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          results.push(...this.listSkillMdFiles(fullPath));
        } else if (entry.isFile() && entry.name === this.SKILL_FILE) {
          results.push(fullPath);
        }
      }
    } catch {
      // ignore unreadable directories
    }
    return results;
  }

  /**
   * Build a SkillIndex from the workspace root.
   */
  buildIndex(workspaceRoot: string): SkillIndex {
    const skills = this.discoverSkills(workspaceRoot);
    return {
      skills,
      lastUpdated: Date.now(),
    };
  }

  /**
   * Check if the index is stale (older than maxAgeMs).
   */
  isStale(index: SkillIndex, maxAgeMs: number = 30000): boolean {
    return Date.now() - index.lastUpdated > maxAgeMs;
  }
}

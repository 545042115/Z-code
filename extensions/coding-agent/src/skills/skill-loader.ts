// Skill Loader - Discovers SKILL.md files from .skills/ directory.
//
// Phase 6A: the YAML frontmatter parser + markdown section splitter
// have moved to V2 (`@ziner/runtime/skills/skill-parser`).
// This file keeps only the filesystem scan (which is Coding-specific
// because it uses the V1 workspace root convention).

import * as fs from 'fs';
import * as path from 'path';
import { Skill, SkillIndex } from './skill-types';
import { parseSkillFile } from '@ziner/runtime';

export class SkillLoader {
  private readonly SKILL_DIR = '.skills';
  private readonly SKILL_FILE = 'SKILL.md';
  private readonly REFERENCES_DIR = 'references';

  /**
   * Discover all SKILL.md files under the workspace's .skills/ directory.
   * OpenClaw-compatible: loads additional markdown files from the
   * skill's `references/` directory and appends them to the skill content.
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
        let skill = parseSkillFile(raw, filePath, path.dirname(filePath));
        if (skill) {
          skill = this.loadReferences(skill);
          skills.push(skill);
        }
      } catch (err) {
        console.warn(`[SkillLoader] Failed to parse ${filePath}:`, err);
      }
    }

    return skills;
  }

  /**
   * Load markdown references from `<skillRoot>/references/*.md` and append
   * them to the skill content and sections.references.
   */
  private loadReferences(skill: Skill): Skill {
    const refsDir = path.join(skill.rootDir, this.REFERENCES_DIR);
    if (!fs.existsSync(refsDir) || !fs.statSync(refsDir).isDirectory()) {
      return skill;
    }

    const files = fs.readdirSync(refsDir)
      .filter(name => name.endsWith('.md'))
      .sort();

    if (files.length === 0) {
      return skill;
    }

    const parts: string[] = [];
    for (const file of files) {
      const filePath = path.join(refsDir, file);
      try {
        const content = fs.readFileSync(filePath, 'utf-8').trim();
        if (content) {
          parts.push(`## Reference: ${file}\n\n${content}`);
        }
      } catch (err) {
        console.warn(`[SkillLoader] Failed to read reference ${filePath}:`, err);
      }
    }

    if (parts.length === 0) {
      return skill;
    }

    const refsContent = parts.join('\n\n');
    const existingRefs = skill.sections.references || '';
    return {
      ...skill,
      content: `${skill.content}\n\n${refsContent}`.trim(),
      sections: {
        ...skill.sections,
        references: existingRefs ? `${existingRefs}\n\n${refsContent}` : refsContent,
      },
    };
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

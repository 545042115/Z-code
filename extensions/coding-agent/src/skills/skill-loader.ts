// Skill Loader - Discovers and parses SKILL.md files from .skills/ directory.
//
// Scans: .skills/**/SKILL.md
// Parses YAML frontmatter + markdown body
// Generates SkillIndex for fast lookup.

import * as fs from 'fs';
import * as path from 'path';
import { Skill, SkillIndex, SkillFrontmatter } from './skill-types';

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
        const skill = this.parseSkillFile(raw, filePath);
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
   * Parse a single SKILL.md file into a Skill object.
   * Supports YAML frontmatter delimited by `---`.
   */
  private parseSkillFile(raw: string, filePath: string): Skill | null {
    const trimmed = raw.trim();
    if (!trimmed.startsWith('---')) {
      // No frontmatter: treat entire content as body, derive name from directory
      const name = path.basename(path.dirname(filePath));
      return {
        name,
        tags: [],
        content: trimmed,
        path: filePath,
      };
    }

    const endIdx = trimmed.indexOf('---', 3);
    if (endIdx === -1) {
      return null;
    }

    const frontmatterRaw = trimmed.slice(3, endIdx).trim();
    const content = trimmed.slice(endIdx + 3).trim();

    const frontmatter = this.parseFrontmatter(frontmatterRaw);

    return {
      name: frontmatter.name || path.basename(path.dirname(filePath)),
      tags: frontmatter.tags || [],
      content,
      path: filePath,
    };
  }

  /**
   * Very lightweight YAML frontmatter parser for simple key/value and lists.
   * Handles:
   *   name: Python CV
   *   tags:
   *     - opencv
   *     - image-processing
   */
  private parseFrontmatter(raw: string): SkillFrontmatter {
    const result: SkillFrontmatter = { name: '', tags: [] };
    const lines = raw.split('\n');
    let currentKey = '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const listMatch = trimmed.match(/^-\s+(.+)$/);
      if (listMatch && currentKey === 'tags') {
        result.tags.push(listMatch[1].trim());
        continue;
      }

      const kvMatch = trimmed.match(/^([\w-]+):\s*(.*)$/);
      if (kvMatch) {
        currentKey = kvMatch[1];
        const value = kvMatch[2].trim();
        if (currentKey === 'name') {
          result.name = value;
        } else if (currentKey === 'tags') {
          // Inline array: tags: [a, b, c]
          const inlineArr = value.match(/^\[(.*)\]$/);
          if (inlineArr) {
            result.tags = inlineArr[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, ''));
          }
        }
      }
    }

    return result;
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

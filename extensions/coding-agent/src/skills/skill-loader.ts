// Skill Loader - Discovers and parses SKILL.md files from .skills/ directory.
//
// Scans: .skills/**/SKILL.md
// Parses YAML frontmatter + markdown body with structured sections
// Generates SkillIndex for fast lookup.

import * as fs from 'fs';
import * as path from 'path';
import { Skill, SkillIndex, SkillFrontmatter, SkillSections, SkillMode } from './skill-types';

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
   * Backward compatible: old format with only name + tags still works.
   */
  private parseSkillFile(raw: string, filePath: string): Skill | null {
    const trimmed = raw.trim();
    const rootDir = path.dirname(filePath);
    const id = path.basename(rootDir);

    if (!trimmed.startsWith('---')) {
      // No frontmatter: treat entire content as body, derive name from directory
      return {
        id,
        name: id,
        tags: [],
        priority: 50,
        mode: 'advisory',
        triggers: {},
        stopIf: [],
        imports: [],
        toolsAllow: [],
        verification: {},
        content: trimmed,
        sections: this.parseSections(trimmed),
        path: filePath,
        rootDir,
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
      id,
      name: frontmatter.name || id,
      description: frontmatter.description,
      tags: frontmatter.tags || [],
      priority: frontmatter.priority ?? 50,
      mode: frontmatter.mode || 'advisory',
      triggers: frontmatter.triggers || {},
      stopIf: frontmatter.stopIf || [],
      imports: frontmatter.imports || [],
      toolsAllow: frontmatter.toolsAllow || [],
      verification: frontmatter.verification || {},
      content,
      sections: this.parseSections(content),
      path: filePath,
      rootDir,
    };
  }

  /**
   * Parse YAML frontmatter with support for all new fields.
   * Handles: name, description, tags, priority, mode, triggers, stop_if,
   * imports, tools_allow, verification.
   */
  private parseFrontmatter(raw: string): SkillFrontmatter {
    const result: SkillFrontmatter = { name: '', tags: [] };
    const lines = raw.split('\n');
    let currentKey = '';
    let inList = false;
    let listTarget: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      // List item: - value
      const listMatch = trimmed.match(/^-\s+(.+)$/);
      if (listMatch && inList) {
        const value = listMatch[1].trim().replace(/^['"]|['"]$/g, '');
        listTarget.push(value);
        continue;
      }

      // Reset list state if we hit a new key
      inList = false;
      listTarget = [];

      // Key-value pair
      const kvMatch = trimmed.match(/^([\w_-]+):\s*(.*)$/);
      if (kvMatch) {
        currentKey = this.normalizeKey(kvMatch[1]);
        const value = kvMatch[2].trim();

        switch (currentKey) {
          case 'name':
            result.name = value.replace(/^['"]|['"]$/g, '');
            break;
          case 'description':
            result.description = value.replace(/^['"]|['"]$/g, '');
            break;
          case 'tags': {
            const inlineArr = value.match(/^\[(.*)\]$/);
            if (inlineArr) {
              result.tags = inlineArr[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, ''));
            } else if (!value) {
              // Multi-line list follows
              inList = true;
              listTarget = result.tags;
            }
            break;
          }
          case 'priority': {
            const num = parseInt(value, 10);
            if (!isNaN(num)) result.priority = Math.max(0, Math.min(100, num));
            break;
          }
          case 'mode':
            if (value === 'advisory' || value === 'strict') {
              result.mode = value as SkillMode;
            }
            break;
          case 'stopif': {
            const inlineArr = value.match(/^\[(.*)\]$/);
            if (inlineArr) {
              result.stopIf = inlineArr[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, ''));
            } else if (!value) {
              inList = true;
              listTarget = result.stopIf = result.stopIf || [];
            }
            break;
          }
          case 'imports': {
            const inlineArr = value.match(/^\[(.*)\]$/);
            if (inlineArr) {
              result.imports = inlineArr[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, ''));
            } else if (!value) {
              inList = true;
              listTarget = result.imports = result.imports || [];
            }
            break;
          }
          case 'toolsallow': {
            const inlineArr = value.match(/^\[(.*)\]$/);
            if (inlineArr) {
              result.toolsAllow = inlineArr[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, ''));
            } else if (!value) {
              inList = true;
              listTarget = result.toolsAllow = result.toolsAllow || [];
            }
            break;
          }
          case 'triggers':
            if (!result.triggers) result.triggers = {};
            break;
          case 'verification':
            if (!result.verification) result.verification = {};
            break;
        }

        // Sub-keys for triggers and verification
        if (currentKey === 'triggers' || currentKey === 'verification') {
          // Track that we're inside a nested block
        }
        continue;
      }

      // Sub-key (indented): e.g., "  intents:" under triggers
      const subKvMatch = trimmed.match(/^([\w_-]+):\s*(.*)$/);
      if (subKvMatch && (currentKey === 'triggers' || currentKey === 'verification')) {
        const subKey = this.normalizeKey(subKvMatch[1]);
        const subValue = subKvMatch[2].trim();

        if (currentKey === 'triggers') {
          if (!result.triggers) result.triggers = {};
          const inlineArr = subValue.match(/^\[(.*)\]$/);
          if (inlineArr) {
            const items = inlineArr[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, ''));
            if (subKey === 'intents') result.triggers.intents = items;
            else if (subKey === 'fileglobs') result.triggers.fileGlobs = items;
            else if (subKey === 'keywords') result.triggers.keywords = items;
          } else if (!subValue) {
            // Multi-line list follows
            inList = true;
            if (subKey === 'intents') {
              result.triggers.intents = result.triggers.intents || [];
              listTarget = result.triggers.intents;
            } else if (subKey === 'fileglobs') {
              result.triggers.fileGlobs = result.triggers.fileGlobs || [];
              listTarget = result.triggers.fileGlobs;
            } else if (subKey === 'keywords') {
              result.triggers.keywords = result.triggers.keywords || [];
              listTarget = result.triggers.keywords;
            }
          }
        } else if (currentKey === 'verification') {
          if (!result.verification) result.verification = {};
          const inlineArr = subValue.match(/^\[(.*)\]$/);
          if (inlineArr) {
            const items = inlineArr[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, ''));
            if (subKey === 'commands') result.verification.commands = items;
            else if (subKey === 'notes') result.verification.notes = items;
          } else if (!subValue) {
            inList = true;
            if (subKey === 'commands') {
              result.verification.commands = result.verification.commands || [];
              listTarget = result.verification.commands;
            } else if (subKey === 'notes') {
              result.verification.notes = result.verification.notes || [];
              listTarget = result.verification.notes;
            }
          }
        }
      }
    }

    return result;
  }

  /**
   * Normalize YAML keys: convert snake_case to camelCase.
   */
  private normalizeKey(key: string): string {
    return key.replace(/_([a-z])/g, (_, c) => c.toLowerCase());
  }

  /**
   * Parse markdown body into structured sections.
   * Recognizes: Purpose, Use When, Workflow, Do, Do Not,
   * Preferred Tools, Verification, References, Examples.
   */
  private parseSections(content: string): SkillSections {
    const sections: SkillSections = {};
    const sectionMap: Record<string, keyof SkillSections> = {
      'purpose': 'purpose',
      'use when': 'useWhen',
      'workflow': 'workflow',
      'do': 'do',
      'do not': 'doNot',
      'preferred tools': 'preferredTools',
      'verification': 'verification',
      'references': 'references',
      'examples': 'examples',
    };

    const lines = content.split('\n');
    let currentSection: string | null = null;
    let currentContent: string[] = [];

    for (const line of lines) {
      const headingMatch = line.match(/^#{1,3}\s+(.+)$/);
      if (headingMatch) {
        // Save previous section
        if (currentSection) {
          const key = sectionMap[currentSection.toLowerCase()];
          if (key) {
            sections[key] = currentContent.join('\n').trim();
          } else {
            // Allow arbitrary section keys
            sections[currentSection.toLowerCase()] = currentContent.join('\n').trim();
          }
        }
        currentSection = headingMatch[1].trim();
        currentContent = [];
      } else {
        currentContent.push(line);
      }
    }

    // Save last section
    if (currentSection) {
      const key = sectionMap[currentSection.toLowerCase()];
      if (key) {
        sections[key] = currentContent.join('\n').trim();
      } else {
        sections[currentSection.toLowerCase()] = currentContent.join('\n').trim();
      }
    }

    return sections;
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

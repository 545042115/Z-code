// Skill Validator - Validates SKILL.md files for correctness.
//
// Checks:
// - SKILL.md exists
// - Frontmatter is properly closed
// - Required fields (name) are present
// - mode is valid
// - priority is in range
// - imports can be resolved
// - No circular imports
// - Referenced files (references/, scripts/) exist

import * as fs from 'fs';
import * as path from 'path';
import { Skill, SkillValidationIssue, SkillValidationResult } from './skill-types';

export class SkillValidator {
  /**
   * Validate all skills in the workspace.
   */
  validateAll(skills: Skill[]): SkillValidationResult {
    const issues: SkillValidationIssue[] = [];

    // Validate each skill individually
    for (const skill of skills) {
      issues.push(...this.validateSkill(skill));
    }

    // Check for circular imports across all skills
    const cycles = this.detectCycles(skills);
    for (const cycle of cycles) {
      issues.push({
        skillId: cycle[0],
        skillPath: skills.find(s => s.id === cycle[0])?.path || '',
        severity: 'error',
        message: `Import cycle detected: ${cycle.join(' -> ')}`,
      });
    }

    // Check for unresolved imports
    const skillIds = new Set(skills.map(s => s.id));
    const skillNames = new Set(skills.map(s => s.name.toLowerCase()));
    for (const skill of skills) {
      for (const importRef of skill.imports) {
        if (!skillIds.has(importRef) && !skillNames.has(importRef.toLowerCase())) {
          issues.push({
            skillId: skill.id,
            skillPath: skill.path,
            severity: 'warning',
            message: `Import "${importRef}" cannot be resolved to any known skill`,
          });
        }
      }
    }

    return {
      valid: !issues.some(i => i.severity === 'error'),
      issues,
    };
  }

  /**
   * Validate a single skill.
   */
  private validateSkill(skill: Skill): SkillValidationIssue[] {
    const issues: SkillValidationIssue[] = [];

    // Check name
    if (!skill.name || skill.name.trim() === '') {
      issues.push({
        skillId: skill.id,
        skillPath: skill.path,
        severity: 'error',
        message: 'Missing required field: name',
      });
    }

    // Check mode
    if (skill.mode !== 'advisory' && skill.mode !== 'strict') {
      issues.push({
        skillId: skill.id,
        skillPath: skill.path,
        severity: 'warning',
        message: `Invalid mode: "${skill.mode}". Must be "advisory" or "strict"`,
      });
    }

    // Check priority range
    if (skill.priority < 0 || skill.priority > 100) {
      issues.push({
        skillId: skill.id,
        skillPath: skill.path,
        severity: 'warning',
        message: `Priority ${skill.priority} out of range [0, 100]`,
      });
    }

    // Check description
    if (!skill.description && skill.tags.length === 0) {
      issues.push({
        skillId: skill.id,
        skillPath: skill.path,
        severity: 'warning',
        message: 'No description or tags provided. Skill may be difficult to discover.',
      });
    }

    // Check SKILL.md file exists
    if (!fs.existsSync(skill.path)) {
      issues.push({
        skillId: skill.id,
        skillPath: skill.path,
        severity: 'error',
        message: `SKILL.md file not found: ${skill.path}`,
      });
    } else {
      // Check frontmatter is properly closed
      try {
        const raw = fs.readFileSync(skill.path, 'utf-8').trim();
        if (raw.startsWith('---')) {
          const endIdx = raw.indexOf('---', 3);
          if (endIdx === -1) {
            issues.push({
              skillId: skill.id,
              skillPath: skill.path,
              severity: 'error',
              message: 'Frontmatter not properly closed (missing closing ---)',
            });
          }
        }
      } catch {
        // File read error already caught above
      }
    }

    // Check references/ files exist
    if (skill.sections.references) {
      const refDir = path.join(skill.rootDir, 'references');
      if (fs.existsSync(refDir)) {
        const refFiles = fs.readdirSync(refDir).filter(f => f.endsWith('.md'));
        // Just verify the directory exists and has files
        if (refFiles.length === 0) {
          issues.push({
            skillId: skill.id,
            skillPath: skill.path,
            severity: 'warning',
            message: 'References section exists but references/ directory is empty',
          });
        }
      }
    }

    // Check scripts/ files exist
    if (skill.verification.commands && skill.verification.commands.length > 0) {
      const scriptsDir = path.join(skill.rootDir, 'scripts');
      // Scripts directory is optional; verification commands may be system commands
      if (fs.existsSync(scriptsDir)) {
        const scriptFiles = fs.readdirSync(scriptsDir);
        for (const cmd of skill.verification.commands) {
          // Check if the command references a local script
          const scriptName = cmd.split(' ')[0];
          if (scriptName.includes('/') || scriptName.endsWith('.js') || scriptName.endsWith('.sh') || scriptName.endsWith('.ts')) {
            const baseName = path.basename(scriptName);
            if (!scriptFiles.some(f => f === baseName)) {
              issues.push({
                skillId: skill.id,
                skillPath: skill.path,
                severity: 'warning',
                message: `Verification command references script "${baseName}" not found in scripts/ directory`,
              });
            }
          }
        }
      }
    }

    return issues;
  }

  /**
   * Detect circular imports using DFS.
   */
  private detectCycles(skills: Skill[]): string[][] {
    const cycles: string[][] = [];
    const visited = new Set<string>();
    const recursionStack = new Set<string>();
    const currentPath: string[] = [];

    const skillMap = new Map(skills.map(s => [s.id, s]));

    const dfs = (skillId: string) => {
      if (recursionStack.has(skillId)) {
        const cycleStart = currentPath.indexOf(skillId);
        if (cycleStart >= 0) {
          cycles.push(currentPath.slice(cycleStart).concat(skillId));
        }
        return;
      }
      if (visited.has(skillId)) return;

      visited.add(skillId);
      recursionStack.add(skillId);
      currentPath.push(skillId);

      const skill = skillMap.get(skillId);
      if (skill && skill.imports) {
        for (const importRef of skill.imports) {
          const importedSkill = skills.find(s =>
            s.id === importRef || s.name.toLowerCase() === importRef.toLowerCase()
          );
          if (importedSkill) {
            dfs(importedSkill.id);
          }
        }
      }

      currentPath.pop();
      recursionStack.delete(skillId);
    };

    for (const skill of skills) {
      dfs(skill.id);
    }

    return cycles;
  }

  /**
   * Format validation result as a readable string.
   */
  formatResult(result: SkillValidationResult): string {
    const lines: string[] = [];

    if (result.valid) {
      lines.push('All skills are valid.');
    } else {
      lines.push('Skill validation found errors:');
    }

    if (result.issues.length === 0) {
      lines.push('No issues found.');
      return lines.join('\n');
    }

    const errors = result.issues.filter(i => i.severity === 'error');
    const warnings = result.issues.filter(i => i.severity === 'warning');

    if (errors.length > 0) {
      lines.push(`\nErrors (${errors.length}):`);
      for (const e of errors) {
        lines.push(`  [${e.skillId}] ${e.message}`);
      }
    }

    if (warnings.length > 0) {
      lines.push(`\nWarnings (${warnings.length}):`);
      for (const w of warnings) {
        lines.push(`  [${w.skillId}] ${w.message}`);
      }
    }

    return lines.join('\n');
  }
}

// Skill Manager - Orchestrates Skill discovery, selection, loading, and prompt injection.
//
// Pipeline:
//   1. discover()     → scan .skills/**/SKILL.md, build cached index
//   2. select()       → rank skills by relevance, return Top-K with reasons
//   3. load()         → return full SelectedSkill objects (already loaded by select)
//   4. getPrompt()    → format selected skills into structured prompt injection

import * as vscode from 'vscode';
import { SkillLoader } from './skill-loader';
import { SkillSelector } from './skill-selector';
import { SkillIndex, SelectedSkill, SkillSelectionInput, Skill } from './skill-types';
import { BudgetManager, DEFAULT_BUDGET } from '../context/context-budget';

export class SkillManager {
  private readonly loader: SkillLoader;
  private readonly selector: SkillSelector;
  private index: SkillIndex | null = null;

  // Prompt limits
  private readonly MAX_SKILL_PROMPT_CHARS = 5000;
  private readonly MAX_SECTION_CHARS = 400;

  constructor() {
    this.loader = new SkillLoader();
    this.selector = new SkillSelector();
  }

  /**
   * Discover skills from the workspace root.
   * Uses cached index if fresh (default 30s TTL).
   */
  discover(forceRefresh: boolean = false): SkillIndex {
    const root = this.getWorkspaceRoot();
    if (!root) {
      return { skills: [], lastUpdated: 0 };
    }

    if (!forceRefresh && this.index && !this.loader.isStale(this.index)) {
      return this.index;
    }

    this.index = this.loader.buildIndex(root);
    console.log(`[SkillManager] Discovered ${this.index.skills.length} skill(s) from ${root}`);
    return this.index;
  }

  /**
   * Select the top-K most relevant skills for the current task.
   * Automatically discovers skills if index is missing or stale.
   */
  select(input: SkillSelectionInput): SelectedSkill[] {
    const index = this.discover();
    if (index.skills.length === 0) {
      return [];
    }
    return this.selector.select(index.skills, input);
  }

  /**
   * Format selected skills into a structured prompt fragment for injection before Planner.
   * Output follows the structured format from SKILL_SYSTEM_PLAN.md section 10.
   * Uses BudgetManager to enforce skill-specific character limits.
   */
  getPrompt(selectedSkills: SelectedSkill[]): string {
    if (selectedSkills.length === 0) {
      return '';
    }

    // Sort: strict direct hits first, then advisory direct hits, then imported
    const sorted = [...selectedSkills].sort((a, b) => {
      // Direct hits before imported
      if (a.importedBy && !b.importedBy) return 1;
      if (!a.importedBy && b.importedBy) return -1;
      // Strict before advisory
      if (a.skill.mode === 'strict' && b.skill.mode !== 'strict') return -1;
      if (a.skill.mode !== 'strict' && b.skill.mode === 'strict') return 1;
      return 0;
    });

    // Use BudgetManager for skill prompt allocation
    const budgetMgr = new BudgetManager({
      ...DEFAULT_BUDGET,
      maxSkillChars: this.MAX_SKILL_PROMPT_CHARS,
      maxTotalChars: this.MAX_SKILL_PROMPT_CHARS,
    });

    for (const selected of sorted) {
      const block = this.formatSkillBlock(selected);
      const isImported = !!selected.importedBy;
      budgetMgr.addChunk('skill', `Skill: ${selected.skill.name}`, block, {
        priority: isImported ? 40 : 75,
        trimmable: true,
      });
    }

    const allocation = budgetMgr.allocate();
    const content = budgetMgr.buildPromptFromResult(allocation);

    return `## Active Skills\n\nThe following local skills are active. Follow strict skills as hard constraints and advisory skills as strong guidance.\n\n${content}`;
  }

  /**
   * Format a single skill into a structured prompt block.
   */
  private formatSkillBlock(selected: SelectedSkill): string {
    const skill = selected.skill;
    const lines: string[] = [];

    lines.push(`### Skill: ${skill.name}`);
    lines.push(`Mode: ${skill.mode}`);
    lines.push(`Score: ${Math.round(selected.score * 100)}%`);

    if (selected.reasons.length > 0) {
      lines.push('Reasons:');
      for (const r of selected.reasons.slice(0, 3)) {
        lines.push(`- ${r.detail}`);
      }
    }

    if (selected.importedBy) {
      lines.push(`Imported by: ${selected.importedBy}`);
    }

    // Structured sections
    const sectionOrder: { key: string; label: string }[] = [
      { key: 'purpose', label: 'Purpose' },
      { key: 'workflow', label: 'Workflow' },
      { key: 'do', label: 'Do' },
      { key: 'doNot', label: 'Do Not' },
      { key: 'preferredTools', label: 'Preferred Tools' },
      { key: 'verification', label: 'Verification' },
      { key: 'references', label: 'References' },
    ];

    for (const { key, label } of sectionOrder) {
      const content = skill.sections[key];
      if (content) {
        const truncated = this.truncateSection(content, this.MAX_SECTION_CHARS);
        lines.push(`${label}:\n${truncated}`);
      }
    }

    // Verification commands
    if (skill.verification.commands && skill.verification.commands.length > 0) {
      lines.push(`Verification Commands: ${skill.verification.commands.join(', ')}`);
    }

    // Tools allow
    if (skill.toolsAllow.length > 0) {
      lines.push(`Preferred Tools: ${skill.toolsAllow.join(', ')}`);
    }

    return lines.join('\n') + '\n';
  }

  /**
   * Truncate a section to a maximum character count, preserving line boundaries.
   */
  private truncateSection(content: string, maxChars: number): string {
    if (content.length <= maxChars) return content;
    const truncated = content.slice(0, maxChars);
    const lastNewline = truncated.lastIndexOf('\n');
    return (lastNewline > maxChars * 0.5 ? truncated.slice(0, lastNewline) : truncated) + '...';
  }

  /**
   * Return a concise summary for UI streaming.
   */
  formatSummary(selectedSkills: SelectedSkill[]): string {
    if (selectedSkills.length === 0) {
      return '';
    }
    const lines = selectedSkills.map(s => {
      const importTag = s.importedBy ? ', imported' : '';
      const modeTag = s.skill.mode === 'strict' ? ', strict' : '';
      const reasonStr = s.reasons.slice(0, 2).map(r => r.detail).join('; ');
      return `   • ${s.name} (${Math.round(s.score * 100)}%${importTag}${modeTag}) — ${reasonStr}`;
    });
    return `已加载 ${selectedSkills.length} 个 Skill:\n${lines.join('\n')}\n\n`;
  }

  /**
   * Detect circular imports in the skill graph.
   */
  detectImportCycles(skills: Skill[]): string[][] {
    const cycles: string[][] = [];
    const visited = new Set<string>();
    const recursionStack = new Set<string>();
    const path: string[] = [];

    const skillMap = new Map(skills.map(s => [s.id, s]));

    const dfs = (skillId: string) => {
      if (recursionStack.has(skillId)) {
        const cycleStart = path.indexOf(skillId);
        if (cycleStart >= 0) {
          cycles.push(path.slice(cycleStart).concat(skillId));
        }
        return;
      }
      if (visited.has(skillId)) return;

      visited.add(skillId);
      recursionStack.add(skillId);
      path.push(skillId);

      const skill = skillMap.get(skillId);
      if (skill && skill.imports) {
        for (const importRef of skill.imports) {
          const importedSkill = skills.find(s => s.id === importRef || s.name.toLowerCase() === importRef.toLowerCase());
          if (importedSkill) {
            dfs(importedSkill.id);
          }
        }
      }

      path.pop();
      recursionStack.delete(skillId);
    };

    for (const skill of skills) {
      dfs(skill.id);
    }

    return cycles;
  }

  /**
   * Get all discovered skills.
   */
  getAllSkills(): Skill[] {
    const index = this.discover();
    return index.skills;
  }

  /**
   * Explain why a specific skill was or wasn't selected for a given input.
   */
  explainSelection(skillId: string, input: SkillSelectionInput): string {
    const index = this.discover();
    const skill = index.skills.find(s => s.id === skillId || s.name.toLowerCase() === skillId.toLowerCase());
    if (!skill) {
      return `Skill "${skillId}" not found.`;
    }

    const selected = this.select(input);
    const wasSelected = selected.some(s => s.skill.id === skill.id);

    if (wasSelected) {
      const match = selected.find(s => s.skill.id === skill.id)!;
      const reasons = match.reasons.map(r => `  - [${r.type}] ${r.detail} (score: ${r.score})`).join('\n');
      return `Skill "${skill.name}" was selected (score: ${Math.round(match.score * 100)}%).\nReasons:\n${reasons}`;
    }

    // Explain why not selected
    const requestLower = input.userRequest.toLowerCase();
    const reasons: string[] = [];

    if (skill.stopIf && skill.stopIf.some(s => requestLower.includes(s.toLowerCase()))) {
      const matched = skill.stopIf.filter(s => requestLower.includes(s.toLowerCase()));
      reasons.push(`- Blocked by stop_if: "${matched.join(', ')}"`);
    }

    if (skill.triggers.intents && skill.triggers.intents.length > 0 && input.taskType) {
      if (!skill.triggers.intents.some(i => i.toLowerCase() === input.taskType!.toLowerCase())) {
        reasons.push(`- Intent mismatch: skill requires [${skill.triggers.intents.join(', ')}], but task type is "${input.taskType}"`);
      }
    }

    if (reasons.length === 0) {
      reasons.push(`- Score below threshold (minimum 0.15 required)`);
      reasons.push(`- No matching keywords, tags, file globs, or description overlap found`);
    }

    return `Skill "${skill.name}" was NOT selected.\nReasons:\n${reasons.join('\n')}`;
  }

  /**
   * Invalidate the cached index. Call this when .skills/ directory changes.
   */
  invalidateCache(): void {
    this.index = null;
    console.log('[SkillManager] Skill index cache invalidated');
  }

  private getWorkspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }
}

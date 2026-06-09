// Skill Manager - Orchestrates Skill discovery, selection, loading, and prompt injection.
//
// Pipeline:
//   1. discover()     → scan .skills/**/SKILL.md, build cached index
//   2. select()       → rank skills by relevance, return Top-K
//   3. load()         → return full SelectedSkill objects (already loaded by select)
//   4. getPrompt()    → format selected skills for Planner prompt injection

import * as vscode from 'vscode';
import { SkillLoader } from './skill-loader';
import { SkillSelector } from './skill-selector';
import { SkillIndex, SelectedSkill, SkillSelectionInput } from './skill-types';

export class SkillManager {
  private readonly loader: SkillLoader;
  private readonly selector: SkillSelector;
  private index: SkillIndex | null = null;

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
   * Format selected skills into a prompt fragment for injection before Planner.
   */
  getPrompt(selectedSkills: SelectedSkill[]): string {
    if (selectedSkills.length === 0) {
      return '';
    }

    const blocks = selectedSkills.map(s =>
      `## Skill: ${s.name}\n${s.contentPreview}${s.contentPreview.length >= 800 ? '...' : ''}\n`
    );

    return `=== ACTIVE SKILLS ===\n\n${blocks.join('\n')}=== END SKILLS ===\n`;
  }

  /**
   * Return a concise summary for UI streaming.
   */
  formatSummary(selectedSkills: SelectedSkill[]): string {
    if (selectedSkills.length === 0) {
      return '';
    }
    const lines = selectedSkills.map(s => `   • ${s.name} (${Math.round(s.score * 100)}% match)`);
    return `🛠️ 已加载 ${selectedSkills.length} 个 Skill:\n${lines.join('\n')}\n\n`;
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

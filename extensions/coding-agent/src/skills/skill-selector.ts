// Skill Selector - Ranks and selects the most relevant skills for a given task.
//
// Pipeline:
//   1. Hard filter: remove skills that are explicitly excluded
//   2. Hard trigger: detect explicit skill name mentions
//   3. Soft scoring: multi-signal weighted scoring
//   4. Import expansion: resolve imported skills
//
// Only Top-K skills are returned (default K=3).

import { Skill, SelectedSkill, SkillSelectionInput, SkillSelectionReason } from './skill-types';

export class SkillSelector {
  private readonly DEFAULT_TOP_K = 3;
  private readonly PREVIEW_LENGTH = 1500;
  private readonly MIN_SCORE = 0.15;
  private readonly MAX_IMPORTED_SKILLS = 3;
  private readonly MAX_IMPORT_DEPTH = 3;

  /**
   * Select the top-K most relevant skills for the given task.
   */
  select(skills: Skill[], input: SkillSelectionInput): SelectedSkill[] {
    if (skills.length === 0) {
      return [];
    }

    const topK = input.topK ?? this.DEFAULT_TOP_K;
    const requestLower = input.userRequest.toLowerCase();
    const taskType = input.taskType?.toLowerCase() || '';
    const involvedFiles = input.discoveryReport?.involvedFiles || [];
    const relatedSymbols = input.discoveryReport?.relatedSymbols || [];
    const currentFile = input.currentFile?.toLowerCase() || '';
    const openFiles = input.openFiles || [];

    // Collect all file paths for matching
    const allFilePaths = [
      currentFile,
      ...openFiles,
      ...involvedFiles.map(f => f.path),
    ].filter(Boolean);

    // Build keyword set from request + taskType + file extensions + symbol names
    const keywordSet = new Set<string>();
    this.tokenize(requestLower).forEach(w => keywordSet.add(w));
    if (taskType) keywordSet.add(taskType);

    allFilePaths.forEach(path => {
      const ext = this.getExt(path);
      if (ext) keywordSet.add(ext);
      this.tokenize(path.toLowerCase()).forEach(w => keywordSet.add(w));
    });

    relatedSymbols.forEach(s => {
      this.tokenize(s.name.toLowerCase()).forEach(w => keywordSet.add(w));
    });

    // Step 1: Hard filter
    const candidates = skills.filter(skill =>
      this.passesHardFilter(skill, requestLower, taskType, allFilePaths)
    );

    // Step 2: Score each candidate
    const scored = candidates.map(skill => {
      const { score, reasons } = this.scoreSkill(skill, keywordSet, requestLower, allFilePaths, relatedSymbols, taskType);
      return { skill, score, reasons };
    });

    // Step 3: Sort by score and take top-K
    scored.sort((a, b) => b.score - a.score);

    const directHits = scored
      .filter(s => s.score >= this.MIN_SCORE)
      .slice(0, topK)
      .map(({ skill, score, reasons }) => this.toSelectedSkill(skill, score, reasons));

    // Step 4: Import expansion
    const importedSkills = this.expandImports(directHits, skills, scored);

    return [...directHits, ...importedSkills];
  }

  /**
   * Hard filter: remove skills that should not be considered.
   */
  private passesHardFilter(
    skill: Skill,
    requestLower: string,
    taskType: string,
    allFilePaths: string[]
  ): boolean {
    // 1. stop_if命中用户请求
    if (skill.stopIf && skill.stopIf.length > 0) {
      for (const stopWord of skill.stopIf) {
        if (requestLower.includes(stopWord.toLowerCase())) {
          return false;
        }
      }
    }

    // 2. triggers.intents存在且不包含当前taskType
    if (skill.triggers.intents && skill.triggers.intents.length > 0 && taskType) {
      if (!skill.triggers.intents.some(intent => intent.toLowerCase() === taskType)) {
        return false;
      }
    }

    // 3. triggers.file_globs存在，且当前文件、打开文件、Discovery文件都不匹配
    if (skill.triggers.fileGlobs && skill.triggers.fileGlobs.length > 0 && allFilePaths.length > 0) {
      const anyMatch = allFilePaths.some(filePath =>
        skill.triggers.fileGlobs!.some(glob => this.matchGlob(filePath, glob))
      );
      if (!anyMatch) {
        return false;
      }
    }

    // 4. Skill缺少name
    if (!skill.name) {
      return false;
    }

    return true;
  }

  /**
   * Score a single skill using multi-signal weighted scoring.
   */
  private scoreSkill(
    skill: Skill,
    keywordSet: Set<string>,
    requestLower: string,
    allFilePaths: string[],
    relatedSymbols: { name: string; kind: string; filePath?: string }[],
    taskType: string
  ): { score: number; reasons: SkillSelectionReason[] } {
    let score = 0;
    const reasons: SkillSelectionReason[] = [];

    // 1. Skill name explicit match (weight: 0.35)
    if (requestLower.includes(skill.name.toLowerCase())) {
      score += 0.35;
      reasons.push({ type: 'trigger', detail: `name "${skill.name}" mentioned in request`, score: 0.35 });
    }

    // 2. triggers.keywords match (weight: 0.25)
    if (skill.triggers.keywords && skill.triggers.keywords.length > 0) {
      let matchedKeywords = 0;
      const matchedNames: string[] = [];
      for (const kw of skill.triggers.keywords) {
        if (requestLower.includes(kw.toLowerCase())) {
          matchedKeywords++;
          matchedNames.push(kw);
        }
      }
      if (matchedKeywords > 0) {
        const kwScore = Math.min(0.25, matchedKeywords * 0.1);
        score += kwScore;
        reasons.push({ type: 'keyword', detail: `matched keywords: ${matchedNames.join(', ')}`, score: kwScore });
      }
    }

    // 3. file_globs match (weight: 0.20)
    if (skill.triggers.fileGlobs && skill.triggers.fileGlobs.length > 0 && allFilePaths.length > 0) {
      const matchedGlobs: string[] = [];
      for (const glob of skill.triggers.fileGlobs) {
        if (allFilePaths.some(fp => this.matchGlob(fp, glob))) {
          matchedGlobs.push(glob);
        }
      }
      if (matchedGlobs.length > 0) {
        const globScore = Math.min(0.20, matchedGlobs.length * 0.1);
        score += globScore;
        reasons.push({ type: 'file', detail: `matched file globs: ${matchedGlobs.join(', ')}`, score: globScore });
      }
    }

    // 4. tags match (weight: 0.15)
    if (skill.tags.length > 0) {
      let matchedTags = 0;
      const matchedNames: string[] = [];
      for (const tag of skill.tags) {
        const tagLower = tag.toLowerCase();
        if (keywordSet.has(tagLower) || requestLower.includes(tagLower)) {
          matchedTags++;
          matchedNames.push(tag);
        }
      }
      if (matchedTags > 0) {
        const tagScore = Math.min(0.15, matchedTags * 0.05);
        score += tagScore;
        reasons.push({ type: 'tag', detail: `matched tags: ${matchedNames.join(', ')}`, score: tagScore });
      }
    }

    // 5. description keyword overlap (weight: 0.15)
    if (skill.description) {
      const descWords = this.tokenize(skill.description.toLowerCase());
      let overlapCount = 0;
      for (const kw of keywordSet) {
        if (descWords.includes(kw)) {
          overlapCount++;
        }
      }
      if (overlapCount > 0) {
        const descScore = Math.min(0.15, overlapCount * 0.03);
        score += descScore;
        reasons.push({ type: 'keyword', detail: `description overlap: ${overlapCount} keywords`, score: descScore });
      }
    }

    // 6. Related symbol name match (weight: 0.10)
    if (relatedSymbols.length > 0) {
      const skillText = (skill.name + ' ' + skill.tags.join(' ')).toLowerCase();
      let symbolMatches = 0;
      for (const sym of relatedSymbols) {
        if (skillText.includes(sym.name.toLowerCase())) {
          symbolMatches++;
        }
      }
      if (symbolMatches > 0) {
        const symScore = Math.min(0.10, symbolMatches * 0.05);
        score += symScore;
        reasons.push({ type: 'symbol', detail: `matched ${symbolMatches} symbol(s)`, score: symScore });
      }
    }

    // 7. Priority boost (0.00 to 0.10)
    if (skill.priority > 50) {
      const priorityScore = ((skill.priority - 50) / 50) * 0.10;
      score += priorityScore;
      reasons.push({ type: 'priority', detail: `priority ${skill.priority}`, score: Math.round(priorityScore * 1000) / 1000 });
    }

    // Cap at 1.0
    score = Math.min(1.0, score);

    return { score, reasons };
  }

  /**
   * Expand imported skills from direct hits.
   */
  private expandImports(
    directHits: SelectedSkill[],
    allSkills: Skill[],
    scoredCandidates: { skill: Skill; score: number; reasons: SkillSelectionReason[] }[]
  ): SelectedSkill[] {
    const imported: SelectedSkill[] = [];
    const seenIds = new Set(directHits.map(s => s.skill.id));
    const queue: { skillId: string; importedBy: string; depth: number }[] = [];

    // Collect imports from direct hits
    for (const hit of directHits) {
      for (const importRef of hit.skill.imports) {
        queue.push({ skillId: importRef, importedBy: hit.skill.name, depth: 1 });
      }
    }

    while (queue.length > 0 && imported.length < this.MAX_IMPORTED_SKILLS) {
      const { skillId, importedBy, depth } = queue.shift()!;

      if (depth > this.MAX_IMPORT_DEPTH) continue;
      if (seenIds.has(skillId)) continue; // Avoid cycles and duplicates

      // Find the imported skill by id, name, or directory name
      const found = allSkills.find(s =>
        s.id === skillId || s.name.toLowerCase() === skillId.toLowerCase()
      );
      if (!found) continue;

      seenIds.add(skillId);

      // Check if this skill was already scored (and not filtered out)
      const existingScored = scoredCandidates.find(c => c.skill.id === found.id);
      const importScore = existingScored ? Math.max(existingScored.score, 0.1) : 0.1;

      const selectedImport = this.toSelectedSkill(
        found,
        importScore,
        [{ type: 'import', detail: `imported by ${importedBy}`, score: importScore }],
        importedBy
      );
      imported.push(selectedImport);

      // Recursively expand
      for (const subImport of found.imports) {
        queue.push({ skillId: subImport, importedBy: found.name, depth: depth + 1 });
      }
    }

    return imported;
  }

  /**
   * Convert a Skill + score + reasons into a SelectedSkill.
   */
  private toSelectedSkill(skill: Skill, score: number, reasons: SkillSelectionReason[], importedBy?: string): SelectedSkill {
    return {
      skill,
      score: Math.round(score * 1000) / 1000,
      reasons,
      importedBy,
      name: skill.name,
      path: skill.path,
      contentPreview: skill.content.slice(0, this.PREVIEW_LENGTH),
    };
  }

  /**
   * Match a file path against a glob pattern.
   * Supports double-star globs and single-star globs.
   */
  private matchGlob(filePath: string, glob: string): boolean {
    // Normalize separators
    const normalizedPath = filePath.replace(/\\/g, '/');
    const normalizedGlob = glob.replace(/\\/g, '/');

    // Simple glob matching: convert glob to regex
    const regexStr = normalizedGlob
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')  // Escape special regex chars (except * and ?)
      .replace(/\*\*/g, '{{DOUBLESTAR}}')      // Preserve **
      .replace(/\*/g, '[^/]*')                  // * matches anything except /
      .replace(/\?/g, '[^/]')                   // ? matches single char except /
      .replace(/\{\{DOUBLESTAR\}\}/g, '.*');    // ** matches anything including /

    try {
      const regex = new RegExp(`^${regexStr}$`, 'i');
      return regex.test(normalizedPath);
    } catch {
      // Fallback to simple extension match
      if (normalizedGlob.startsWith('*.')) {
        const ext = normalizedGlob.slice(1);
        return normalizedPath.toLowerCase().endsWith(ext.toLowerCase());
      }
      return false;
    }
  }

  private tokenize(text: string): string[] {
    return text
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 2)
      .map(w => w.toLowerCase());
  }

  private getExt(filePath: string): string | null {
    const idx = filePath.lastIndexOf('.');
    return idx > 0 ? filePath.slice(idx + 1).toLowerCase() : null;
  }
}

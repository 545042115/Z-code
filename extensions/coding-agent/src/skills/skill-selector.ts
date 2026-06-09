// Skill Selector - Ranks and selects the most relevant skills for a given task.
//
// Scoring logic:
// 1. Keyword overlap between user request and skill tags/name
// 2. File extension / language matching from discovery results
// 3. Task type alignment (e.g., 'react' skills for feature_add on .tsx files)
//
// Only Top-K skills are returned (default K=3).

import { Skill, SelectedSkill, SkillSelectionInput } from './skill-types';

export class SkillSelector {
  private readonly DEFAULT_TOP_K = 3;
  private readonly PREVIEW_LENGTH = 800;

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

    // Build keyword set from request + taskType + file extensions + symbol names
    const keywordSet = new Set<string>();
    this.tokenize(requestLower).forEach(w => keywordSet.add(w));
    if (taskType) keywordSet.add(taskType);

    involvedFiles.forEach(f => {
      const path = f.path;
      const ext = this.getExt(path);
      if (ext) keywordSet.add(ext);
      this.tokenize(path.toLowerCase()).forEach(w => keywordSet.add(w));
    });

    relatedSymbols.forEach(s => {
      this.tokenize(s.name.toLowerCase()).forEach(w => keywordSet.add(w));
    });

    const scored = skills.map(skill => {
      const score = this.scoreSkill(skill, keywordSet, requestLower);
      return {
        skill,
        score,
      };
    });

    scored.sort((a, b) => b.score - a.score);

    return scored.slice(0, topK).map(({ skill, score }) => ({
      name: skill.name,
      score: Math.round(score * 1000) / 1000,
      path: skill.path,
      contentPreview: skill.content.slice(0, this.PREVIEW_LENGTH),
    }));
  }

  /**
   * Score a single skill against the keyword set.
   */
  private scoreSkill(skill: Skill, keywordSet: Set<string>, requestLower: string): number {
    let score = 0;
    const skillText = (skill.name + ' ' + skill.tags.join(' ') + ' ' + skill.content.slice(0, 2000)).toLowerCase();
    const skillWords = this.tokenize(skillText);
    const skillWordSet = new Set(skillWords);

    // 1. Tag matches (highest weight)
    for (const tag of skill.tags) {
      const tagLower = tag.toLowerCase();
      if (keywordSet.has(tagLower)) {
        score += 0.35;
      }
      // Partial tag match in request
      if (requestLower.includes(tagLower)) {
        score += 0.25;
      }
    }

    // 2. Keyword overlap
    let overlapCount = 0;
    for (const kw of keywordSet) {
      if (skillWordSet.has(kw)) {
        overlapCount++;
      }
    }
    const overlapRatio = keywordSet.size > 0 ? overlapCount / keywordSet.size : 0;
    score += overlapRatio * 0.3;

    // 3. Name match
    if (requestLower.includes(skill.name.toLowerCase())) {
      score += 0.2;
    }

    // 4. Content keyword density bonus
    const density = skillWords.length > 0 ? overlapCount / skillWords.length : 0;
    score += density * 0.1;

    return Math.min(1.0, score);
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

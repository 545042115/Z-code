// Skill System - Type Definitions
//
// Skills are domain-specific knowledge packs stored as SKILL.md files
// under .skills/**/SKILL.md. Each skill contains structured frontmatter
// (name, description, tags, triggers, priority, mode, imports, etc.)
// and markdown content with standardized sections.

export type SkillMode = 'advisory' | 'strict';

export interface SkillTriggers {
  intents?: string[];
  fileGlobs?: string[];
  keywords?: string[];
}

export interface SkillVerification {
  commands?: string[];
  notes?: string[];
}

export interface SkillFrontmatter {
  name: string;
  description?: string;
  tags: string[];
  priority?: number;
  mode?: SkillMode;
  triggers?: SkillTriggers;
  stopIf?: string[];
  imports?: string[];
  toolsAllow?: string[];
  verification?: SkillVerification;
}

export interface SkillSections {
  purpose?: string;
  useWhen?: string;
  workflow?: string;
  do?: string;
  doNot?: string;
  preferredTools?: string;
  verification?: string;
  references?: string;
  examples?: string;
  [key: string]: string | undefined;
}

export interface Skill {
  id: string;
  name: string;
  description?: string;
  tags: string[];
  priority: number;
  mode: SkillMode;
  triggers: SkillTriggers;
  stopIf: string[];
  imports: string[];
  toolsAllow: string[];
  verification: SkillVerification;
  content: string;
  sections: SkillSections;
  path: string;
  rootDir: string;
}

export interface SkillSelectionReason {
  type: 'trigger' | 'keyword' | 'tag' | 'file' | 'symbol' | 'priority' | 'import';
  detail: string;
  score: number;
}

export interface SelectedSkill {
  skill: Skill;
  score: number;
  reasons: SkillSelectionReason[];
  importedBy?: string;
  // Backward-compatible fields
  name: string;
  path: string;
  contentPreview: string;
}

export interface SkillIndex {
  skills: Skill[];
  lastUpdated: number;
}

export interface SkillSelectionInput {
  userRequest: string;
  taskType?: string;
  currentFile?: string;
  openFiles?: string[];
  discoveryReport?: {
    involvedFiles: { path: string }[];
    relatedSymbols: { name: string; kind: string; filePath?: string }[];
  };
  topK?: number;
}

// Validation types
export interface SkillValidationIssue {
  skillId: string;
  skillPath: string;
  severity: 'error' | 'warning';
  message: string;
}

export interface SkillValidationResult {
  valid: boolean;
  issues: SkillValidationIssue[];
}

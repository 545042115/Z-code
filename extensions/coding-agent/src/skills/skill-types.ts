// Skill System - Type Definitions
//
// Skills are domain-specific knowledge packs stored as SKILL.md files
// under .skills/**/SKILL.md. Each skill contains frontmatter (name, tags)
// and markdown content with coding patterns, conventions, and best practices.

export interface SkillFrontmatter {
  name: string;
  tags: string[];
}

export interface Skill {
  name: string;
  tags: string[];
  content: string;   // Markdown body after frontmatter
  path: string;      // Absolute path to SKILL.md
}

export interface SelectedSkill {
  name: string;
  score: number;     // Relevance score 0.0 - 1.0
  path: string;
  contentPreview: string; // First N chars of content for prompt injection
}

export interface SkillIndex {
  skills: Skill[];
  lastUpdated: number; // timestamp
}

export interface SkillSelectionInput {
  userRequest: string;
  taskType?: string;
  discoveryReport?: { involvedFiles: { path: string }[]; relatedSymbols: { name: string; kind: string; filePath?: string }[] };
  topK?: number;
}

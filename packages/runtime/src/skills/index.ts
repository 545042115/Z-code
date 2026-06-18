// @z-assistant/runtime — skills
//
// Universal Skills framework. Pure Node, no vscode.
//
// Skill files are markdown documents with YAML frontmatter under
// `.skills/**/SKILL.md`. The framework defines:
//   - canonical types (Skill / SkillFrontmatter / SkillSections / SelectedSkill)
//   - pure helpers (validateSkill, scoreSkill, matchGlob, selectSkills)
//   - **skill-parser**: YAML frontmatter parser + markdown section splitter
//
// Agent-specific loaders (Coding's `skill-loader.ts`) sit on top of
// this framework and supply the file-system scan that builds a SkillIndex.
//
// This file is the framework part. It is shared by every agent
// and is the contract that V2 Apps rely on.

export {
  validateSkill,
  scoreSkill,
  matchGlob,
  selectSkills,
  type SkillMode,
  type SkillTriggers,
  type SkillVerification,
  type SkillFrontmatter,
  type SkillSections,
  type Skill,
  type SkillSelectionReason,
  type SelectedSkill,
  type SkillIndex,
  type SkillSelectionInput,
  type SkillValidationIssue,
  type SkillValidationResult,
} from './skills';

export {
  parseSkillFile,
  parseFrontmatter,
  parseSections,
} from './skill-parser';

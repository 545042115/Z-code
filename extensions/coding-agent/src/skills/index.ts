// Skills module — single import surface.
//
// Phase 6A: this is now a thin shim over the V2 Skills framework
// (`@z-assistant/runtime` re-exports the `skills` subpackage).
//
// The Coding-specific loader/selector/manager
// (skill-loader / skill-selector / skill-manager / skill-validator)
// stay in V1 — they handle the .skills/ directory scan, the
// frontmatter parser, and the manager that integrates with the
// V1 Pipeline.

export {
  validateSkill,
  scoreSkill,
  matchGlob,
  selectSkills,
  parseSkillFile,
  parseFrontmatter,
  parseSections,
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
} from '@z-assistant/runtime';

export { SkillLoader } from './skill-loader';
export { SkillSelector } from './skill-selector';
export { SkillManager } from './skill-manager';
export { SkillValidator } from './skill-validator';

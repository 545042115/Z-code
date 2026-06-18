// V1 skill-types.ts — Phase 6A shim.
//
// The framework types are now owned by V2
// (`@z-assistant/runtime/skills`). V1 re-exports the same types so
// any code importing from `'../skills/skill-types'` keeps working.

export {
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

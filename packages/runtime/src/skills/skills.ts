// Skills framework — generic types for skill packages.
//
// Per V2_VISION §"Skills" and ADR-0006 the Skills system is a
// cross-cutting knowledge-packs mechanism shared by every agent
// (Coding, Browser, Research). The framework part — type
// definitions, validation helpers, and the registry contract — is
// generic and lives in V2. Agent-specific loaders and selectors
// (Coding's `skill-loader.ts`, `skill-selector.ts`) sit ON TOP of
// this framework.
//
// Skill files are markdown documents with YAML frontmatter under
// .skills/**/SKILL.md. The framework defines:
//
//   - SkillMode            'advisory' | 'strict'
//   - SkillFrontmatter     metadata in YAML header
//   - SkillSections        standardized markdown sections
//   - Skill                full parsed skill record
//   - SkillSelectionReason why a skill was selected (for UI / debug)
//   - SelectedSkill        selection result with score + reasons
//   - SkillIndex           in-memory snapshot of all loaded skills
//   - SkillSelectionInput  input for the selector
//   - SkillValidationIssue + Result — loader's pre-validation output
//
// Phase 6A: framework foundation. R7 wires Coding's selector/loader
// and adds the cross-agent `SkillRegistry` interface.

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
  // OpenClaw-compatible metadata
  argumentHint?: string;
  userInvocable?: boolean;
  // Project-specific extensions (optional for compatibility)
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
  // OpenClaw-compatible metadata
  argumentHint?: string;
  userInvocable: boolean;
  // Project-specific extensions
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

// ── Pure validation helpers ──────────────────────────────────────────

/** Validate a parsed skill record against the framework's invariants. */
export function validateSkill(skill: Skill): SkillValidationResult {
  const issues: SkillValidationIssue[] = [];
  if (!skill.id) issues.push({ skillId: skill.id, skillPath: skill.path, severity: 'error', message: 'skill.id is required' });
  if (!skill.name) issues.push({ skillId: skill.id, skillPath: skill.path, severity: 'error', message: 'skill.name is required' });
  if (!Array.isArray(skill.tags)) issues.push({ skillId: skill.id, skillPath: skill.path, severity: 'error', message: 'skill.tags must be an array' });
  if (skill.priority < 0 || skill.priority > 100) issues.push({ skillId: skill.id, skillPath: skill.path, severity: 'warning', message: 'skill.priority should be in [0, 100]' });
  if (skill.mode && skill.mode !== 'advisory' && skill.mode !== 'strict') issues.push({ skillId: skill.id, skillPath: skill.path, severity: 'error', message: 'skill.mode must be advisory | strict' });
  return { valid: !issues.some((i) => i.severity === 'error'), issues };
}

/** Score a single skill against a SkillSelectionInput. Pure function. */
export function scoreSkill(skill: Skill, input: SkillSelectionInput): { score: number; reasons: SkillSelectionReason[] } {
  const reasons: SkillSelectionReason[] = [];
  const req = (input.userRequest || '').toLowerCase();
  let score = 0;

  // 1) Intent trigger
  for (const intent of skill.triggers.intents ?? []) {
    if (req.includes(intent.toLowerCase())) {
      const s = 50;
      score += s;
      reasons.push({ type: 'trigger', detail: `intent: ${intent}`, score: s });
    }
  }

  // 2) Keyword trigger
  for (const kw of skill.triggers.keywords ?? []) {
    if (req.includes(kw.toLowerCase())) {
      const s = 10;
      score += s;
      reasons.push({ type: 'keyword', detail: `keyword: ${kw}`, score: s });
    }
  }

  // 3) Tag match
  for (const tag of skill.tags) {
    if (req.includes(tag.toLowerCase())) {
      const s = 5;
      score += s;
      reasons.push({ type: 'tag', detail: `tag: ${tag}`, score: s });
    }
  }

  // 4) File-glob match
  for (const glob of skill.triggers.fileGlobs ?? []) {
    for (const f of [input.currentFile, ...(input.openFiles ?? [])]) {
      if (!f) continue;
      if (matchGlob(glob, f)) {
        const s = 30;
        score += s;
        reasons.push({ type: 'file', detail: `${glob} → ${f}`, score: s });
      }
    }
  }

  // 5) Symbol match
  for (const sym of input.discoveryReport?.relatedSymbols ?? []) {
    if (sym.filePath && skill.path && sym.filePath.includes(skill.rootDir)) {
      const s = 2;
      score += s;
      reasons.push({ type: 'symbol', detail: sym.name, score: s });
    }
  }

  // 6) Priority baseline
  const priority = skill.priority ?? 50;
  score += Math.round(priority * 0.1);
  reasons.push({ type: 'priority', detail: `priority=${priority}`, score: Math.round(priority * 0.1) });

  return { score, reasons };
}

/** Tiny glob matcher: `*` matches anything except `/`, `**` matches any
 *  path segment, `?` matches a single char. Sufficient for skill
 *  file-glob triggers; full minimatch-like behavior is the agent
 *  loader's job. */
export function matchGlob(glob: string, path: string): boolean {
  // Quick escape: exact match
  if (glob === path) return true;
  // Convert glob to regex
  const rx = '^' + glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '::DOUBLESTAR::')
    .replace(/\*/g, '[^/]*')
    .replace(/::DOUBLESTAR::/g, '.*')
    .replace(/\?/g, '[^/]') + '$';
  return new RegExp(rx).test(path);
}

/** Select the top-K skills for a given input. Pure function over an
 *  in-memory index; the agent loader supplies the index.
 *
 *  Skills whose body is highly similar (Jaccard >= `SKILL_DEDUP_THRESHOLD`)
 *  to a higher-ranked already-accepted skill are dropped. This prevents
 *  near-duplicate skill packs from diluting the model's attention and
 *  wasting context tokens on overlapping content.
 */
export function selectSkills(index: SkillIndex, input: SkillSelectionInput): SelectedSkill[] {
  const topK = input.topK ?? 5;
  const scored = index.skills
    .map((s) => {
      const r = scoreSkill(s, input);
      return { skill: s, score: r.score, reasons: r.reasons };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  const deduped: typeof scored = [];
  const acceptedTokens: Set<string>[] = [];
  for (const candidate of scored) {
    const tokens = tokenizeForDedup(candidate.skill.content);
    let tooSimilar = false;
    for (const existing of acceptedTokens) {
      if (jaccardSimilarity(tokens, existing) >= SKILL_DEDUP_THRESHOLD) {
        tooSimilar = true;
        break;
      }
    }
    if (!tooSimilar) {
      deduped.push(candidate);
      acceptedTokens.push(tokens);
    }
    if (deduped.length >= topK) break;
  }
  return deduped.map((s) => ({
    skill: s.skill,
    score: s.score,
    reasons: s.reasons,
    name: s.skill.name,
    path: s.skill.path,
    contentPreview: s.skill.content.slice(0, 200),
  }));
}

/** Jaccard similarity threshold above which two skills are considered duplicates.
 *  Tuned to 0.85 — high enough to merge near-identical packs, low enough to
 *  keep skills that share boilerplate but address distinct concerns. */
export const SKILL_DEDUP_THRESHOLD = 0.85;

/** Tokenize a skill body for dedup comparisons.
 *  Keeps ASCII word chars, digits, underscores, and CJK ideographs
 *  (covers both English `keywords: [...]` style and 中文 skills). */
function tokenizeForDedup(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z0-9_\u4e00-\u9fff]+/g) ?? []));
}

/** Jaccard similarity over two token sets: |A ∩ B| / |A ∪ B|. */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersect = 0;
  for (const t of a) if (b.has(t)) intersect++;
  return intersect / (a.size + b.size - intersect);
}

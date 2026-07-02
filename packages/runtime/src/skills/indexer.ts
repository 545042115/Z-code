// @ziner/runtime — In-Memory Skill Indexer (P1-3).
//
// Maintains inverted indexes over the active skill set so the runtime
// can resolve free-text queries to skill candidates quickly. The
// indexer is intentionally lightweight: lowercase tokenisation, exact
// match on intents / keywords / tags, plain string match on file
// globs. Higher-fidelity scoring lives in `scoreSkill` in skills.ts.

import type { Skill, ISkillIndexer } from '@ziner/contracts';

// ── InMemorySkillIndexer ─────────────────────────────────────────────

export class InMemorySkillIndexer implements ISkillIndexer {
  private readonly intentMap = new Map<string, Set<string>>();
  private readonly keywordMap = new Map<string, Set<string>>();
  private readonly tagMap = new Map<string, Set<string>>();
  private readonly globMap = new Map<string, Set<string>>();
  private readonly skillsById = new Map<string, Skill>();

  rebuild(skills: Skill[]): void {
    this.intentMap.clear();
    this.keywordMap.clear();
    this.tagMap.clear();
    this.globMap.clear();
    this.skillsById.clear();
    for (const s of skills) this.upsert(s);
  }

  upsert(skill: Skill): void {
    if (this.skillsById.has(skill.id)) this.remove(skill.id);
    this.skillsById.set(skill.id, skill);
    for (const intent of skill.triggers.intents ?? []) {
      addTo(this.intentMap, intent.toLowerCase(), skill.id);
    }
    for (const kw of skill.triggers.keywords ?? []) {
      addTo(this.keywordMap, kw.toLowerCase(), skill.id);
    }
    for (const tag of skill.tags ?? []) {
      addTo(this.tagMap, tag.toLowerCase(), skill.id);
    }
    for (const g of skill.triggers.fileGlobs ?? []) {
      addTo(this.globMap, g.toLowerCase(), skill.id);
    }
  }

  remove(id: string): void {
    this.skillsById.delete(id);
    removeFromAll(this.intentMap, id);
    removeFromAll(this.keywordMap, id);
    removeFromAll(this.tagMap, id);
    removeFromAll(this.globMap, id);
  }

  search(query: string, topK = 5): Skill[] {
    const tokens = tokenize(query);
    if (tokens.length === 0) return [];
    const scores = new Map<string, number>();
    for (const tok of tokens) {
      for (const id of this.intentMap.get(tok) ?? []) {
        scores.set(id, (scores.get(id) ?? 0) + 50);
      }
      for (const id of this.keywordMap.get(tok) ?? []) {
        scores.set(id, (scores.get(id) ?? 0) + 10);
      }
      for (const id of this.tagMap.get(tok) ?? []) {
        scores.set(id, (scores.get(id) ?? 0) + 5);
      }
    }
    const ranked = [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, Math.max(0, topK));
    const out: Skill[] = [];
    for (const [id] of ranked) {
      const s = this.skillsById.get(id);
      if (s) out.push(s);
    }
    return out;
  }

  stats(): {
    skillCount: number;
    intentCount: number;
    keywordCount: number;
    tagCount: number;
  } {
    return {
      skillCount: this.skillsById.size,
      intentCount: this.intentMap.size,
      keywordCount: this.keywordMap.size,
      tagCount: this.tagMap.size,
    };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function addTo(map: Map<string, Set<string>>, key: string, id: string): void {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  set.add(id);
}

function removeFromAll(map: Map<string, Set<string>>, id: string): void {
  for (const [key, set] of map) {
    if (set.delete(id) && set.size === 0) map.delete(key);
  }
}

function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9_-]+/)
    .filter((t) => t.length > 0);
}

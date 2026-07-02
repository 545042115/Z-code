// Skill loader for the VSCode Connector / Desktop Chat Agent.
//
// Scans `.skills/**/SKILL.md` from a configurable root directory,
// parses OpenClaw / Claude Code compatible skill files, and builds
// a runtime SkillIndex that can be passed into the chat agent.

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  parseSkillFile,
  type Skill,
  type SkillIndex,
} from '@ziner/runtime/skills';

export interface ChatSkillLoaderOptions {
  /** Root directory to scan for skill files under the .skills folder. */
  rootDir: string;
}

const SKILL_DIR = '.skills';
const SKILL_FILE = 'SKILL.md';

async function listSkillFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...await listSkillFiles(fullPath));
      } else if (entry.isFile() && entry.name === SKILL_FILE) {
        results.push(fullPath);
      }
    }
  } catch {
    // ignore unreadable directories
  }
  return results;
}

// ── In-memory cache ────────────────────────────────────────────────
const skillCache = new Map<string, { index: SkillIndex; cachedAt: number }>();
const SKILL_CACHE_TTL_MS = 60_000; // 1 minute

/**
 * Discover all skills under the .skills folder inside rootDir.
 * Returns an empty index if the .skills directory does not exist.
 * Results are cached for SKILL_CACHE_TTL_MS to avoid repeated I/O.
 */
export async function discoverChatSkills(opts: ChatSkillLoaderOptions): Promise<SkillIndex> {
  const cacheKey = path.resolve(opts.rootDir);
  const cached = skillCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < SKILL_CACHE_TTL_MS) {
    return cached.index;
  }

  const skillDir = path.join(opts.rootDir, SKILL_DIR);
  if (!fs.existsSync(skillDir)) {
    const empty: SkillIndex = { skills: [], lastUpdated: Date.now() };
    skillCache.set(cacheKey, { index: empty, cachedAt: Date.now() });
    return empty;
  }

  const skills: Skill[] = [];
  const files = await listSkillFiles(skillDir);
  for (const filePath of files) {
    try {
      const raw = await fs.promises.readFile(filePath, 'utf-8');
      const skill = parseSkillFile(raw, filePath, path.dirname(filePath));
      if (skill) {
        skills.push(skill);
      }
    } catch (err) {
      console.warn(`[ChatSkillLoader] Failed to parse ${filePath}:`, err);
    }
  }

  const index: SkillIndex = { skills, lastUpdated: Date.now() };
  skillCache.set(cacheKey, { index, cachedAt: Date.now() });
  return index;
}

/**
 * Clear the in-memory skill cache. Useful when skills are modified at runtime.
 */
export function clearSkillCache(rootDir?: string): void {
  if (rootDir) {
    skillCache.delete(path.resolve(rootDir));
  } else {
    skillCache.clear();
  }
}

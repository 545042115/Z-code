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
} from '@z-assistant/runtime/skills';

export interface ChatSkillLoaderOptions {
  /** Root directory to scan for skill files under the .skills folder. */
  rootDir: string;
}

const SKILL_DIR = '.skills';
const SKILL_FILE = 'SKILL.md';

function listSkillFiles(dir: string): string[] {
  const results: string[] = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...listSkillFiles(fullPath));
      } else if (entry.isFile() && entry.name === SKILL_FILE) {
        results.push(fullPath);
      }
    }
  } catch {
    // ignore unreadable directories
  }
  return results;
}

/**
 * Discover all skills under the .skills folder inside rootDir.
 * Returns an empty index if the .skills directory does not exist.
 */
export function discoverChatSkills(opts: ChatSkillLoaderOptions): SkillIndex {
  const skillDir = path.join(opts.rootDir, SKILL_DIR);
  if (!fs.existsSync(skillDir)) {
    return { skills: [], lastUpdated: Date.now() };
  }

  const skills: Skill[] = [];
  for (const filePath of listSkillFiles(skillDir)) {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const skill = parseSkillFile(raw, filePath, path.dirname(filePath));
      if (skill) {
        skills.push(skill);
      }
    } catch (err) {
      console.warn(`[ChatSkillLoader] Failed to parse ${filePath}:`, err);
    }
  }

  return {
    skills,
    lastUpdated: Date.now(),
  };
}

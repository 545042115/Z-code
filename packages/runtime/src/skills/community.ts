// @z-assistant/runtime — Local Community Skill Store (P1-3).
//
// Filesystem-backed implementation of `ICommunitySkillStore`. Each
// published skill is written as a JSON file under
// `<rootDir>/community/<id>.json` containing both the catalog
// metadata (`entry`) and the full skill body. This is enough to
// support a "share with myself across machines" workflow and to
// stub the contract for tests.

import { promises as fsp, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'node:crypto';
import type {
  CommunitySkillEntry,
  ICommunitySkillStore,
  Skill,
} from '@z-assistant/contracts';

// ── Options ──────────────────────────────────────────────────────────

export interface LocalCommunitySkillStoreOptions {
  rootDir: string;
  /** Publisher id stamped on every published skill. */
  publisher?: string;
}

interface StoredSkill {
  entry: CommunitySkillEntry;
  body: string;
  /** Snapshot of structured fields so `pull` can reconstruct a Skill. */
  skill: Pick<
    Skill,
    | 'id'
    | 'name'
    | 'description'
    | 'tags'
    | 'priority'
    | 'mode'
    | 'triggers'
    | 'stopIf'
    | 'imports'
    | 'toolsAllow'
    | 'verification'
  >;
}

// ── LocalCommunitySkillStore ─────────────────────────────────────────

export class LocalCommunitySkillStore implements ICommunitySkillStore {
  private readonly dir: string;
  private readonly publisher: string;

  constructor(opts: LocalCommunitySkillStoreOptions) {
    this.dir = join(opts.rootDir, 'community');
    this.publisher = opts.publisher ?? 'local-user';
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
  }

  get path(): string {
    return this.dir;
  }

  async publish(
    skill: Skill,
    opts: { source?: 'user' | 'discovery'; note?: string } = {}
  ): Promise<{ id: string; url?: string }> {
    const id = randomUUID();
    const entry: CommunitySkillEntry = {
      id,
      name: skill.name,
      description: skill.description,
      tags: [...skill.tags, opts.source ?? 'user'],
      publisher: this.publisher,
      publishedAt: Date.now(),
      preview: (skill.content ?? '').slice(0, 200),
    };
    const stored: StoredSkill = {
      entry,
      body: skill.content,
      skill: {
        id: skill.id,
        name: skill.name,
        description: skill.description,
        tags: skill.tags,
        priority: skill.priority,
        mode: skill.mode,
        triggers: skill.triggers,
        stopIf: skill.stopIf,
        imports: skill.imports,
        toolsAllow: skill.toolsAllow,
        verification: skill.verification,
      },
    };
    const file = join(this.dir, `${id}.json`);
    await fsp.writeFile(file, JSON.stringify(stored, null, 2), 'utf8');
    return { id, url: `file://${file.replace(/\\/g, '/')}` };
  }

  async list(): Promise<CommunitySkillEntry[]> {
    if (!existsSync(this.dir)) return [];
    const files = await fsp.readdir(this.dir);
    const out: CommunitySkillEntry[] = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const raw = await fsp.readFile(join(this.dir, f), 'utf8');
        const stored = JSON.parse(raw) as StoredSkill;
        if (stored?.entry) out.push(stored.entry);
      } catch {
        // skip malformed
      }
    }
    out.sort((a, b) => b.publishedAt - a.publishedAt);
    return out;
  }

  async pull(id: string): Promise<Skill> {
    const file = join(this.dir, `${id}.json`);
    if (!existsSync(file)) {
      throw new Error(`community skill not found: ${id}`);
    }
    const raw = await fsp.readFile(file, 'utf8');
    const stored = JSON.parse(raw) as StoredSkill;
    return {
      ...stored.skill,
      content: stored.body,
      sections: {},
      path: file,
      rootDir: this.dir,
    };
  }
}

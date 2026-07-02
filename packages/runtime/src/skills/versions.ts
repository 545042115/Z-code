// @ziner/runtime — Skill Version Registry (P1-3).
//
// JSON-file backed registry for SkillVersion records. One file per
// rootDir; the in-memory cache is loaded lazily on the first call.
//
// Versions are tracked per-skill-id; the registry supports activate /
// rollback / markObsolete so the auto-discovery loop can promote new
// drafts and the obsolescence detector can retire them.

import { promises as fsp, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import type {
  ISkillVersionRegistry,
  SkillVersion,
} from '@ziner/contracts';

// ── Storage shape ────────────────────────────────────────────────────

type VersionMap = Record<string, SkillVersion[]>;

/** Extended provenance used internally to persist obsolescence reason. */
interface VersionProvenance {
  candidateId?: string;
  failureCaseIds?: string[];
  parentVersion?: number;
  obsoleteReason?: string;
}

// ── JsonFileSkillVersionRegistry ─────────────────────────────────────

export interface JsonFileSkillVersionRegistryOptions {
  rootDir: string;
  filename?: string;
}

export class JsonFileSkillVersionRegistry implements ISkillVersionRegistry {
  private readonly filePath: string;
  private cache?: VersionMap;
  /** Serialized write chain — each save awaits the previous. */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(opts: JsonFileSkillVersionRegistryOptions) {
    if (!existsSync(opts.rootDir)) mkdirSync(opts.rootDir, { recursive: true });
    this.filePath = join(opts.rootDir, opts.filename ?? 'skill-versions.json');
  }

  get path(): string {
    return this.filePath;
  }

  async flush(): Promise<void> {
    await this.writeChain;
  }

  // ── ISkillVersionRegistry ───────────────────────────────────────

  async push(version: SkillVersion): Promise<void> {
    const map = await this.load();
    const arr = map[version.skillId] ?? [];
    arr.push(version);
    map[version.skillId] = arr;
    await this.save();
  }

  async list(skillId: string): Promise<SkillVersion[]> {
    const map = await this.load();
    return (map[skillId] ?? []).slice();
  }

  async getActive(skillId: string): Promise<SkillVersion | null> {
    const map = await this.load();
    const versions = map[skillId] ?? [];
    return versions.find((v) => v.status === 'active') ?? null;
  }

  async activate(skillId: string, version: number): Promise<void> {
    const map = await this.load();
    const versions = map[skillId];
    if (!versions) return;
    for (const v of versions) {
      if (v.version === version) v.status = 'active';
      else if (v.status === 'active') v.status = 'inactive';
    }
    await this.save();
  }

  async rollback(skillId: string): Promise<SkillVersion | null> {
    const map = await this.load();
    const versions = map[skillId];
    if (!versions || versions.length === 0) return null;
    const active = versions.find((v) => v.status === 'active');
    // Order versions ascending by version number for stable comparison.
    const sorted = [...versions].sort((a, b) => a.version - b.version);
    let target: SkillVersion | undefined;
    if (active) {
      // Previous version in version-number order.
      const idx = sorted.findIndex((v) => v.version === active.version);
      for (let i = idx - 1; i >= 0; i--) {
        if (sorted[i].status !== 'obsolete') {
          target = sorted[i];
          break;
        }
      }
      if (!target) return null;
      active.status = 'inactive';
    } else {
      // Nothing active — pick the latest non-obsolete.
      for (let i = sorted.length - 1; i >= 0; i--) {
        if (sorted[i].status !== 'obsolete') {
          target = sorted[i];
          break;
        }
      }
      if (!target) return null;
    }
    target.status = 'active';
    await this.save();
    return target;
  }

  async markObsolete(skillId: string, version: number, reason: string): Promise<void> {
    const map = await this.load();
    const versions = map[skillId];
    if (!versions) return;
    for (const v of versions) {
      if (v.version === version) {
        v.status = 'obsolete';
        const prov: VersionProvenance = { ...(v.provenance ?? {}) };
        prov.obsoleteReason = reason;
        v.provenance = prov as SkillVersion['provenance'];
      }
    }
    await this.save();
  }

  // ── Persistence ─────────────────────────────────────────────────

  private async load(): Promise<VersionMap> {
    if (this.cache) return this.cache;
    if (!existsSync(this.filePath)) {
      this.cache = {};
      return this.cache;
    }
    try {
      const raw = await fsp.readFile(this.filePath, 'utf8');
      this.cache = (JSON.parse(raw) as VersionMap) ?? {};
    } catch {
      this.cache = {};
    }
    return this.cache;
  }

  private save(): Promise<void> {
    const snapshot = JSON.stringify(this.cache ?? {}, null, 2);
    this.writeChain = this.writeChain
      .then(() => fsp.writeFile(this.filePath, snapshot, 'utf8'))
      .catch((err) => {
        console.error('[JsonFileSkillVersionRegistry] save error:', err);
      });
    return this.writeChain;
  }
}

// ── NoopSkillVersionRegistry ─────────────────────────────────────────

export class NoopSkillVersionRegistry implements ISkillVersionRegistry {
  async push(_version: SkillVersion): Promise<void> {}
  async list(_skillId: string): Promise<SkillVersion[]> { return []; }
  async getActive(_skillId: string): Promise<SkillVersion | null> { return null; }
  async activate(_skillId: string, _version: number): Promise<void> {}
  async rollback(_skillId: string): Promise<SkillVersion | null> { return null; }
  async markObsolete(_skillId: string, _version: number, _reason: string): Promise<void> {}
}

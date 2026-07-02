// @ziner/runtime — Skill Review Queue (P1-3).
//
// Persisted queue of CandidateSkill records awaiting human review.
// Backed by a single JSON file under `<rootDir>/skill-review-queue.json`.
//
// Approval / rejection mutates the candidate in place; consumers
// register `onApprove` / `onReject` callbacks to hook the queue into
// the rest of the auto-discovery pipeline (e.g. push to the version
// registry, notify a UI).

import { promises as fsp, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import type {
  CandidateSkill,
  ISkillReviewQueue,
} from '@ziner/contracts';

// ── Options ──────────────────────────────────────────────────────────

export interface JsonFileSkillReviewQueueOptions {
  rootDir: string;
  filename?: string;
  onApprove?: (candidate: CandidateSkill) => Promise<void> | void;
  onReject?: (candidate: CandidateSkill) => Promise<void> | void;
}

// ── JsonFileSkillReviewQueue ─────────────────────────────────────────

export class JsonFileSkillReviewQueue implements ISkillReviewQueue {
  private readonly filePath: string;
  private readonly onApprove?: (candidate: CandidateSkill) => Promise<void> | void;
  private readonly onReject?: (candidate: CandidateSkill) => Promise<void> | void;
  private cache?: CandidateSkill[];
  private writeChain: Promise<void> = Promise.resolve();

  constructor(opts: JsonFileSkillReviewQueueOptions) {
    if (!existsSync(opts.rootDir)) mkdirSync(opts.rootDir, { recursive: true });
    this.filePath = join(opts.rootDir, opts.filename ?? 'skill-review-queue.json');
    this.onApprove = opts.onApprove;
    this.onReject = opts.onReject;
  }

  get path(): string {
    return this.filePath;
  }

  async flush(): Promise<void> {
    await this.writeChain;
  }

  // ── ISkillReviewQueue ───────────────────────────────────────────

  async enqueue(candidate: CandidateSkill): Promise<void> {
    const queue = await this.load();
    queue.push(candidate);
    await this.save();
  }

  async listPending(): Promise<CandidateSkill[]> {
    const queue = await this.load();
    return queue.filter((c) => c.status === 'pending').slice();
  }

  async get(id: string): Promise<CandidateSkill | null> {
    const queue = await this.load();
    return queue.find((c) => c.id === id) ?? null;
  }

  async approve(id: string, opts: { reviewer?: string; note?: string } = {}): Promise<CandidateSkill> {
    const queue = await this.load();
    const c = queue.find((x) => x.id === id);
    if (!c) throw new Error(`candidate not found: ${id}`);
    c.status = 'approved';
    c.reviewedAt = Date.now();
    if (opts.reviewer !== undefined) c.reviewedBy = opts.reviewer;
    if (opts.note !== undefined) c.reviewNote = opts.note;
    await this.save();
    if (this.onApprove) await this.onApprove(c);
    return c;
  }

  async reject(id: string, opts: { reviewer?: string; note?: string } = {}): Promise<CandidateSkill> {
    const queue = await this.load();
    const c = queue.find((x) => x.id === id);
    if (!c) throw new Error(`candidate not found: ${id}`);
    c.status = 'rejected';
    c.reviewedAt = Date.now();
    if (opts.reviewer !== undefined) c.reviewedBy = opts.reviewer;
    if (opts.note !== undefined) c.reviewNote = opts.note;
    await this.save();
    if (this.onReject) await this.onReject(c);
    return c;
  }

  // ── Persistence ─────────────────────────────────────────────────

  private async load(): Promise<CandidateSkill[]> {
    if (this.cache) return this.cache;
    if (!existsSync(this.filePath)) {
      this.cache = [];
      return this.cache;
    }
    try {
      const raw = await fsp.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as CandidateSkill[];
      this.cache = Array.isArray(parsed) ? parsed : [];
    } catch {
      this.cache = [];
    }
    return this.cache;
  }

  private save(): Promise<void> {
    const snapshot = JSON.stringify(this.cache ?? [], null, 2);
    this.writeChain = this.writeChain
      .then(() => fsp.writeFile(this.filePath, snapshot, 'utf8'))
      .catch((err) => {
        console.error('[JsonFileSkillReviewQueue] save error:', err);
      });
    return this.writeChain;
  }
}
